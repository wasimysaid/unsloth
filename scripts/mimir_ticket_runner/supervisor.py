"""Detached Linux process supervision; only settled process results can complete.

Job directories are append-only attempt identities: never delete/reset one to
retry. stdout.jsonl (including review output_text) and stderr.log stay local.
"""
from __future__ import annotations

from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time
import uuid

from .common import RunnerError, atomic_json, read_json

ROOT = Path(__file__).resolve().parents[2]
NONCE_ENV = "MIMIR_TICKET_RUNNER_NONCE"
SIGINT_GRACE_SECONDS = 10
ENV_KEYS = {"PATH", "TMPDIR", "CARGO_TARGET_DIR", "CARGO_BUILD_JOBS", "CUDA_VISIBLE_DEVICES",
            "XDG_CACHE_HOME", "HF_HOME", "UV_CACHE_DIR", "PIP_CACHE_DIR", "npm_config_cache"}
_HELPERS = {}


@contextmanager
def _lock(job_dir: Path):
    with (job_dir / ".supervisor.lock").open("a+b") as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        yield


def _process(pid: int) -> dict | None:
    """Read only the nonce from environ; never persist ambient credentials."""
    path = Path(f"/proc/{pid}")
    try:
        stat = (path / "stat").read_text().rsplit(")", 1)[1].split()
        if stat[0] in {"Z", "X"}:
            return None
        uid = path.stat().st_uid
        if uid != os.getuid():
            raise RunnerError("Process belongs to another user")
        prefix = (NONCE_ENV + "=").encode()
        nonce = next((entry[len(prefix):].decode() for entry in
                      (path / "environ").read_bytes().split(b"\0") if entry.startswith(prefix)), None)
        identity = {
            "pid": pid, "start_time": int(stat[19]), "uid": uid,
            "exe": os.readlink(path / "exe"), "cwd": os.readlink(path / "cwd"),
            "cmdline": [part.decode(errors="surrogateescape") for part in
                        (path / "cmdline").read_bytes().split(b"\0") if part],
            "nonce": nonce,
        }
        after = (path / "stat").read_text().rsplit(")", 1)[1].split()
        if after[0] in {"Z", "X"} or int(after[19]) != identity["start_time"]:
            return None
        return identity
    except (FileNotFoundError, ProcessLookupError):
        return None


def _capture(pid: int, nonce: str) -> dict | None:
    """Do not persist the transient empty /proc image during exec startup."""
    deadline = time.monotonic() + 2
    previous = None
    while time.monotonic() < deadline:
        try:
            current = _process(pid)
        except (OSError, ValueError, RunnerError):
            # exec briefly changes /proc visibility/dumpability. This is only
            # bounded observation of our spawned PID, never permission bypass.
            time.sleep(0.005)
            continue
        if current is None:
            if previous and previous["nonce"] == nonce and previous["cmdline"]:
                return previous
            try:
                state = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0]
            except (OSError, IndexError):
                return None
            if state in {"Z", "X"}:
                return None
            time.sleep(0.005)
            continue
        if current["nonce"] == nonce and current["cmdline"] and current == previous:
            return current
        previous = current
        time.sleep(0.005)
    return None


def _child_identity(child: subprocess.Popen, job: dict) -> dict | None:
    identity = _capture(child.pid, job["nonce"])
    if identity is not None:
        return identity
    # Popen has acknowledged exec, and this helper has not called poll/wait yet.
    # An owned, unreaped zombie cannot have its PID reused. Bind the observed
    # start-time/UID/parent to the exact acknowledged argv/cwd/environment intent.
    # This is exit evidence only, NEVER a live-process signalling identity.
    path = Path(f"/proc/{child.pid}")
    deadline = time.monotonic() + 0.1
    while time.monotonic() < deadline:
        try:
            stat = (path / "stat").read_text().rsplit(")", 1)[1].split()
            # /proc inode ownership may change during exec/dumpability changes;
            # the kernel's real/effective task credentials are authoritative.
            uids = next(line for line in (path / "status").read_text().splitlines()
                        if line.startswith("Uid:")).split()[1:]
            uid = int(uids[1])
            if (int(stat[1]) != os.getpid() or int(uids[0]) != os.getuid()
                    or uid != os.getuid() or child.returncode is not None):
                return None
            if stat[0] in {"Z", "X"}:
                return {"pid": child.pid, "start_time": int(stat[19]), "uid": uid,
                        "exe": str(Path(job["argv"][0]).resolve()), "cmdline": job["argv"],
                        "cwd": job["cwd"], "nonce": job["nonce"], "exited_before_capture": True}
        except (OSError, ValueError, IndexError, StopIteration):
            pass
        time.sleep(0.002)
    return None


