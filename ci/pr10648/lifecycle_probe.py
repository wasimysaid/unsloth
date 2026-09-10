#!/usr/bin/env python3
"""Real, isolated Unsloth Studio install/update lifecycle probe for PR #10648.

This probe intentionally invokes the shipped installer and installed CLI.  It does
not mock or import installer internals.  Detailed command/server/strace logs stay in
ROOT/private; only the credential-free JSON summary in ROOT/results is upload-safe.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

HEAD_SHA = "b2d65068d7cbc9c5e3a5acf70c2c3600a97eadf7"
BASE_SHA = "191b69c12b4434b5247f1fd7a455b4a760b169ae"
MARKER_NAMES = {
    "UNSLOTH_PREBUILT_INFO.json",
    "UNSLOTH_NODE_PREBUILT_INFO.json",
    "UNSLOTH_WHISPER_PREBUILT_INFO.json",
}
RUNTIME_NAMES = {
    "llama-server", "llama-server.exe", "llama-quantize", "llama-quantize.exe",
    "whisper-server", "whisper-server.exe", "node", "node.exe", "npm", "npm.cmd",
    "bun", "bun.exe",
}
SECRET_NAME = re.compile(
    r"(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|AUTH|COOKIE|CREDENTIAL|AWS_|AZURE_|GCP_|GOOGLE_APPLICATION|SSH_|NETRC|GH_|GITHUB_TOKEN|CI_JOB_JWT)",
    re.IGNORECASE,
)


def status(phase: str, outcome: str, detail: str = "") -> None:
    # Only fixed labels and caller-generated non-secret detail reach the public log.
    suffix = f" ({detail})" if detail else ""
    print(f"PR10648 {phase}: {outcome}{suffix}", flush=True)


def redact_text(text: str, private_values: tuple[str, ...] = ()) -> str:
    """Bound and redact text before placing it in a public summary or console."""
    cleaned = text.replace("\r", "")
    for value in sorted((v for v in private_values if len(v) > 3), key=len, reverse=True):
        cleaned = cleaned.replace(value, "<isolated-path>")
    cleaned = re.sub(r"(https?://)[^/@\s]+@", r"\1<redacted>@", cleaned)
    cleaned = re.sub(r"([?&][^=\s&]+)=[^&#\s]+", r"\1=<redacted>", cleaned)
    cleaned = re.sub(r"\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}(?:\.[A-Za-z0-9_-]{8,})?\b", "<redacted-jwt>", cleaned)
    return cleaned[:1000]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def git_sha(repo: Path) -> str:
    return subprocess.check_output(
        ["git", "-C", str(repo), "rev-parse", "HEAD"], text=True, stderr=subprocess.DEVNULL
    ).strip()


def mask_system_node(root: Path) -> None:
    """Expose real host tools except Node/npm, without altering the host installation."""
    tools = root / "tool-path"
    tools.mkdir()
    excluded = {"node", "nodejs", "npm", "npx", "bun", "bunx", "corepack"}
    for directory in os.environ.get("PATH", "").split(os.pathsep):
        source = Path(directory)
        if not source.is_dir():
            continue
        for candidate in source.iterdir():
            target = tools / candidate.name
            if candidate.name in excluded or target.exists() or target.is_symlink():
                continue
            if candidate.is_file() and os.access(candidate, os.X_OK):
                target.symlink_to(candidate.resolve())



def safe_environment(root: Path, studio_home: Path) -> dict[str, str]:
    """Minimal inherited environment with credential-bearing names removed."""
    env: dict[str, str] = {}
    allow = {
        "PATH", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "SYSTEMROOT",
        "WINDIR", "COMSPEC", "PATHEXT", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS",
        "TMP", "TEMP",
    }
    for key, value in os.environ.items():
        if key in allow and not SECRET_NAME.search(key):
            env[key] = value
    os_home = root / "os-home"
    cache = root / "cache"
    temp = root / "tmp"
    for path in (os_home, cache, temp, root / "config", root / "data", root / "hf"):
        path.mkdir(parents=True, exist_ok=True)
    env.update(
        {
            "HOME": str(os_home),
            "USERPROFILE": str(os_home),
            "UNSLOTH_STUDIO_HOME": str(studio_home),
            "STUDIO_HOME": "",
            "UNSLOTH_SKIP_AUTOSTART": "1",
            "UNSLOTH_NO_TORCH": "1",
            "UNSLOTH_LLAMA_CPP_BACKEND": "cpu",
            "CUDA_VISIBLE_DEVICES": "",
            "XDG_CONFIG_HOME": str(root / "config"),
            "XDG_DATA_HOME": str(root / "data"),
            "XDG_CACHE_HOME": str(cache / "xdg"),
            "UV_CACHE_DIR": str(cache / "uv"),
            "HF_HOME": str(root / "hf"),
            "HF_HUB_CACHE": str(root / "hf" / "hub"),
            "HF_XET_CACHE": str(root / "hf" / "xet"),
            "HUGGINGFACE_HUB_CACHE": str(root / "hf" / "hub"),
            "TMPDIR": str(temp),
            "TMP": str(temp),
            "TEMP": str(temp),
            "NO_COLOR": "1",
            "PYTHONUNBUFFERED": "1",
        }
    )
    if (root / "tool-path").is_dir():
        env["PATH"] = str(root / "tool-path")
    return env


def run_logged(
    argv: list[str], *, cwd: Path, env: dict[str, str], log: Path, timeout: int,
    trace: Path | None = None,
) -> dict[str, Any]:
    wrapped = argv
    traced = False
    if trace is not None and platform.system() == "Linux" and shutil.which("strace"):
        wrapped = ["strace", "-f", "-qq", "-e", "trace=network", "-o", str(trace), "--", *argv]
        traced = True
    started = time.monotonic()
    with log.open("wb") as output:
        proc = subprocess.run(wrapped, cwd=cwd, env=env, stdout=output, stderr=subprocess.STDOUT, timeout=timeout)
    result: dict[str, Any] = {
        "exit_code": proc.returncode,
        "seconds": round(time.monotonic() - started, 3),
        "network": network_summary(trace) if traced and trace is not None else {"instrumentation": "unavailable"},
    }
    if proc.returncode:
        raise RuntimeError(f"command failed with exit {proc.returncode}; inspect the private phase log")
    return result


def network_summary(trace: Path) -> dict[str, Any]:
    """Best-effort external syscall evidence; values are kernel-reported transfer counts."""
    sent = received = calls = 0
    try:
        for line in trace.read_text(encoding="utf-8", errors="replace").splitlines():
            match = re.search(r"\b(send(?:to|msg)?|recv(?:from|msg)?)\(.*\)\s+=\s+(-?\d+)", line)
            if not match:
                continue
            calls += 1
            amount = max(0, int(match.group(2)))
            if match.group(1).startswith("send"):
                sent += amount
            else:
                received += amount
    except OSError:
        return {"instrumentation": "strace", "read_error": True}
    return {
        "instrumentation": "strace-network-syscalls",
        "successful_transfer_calls": calls,
        "bytes_sent_lower_bound": sent,
        "bytes_received_lower_bound": received,
        "note": "TLS/socket syscall payload counts; not wire bytes and may omit non-send/recv I/O",
    }


def cli_path(studio_home: Path) -> Path:
    if os.name == "nt":
        for candidate in (studio_home / "unsloth_studio" / "Scripts" / "unsloth.exe", studio_home / "bin" / "unsloth.cmd"):
            if candidate.is_file():
                return candidate
    else:
        candidate = studio_home / "unsloth_studio" / "bin" / "unsloth"
        if candidate.is_file():
            return candidate
    raise RuntimeError("installed CLI was not found below the isolated Studio home")


def command_for_cli(cli: Path, *args: str) -> list[str]:
    if os.name == "nt" and cli.suffix.lower() == ".cmd":
        return [os.environ.get("COMSPEC", "cmd.exe"), "/d", "/s", "/c", str(cli), *args]
    return [str(cli), *args]


def short_version(argv: list[str], env: dict[str, str], cwd: Path, accept_nonzero: bool = False) -> dict[str, Any]:
    try:
        proc = subprocess.run(argv, cwd=cwd, env=env, capture_output=True, text=True, timeout=60)
        raw = (proc.stdout + "\n" + proc.stderr).strip()
        private_values = tuple(
            value
            for key, value in env.items()
            if key in {"HOME", "USERPROFILE", "UNSLOTH_STUDIO_HOME", "TMPDIR", "TMP", "TEMP"}
        )
        text = redact_text("\n".join(raw.splitlines()[:8]), private_values)
        if proc.returncode and not accept_nonzero:
            text = f"exit {proc.returncode}: {text}"
        return {"exit_code": proc.returncode, "output": text}
    except (OSError, subprocess.SubprocessError) as exc:
        return {"error": type(exc).__name__}


def inventory(studio_home: Path, env: dict[str, str]) -> dict[str, Any]:
    markers: dict[str, Any] = {}
    binaries: dict[str, Any] = {}
    if not studio_home.exists():
        return {"markers": markers, "runtime_binaries": binaries}
    for path in sorted(studio_home.rglob("*")):
        if not path.is_file() or path.is_symlink():
            continue
        rel = path.relative_to(studio_home).as_posix()
        if path.name in MARKER_NAMES:
            entry: dict[str, Any] = {"sha256": sha256(path), "size": path.stat().st_size}
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
                # Marker values are release metadata, but retain only fields needed for lifecycle evidence.
                keys = (
                    "schema_version", "component", "release_tag", "upstream_tag", "source_commit",
                    "backend", "install_kind", "ggml_tree", "paired_llama_tag",
                    "paired_llama_ggml_tree", "runtime_wiring_version",
                )
                entry["fields"] = {key: payload[key] for key in keys if key in payload and isinstance(payload[key], (str, int, bool, type(None)))}
                entry["evidence_fields"] = {
                    key: bool(payload.get(key))
                    for key in ("runtime_files", "host_profile", "node_binary", "node_version_checked", "paired_llama_ggml_tree")
                }
            except (OSError, ValueError):
                entry["json_valid"] = False
            markers[rel] = entry
        if path.name in RUNTIME_NAMES and (os.access(path, os.X_OK) or path.suffix.lower() in {".exe", ".cmd"}):
            version_argv = [str(path), "--version"]
            if os.name == "nt" and path.suffix.lower() == ".cmd":
                version_argv = [env.get("COMSPEC", "cmd.exe"), "/d", "/s", "/c", str(path), "--version"]
            binaries[rel] = {
                "sha256": sha256(path),
                "size": path.stat().st_size,
                "version": short_version(version_argv, env, studio_home, accept_nonzero="quantize" in path.name),
            }
    return {"markers": markers, "runtime_binaries": binaries}


def binary_hashes(snapshot: dict[str, Any]) -> dict[str, str]:
    return {name: data["sha256"] for name, data in snapshot["runtime_binaries"].items()}


def marker_has_pair(snapshot: dict[str, Any]) -> bool | None:
    whisper = [v for k, v in snapshot["markers"].items() if k.endswith("UNSLOTH_WHISPER_PREBUILT_INFO.json")]
    slim = [v for v in whisper if v.get("fields", {}).get("install_kind") == "slim"]
    if not slim:
        return None
    return all(bool(v.get("fields", {}).get("paired_llama_ggml_tree")) for v in slim)


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def http_json(url: str, *, payload: dict[str, str] | None = None, timeout: float = 5) -> tuple[int, Any]:
    data = json.dumps(payload).encode() if payload is not None else None
    headers = {"Content-Type": "application/json"} if data is not None else {}
    request = urllib.request.Request(url, data=data, headers=headers, method="POST" if data is not None else "GET")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = response.read(1024 * 1024)
        try:
            decoded = json.loads(body)
        except ValueError:
            decoded = None
        return response.status, decoded


def launch_health_auth(cli: Path, studio_home: Path, env: dict[str, str], private: Path, label: str) -> dict[str, Any]:
    port = free_port()
    log = private / f"studio-{label}.log"
    argv = command_for_cli(cli, "studio", "-H", "127.0.0.1", "-p", str(port))
    with log.open("wb") as output:
        proc = subprocess.Popen(
            argv, cwd=studio_home, env=env, stdout=output, stderr=subprocess.STDOUT,
            start_new_session=(os.name != "nt"), creationflags=(subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0),
        )
    try:
        health_path = None
        health_deadline = time.monotonic() + 180
        while time.monotonic() < health_deadline:
            if proc.poll() is not None:
                raise RuntimeError(f"Studio exited before health ({proc.returncode}); private log: {log}")
            for path in ("/healthz", "/api/health"):
                try:
                    code, _ = http_json(f"http://127.0.0.1:{port}{path}")
                    if code == 200:
                        health_path = path
                        break
                except (OSError, urllib.error.URLError, TimeoutError):
                    pass
            if health_path:
                break
            time.sleep(1)
        if not health_path:
            raise RuntimeError(f"Studio health timeout; private log: {log}")

        password_file = studio_home / "auth" / ".bootstrap_password"
        password_deadline = time.monotonic() + 120
        while time.monotonic() < password_deadline and not password_file.is_file():
            if proc.poll() is not None:
                raise RuntimeError(f"Studio exited before auth bootstrap; private log: {log}")
            time.sleep(0.5)
        if not password_file.is_file():
            raise RuntimeError("bootstrap password file did not appear")
        password = password_file.read_text(encoding="utf-8").strip()
        if not password:
            raise RuntimeError("bootstrap password file was empty")
        code, response = http_json(
            f"http://127.0.0.1:{port}/api/auth/login",
            payload={"username": "unsloth", "password": password}, timeout=15,
        )
        # Do not retain, inspect, or serialize token values.
        token_keys = set(response) if isinstance(response, dict) else set()
        auth_ok = code == 200 and bool(token_keys & {"access_token", "token"})
        if not auth_ok:
            raise RuntimeError(f"Studio login did not return an access token (HTTP {code})")
        return {"health": True, "health_path": health_path, "auth": True, "pid_owned": True}
    finally:
        if proc.poll() is None:
            if os.name == "nt":
                proc.terminate()
            else:
                try:
                    os.killpg(proc.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            try:
                proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                if os.name == "nt":
                    proc.kill()
                else:
                    try:
                        os.killpg(proc.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                proc.wait(timeout=10)


def write_summary(path: Path, summary: dict[str, Any]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--head-dir", required=True, type=Path)
    parser.add_argument("--base-dir", required=True, type=Path)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--scenario", required=True, choices=("fresh", "upgrade"))
    parser.add_argument("--mask-system-node", action="store_true")
    args = parser.parse_args()

    head = args.head_dir.expanduser().resolve(strict=True)
    base = args.base_dir.expanduser().resolve(strict=True)
    root = args.root.expanduser().resolve()
    if root.exists() and any(root.iterdir()):
        raise SystemExit(f"--root must be absent or empty: {root}")
    private = root / "private"
    results = root / "results"
    private.mkdir(parents=True, mode=0o700)
    results.mkdir(parents=True)
    try:
        os.chmod(private, 0o700)
    except OSError:
        pass
    studio_home = root / "studio-home"
    if args.mask_system_node:
        mask_system_node(root)
    env = safe_environment(root, studio_home)
    initial = head if args.scenario == "fresh" else base
    expected = HEAD_SHA if initial == head else BASE_SHA
    actual_head, actual_base, actual_initial = git_sha(head), git_sha(base), git_sha(initial)
    if actual_head != HEAD_SHA or actual_base != BASE_SHA or actual_initial != expected:
        raise SystemExit("pinned checkout SHA mismatch")

    summary: dict[str, Any] = {
        "schema": 1,
        "scenario": args.scenario,
        "platform": {"system": platform.system(), "machine": platform.machine(), "python": platform.python_version()},
        "refs": {"head": actual_head, "base": actual_base, "initial": actual_initial},
        "isolation": {"credential_env_removed": True, "cuda_visible_devices": "", "llama_backend": "cpu", "autostart_disabled": True},
        "phases": {},
        "assertions": {},
    }
    summary_path = results / f"pr10648-{args.scenario}-{platform.system().lower()}.json"
    sentinel = studio_home / "app-data" / "pr10648-lifecycle-sentinel.json"

    try:
        status("install", "START", args.scenario)
        if os.name == "nt":
            install_argv = ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(initial / "install.ps1"), "--local", "--no-torch", "--skip-autostart"]
        else:
            install_argv = ["bash", str(initial / "install.sh"), "--local", "--no-torch"]
        summary["phases"]["install"] = run_logged(
            install_argv, cwd=initial, env=env, log=private / "install.log", timeout=3600,
            trace=private / "install.strace",
        )
        cli = cli_path(studio_home)
        summary["phases"]["installed_cli_version"] = short_version(command_for_cli(cli, "--version"), env, studio_home)
        before = inventory(studio_home, env)
        summary["phases"]["inventory_initial"] = before
        if not before["runtime_binaries"]:
            raise RuntimeError("initial install produced no inventoried runtime binaries")
        sentinel.parent.mkdir(parents=True, exist_ok=True)
        sentinel_payload = {"purpose": "PR10648 lifecycle retention", "value": "retain-across-update"}
        sentinel.write_text(json.dumps(sentinel_payload) + "\n", encoding="utf-8")
        summary["phases"]["live_before"] = launch_health_auth(cli, studio_home, env, private, "before")
        status("install", "PASS")

        env["STUDIO_LOCAL_REPO"] = str(head)
        update_argv = command_for_cli(cli, "studio", "update", "--local", "--verbose")
        status("update-1", "START")
        summary["phases"]["update_1"] = run_logged(
            update_argv, cwd=head, env=env, log=private / "update-1.log", timeout=3600,
            trace=private / "update-1.strace",
        )
        after_update = inventory(studio_home, env)
        summary["phases"]["inventory_after_update"] = after_update
        summary["phases"]["updated_cli_version"] = short_version(command_for_cli(cli_path(studio_home), "--version"), env, studio_home)
        summary["assertions"]["sentinel_retained_after_update"] = sentinel.is_file() and json.loads(sentinel.read_text()) == sentinel_payload
        if not summary["assertions"]["sentinel_retained_after_update"]:
            raise RuntimeError("safe app-data sentinel was not retained")
        if args.scenario == "upgrade":
            pair = marker_has_pair(after_update)
            summary["assertions"]["slim_whisper_pair_marker_migrated"] = pair
            if pair is False:
                raise RuntimeError("slim whisper marker did not gain paired_llama_ggml_tree")
        status("update-1", "PASS")

        status("no-op-update", "START")
        summary["phases"]["no_op_update"] = run_logged(
            update_argv, cwd=head, env=env, log=private / "update-noop.log", timeout=3600,
            trace=private / "update-noop.strace",
        )
        after_noop = inventory(studio_home, env)
        summary["phases"]["inventory_after_noop"] = after_noop
        unchanged = binary_hashes(after_update) == binary_hashes(after_noop)
        summary["assertions"]["noop_runtime_binary_hashes_unchanged"] = unchanged
        if not unchanged:
            raise RuntimeError("repeated no-op update changed runtime binary inventory/hash")
        status("no-op-update", "PASS")

        if args.scenario == "upgrade":
            quantizers = [studio_home / rel for rel in after_noop["runtime_binaries"] if Path(rel).name.lower() in {"llama-quantize", "llama-quantize.exe"}]
            if len(quantizers) != 1:
                raise RuntimeError(f"expected exactly one inventoried llama-quantize, found {len(quantizers)}")
            quantize = quantizers[0]
            expected_hash = sha256(quantize)
            with quantize.open("wb"):
                pass
            summary["assertions"]["damage_truncation_observed"] = quantize.stat().st_size == 0
            status("repair-update", "START")
            summary["phases"]["repair_update"] = run_logged(
                update_argv, cwd=head, env=env, log=private / "update-repair.log", timeout=3600,
                trace=private / "update-repair.strace",
            )
            repaired = quantize.is_file() and quantize.stat().st_size > 0 and sha256(quantize) == expected_hash
            summary["assertions"]["truncated_quantize_repaired_exact_hash"] = repaired
            if not repaired:
                raise RuntimeError("actual update did not restore truncated llama-quantize to its prior hash")
            summary["phases"]["inventory_after_repair"] = inventory(studio_home, env)
            status("repair-update", "PASS")

        summary["phases"]["live_after"] = launch_health_auth(cli_path(studio_home), studio_home, env, private, "after")
        summary["assertions"]["sentinel_retained_final"] = sentinel.is_file() and json.loads(sentinel.read_text()) == sentinel_payload
        if not summary["assertions"]["sentinel_retained_final"]:
            raise RuntimeError("safe app-data sentinel was not retained through final launch")
        summary["result"] = "PASS"
        status("scenario", "PASS", args.scenario)
        write_summary(summary_path, summary)
        return 0
    except Exception as exc:
        summary["result"] = "FAIL"
        safe_message = redact_text(
            str(exc),
            (str(root), str(private), str(studio_home), str(head), str(base)),
        )
        summary["failure"] = {"type": type(exc).__name__, "message": safe_message}
        write_summary(summary_path, summary)
        status("scenario", "FAIL", args.scenario)
        print(f"Safe failure detail: {type(exc).__name__}: {safe_message}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
