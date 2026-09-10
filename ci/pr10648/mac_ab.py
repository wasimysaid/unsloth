#!/usr/bin/env python3
"""Real macOS A/B Studio update benchmark and base-to-head migration probe.

A is the exact base and B is the exact head. Detailed subprocess/server output is
private; stdout and the public summary contain only phase status, timings, versions,
hashes, release metadata, and boolean assertions.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import platform
import re
import shutil
import signal
import socket
import statistics
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

BASE_SHA = "191b69c12b4434b5247f1fd7a455b4a760b169ae"
HEAD_SHA = "b2d65068d7cbc9c5e3a5acf70c2c3600a97eadf7"
MARKER_PATHS = {
    "llama.cpp/UNSLOTH_PREBUILT_INFO.json": "llama",
    "node/UNSLOTH_NODE_PREBUILT_INFO.json": "node",
    "whisper.cpp/UNSLOTH_WHISPER_PREBUILT_INFO.json": "whisper",
}
BINARY_PATHS = {
    "llama.cpp/build/bin/llama-server",
    "llama.cpp/build/bin/llama-quantize",
    "whisper.cpp/build/bin/whisper-server",
    "node/bin/node",
}
SECRET_ENV = re.compile(r"TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|AUTH|COOKIE|CREDENTIAL|AWS_|AZURE_|GCP_|SSH_|NETRC|GH_", re.I)


def emit(phase: str, outcome: str, seconds: float | None = None) -> None:
    suffix = f" {seconds:.3f}s" if seconds is not None else ""
    print(f"PR10648 mac-ab {phase}: {outcome}{suffix}", flush=True)


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def git_sha(path: Path) -> str:
    return subprocess.check_output(["git", "-C", str(path), "rev-parse", "HEAD"], text=True, stderr=subprocess.DEVNULL).strip()


def benchmark_order(repetitions: int) -> list[list[str]]:
    return [["A", "B"] if index % 2 == 0 else ["B", "A"] for index in range(repetitions)]


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def stop_group(process: subprocess.Popen[Any]) -> None:
    if process.poll() is not None:
        return
    for sig, wait in ((signal.SIGTERM, 15), (signal.SIGKILL, 5)):
        try:
            os.killpg(process.pid, sig)
        except ProcessLookupError:
            return
        try:
            process.wait(timeout=wait)
            return
        except subprocess.TimeoutExpired:
            pass


def run(argv: list[str], *, cwd: Path, env: dict[str, str], log: Path, timeout: int = 3600) -> float:
    started = time.monotonic()
    with log.open("wb") as output:
        process = subprocess.Popen(argv, cwd=cwd, env=env, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            stop_group(process)
            raise RuntimeError("owned command timed out; inspect private log") from None
    elapsed = round(time.monotonic() - started, 3)
    if code:
        raise RuntimeError(f"owned command exited {code}; inspect private log")
    return elapsed


def diagnostic_excerpt(log: Path) -> list[str]:
    """Return only bounded native-runtime/download status lines safe for artifacts."""
    allowed = re.compile(r"llama\.cpp|whisper\.cpp|\bnode\b|prebuilt|already matches|nothing to do|download", re.I)
    forbidden = re.compile(r"password|credential|authorization|bearer|jwt|token", re.I)
    ansi = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
    lines: list[str] = []
    try:
        source = log.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return lines
    for raw in source:
        line = ansi.sub("", raw).strip()
        if not allowed.search(line):
            continue
        line = re.sub(r"https?://\S+", "<url>", line)
        line = re.sub(r"/(?:Users|private|tmp)/\S+", "<isolated-path>", line)
        if forbidden.search(line):
            continue
        lines.append(line[:300])
        if len(lines) == 30:
            break
    return lines


def audit_summary(path: Path) -> dict[str, Any]:
    counts: dict[str, int] = {}
    urllib_hosts: dict[str, int] = {}
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        lines = []
    for line in lines:
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if event.get("kind") == "native_subprocess":
            key = f"{event.get('binary', 'unknown')}:{event.get('probe', 'unknown')}"
            counts[key] = counts.get(key, 0) + 1
        elif event.get("kind") == "urllib_request":
            host = str(event.get("hostname", "<invalid-host>"))
            urllib_hosts[host] = urllib_hosts.get(host, 0) + 1
    return {
        "native_probe_counts": dict(sorted(counts.items())),
        "native_probe_total": sum(counts.values()),
        "urllib_host_counts": dict(sorted(urllib_hosts.items())),
    }



def native_probe_total(audits: list[dict[str, Any]], prefix: str) -> int:
    return sum(
        count
        for audit in audits
        for key, count in audit["native_probe_counts"].items()
        if key.startswith(prefix)
    )


def audit_environment(env: dict[str, str], audit_file: Path) -> dict[str, str]:
    observed = dict(env)
    audit_dir = Path(__file__).with_name("audit").resolve()
    observed["PYTHONPATH"] = str(audit_dir)
    observed["PR10648_AUDIT_FILE"] = str(audit_file)
    return observed


def release_inventory(snapshot: dict[str, Any]) -> dict[str, Any]:
    return {
        name: {key: marker.get(key) for key in ("release", "upstream_tag", "backend", "install_kind")}
        for name, marker in sorted(snapshot["markers"].items())
    }


def isolated_node_proven(snapshot: dict[str, Any]) -> bool:
    binaries = snapshot["binaries"]
    return "node" in snapshot["markers"] and any(name == "node/bin/node" or name.endswith("/node/bin/node") for name in binaries)


def expected_native_binaries_present(snapshot: dict[str, Any]) -> bool:
    present = {Path(name).name for name in snapshot["binaries"]}
    return {"llama-server", "llama-quantize", "whisper-server", "node"}.issubset(present)


def isolated_environment(side_root: Path, studio_home: Path) -> dict[str, str]:
    allowed = {"PATH", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM"}
    env = {key: value for key, value in os.environ.items() if key in allowed and not SECRET_ENV.search(key)}
    homes = {
        "HOME": side_root / "os-home",
        "XDG_CONFIG_HOME": side_root / "config",
        "XDG_DATA_HOME": side_root / "data",
        "XDG_CACHE_HOME": side_root / "cache" / "xdg",
        "UV_CACHE_DIR": side_root / "cache" / "uv",
        "HF_HOME": side_root / "cache" / "hf",
        "HF_HUB_CACHE": side_root / "cache" / "hf" / "hub",
        "HF_XET_CACHE": side_root / "cache" / "hf" / "xet",
        "TMPDIR": side_root / "tmp",
    }
    for path in homes.values():
        path.mkdir(parents=True, exist_ok=True)
    env.update({key: str(value) for key, value in homes.items()})
    env.update({
        "UNSLOTH_STUDIO_HOME": str(studio_home),
        "UNSLOTH_SKIP_AUTOSTART": "1",
        "UNSLOTH_NO_TORCH": "1",
        "NO_COLOR": "1",
        "PYTHONUNBUFFERED": "1",
    })
    # Deliberately absent: macOS must take native Metal (Apple silicon) or CPU (Intel).
    env.pop("UNSLOTH_LLAMA_CPP_BACKEND", None)
    env.pop("CUDA_VISIBLE_DEVICES", None)
    return env


def add_node_mask(env: dict[str, str], side_root: Path) -> None:
    """Shadow only system node/npm probes; preserve real macOS python/git argv behavior."""
    tools = side_root / "node-mask"
    tools.mkdir()
    for name in ("node", "npm"):
        script = tools / name
        script.write_text("#!/bin/sh\nexit 127\n", encoding="utf-8")
        script.chmod(0o755)
    env["PATH"] = str(tools) + os.pathsep + env.get("PATH", "/usr/bin:/bin")


def cli(studio_home: Path) -> Path:
    path = studio_home / "unsloth_studio" / "bin" / "unsloth"
    if not path.is_file():
        raise RuntimeError("installed CLI absent")
    return path


def update_argv(studio_home: Path) -> list[str]:
    return [str(cli(studio_home)), "studio", "update", "--local", "--verbose"]


def safe_output(argv: list[str], env: dict[str, str], cwd: Path, *, accepted: set[int] = {0}) -> dict[str, Any]:
    try:
        result = subprocess.run(argv, cwd=cwd, env=env, capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.SubprocessError) as exc:
        return {"ok": False, "error": type(exc).__name__}
    text = (result.stdout + "\n" + result.stderr).replace("\r", "").strip()
    for private in (env.get("HOME", ""), env.get("UNSLOTH_STUDIO_HOME", ""), str(cwd)):
        if private:
            text = text.replace(private, "<isolated-path>")
    return {"ok": result.returncode in accepted and bool(text), "exit_code": result.returncode, "output": "\n".join(text.splitlines()[:6])[:800]}


def installed_dependencies(studio_home: Path, env: dict[str, str]) -> list[dict[str, str]]:
    python = studio_home / "unsloth_studio" / "bin" / "python"
    code = "import importlib.metadata as m,json;print(json.dumps(sorted([{'name':d.metadata.get('Name',''),'version':d.version} for d in m.distributions()],key=lambda x:x['name'].lower())))"
    result = subprocess.run([str(python), "-I", "-c", code], env=env, capture_output=True, text=True, timeout=60, check=True)
    data = json.loads(result.stdout)
    return data if isinstance(data, list) else []


def inventory(studio_home: Path, env: dict[str, str]) -> dict[str, Any]:
    markers: dict[str, Any] = {}
    binaries: dict[str, Any] = {}
    runtime_payload: dict[str, str] = {}
    for path in sorted(studio_home.rglob("*")):
        if not path.is_file() or path.is_symlink():
            continue
        relative = path.relative_to(studio_home).as_posix()
        if (relative.startswith(("llama.cpp/", "whisper.cpp/")) and path.name.endswith(".dylib")) or relative.startswith("node/lib/node_modules/npm/"):
            runtime_payload[relative] = digest(path)
        component = MARKER_PATHS.get(relative)
        if component:
            payload = json.loads(path.read_text(encoding="utf-8"))
            markers[component] = {
                "path": relative,
                "sha256": digest(path),
                "release": payload.get("release_tag") or payload.get("version"),
                "upstream_tag": payload.get("upstream_tag") or payload.get("tag"),
                "backend": payload.get("backend"),
                "install_kind": payload.get("install_kind"),
                "new_evidence": {
                    "runtime_files": bool(payload.get("runtime_files")),
                    "host_profile": bool(payload.get("host_profile")),
                    "node_binary": bool(payload.get("node_binary")),
                    "node_version_checked": bool(payload.get("node_version_checked")),
                    "npm_cli": bool(payload.get("npm_cli")),
                    "npm_major_checked": payload.get("npm_major_checked") is not None,
                    "paired_llama_ggml_tree": bool(payload.get("paired_llama_ggml_tree")),
                },
            }
        if relative in BINARY_PATHS and os.access(path, os.X_OK):
            accepted = {0, 1} if path.name == "llama-quantize" else {0}
            argument = "--version" if path.name in {"node", "npm", "llama-quantize"} else "--help"
            binaries[relative] = {
                "sha256": digest(path),
                "size": path.stat().st_size,
                "loader_check": safe_output([str(path), argument], env, studio_home, accepted=accepted),
            }
    return {"markers": markers, "binaries": binaries, "runtime_payload": runtime_payload, "dependencies": installed_dependencies(studio_home, env)}


def hashes(snapshot: dict[str, Any]) -> dict[str, str]:
    return {
        **{name: data["sha256"] for name, data in snapshot["binaries"].items()},
        **{f"payload:{name}": value for name, value in snapshot.get("runtime_payload", {}).items()},
    }


def marker_evidence(snapshot: dict[str, Any]) -> dict[str, bool]:
    markers = snapshot["markers"]
    llama = markers.get("llama", {}).get("new_evidence", {})
    node = markers.get("node", {}).get("new_evidence", {})
    whisper = markers.get("whisper", {})
    whisper_fields = whisper.get("new_evidence", {})
    return {
        "llama_runtime_integrity": bool(llama.get("runtime_files") and llama.get("host_profile")),
        "node_runtime_integrity": bool(node.get("node_binary") and node.get("node_version_checked") and node.get("npm_cli") and node.get("npm_major_checked")),
        "whisper_runtime_pairing": bool(whisper) and (
            whisper.get("install_kind") != "slim"
            or bool(whisper_fields.get("paired_llama_ggml_tree"))
        ),
    }


def auth_request(url: str, payload: dict[str, str] | None = None) -> tuple[int, Any]:
    body = json.dumps(payload).encode() if payload else None
    request = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"} if body else {}, method="POST" if body else "GET")
    with urllib.request.urlopen(request, timeout=5) as response:
        raw = response.read(1024 * 1024)
        try:
            return response.status, json.loads(raw)
        except ValueError:
            return response.status, None


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def live_check(studio_home: Path, env: dict[str, str], log: Path, expected_password: str | None = None) -> tuple[dict[str, bool], str]:
    port = free_port()
    with log.open("wb") as output:
        process = subprocess.Popen([str(cli(studio_home)), "studio", "-H", "127.0.0.1", "-p", str(port)], cwd=studio_home, env=env, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
    try:
        health = False
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline and process.poll() is None:
            for endpoint in ("/healthz", "/api/health"):
                try:
                    if auth_request(f"http://127.0.0.1:{port}{endpoint}")[0] == 200:
                        health = True
                        break
                except (OSError, urllib.error.URLError):
                    pass
            if health:
                break
            time.sleep(1)
        if not health:
            raise RuntimeError("Studio health failed; inspect private server log")
        password_file = studio_home / "auth" / ".bootstrap_password"
        deadline = time.monotonic() + 120
        while not password_file.is_file() and time.monotonic() < deadline:
            time.sleep(0.25)
        password = password_file.read_text(encoding="utf-8").strip()
        if not password:
            raise RuntimeError("bootstrap credential unavailable")
        code, response = auth_request(f"http://127.0.0.1:{port}/api/auth/login", {"username": "unsloth", "password": password})
        authenticated = code == 200 and isinstance(response, dict) and bool(response.get("access_token"))
        if not authenticated:
            raise RuntimeError("Studio authentication failed")
        persisted = expected_password is None or hmac.compare_digest(password, expected_password)
        return {"health": True, "auth": True, "auth_credential_persisted": persisted}, password
    finally:
        stop_group(process)


def new_summary(base: Path, head: Path, repetitions: int) -> dict[str, Any]:
    return {
        "schema": 1,
        "result": "INCOMPLETE",
        "refs": {"base": git_sha(base), "head": git_sha(head)},
        "platform": {"system": platform.system(), "machine": platform.machine(), "version": platform.mac_ver()[0]},
        "repetitions": repetitions,
        "benchmark_order": benchmark_order(repetitions),
        "sides": {"A": {"implementation": "base", "samples_seconds": []}, "B": {"implementation": "head", "samples_seconds": []}},
        "migration": {},
        "assertions": {},
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-dir", required=True, type=Path)
    parser.add_argument("--head-dir", required=True, type=Path)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--repetitions", type=int, default=3)
    args = parser.parse_args()
    if platform.system() != "Darwin":
        raise SystemExit("mac_ab.py must run on macOS")
    if args.repetitions < 1:
        raise SystemExit("--repetitions must be >= 1")
    base, head = args.base_dir.resolve(strict=True), args.head_dir.resolve(strict=True)
    root = args.root.resolve()
    if root.exists() and any(root.iterdir()):
        raise SystemExit("--root must be absent or empty")
    root.mkdir(parents=True, exist_ok=True)
    private, results = root / "private", root / "results"
    private.mkdir(mode=0o700); results.mkdir()
    summary_path = results / "pr10648-macos-ab.json"
    summary = new_summary(base, head, args.repetitions)
    write_json(summary_path, summary)
    if summary["refs"] != {"base": BASE_SHA, "head": HEAD_SHA}:
        raise SystemExit("pinned checkout mismatch")
    python312 = shutil.which("python3.12")
    if not python312:
        raise SystemExit("python3.12 is required")

    states: dict[str, dict[str, Any]] = {}
    try:
        for name, source in (("A", base), ("B", head)):
            side_root = root / name
            studio_home = side_root / "studio-home"
            env = isolated_environment(side_root, studio_home)
            add_node_mask(env, side_root)
            states[name] = {"source": source, "home": studio_home, "env": env}
            emit(f"{name}-install", "START")
            seconds = run(["bash", str(source / "install.sh"), "--local", "--no-torch", "--python", python312], cwd=source, env=env, log=private / f"{name}-install.log")
            summary["sides"][name]["install_seconds"] = seconds
            summary["sides"][name]["native_routing"] = "default-metal-apple-silicon-or-cpu-intel"
            summary["sides"][name]["backend_override_absent"] = "UNSLOTH_LLAMA_CPP_BACKEND" not in env
            sentinel = studio_home / "app-data" / "mac-ab-sentinel.json"
            sentinel.parent.mkdir(parents=True, exist_ok=True)
            sentinel.write_text('{"retain":true}\n', encoding="utf-8")
            states[name]["sentinel"] = sentinel
            live, password = live_check(studio_home, env, private / f"{name}-server-after-install.log")
            states[name]["password"] = password
            summary["sides"][name]["live_after_install"] = live
            env["STUDIO_LOCAL_REPO"] = str(source)
            settle = run(update_argv(studio_home), cwd=source, env=env, log=private / f"{name}-settle.log")
            summary["sides"][name]["settle_seconds"] = settle

            summary["sides"][name]["settle_excerpt"] = diagnostic_excerpt(private / f"{name}-settle.log")
            summary["sides"][name]["inventory_after_settle"] = inventory(studio_home, env)
            emit(f"{name}-install", "PASS", seconds)
            write_json(summary_path, summary)

        baseline_hashes = {name: hashes(summary["sides"][name]["inventory_after_settle"]) for name in ("A", "B")}
        for name in ("A", "B"):
            summary["sides"][name]["sample_audits"] = []
            summary["sides"][name]["sample_excerpts"] = []
        for round_index, order in enumerate(summary["benchmark_order"], 1):
            for name in order:
                state = states[name]
                update_log = private / f"benchmark-{round_index}-{name}.log"
                audit_file = private / f"benchmark-{round_index}-{name}-audit.jsonl"
                measured_env = audit_environment(state["env"], audit_file)
                elapsed = run(update_argv(state["home"]), cwd=state["source"], env=measured_env, log=update_log)
                summary["sides"][name]["samples_seconds"].append(elapsed)
                summary["sides"][name]["sample_audits"].append(audit_summary(audit_file))
                summary["sides"][name]["sample_excerpts"].append(diagnostic_excerpt(update_log))
                emit(f"benchmark-{round_index}-{name}", "PASS", elapsed)
                write_json(summary_path, summary)
        final_snapshots: dict[str, dict[str, Any]] = {}
        for name in ("A", "B"):
            state = states[name]
            final = inventory(state["home"], state["env"])
            final_snapshots[name] = final
            summary["sides"][name]["inventory_after_benchmark"] = final
            summary["sides"][name]["median_seconds"] = round(statistics.median(summary["sides"][name]["samples_seconds"]), 3)
            summary["assertions"][f"{name}_noop_binary_hashes_unchanged"] = hashes(final) == baseline_hashes[name]

        releases_equal = release_inventory(final_snapshots["A"]) == release_inventory(final_snapshots["B"])
        dependencies_equal = final_snapshots["A"]["dependencies"] == final_snapshots["B"]["dependencies"]
        binary_bytes_equal = hashes(final_snapshots["A"]) == hashes(final_snapshots["B"])
        node_isolated = {name: isolated_node_proven(final_snapshots[name]) for name in ("A", "B")}
        native_binaries_present = {
            name: expected_native_binaries_present(final_snapshots[name]) for name in ("A", "B")
        }
        summary["comparability"] = {
            "native_release_inventories_equal": releases_equal,
            "dependency_versions_equal": dependencies_equal,
            "native_binary_hashes_equal": binary_bytes_equal,
            "isolated_node_proven": node_isolated,
            "expected_native_binaries_present": native_binaries_present,
            "interpretable": (
                releases_equal
                and dependencies_equal
                and binary_bytes_equal
                and all(node_isolated.values())
                and all(native_binaries_present.values())
            ),
        }
        summary["assertions"].update({
            "native_releases_equal": releases_equal,
            "dependency_versions_equal": dependencies_equal,
            "native_binary_hashes_equal": binary_bytes_equal,
            "A_uses_isolated_node": node_isolated["A"],
            "B_uses_isolated_node": node_isolated["B"],

            "A_expected_native_binaries_present": native_binaries_present["A"],
            "B_expected_native_binaries_present": native_binaries_present["B"],
        })

        write_json(summary_path, summary)
        if not summary["comparability"]["interpretable"]:
            raise RuntimeError("A/B environments are not comparable; timing interpretation refused")

        # macos_dyld_load_issues still executes both binaries even on the marker
        # fast path. Measure that retained safety work, rather than assume it vanished.
        a_probe_total = native_probe_total(summary["sides"]["A"]["sample_audits"], "llama-")
        b_probe_total = native_probe_total(summary["sides"]["B"]["sample_audits"], "llama-")
        summary["assertions"]["base_A_default_path_runs_llama_probes"] = a_probe_total > 0
        summary["assertions"]["head_B_preserves_macos_dyld_probes"] = b_probe_total >= 2 * args.repetitions
        summary["hypotheses"] = {"head_eliminates_macos_dyld_probes": b_probe_total == 0}
        a_release_api = sum(item["urllib_host_counts"].get("api.github.com", 0) for item in summary["sides"]["A"]["sample_audits"])
        b_release_api = sum(item["urllib_host_counts"].get("api.github.com", 0) for item in summary["sides"]["B"]["sample_audits"])
        summary["assertions"]["head_reduces_release_API_requests"] = b_release_api < a_release_api

        # Causal control: the same B install after timing, changing only the documented
        # full-check switch, must restore release selection without changing binaries.
        b_state = states["B"]
        control_log = private / "B-full-check-control.log"
        control_audit_file = private / "B-full-check-control-audit.jsonl"
        control_env = audit_environment(b_state["env"], control_audit_file)
        control_env["UNSLOTH_PREBUILT_FULL_CHECK"] = "1"
        control_seconds = run(update_argv(b_state["home"]), cwd=head, env=control_env, log=control_log)
        control_audit = audit_summary(control_audit_file)
        control_snapshot = inventory(b_state["home"], b_state["env"])
        summary["full_check_control_B"] = {
            "seconds": control_seconds,
            "audit": control_audit,
            "diagnostic_excerpt": diagnostic_excerpt(control_log),
            "switch": "UNSLOTH_PREBUILT_FULL_CHECK=1",
        }
        control_llama_probes = native_probe_total([control_audit], "llama-")
        summary["assertions"]["B_full_check_preserves_macos_dyld_probes"] = control_llama_probes >= 2
        control_release_api = control_audit["urllib_host_counts"].get("api.github.com", 0)
        summary["assertions"]["B_full_check_restores_release_API_requests"] = control_release_api > b_release_api / args.repetitions
        summary["assertions"]["B_full_check_binary_hashes_unchanged"] = hashes(control_snapshot) == hashes(final_snapshots["B"])
        summary["causal_fastpath_observation"] = {
            "base_A_default_llama_probe_total": a_probe_total,
            "head_B_default_llama_probe_total": b_probe_total,
            "head_B_forced_full_check_llama_probe_total": control_llama_probes,
            "base_A_release_API_requests_total": a_release_api,
            "head_B_release_API_requests_total": b_release_api,
            "head_B_forced_full_check_release_API_requests": control_release_api,
        }

        write_json(summary_path, summary)
        for name in ("A", "B"):
            state = states[name]
            live, _ = live_check(state["home"], state["env"], private / f"{name}-server-after-benchmark.log", state["password"])
            summary["sides"][name]["live_after_benchmark"] = live

            summary["assertions"][f"{name}_auth_persisted_after_benchmark"] = live["auth_credential_persisted"]

            write_json(summary_path, summary)

        # Migrate A only after the immutable base-vs-head benchmark is complete.
        state = states["A"]
        state["env"]["STUDIO_LOCAL_REPO"] = str(head)
        emit("A-base-to-head", "START")
        migration_log = private / "A-migrate-head.log"
        migration_audit_file = private / "A-migrate-head-audit.jsonl"
        migration_seconds = run(
            update_argv(state["home"]),
            cwd=head,
            env=audit_environment(state["env"], migration_audit_file),
            log=migration_log,
        )
        migrated = inventory(state["home"], state["env"])
        summary["assertions"]["migration_native_loaders_pass"] = expected_native_binaries_present(migrated) and all(item["loader_check"]["ok"] for item in migrated["binaries"].values())
        evidence = marker_evidence(migrated)
        post_migration_hashes = hashes(migrated)

        summary["migration"] = {
            "update_seconds": migration_seconds,
            "update_audit": audit_summary(migration_audit_file),
            "update_excerpt": diagnostic_excerpt(migration_log),
            "marker_evidence_groups": evidence,
            "inventory_after_migration": migrated,
        }
        summary["assertions"]["migration_marker_evidence_complete"] = all(evidence.values())
        write_json(summary_path, summary)
        if not summary["assertions"]["migration_marker_evidence_complete"]:
            raise RuntimeError("head migration did not populate all three marker evidence groups")
        migration_noop_log = private / "A-migrate-noop.log"
        noop_seconds = run(update_argv(state["home"]), cwd=head, env=state["env"], log=migration_noop_log)
        after_noop = inventory(state["home"], state["env"])

        summary["migration"].update({
            "repeat_noop_seconds": noop_seconds,
            "repeat_noop_excerpt": diagnostic_excerpt(migration_noop_log),
            "inventory_after_repeat_noop": after_noop,
        })
        write_json(summary_path, summary)
        quantizers = [state["home"] / name for name in after_noop["binaries"] if Path(name).name == "llama-quantize"]
        if len(quantizers) != 1:
            raise RuntimeError("canonical llama-quantize was not uniquely identified")
        quantize = quantizers[0]
        original_hash = digest(quantize)
        quantize.write_bytes(b"")

        truncation_observed = quantize.stat().st_size == 0

        summary["assertions"]["quantize_truncation_observed"] = truncation_observed
        write_json(summary_path, summary)
        repair_seconds = run(update_argv(state["home"]), cwd=head, env=state["env"], log=private / "A-repair.log")
        repaired = quantize.is_file() and quantize.stat().st_size > 0 and digest(quantize) == original_hash
        repaired_snapshot = inventory(state["home"], state["env"])
        summary["assertions"]["repaired_native_loaders_pass"] = expected_native_binaries_present(repaired_snapshot) and all(item["loader_check"]["ok"] for item in repaired_snapshot["binaries"].values())
        summary["assertions"]["repaired_entire_native_payload_matches"] = hashes(repaired_snapshot) == post_migration_hashes
        live, _ = live_check(state["home"], state["env"], private / "A-server-after-migration.log", state["password"])
        summary["migration"].update({
            "repair_seconds": repair_seconds,
            "repair_excerpt": diagnostic_excerpt(private / "A-repair.log"),
            "live_after_repair": live,
            "inventory_after_repair": repaired_snapshot,

            "auth_persisted_after_migration": live["auth_credential_persisted"],
        })
        write_json(summary_path, summary)
        summary["assertions"].update({
            "migration_repeat_noop_hashes_unchanged": hashes(after_noop) == post_migration_hashes,
            "quantize_truncation_observed": truncation_observed,
            "quantize_repaired_exact_hash": repaired,

            "A_auth_persisted_after_migration": live["auth_credential_persisted"],
            "A_sentinel_retained": state["sentinel"].read_text(encoding="utf-8") == '{"retain":true}\n',
            "B_sentinel_retained": states["B"]["sentinel"].read_text(encoding="utf-8") == '{"retain":true}\n',
            "all_loader_checks_pass": all(item["loader_check"]["ok"] for side in ("A", "B") for item in summary["sides"][side]["inventory_after_benchmark"]["binaries"].values()),
        })
        if not all(summary["assertions"].values()):
            raise RuntimeError("one or more lifecycle assertions failed")
        summary["comparison"] = {
            "base_median_seconds": summary["sides"]["A"]["median_seconds"],
            "head_median_seconds": summary["sides"]["B"]["median_seconds"],
            "head_minus_base_seconds": round(summary["sides"]["B"]["median_seconds"] - summary["sides"]["A"]["median_seconds"], 3),
        }
        summary["result"] = "PASS"
        write_json(summary_path, summary)
        emit("complete", "PASS")
        return 0
    except Exception as exc:
        summary["result"] = "FAIL"
        summary["failure"] = {"type": type(exc).__name__, "message": str(exc)[:500]}
        summary["failure"]["phase_diagnostics"] = {log.name: diagnostic_excerpt(log) for log in sorted(private.glob("*.log")) if "server" not in log.name}
        write_json(summary_path, summary)
        emit("complete", "FAIL")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
