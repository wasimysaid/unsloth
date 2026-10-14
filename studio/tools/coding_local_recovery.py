#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""No-GPU real native fault/reopen/catalog acceptance using authentic prior session evidence."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import time


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-run", type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    task = root / ".scratch/ticket246-live"
    source = args.source_run.resolve()
    if not source.is_relative_to(task.resolve()):
        parser.error("Source must be an authentic task-owned completed run")
    original = json.loads((source / "browser/report.json").read_text())
    assert original["native_requests"][original["request_id"]]["status"] == "completed"
    original_file = Path(original["file"]["path"])
    assert digest(original_file) == original["file"]["sha256"]
    native = root.parent / "mimir/target/studio-local/mimir-compression-settled"
    assert digest(native) == "a3501fdf9829857c8e8fc447ed67bcf23c45847a370770c76d9dedb0e64f8c43"
    package = root.parent / "mimir/target/studio-frontend-package"
    os.umask(0o077)
    run = task / ("recovery-" + secrets.token_hex(4))
    run.mkdir(mode=0o700)
    for name in ("home", "native", "studio-home", "hf", "browser"):
        (run / name).mkdir(mode=0o700)
    # Copy authentic native-owned saved records, not synthetic entries/events.
    # Project/file effects remain at their original verified task-owned location.
    shutil.copytree(source / "native/sessions", run / "native/sessions")
    report = {"kind": "actual-no-GPU-native-recovery", "status": "incomplete", "source_run": str(source),
              "conversation_id": original["conversation_id"], "native_sha256": digest(native),
              "plugin_sha256": digest(package / "plugin.wasm"), "gpu_workload_started": False,
              "source_session_copy": "Authentic completed native session records; no events or provider responses fabricated",
              "original_file": original["file"], "screenshots": []}
    print("RECOVERY_RUN_DIR=" + str(run), flush=True)
    password = secrets.token_urlsafe(32)
    env = dict(os.environ, CUDA_VISIBLE_DEVICES="", HOME=str(run / "home"),
               UNSLOTH_STUDIO_HOME=str(run / "studio-home"), MIMIR_CODING_AGENT_DIR=str(run / "native"),
               HF_HOME=str(run / "hf"), HF_HUB_CACHE=str(run / "hf/hub"), HF_XET_CACHE=str(run / "hf/xet"),
               PYTHONPATH=os.pathsep.join((str(root / "studio/tools"), str(root / "studio/backend"))),
               LLAMA_SERVER_PATH=str(task / "llama.cpp/llama-server"), UNSLOTH_MIMIR_EXECUTABLE=str(native),
               UNSLOTH_MIMIR_PLUGIN_PACKAGE=str(package), CODING_ACCEPTANCE_PASSWORD=password,
               MIMIR_DISABLE_MODELS_FETCH="1")
    for key in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "MIMIR_STUDIO_LOCAL_KEY",
                "MIMIR_STUDIO_LOCAL_URL", "MIMIR_STUDIO_LOCAL_INCARNATION", "UNSLOTH_MIMIR_STUDIO_URL",
                "MIMIR_MODELS_PATH", "MIMIR_SKILLS_DIR", "CODING_LOCAL_COLD_LOAD"):
        env.pop(key, None)
    server = None
    try:
        with (run / "plugin-install.log").open("w") as log:
            installed = subprocess.run([str(native), "plugin", "install", str(package)], cwd=root, env=env,
                                       stdout=log, stderr=subprocess.STDOUT, timeout=360)
        report["plugin_install_exit_code"] = installed.returncode
        assert installed.returncode == 0
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0)); port = sock.getsockname()[1]
        base = f"http://127.0.0.1:{port}"
        server_log = (run / "server.log").open("w")
        server = subprocess.Popen([sys.executable, "-m", "uvicorn", "coding_local_app:create_app", "--factory",
                                   "--host", "127.0.0.1", "--port", str(port), "--no-access-log"],
                                  cwd=root, env=env, stdout=server_log, stderr=subprocess.STDOUT)
        report["server_pid"] = server.pid
        import httpx
        from playwright.sync_api import sync_playwright, expect
        with httpx.Client(timeout=30) as client:
            deadline = time.monotonic() + 60
            while True:
                assert server.poll() is None
                try:
                    anonymous = client.get(base + "/api/inference/models")
                    assert anonymous.status_code in (401, 403)
                    break
                except httpx.ConnectError:
                    assert time.monotonic() < deadline
                    time.sleep(0.2)
            login = client.post(base + "/api/auth/login", json={"username": "unsloth", "password": password})
            assert login.status_code == 200
            tokens = login.json()
            headers = {"Authorization": "Bearer " + tokens["access_token"]}
            def owner():
                response = client.get(base + "/api/coding-local-acceptance/protection", headers=headers)
                assert response.status_code == 200
                value = response.json()
                assert value["coding_holds"] == 0 and not value["primary_loaded"] and not value["primary_active"]
                return value
            with sync_playwright() as playwright:
                browser = playwright.firefox.launch(headless=True, firefox_user_prefs={"gfx.webrender.software": True, "layers.acceleration.disabled": True})
                context = browser.new_context(viewport={"width": 1440, "height": 1000})
                page = context.new_page()
                page.goto(base + "/login")
                page.evaluate("tokens => {localStorage.setItem('unsloth_auth_token',tokens.access_token);localStorage.setItem('unsloth_auth_refresh_token',tokens.refresh_token);localStorage.setItem('unsloth_auth_session_mark','coding-local-recovery');}", tokens)
                conversation = original["conversation_id"]
                def reopen():
                    page.goto(base + "/coding")
                    expect(page.get_by_role("heading", name="Build with Mimir")).to_be_visible(timeout=60000)
                    refresh = page.get_by_role("button", name="Refresh coding conversations", exact=True)
                    expect(refresh).to_be_enabled(timeout=60000)
                    refresh.click()
                    expect(refresh).to_be_enabled(timeout=60000)
                    saved = page.locator('[aria-label="Saved coding conversations"] button').filter(has_text=conversation)
                    expect(saved).to_be_visible(timeout=60000)
                    saved.click()
                    expect(page.get_by_test_id("coding-conversation-id")).to_have_text(conversation, timeout=60000)
                    expect(page.get_by_test_id("coding-event-status")).to_contain_text("Native event stream connected", timeout=60000)
                    call = original["shell_tool"]["call_id"]
                    tool = page.locator('[data-testid="coding-tool-row"][data-call-id=' + json.dumps(call) + ']')
                    expect(tool).to_have_count(1, timeout=60000)
                    expect(tool).to_contain_text("completed")
                    tool.locator("summary").click()
                    expect(tool.get_by_label("Actual public tool output", exact=True)).to_contain_text("TICKET246_REAL_NATIVE_SHELL")
                reopen()
                before = owner()
                assert isinstance(before["native_pid"], int)
                report["owner_before_fault"] = before
                fault = client.post(base + "/api/coding-local-acceptance/recover-idle-native", headers=headers, timeout=60)
                assert fault.status_code == 200
                recovery = fault.json()
                assert recovery["native_pid_before"] == before["native_pid"] and recovery["native_exit_code"] == -9
                assert recovery["coding_holds"] == 0 and not recovery["model_active"]
                report["actual_fault"] = recovery
                reopen()
                catalog = client.post(base + f"/api/coding/conversations/{conversation}/models/refresh", headers=headers, timeout=60)
                assert catalog.status_code == 200
                wanted = original["native_configuration"]["model"]
                assert any(p["id"] == "studio-local" and any(m["id"] == wanted for m in p["models"]) for p in catalog.json())
                after = owner()
                assert isinstance(after["native_pid"], int) and after["native_pid"] != before["native_pid"]
                assert digest(original_file) == original["file"]["sha256"]
                report.update(owner_after_reopen=after, catalog_refresh_http_status=catalog.status_code,
                              file_sha256_unchanged=digest(original_file), retained_shell_call_id=original["shell_tool"]["call_id"])
                for label, width, height in (("desktop", 1440, 1000), ("narrow", 390, 844)):
                    page.set_viewport_size({"width": width, "height": height})
                    image = run / f"browser/recovered-{label}.png"
                    page.screenshot(path=str(image), full_page=True, animations="disabled")
                    report["screenshots"].append(str(image))
                    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
                browser.close()
        report["status"] = "passed"
    except BaseException as exc:
        report["status"] = "failed"
        report["failure_type"] = type(exc).__name__
        raise
    finally:
        if server is not None and server.poll() is None:
            server.terminate()
            report["server_exit_code"] = server.wait(timeout=120)
            server_log.close()
            lifespan = run / "studio-home/acceptance-lifespan.json"
            if lifespan.is_file(): report["lifespan"] = json.loads(lifespan.read_text())
            report["cleanup_confirmed"] = report["server_exit_code"] in (0, -15) and report.get("lifespan", {}).get("cleanup_confirmed", False)
        (run / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    assert report["status"] == "passed" and report.get("cleanup_confirmed"), "Recovery or actual clean lifespan did not pass"
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