def _probe(identity, nonce: str) -> str:
    if not isinstance(identity, dict):
        return "missing"
    fields = {"pid", "start_time", "uid", "exe", "cwd", "cmdline", "nonce"}
    extra = set(identity) - fields
    if (not fields <= set(identity) or extra not in (set(), {"exited_before_capture"})
            or (extra and identity["exited_before_capture"] is not True)
            or type(identity["pid"]) is not int or identity["pid"] <= 0):
        return "mismatch"
    if identity["nonce"] != nonce or identity["uid"] != os.getuid():
        return "mismatch"
    try:
        actual = _process(identity["pid"])
    except (OSError, ValueError, RunnerError):
        return "unknown"
    if actual is None:
        return "gone"
    if extra:
        # A forged exit-only fingerprint must not settle or signal live work.
        return "unknown" if actual["nonce"] == nonce else "mismatch"
    return "running" if actual == identity else "mismatch"


def _job_processes(nonce: str, supervisor_pid: int) -> list[dict]:
    """Observe nonce-bearing owned descendants, including detached native tools.

    No signals are sent to this list. Native Mimir owns its tool cancellation.
    """
    processes = []
    for path in Path("/proc").iterdir():
        if not path.name.isdigit() or int(path.name) == supervisor_pid:
            continue
        try:
            if path.stat().st_uid != os.getuid():
                continue
            prefix = (NONCE_ENV + "=" + nonce).encode()
            if prefix not in (path / "environ").read_bytes().split(b"\0"):
                continue
            identity = _process(int(path.name))
            if identity is not None and identity["nonce"] == nonce:
                processes.append(identity)
        except (OSError, ValueError, RunnerError):
            # Disappearing processes are normal. For a known identity, _probe
            # remains authoritative; inaccessible processes are never signalled.
            continue
    return sorted(processes, key=lambda identity: identity["pid"])


def _interrupt(identity: dict, nonce: str) -> bool:
    """Pin the process with a pidfd, then verify all recorded identity fields."""
    if _probe(identity, nonce) != "running":
        return False
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        return False  # No racy PID-only fallback.
    try:
        fd = os.pidfd_open(identity["pid"])
        try:
            if _probe(identity, nonce) != "running":
                return False
            signal.pidfd_send_signal(fd, signal.SIGINT)
            return True
        finally:
            os.close(fd)
    except (OSError, ProcessLookupError):
        return False


def _result(status: str, reason: str, terminal=None, exit_code=None) -> dict:
    return {"status": status, "terminal": terminal, "exit_code": exit_code, "reason": reason}


def _alias(record: dict, snake: str, camel: str) -> str | None:
    values = [record[key] for key in (snake, camel) if key in record]
    if not values:
        return None
    if any(not isinstance(value, str) or not value.strip() for value in values) or len(set(values)) != 1:
        raise ValueError(f"inconsistent or missing {snake}")
    return values[0]


