#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Ticket246 CPU-only actual HTTP auth/inference composition smoke; not workload acceptance."""
from __future__ import annotations

import argparse
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


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--probe-deps", action="store_true", help="Use task-owned minimal dependency target without editing shared .venv")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    task = root / ".scratch/ticket246-live"
    evidence = task / ("http-probe-" + secrets.token_hex(4))
    evidence.mkdir(mode=0o700, parents=True)
    for name in ("home", "native", "studio-home", "hf"):
        (evidence / name).mkdir(mode=0o700)
    password = secrets.token_urlsafe(32)
    paths = [str(root / "studio/tools"), str(root / "studio/backend")]
    if args.probe_deps:
        paths.insert(0, str(task / "probe-deps"))
    env = dict(os.environ, CUDA_VISIBLE_DEVICES="", HOME=str(evidence / "home"),
               UNSLOTH_STUDIO_HOME=str(evidence / "studio-home"), MIMIR_CODING_AGENT_DIR=str(evidence / "native"),
               HF_HOME=str(evidence / "hf"), HF_HUB_CACHE=str(evidence / "hf/hub"),
               HF_XET_CACHE=str(evidence / "hf/xet"), PYTHONPATH=os.pathsep.join(paths),
               LLAMA_SERVER_PATH=str(task / "llama.cpp/llama-server"), CODING_ACCEPTANCE_PASSWORD=password)
    for key in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "MIMIR_STUDIO_LOCAL_KEY",
                "MIMIR_STUDIO_LOCAL_URL", "MIMIR_STUDIO_LOCAL_INCARNATION", "UNSLOTH_MIMIR_STUDIO_URL"):
        env.pop(key, None)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    report = {"kind": "setup-http-smoke-only", "gpu_workload_started": False,
              "native_coding_workload_submitted": False, "composition": "production auth/coding/inference + keepwarm",
              "evidence_dir": str(evidence), "checks": [], "server_cleanup_confirmed": False}
    token = None

    def request(path, body=None, *, authenticated=False):
        headers = {"Content-Type": "application/json"}
        if authenticated:
            headers["Authorization"] = "Bearer " + token
        req = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=10) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as exc:
            # Never persist raw HTTP/auth bodies, tokens or credentials.
            return exc.code, None

    with (evidence / "server.log").open("w") as output:
        server = subprocess.Popen([sys.executable, "-m", "uvicorn", "coding_local_app:create_app", "--factory",
                                   "--host", "127.0.0.1", "--port", str(port), "--no-access-log"],
                                  cwd=root, env=env, stdout=output, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + 30
            while True:
                if server.poll() is not None:
                    raise RuntimeError("Real-router server failed startup; inspect sanitized server log")
                try:
                    status, _ = request("/api/inference/models")
                    break
                except urllib.error.URLError:
                    if time.monotonic() >= deadline:
                        raise RuntimeError("Real-router server did not start within 30 seconds")
                    time.sleep(0.1)
            assert status in (401, 403), "Production inference admitted an anonymous caller"
            report["checks"].append("anonymous production inference denied")
            status, login = request("/api/auth/login", {"username": "unsloth", "password": password})
            assert status == 200, "Production auth login failed"
            token = login["access_token"]
            report["checks"].append("production auth login succeeded; token retained in memory only")
            status, models = request("/api/inference/models", authenticated=True)
            assert status == 200 and isinstance(models.get("data"), list)
            report["checks"].append("authenticated production inference model listing succeeded")
            status, state = request("/api/coding-local-acceptance/protection", authenticated=True)
            assert status == 200 and state["coding_holds"] == 0 and not state["primary_loaded"] and not state["primary_active"]
            report["protection_observation"] = state
            report["checks"].append("actual gated owner has zero idle coding protections; no model loaded")
        finally:
            server.terminate()
            try:
                code = server.wait(timeout=20)
            except subprocess.TimeoutExpired:
                server.kill()
                code = server.wait(timeout=10)
                report["cleanup_forced"] = True
            report["server_exit_code"] = code
            output.flush()
            shutdown_log = (evidence / "server.log").read_text()
            # Current uvicorn re-raises the captured SIGTERM after completing its
            # lifespan. Exit -15 alone is neither clean nor failed cleanup evidence.
            report["lifespan_cleanup_confirmed"] = "Application shutdown complete." in shutdown_log
            report["server_cleanup_confirmed"] = (
                code in (0, -15) and report["lifespan_cleanup_confirmed"]
                and not report.get("cleanup_forced", False)
            )
            (evidence / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    if not report["server_cleanup_confirmed"]:
        raise RuntimeError("Real-router server shutdown was not clean")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
