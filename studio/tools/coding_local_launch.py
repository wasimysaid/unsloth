#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Isolated ticket246 live launcher: real Studio routers/native binary, exact owned cleanup."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

GPU = "GPU-2bdfcc31-cf97-42d6-c898-40700d02fd40"
EXPIRY = 1791980523


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gpu-capacity-confirmed", action="store_true")
    parser.add_argument("--browser", default="firefox", choices=("firefox", "chromium"))
    parser.add_argument("--deadline-seconds", type=int, default=480)
    parser.add_argument("--native", type=Path, help="Explicit reviewed binary under sibling mimir/target")
    args = parser.parse_args()
    if not args.gpu_capacity_confirmed or time.time() + 1500 >= EXPIRY:
        parser.error("Authorized GPU confirmation and at least1500 seconds of grant are required")
    os.umask(0o077)
    root = Path(__file__).resolve().parents[2]
    task = root / ".scratch/ticket246-live"
    run = task / ("live-" + secrets.token_hex(4))
    run.mkdir(parents=True, mode=0o700)
    for name in ("home", "native", "studio-home", "project", "hf"):
        (run / name).mkdir(mode=0o700)
    print("LIVE_RUN_DIR=" + str(run), flush=True)
    binary = (args.native or root.parent / "mimir/target/studio-local/mimir-compression-settled").resolve()
    if not binary.is_relative_to((root.parent / "mimir/target").resolve()) or not binary.is_file():
        parser.error("Expected a reviewed native executable under sibling mimir/target")
    package = root.parent / "mimir/target/studio-frontend-package"
    password = secrets.token_urlsafe(32)
    env = dict(os.environ, CUDA_VISIBLE_DEVICES=GPU, HOME=str(run / "home"),
               UNSLOTH_STUDIO_HOME=str(run / "studio-home"), MIMIR_CODING_AGENT_DIR=str(run / "native"),
               HF_HOME=str(run / "hf"), HF_HUB_CACHE=str(run / "hf/hub"), HF_XET_CACHE=str(run / "hf/xet"),
               PYTHONPATH=os.pathsep.join((str(root / "studio/tools"), str(root / "studio/backend"))),
               LLAMA_SERVER_PATH=str(task / "llama.cpp/llama-server"),
               UNSLOTH_MIMIR_EXECUTABLE=str(binary), UNSLOTH_MIMIR_PLUGIN_PACKAGE=str(package),
               CODING_ACCEPTANCE_PASSWORD=password, CODING_LOCAL_COLD_LOAD="1", MIMIR_DISABLE_MODELS_FETCH="1")
    for key in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "MIMIR_STUDIO_LOCAL_KEY",
                "MIMIR_STUDIO_LOCAL_URL", "MIMIR_STUDIO_LOCAL_INCARNATION", "UNSLOTH_MIMIR_STUDIO_URL", "MIMIR_MODELS_PATH", "MIMIR_SKILLS_DIR"):
        env.pop(key, None)
    report = {"kind": "actual-isolated-Studio-local-launcher", "run_dir": str(run), "gpu_uuid": GPU,
              "grant_expiry": EXPIRY, "peak_budget_mib": 24576, "status": "incomplete", "gpu_samples": []}
    server = driver = None
    token = None
    base = None

    def http(path, body=None, *, auth=True, timeout=15):
        headers = {"Content-Type": "application/json"}
        if auth and token:
            headers["Authorization"] = "Bearer " + token
        req = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as exc:
            return exc.code, None

    def save():
        (run / "launcher-report.json").write_text(json.dumps(report, indent=2) + "\n")

    try:
        capacity = subprocess.check_output(["nvidia-smi", "-i", GPU, "--query-gpu=uuid,memory.total,memory.used,utilization.gpu", "--format=csv,noheader,nounits"], text=True, timeout=60).strip()
        uuid, total, used, utilization = [s.strip() for s in capacity.split(",")]
        assert uuid == GPU and int(total) - int(used) >= 24576, "GPU6 lacks authorized peak capacity"
        report["initial_gpu"] = {"uuid": uuid, "total_mib": int(total), "used_mib": int(used), "utilization_percent": int(utilization)}
        report["source_revisions"] = {name: subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=directory, text=True).strip()
                                      for name, directory in (("studio", root), ("mimir", root.parent / "mimir"))}
        report["native_sha256"] = digest(binary)
        report["plugin_sha256"] = digest(package / "plugin.wasm")
        report["frontend_index_sha256"] = digest(root / "studio/frontend/dist/index.html")
        with (run / "plugin-install.log").open("w") as log:
            install = subprocess.run([str(binary), "plugin", "install", str(package)], cwd=root, env=env,
                                     stdout=log, stderr=subprocess.STDOUT, timeout=360)
        report["plugin_install_exit_code"] = install.returncode
        assert install.returncode == 0, "Current product package could not install"
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0)); port = sock.getsockname()[1]
        base = f"http://127.0.0.1:{port}"
        server_log = (run / "server.log").open("w")
        server = subprocess.Popen([sys.executable, "-m", "uvicorn", "coding_local_app:create_app", "--factory", "--host", "127.0.0.1", "--port", str(port), "--no-access-log"], cwd=root, env=env, stdout=server_log, stderr=subprocess.STDOUT)
        report["server_pid"] = server.pid
        deadline = time.monotonic() + 60
        while True:
            assert server.poll() is None, "Task Studio server failed startup"
            try:
                code, _ = http("/api/inference/models", auth=False)
                assert code in (401, 403)
                break
            except urllib.error.URLError:
                assert time.monotonic() < deadline, "Task server startup timed out"
                time.sleep(0.2)
        code, login = http("/api/auth/login", {"username": "unsloth", "password": password}, auth=False)
        assert code == 200
        token = login["access_token"]
        report["authentication"] = {"anonymous_inference_denied": True, "real_login_succeeded": True}
        driver_log = (run / "browser-driver.log").open("w")
        driver = subprocess.Popen([sys.executable, str(root / "studio/tools/coding_local_browser_acceptance.py"),
                                   "--base-url", base, "--project", str(run / "project"), "--evidence-dir", str(run / "browser"),
                                   "--browser", args.browser, "--deadline-seconds", str(args.deadline_seconds), "--cold-load", "--gpu-capacity-confirmed"],
                                  cwd=root, env=env, stdout=driver_log, stderr=subprocess.STDOUT)
        driver_deadline = time.monotonic() + args.deadline_seconds + 240
        next_gpu = 0
        while driver.poll() is None:
            assert time.monotonic() < driver_deadline and time.time() + 120 < EXPIRY, "Live browser driver exceeded bounded lifetime"
            code, state = http("/api/coding-local-acceptance/protection")
            if code == 200 and state.get("server_pid"):
                report["task_llama_pid"] = state["server_pid"]
                if time.monotonic() >= next_gpu:
                    listing = subprocess.check_output(["nvidia-smi", "-i", GPU, "--query-compute-apps=pid,gpu_uuid,used_memory", "--format=csv,noheader,nounits"], text=True, timeout=60)
                    for line in listing.splitlines():
                        fields = [s.strip() for s in line.split(",")]
                        if len(fields) == 3 and fields[0] == str(state["server_pid"]):
                            assert fields[1] == GPU
                            sample = {"pid": state["server_pid"], "uuid": fields[1], "used_mib": int(fields[2]), "epoch": int(time.time())}
                            report["gpu_samples"].append(sample)
                            save()
                            assert sample["used_mib"] <= 24576, "Task model exceeded GPU grant"
                    next_gpu = time.monotonic() + 5
            time.sleep(0.3)
        report["browser_driver_exit_code"] = driver.returncode
        driver_log.close()
        browser_report_path = run / "browser/report.json"
        if browser_report_path.is_file():
            browser_report = json.loads(browser_report_path.read_text())
            report["browser_report"] = str(browser_report_path)
            remaining = browser_report.get("remaining_request_id")
            if remaining:
                # Subscribe to the current native snapshot BEFORE requesting exact
                # cancellation. Preserve actual terminal state rather than the ACK.
                import httpx
                conversation = browser_report["conversation_id"]
                headers = {"Authorization": "Bearer " + token,
                           "X-Mimir-Runtime-Generation": str(browser_report["runtime_generation"])}
                with httpx.Client(timeout=httpx.Timeout(180, connect=10)) as client:
                    with client.stream("GET", base + f"/api/coding/conversations/{conversation}/events", headers=headers) as stream:
                        assert stream.status_code == 200
                        cancelled = client.post(base + f"/api/coding/conversations/{conversation}/requests/{remaining}/cancel", headers=headers)
                        report["failure_cancel_ack"] = cancelled.status_code
                        for line in stream.iter_lines():
                            if not line.startswith("data:"):
                                continue
                            event = json.loads(line[5:].strip()).get("event", {})
                            found = next((r for r in event.get("state", {}).get("requests", []) if r["id"] == remaining), None)
                            if found and found["status"] in ("completed", "cancelled", "failed", "interrupted"):
                                report["failure_native_terminal"] = {"id": remaining, "status": found["status"]}
                                break
                code, state = http("/api/coding-local-acceptance/protection")
                report["failure_cleanup_owner"] = state
                assert code == 200 and state["coding_holds"] == 0, "Exact native request cancellation did not release owner protection"
        report["status"] = "passed" if driver.returncode == 0 else "failed-workload"
    except BaseException as exc:
        report["status"] = "failed"
        report["failure_type"] = type(exc).__name__
        raise
    finally:
        if driver is not None and driver.poll() is None:
            # This is our exact launched acceptance helper, not a native completion.
            driver.terminate()
            try: driver.wait(timeout=10)
            except subprocess.TimeoutExpired:
                driver.kill(); driver.wait(timeout=10)
            report["driver_forced_stop"] = True
        if server is not None and server.poll() is None:
            server.terminate()
            try:
                code = server.wait(timeout=120)
            except subprocess.TimeoutExpired:
                # Never force-kill an unconfirmed native/model cleanup tree here.
                report["server_shutdown_blocked"] = True
                save()
                raise RuntimeError("Task server cleanup did not terminate; parent must inspect exact owned processes")
            report["server_exit_code"] = code
            server_log.close()
            lifespan = run / "studio-home/acceptance-lifespan.json"
            if lifespan.is_file():
                report["lifespan"] = json.loads(lifespan.read_text())
            report["server_cleanup_confirmed"] = code in (0, -15) and report.get("lifespan", {}).get("cleanup_confirmed", False)
        save()
    print(json.dumps(report, indent=2))
    assert report["status"] == "passed" and report.get("server_cleanup_confirmed"), "Real workload or cleanup did not pass"


if __name__ == "__main__":
    main()