def _native_result(path: Path) -> tuple[dict, str | None]:
    data = path.read_bytes()
    if not data or not data.endswith(b"\n"):
        raise ValueError("missing or truncated JSONL")
    records = []
    for line in data.decode("utf-8").splitlines():
        record = json.loads(line, parse_constant=lambda value: (_ for _ in ()).throw(ValueError("invalid JSON constant")))
        if not isinstance(record, dict):
            raise ValueError("JSONL records must be objects")
        records.append(record)
    terminals = [record for record in records if record.get("event") == "run_finished"]
    starts = [record for record in records if record.get("event") == "run_start"]
    if len(terminals) != 1 or len(starts) != 1:
        raise ValueError("missing or conflicting native start/terminal records")
    terminal, start = terminals[0], starts[0]
    if terminal is not records[-1] or start is not records[0]:
        raise ValueError("native start/terminal ordering is invalid")
    if any(record.get("schema") != "mimir.run.v2" for record in (start, terminal)):
        raise ValueError("unsupported native result schema")
    session = _alias(terminal, "session_id", "sessionId")
    request = _alias(terminal, "request_id", "requestId")
    if not session or not request or _alias(start, "session_id", "sessionId") != session:
        raise ValueError("missing or mismatched native session/request identity")
    for record in records:
        if record.get("schema") == "mimir.run.v2":
            sid = _alias(record, "session_id", "sessionId")
            rid = _alias(record, "request_id", "requestId")
            if (sid is not None and sid != session) or (rid is not None and rid != request):
                raise ValueError("conflicting native session/request identities")
    return terminal, hashlib.sha256(data).hexdigest()


def _inspect(job_dir: Path) -> dict:
    identity = {"nonce": None, "supervisor": None, "child": None, "unsettled": [],
                "supervisor_state": "missing", "child_state": "missing"}
    protocol = None
    try:
        job = read_json(job_dir / "job.json")
        if (not isinstance(job, dict) or not isinstance(job.get("nonce"), str)
                or not job["nonce"] or job.get("protocol") not in {"native", "command"}):
            return {**_result("unknown", "missing or invalid launch intent"), "identity": identity, "protocol": protocol}
        nonce, protocol = job["nonce"], job["protocol"]
        identity.update({"nonce": nonce, "supervisor": job.get("supervisor"), "child": job.get("child"),
                         "unsettled": job.get("unsettled", [])})
        for name in ("supervisor", "child"):
            identity[name + "_state"] = _probe(identity[name], nonce)
        receipt = read_json(job_dir / "exit.json")
    except (OSError, ValueError, TypeError):
        return {**_result("unknown", "unreadable or corrupt supervision metadata"), "identity": identity, "protocol": protocol}
    if receipt is None:
        if any(identity[name + "_state"] in {"mismatch", "unknown"} for name in ("child", "supervisor")):
            result = _result("unknown", "process identity is ambiguous; reconciliation required")
        elif job.get("needs_human") or job.get("stop_requested"):
            result = _result("needs-human", "interrupted work has not settled")
        elif job.get("launch_error"):
            result = _result("failed", "supervisor or child could not start")
        elif identity["supervisor_state"] == "gone" and identity["child_state"] == "running":
            result = _result("needs-human", "supervisor disappeared while work remains")
        elif identity["supervisor_state"] == "running":
            result = _result("running", "supervised process has not settled")
        else:
            result = _result("unknown", "launch outcome or process settlement is unrecorded; never relaunch")
        return {**result, "identity": identity, "protocol": protocol}
    code = receipt.get("exit_code") if isinstance(receipt, dict) else None
    child = job.get("child")
    if (not isinstance(receipt, dict) or receipt.get("nonce") != nonce
            or receipt.get("protocol") != protocol or receipt.get("child") != child
            or not isinstance(child, dict) or child.get("nonce") != nonce
            or receipt.get("settled") is not True or type(code) is not int):
        result = _result("unknown", "exit receipt does not prove this process settled", exit_code=code)
    elif identity["child_state"] in {"running", "unknown", "missing"} or any(
            _probe(item, nonce) in {"running", "unknown"} for item in identity["unsettled"]):
        result = _result("unknown", "exit receipt conflicts with observable process settlement", exit_code=code)
    elif receipt.get("timed_out") or receipt.get("stop_requested") or job.get("stop_requested") or job.get("needs_human"):
        result = _result("needs-human", "supervised work was interrupted; automatic retry is forbidden", exit_code=code)
    else:
        try:
            for name, key in (("stdout.jsonl", "stdout_sha256"), ("stderr.log", "stderr_sha256")):
                if hashlib.sha256((job_dir / name).read_bytes()).hexdigest() != receipt.get(key):
                    raise ValueError("logs differ from settled exit receipt")
            if protocol == "command":
                result = _result("completed" if code == 0 else "failed", "settled command exit", exit_code=code)
            else:
                terminal, _ = _native_result(job_dir / "stdout.jsonl")
                if terminal.get("cleanup_error") is not None or terminal.get("error") is not None:
                    result = _result("failed", "native execution or cleanup failed", terminal, code)
                elif terminal.get("outcome") == "interaction-required":
                    result = _result("needs-human", "native execution requires interaction", terminal, code)
                elif code != 0 or terminal.get("outcome") != "completed":
                    result = _result("failed", "native outcome or exit code is not successful", terminal, code)
                elif isinstance(terminal.get("execution"), dict) and terminal["execution"].get("terminal_cause", "completed") != "completed":
                    result = _result("failed", "native execution terminal cause is not completed", terminal, code)
                else:
                    result = _result("completed", "matching native terminal and settled successful exit", terminal, code)
        except (OSError, ValueError, UnicodeError, TypeError):
            result = _result("failed", "invalid/truncated/conflicting native JSONL or changed local logs", exit_code=code)
    return {**result, "identity": identity, "protocol": protocol}


def inspect(job_dir: Path) -> dict:
    """Read/reconcile local artifacts without resetting an attempt or signalling."""
    job_dir = Path(job_dir).resolve()
    for pid, process in list(_HELPERS.items()):
        if process.poll() is not None:
            del _HELPERS[pid]
    if not job_dir.is_dir():
        return {**_result("unknown", "job directory is missing"), "identity": None, "protocol": None}
    with _lock(job_dir):
        return _inspect(job_dir)


def parse_result(job_dir: Path) -> dict:
    """Return status/terminal/exit_code/reason, including local terminal output_text.

    This is local data for verification/review, not a GitHub-publication payload.
    """
    observed = inspect(job_dir)
    return {key: observed[key] for key in ("status", "terminal", "exit_code", "reason")}


def _environment(job_dir: Path, nonce: str, overrides: dict) -> dict:
    env = os.environ.copy()
    env.update(overrides)
    for key in ("GH_TOKEN", "GITHUB_TOKEN"):
        env.pop(key, None)
    env["GH_CONFIG_DIR"] = str(job_dir / "github-empty")
    env["CUDA_VISIBLE_DEVICES"] = overrides.get("CUDA_VISIBLE_DEVICES", "")
    env[NONCE_ENV] = nonce
    return env


def launch(job_dir: Path, argv: list[str], cwd: Path, *, timeout: int,
           env_overrides: dict | None = None, protocol: str = "native") -> dict:
    """Persist intent, spawn a detached helper once, and return observed state.

    Existing jobs are never relaunched, including ambiguous or damaged jobs.
    Only the small non-secret ENV_KEYS allowlist may be persisted as overrides.
    Native jobs require prompt.txt and matching Mimir JSONL. Explicit command
    jobs allow absent prompt.txt (EOF stdin) and ordinary non-JSON output.
    """
    job_dir, cwd = Path(job_dir).resolve(), Path(cwd).resolve()
    if not job_dir.is_dir():
        raise RunnerError("Job directory and prompt.txt must already exist")
    with _lock(job_dir):
        if (job_dir / "job.json").exists():
            return _inspect(job_dir)
        if any((job_dir / name).exists() for name in ("exit.json", "stdout.jsonl", "stderr.log", "supervisor.log")):
            return {**_result("unknown", "artifacts exist without launch intent; never reset or relaunch"), "identity": None, "protocol": None}
        if not isinstance(argv, list) or not argv or any(not isinstance(arg, str) or "\0" in arg for arg in argv):
            raise RunnerError("argv must be a nonempty list of strings")
        if protocol not in {"native", "command"}:
            raise RunnerError("Protocol must be native or explicitly command")
        if (type(timeout) is not int or timeout <= 0 or not cwd.is_dir()
                or (protocol == "native" and not (job_dir / "prompt.txt").is_file())):
            raise RunnerError("A positive timeout, existing cwd, and native prompt.txt are required")
        overrides = dict(env_overrides or {})
        if set(overrides) - ENV_KEYS or any(not isinstance(value, str) or "\0" in value for value in overrides.values()):
            raise RunnerError("Only explicitly trusted non-secret environment overrides are allowed")
        search_path = overrides.get("PATH", os.environ.get("PATH", os.defpath))
        search_path = os.pathsep.join(str(Path(entry) if Path(entry).is_absolute() else cwd / entry)
                                      for entry in search_path.split(os.pathsep))
        name = str(cwd / argv[0]) if not Path(argv[0]).is_absolute() and os.sep in argv[0] else argv[0]
        executable = shutil.which(name, path=search_path)
        if not executable:
            raise RunnerError("Job executable is unavailable")
        argv = [str(Path(executable).absolute()), *argv[1:]]
        config = job_dir / "github-empty"
        config.mkdir(mode=0o700, exist_ok=True)
        if any(config.iterdir()):
            raise RunnerError("Job-owned GitHub configuration directory must be empty")
        job = {"version": 1, "nonce": uuid.uuid4().hex, "argv": argv, "cwd": str(cwd),
               "protocol": protocol, "timeout": timeout, "created_at": time.time(), "env_overrides": overrides,
               "supervisor": None, "child": None, "child_spawn_intent": False,
               "stop_requested": None, "needs_human": False}
        atomic_json(job_dir / "job.json", job)
        process = None
        try:
            with (job_dir / "supervisor.log").open("ab") as log:
                process = subprocess.Popen(
                    [sys.executable, "-m", "scripts.mimir_ticket_runner.supervisor", str(job_dir)],
                    cwd=ROOT, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                    env=_environment(job_dir, job["nonce"], overrides),
                    start_new_session=True, close_fds=True, shell=False,
                )
            _HELPERS[process.pid] = process
            job["supervisor"] = _capture(process.pid, job["nonce"])
            if job["supervisor"] is None or job["supervisor"].get("nonce") != job["nonce"]:
                job["needs_human"] = True
            atomic_json(job_dir / "job.json", job)
        except (OSError, RunnerError):
            job["launch_error" if process is None else "needs_human"] = True
            atomic_json(job_dir / "job.json", job)
        return _inspect(job_dir)


def stop(job_dir: Path) -> dict:
    """Request cancellation; signal only a verified native child, never a PID alone."""
    job_dir = Path(job_dir).resolve()
    if not job_dir.is_dir():
        return inspect(job_dir)
    with _lock(job_dir):
        current = _inspect(job_dir)
        if (job_dir / "exit.json").exists() or current["status"] in {"failed", "unknown"}:
            return current
        job = read_json(job_dir / "job.json")
        if not job.get("stop_requested"):
            job["stop_requested"] = {"kind": "manual", "at": time.time(), "sigint_sent": False}
        if job.get("child") and not job["stop_requested"]["sigint_sent"]:
            job["stop_requested"]["sigint_sent"] = _interrupt(job["child"], job["nonce"])
            if not job["stop_requested"]["sigint_sent"]:
                job["needs_human"] = True
        atomic_json(job_dir / "job.json", job)
        return _inspect(job_dir)


def _serve(job_dir: Path) -> None:
    """Independent helper: survive coordinator exit and own the native wait()."""
    with _lock(job_dir):
        job = read_json(job_dir / "job.json")
        if not isinstance(job, dict) or job.get("nonce") != os.environ.get(NONCE_ENV):
            raise RunnerError("Helper does not match persisted launch intent")
        actual = _capture(os.getpid(), job["nonce"])
        if actual is None or (job.get("supervisor") is not None and job["supervisor"] != actual):
            raise RunnerError("Supervisor identity is ambiguous")
        if job.get("child_spawn_intent") or (job_dir / "exit.json").exists():
            raise RunnerError("Existing native spawn intent cannot be replayed")
        job["supervisor"] = actual
        if job.get("stop_requested") or job.get("needs_human"):
            job["needs_human"] = True
            atomic_json(job_dir / "job.json", job)
            return
        job["child_spawn_intent"] = True
        atomic_json(job_dir / "job.json", job)
        prompt_path = job_dir / "prompt.txt"
        if job["protocol"] == "command" and not prompt_path.exists():
            prompt_path = Path(os.devnull)
        try:
            with prompt_path.open("rb") as prompt, \
                    (job_dir / "stdout.jsonl").open("xb") as stdout, \
                    (job_dir / "stderr.log").open("xb") as stderr:
                # Regular-file stdin reaches EOF without scheduler-owned pipes.
                child = subprocess.Popen(job["argv"], cwd=job["cwd"], stdin=prompt,
                                         stdout=stdout, stderr=stderr, shell=False,
                                         env=_environment(job_dir, job["nonce"], job["env_overrides"]),
                                         start_new_session=True, close_fds=True)
        except OSError:
            job["launch_error"] = True
            atomic_json(job_dir / "job.json", job)
            return
        try:
            job["child"] = _child_identity(child, job)
        except (OSError, ValueError, RunnerError):
            job["child"] = None
        job["started_at"] = time.time()
        if job["child"] is None or job["child"].get("nonce") != job["nonce"]:
            job["needs_human"] = True
        atomic_json(job_dir / "job.json", job)
    nonce, native_identity, protocol = job["nonce"], job["child"], job["protocol"]
    deadline = time.monotonic() + job["timeout"]
    timed_out = False
    while child.poll() is None:
        with _lock(job_dir):
            job = read_json(job_dir / "job.json")
            if job.get("nonce") != nonce or job.get("child") != native_identity or job.get("protocol") != protocol:
                job["needs_human"] = True
            if time.monotonic() >= deadline and not job.get("stop_requested"):
                timed_out = True
                job["stop_requested"] = {"kind": "timeout", "at": time.time(), "sigint_sent": False}
            control = job.get("stop_requested")
            if control:
                if not control["sigint_sent"] and not job.get("needs_human"):
                    control["sigint_sent"] = _interrupt(native_identity, nonce)
                if not control["sigint_sent"] or time.time() - control["at"] >= SIGINT_GRACE_SECONDS:
                    job["needs_human"] = True
            if control or job.get("needs_human"):
                atomic_json(job_dir / "job.json", job)
        time.sleep(0.05)
    code = child.wait()
    # A native exit alone cannot settle still-running nonce-bearing tool work.
    # Observe it, but never kill a whole process group or unrelated user process.
    cleanup_deadline = time.monotonic() + SIGINT_GRACE_SECONDS
    tracked = {}
    while True:
        for identity in _job_processes(nonce, os.getpid()):
            tracked[(identity["pid"], identity["start_time"])] = identity
        unsettled = [identity for identity in tracked.values() if _probe(identity, nonce) in {"running", "unknown"}]
        with _lock(job_dir):
            job = read_json(job_dir / "job.json")
            job["unsettled"] = unsettled
            if unsettled and time.monotonic() >= cleanup_deadline:
                job["needs_human"] = True
            atomic_json(job_dir / "job.json", job)
        if not unsettled:
            break
        time.sleep(0.1)
    # Only after native wait() and tool settlement: flush logs and durable exit.
    for name in ("stdout.jsonl", "stderr.log"):
        with (job_dir / name).open("rb") as stream:
            os.fsync(stream.fileno())
    with _lock(job_dir):
        job = read_json(job_dir / "job.json")
        atomic_json(job_dir / "exit.json", {
            "nonce": nonce, "protocol": protocol, "child": native_identity, "exit_code": code,
            "settled": True, "finished_at": time.time(), "timed_out": timed_out,
            "stop_requested": bool(job.get("stop_requested")),
            "stdout_sha256": hashlib.sha256((job_dir / "stdout.jsonl").read_bytes()).hexdigest(),
            "stderr_sha256": hashlib.sha256((job_dir / "stderr.log").read_bytes()).hexdigest(),
        })


def main() -> int:
    if len(sys.argv) != 2:
        raise RunnerError("Usage: python -m scripts.mimir_ticket_runner.supervisor <jobdir>")
    _serve(Path(sys.argv[1]).resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
