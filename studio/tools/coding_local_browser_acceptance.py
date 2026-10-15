#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Real Studio-local browser workload against an already running coding_local_app.

Explicit GPU confirmation is mandatory. No provider fixtures, event injection,
route fulfillment, or synthetic tool results. This script does not start Studio
or kill its processes. Parent owns coordinated server launch and final cleanup.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import time
from urllib.parse import urlsplit

from coding_file_change_scenarios import LIVE_PROFILE_OBSERVER


GRANT_EXPIRY = 1791980523
GPU_UUID = "GPU-2bdfcc31-cf97-42d6-c898-40700d02fd40"

LOCAL_REQUEST_OBSERVER = r"""(() => {
  const original = window.fetch.bind(window);
  window.localNativeRequests = {};
  window.localNativeTools = {};
  window.localNativeToolTransitions = [];
  window.localNativePreparation = [];
  window.localNativeObserverErrors = [];
  window.fetch = async (...args) => {
    const response = await original(...args);
    const url = String(args[0] instanceof Request ? args[0].url : args[0]);
    if (!/\/api\/coding\/conversations\/[^/]+\/events$/.test(url) || !response.ok || !response.body) return response;
    void (async () => {
      const reader = response.clone().body.getReader();
      const decoder = new TextDecoder(); let buffer = '';
      try {
        for (;;) {
          const {done,value} = await reader.read(); if(done) break;
          buffer += decoder.decode(value,{stream:true}); let match;
          while((match=/\r?\n\r?\n/.exec(buffer))) {
            const frame=buffer.slice(0,match.index); buffer=buffer.slice(match.index+match[0].length);
            const data=frame.split(/\r?\n/).filter(s=>s.startsWith('data:')).map(s=>s.slice(5).trimStart()).join('\n');
            if(!data) continue;
            const event=JSON.parse(data).event;
            for(const request of event?.state?.requests ?? []) window.localNativeRequests[request.id]={id:request.id,status:request.status};
            const prep=event?.state?.execution_preparation;
            if(prep && window.localNativePreparation.length<128) window.localNativePreparation.push({request_id:prep.request_id,phase:prep.phase});
            for(const row of event?.rows ?? []) if(row.tool) {
              const t=row.tool;
              const record={name:t.name,call_id:t.call_id,invocation_id:t.invocation_id,status:t.status};
              if(window.localNativeTools[t.call_id]?.status !== t.status && window.localNativeToolTransitions.length<128) window.localNativeToolTransitions.push(record);
              window.localNativeTools[t.call_id]=record;
            }
          }
          if(buffer.length>2*1024*1024 || Object.keys(window.localNativeTools).length>128) throw new Error('Native observer bound exceeded');
        }
      } catch(error) {
        if(!(error instanceof TypeError || error.name==='AbortError')) window.localNativeObserverErrors.push(error.name);
      } finally {await reader.cancel().catch(()=>{});}
    })();
    return response;
  };
})();"""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--project", type=Path, required=True)
    parser.add_argument("--evidence-dir", type=Path, required=True)
    parser.add_argument("--gpu-capacity-confirmed", action="store_true")
    parser.add_argument("--browser", choices=("firefox", "chromium"), default="firefox")
    parser.add_argument("--chrome", default="/usr/bin/google-chrome")
    parser.add_argument("--deadline-seconds", type=int, default=360)
    parser.add_argument("--cold-load", action="store_true", help="Use isolated saved Studio overrides; native request owns actual model load")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    task = (root / ".scratch/ticket246-live").resolve()
    project, evidence = args.project.resolve(), args.evidence_dir.resolve()
    if not project.is_relative_to(task) or not evidence.is_relative_to(task):
        parser.error("Project and evidence must be task-owned under .scratch/ticket246-live")
    if not args.gpu_capacity_confirmed:
        parser.error("Parent must recheck GPU6 capacity and confirm the authorized launch")
    if not 30 <= args.deadline_seconds <= 600 or time.time() + args.deadline_seconds + 120 >= GRANT_EXPIRY:
        parser.error("Workload deadline is invalid or would overrun GPU grant; coordinate a new grant first")
    parsed = urlsplit(args.base_url)
    if parsed.scheme not in ("http", "https") or parsed.hostname not in ("127.0.0.1", "localhost", "::1") or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
        parser.error("Expected a credential-free loopback Studio origin")
    base = args.base_url.rstrip("/")
    password = os.environ.get("CODING_ACCEPTANCE_PASSWORD")
    if not password:
        parser.error("Pass task password through CODING_ACCEPTANCE_PASSWORD, never command-line arguments")
    if evidence.exists():
        parser.error("Use a fresh evidence directory")
    os.umask(0o077)
    evidence.mkdir(parents=True, mode=0o700)
    project.mkdir(parents=True, exist_ok=True)
    filename = "ticket246-" + secrets.token_hex(4) + ".txt"
    content = "TICKET246_REAL_NATIVE_FILE\n"
    marker = "TICKET246_REAL_NATIVE_SHELL"
    report = {"kind": "real-Studio-served-local-model-native-tool-workload", "status": "incomplete",
              "gpu_uuid": GPU_UUID, "peak_memory_budget_gib": 24, "deadline_seconds": args.deadline_seconds,
              "screenshots": [], "load_mode": "native-cold" if args.cold_load else "preloaded-borrow",
              "limitations": ["Busy/retry and process recovery have not yet run."]}
    request_id = conversation = None
    context = page = None

    def snapshot(name):
        path = evidence / (name + ".png")
        page.screenshot(path=str(path), full_page=True, animations="disabled")
        report["screenshots"].append(str(path))
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "Rendered route horizontally overflows"

    try:
        from playwright.sync_api import sync_playwright, expect
        with sync_playwright() as playwright:
            browser = (playwright.firefox.launch(headless=True, firefox_user_prefs={"gfx.webrender.software": True, "layers.acceleration.disabled": True})
                       if args.browser == "firefox" else playwright.chromium.launch(executable_path=args.chrome, headless=True, args=["--disable-gpu"]))
            context = browser.new_context(viewport={"width": 1440, "height": 1000})
            context.add_init_script(LIVE_PROFILE_OBSERVER + "\n" + LOCAL_REQUEST_OBSERVER)
            page = context.new_page()
            login = context.request.post(base + "/api/auth/login", data={"username": "unsloth", "password": password})
            assert login.ok, f"Production auth login failed ({login.status})"
            tokens = login.json()
            headers = {"Authorization": "Bearer " + tokens["access_token"]}
            page.goto(base + "/login")
            page.evaluate("tokens => {localStorage.setItem('unsloth_auth_token',tokens.access_token); localStorage.setItem('unsloth_auth_refresh_token',tokens.refresh_token); localStorage.setItem('unsloth_auth_session_mark','coding-local-acceptance');}", tokens)
            page.goto(base + "/coding")
            expect(page.get_by_role("heading", name="Build with Mimir")).to_be_visible()
            page.get_by_role("button", name="Choose project folder", exact=True).click()
            expect(page.get_by_test_id("coding-browsed-path")).to_be_visible(timeout=60000)
            page.get_by_label("Host folder path", exact=True).fill(str(project))
            page.get_by_role("button", name="Browse", exact=True).click()
            expect(page.get_by_test_id("coding-browsed-path")).to_have_text(str(project), timeout=60000)
            with page.expect_response(lambda r: r.url == base + "/api/coding/conversations" and r.request.method == "POST", timeout=60000) as created:
                page.get_by_role("button", name="Open project", exact=True).click()
            assert created.value.status == 201
            conversation = created.value.json()["id"]
            report["conversation_id"] = conversation
            report["runtime_generation"] = created.value.json()["runtime_generation"]
            headers["X-Mimir-Runtime-Generation"] = str(report["runtime_generation"])
            expect(page.get_by_test_id("coding-conversation-id")).to_have_text(conversation, timeout=60000)
            expect(page.get_by_test_id("coding-event-status")).to_contain_text("Native event stream connected", timeout=60000)
            catalog = context.request.post(base + f"/api/coding/conversations/{conversation}/models/refresh", headers=headers)
            assert catalog.ok, f"Actual native catalog refresh failed ({catalog.status})"
            choices = catalog.json()
            provider = next(p for p in choices if p["id"] == "studio-local")
            model_path = task / "models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf"
            model = next(m for m in provider["models"] if m["api_model"] == str(model_path))
            report["native_configuration"] = {"provider": provider["id"], "model": model["id"], "api_model": model["api_model"]}
            before = context.request.get(base + "/api/coding-local-acceptance/protection", headers=headers)
            assert before.ok and before.json()["coding_holds"] == 0 and not before.json()["primary_loaded"], "Acceptance requires an empty task-owned model owner, never evict existing work"
            # Bound model memory using the real gated lifecycle; coding borrows it
            # without changing settings. /load uses max_seq_length, not n_ctx.
            if not args.cold_load:
                loaded = context.request.post(base + "/api/inference/load", headers=headers, timeout=240000,
                    data={"model_path": model["api_model"], "max_seq_length": 32768, "n_parallel": 1,
                          "speculative_type": "off", "disable_vision": True, "gpu_memory_mode": "manual", "gpu_layers": 99})
                assert loaded.ok, f"Gated Studio model load failed ({loaded.status}); no fallback allowed"
                bounded = context.request.get(base + "/api/coding-local-acceptance/protection", headers=headers).json()
                assert bounded["coding_holds"] == 0 and bounded["primary_loaded"] and bounded["served_context"] <= 32768
                assert not bounded["gpu_backend_unavailable"], "Studio reported GPU runtime unavailable; CPU fallback is not accepted"
                assert isinstance(bounded["server_pid"], int), "No actual Studio-owned llama-server PID"
                report["bounded_preload"] = bounded
            page.get_by_role("button", name="Configure next coding request", exact=True).click()
            picker = page.get_by_test_id("coding-model-picker")
            picker.get_by_role("button", name="Choose coding model", exact=True).click()
            row = picker.locator(f'button[data-provider="studio-local"][data-model="{model["id"]}"]')
            expect(row).to_be_enabled(timeout=60000)
            with page.expect_response(lambda r: r.url == base + f"/api/coding/conversations/{conversation}/configuration" and r.request.method == "POST", timeout=60000) as configured:
                row.click()
            assert configured.value.ok and configured.value.request.post_data_json == {"provider": "studio-local", "model": model["id"]}
            page.keyboard.press("Escape")
            expect(page.get_by_test_id("coding-next-model")).to_contain_text("studio-local/" + model["id"])
            snapshot("local-selected-desktop")
            page.set_viewport_size({"width": 390, "height": 844})
            snapshot("local-selected-narrow")
            page.set_viewport_size({"width": 1440, "height": 1000})
            prompt = (f"In this disposable project only, use native write_file to create {filename} with exactly {json.dumps(content)}. "
                      f"Then use native shell with command 'sleep 20; printf {marker}', timeout_seconds 45, yield_time_ms 30000. "
                      f"Finally use native read_file to verify {filename}. Do not read credentials, use any remote provider, or change other files. Report completion briefly.")
            # Recheck immediately before native cold load, not just before the
            # potentially slow native package installation in the launcher.
            if args.cold_load:
                capacity = subprocess.check_output(["nvidia-smi", "-i", GPU_UUID,
                    "--query-gpu=uuid,memory.total,memory.used,utilization.gpu", "--format=csv,noheader,nounits"],
                    text=True, timeout=60).strip()
                uuid, total, used, utilization = [s.strip() for s in capacity.split(",")]
                assert uuid == GPU_UUID and int(total) - int(used) >= 24576, "Cold-load GPU grant capacity is unavailable"
                report["gpu_before_native_submission"] = {"uuid": uuid, "total_mib": int(total), "used_mib": int(used),
                    "utilization_percent": int(utilization), "epoch": int(time.time())}
            composer = page.get_by_label("Coding prompt", exact=True)
            composer.fill(prompt)
            with page.expect_response(lambda r: r.url == base + f"/api/coding/conversations/{conversation}/prompts" and r.request.method == "POST", timeout=60000) as submitted:
                composer.press("Enter")
            assert submitted.value.status == 202
            request_id = submitted.value.json()["request_id"]
            report["request_id"] = request_id
            expect(page.get_by_test_id("coding-request-id")).to_contain_text(request_id, timeout=60000)
            status = page.get_by_test_id("coding-run-status")
            deadline = time.monotonic() + args.deadline_seconds
            max_holds, gap_hold = 0, False
            preparations = set()
            while time.monotonic() < deadline:
                observed = context.request.get(base + "/api/coding-local-acceptance/protection", headers=headers)
                assert observed.ok
                owner = observed.json()
                holds = owner["coding_holds"]
                max_holds = max(max_holds, holds)
                if owner["primary_loaded"]:
                    assert owner["served_context"] <= 32768 and not owner["gpu_backend_unavailable"]
                    report["live_model_observation"] = owner
                preparation = page.get_by_test_id("coding-local-preparation")
                if preparation.count():
                    label = preparation.inner_text()[:512]
                    if label not in preparations:
                        preparations.add(label)
                        snapshot("local-preparation-" + str(len(preparations)) + "-desktop")
                        page.set_viewport_size({"width": 390, "height": 844})
                        snapshot("local-preparation-" + str(len(preparations)) + "-narrow")
                        page.set_viewport_size({"width": 1440, "height": 1000})
                running_shells = page.evaluate("Object.values(window.localNativeTools).filter(t => t.name === 'shell' && t.status === 'running')")
                if running_shells and not gap_hold:
                    running_call = running_shells[0]
                    rendered = page.locator('[data-testid="coding-tool-row"][data-call-id=' + json.dumps(running_call["call_id"]) + ']')
                    # Sample owner/refusal immediately, before a slow rendering
                    # assertion can outlive the real native tool gap.
                    gap_owner = context.request.get(base + "/api/coding-local-acceptance/protection", headers=headers).json()
                    assert gap_owner["coding_holds"] > 0, "Whole-request protection was lost during the native shell gap"
                    report["native_shell_gap"] = running_call
                    refusal = context.request.post(base + "/api/inference/unload", headers=headers, data={"model_path": model["api_model"]})
                    assert refusal.status == 409, "Destructive production unload was not refused during native tools"
                    report["destructive_unload_during_tool"] = {"status": refusal.status, "coding_holds": gap_owner["coding_holds"]}
                    runtime_before = context.request.get(base + "/api/coding/runtime", headers=headers).json()
                    restart_refusal = context.request.post(base + "/api/coding/runtime/restart", headers=headers,
                        data={"scope": "all_hosted_conversations"})
                    assert restart_refusal.status == 409, "Whole-runtime restart was not refused during protected native tools"
                    owner_after_refusal = context.request.get(base + "/api/coding-local-acceptance/protection", headers=headers).json()
                    runtime_after = context.request.get(base + "/api/coding/runtime", headers=headers).json()
                    assert owner_after_refusal["coding_holds"] > 0 and owner_after_refusal["native_pid"] == gap_owner["native_pid"]
                    assert runtime_after["generation"] == runtime_before["generation"] and runtime_after["state"] == "running"
                    report["whole_runtime_restart_during_protected_tool"] = {
                        "status": restart_refusal.status, "generation": runtime_after["generation"],
                        "coding_holds_preserved": owner_after_refusal["coding_holds"], "native_pid": owner_after_refusal["native_pid"]}
                    gap_hold = True
                    expect(rendered).to_contain_text("running", timeout=3000)
                    report["shell_row_during_native_gap"] = rendered.inner_text()[:1024]
                    report["rendered_running_shell_assertion"] = "passed"
                    snapshot("local-protected-native-shell-desktop")
                terminal = status.inner_text() if status.count() else ""
                if terminal.lower().startswith(("completed", "failed", "interrupted", "stopped")):
                    report["terminal_status"] = terminal
                    break
                page.wait_for_timeout(150)
            else:
                raise AssertionError("No native terminal result within live workload deadline")
            report["preparation_ui_observed"] = sorted(preparations)
            report["max_coding_holds"] = max_holds
            assert report["terminal_status"] == "Completed", "Real native request did not complete"
            report["native_requests"] = page.evaluate("window.localNativeRequests")
            report["native_tools"] = page.evaluate("Object.values(window.localNativeTools)")
            report["native_tool_transitions"] = page.evaluate("window.localNativeToolTransitions")
            report["native_preparation"] = page.evaluate("window.localNativePreparation")
            assert report["native_requests"].get(request_id, {}).get("status") == "completed", "Exact native terminal state was not observed"
            assert max_holds > 0 and gap_hold, "Actual native tool-gap protection evidence is missing"
            effects = page.evaluate("window.codingFileChangeLiveRows")
            assert any(r["name"] == "write_file" for r in effects), "No actual native write_file profile"
            report["file_tools"] = [{k: r[k] for k in ("name", "call_id", "invocation_id", "output_profile")} for r in effects]
            assert (project / filename).read_text() == content, "Native file evidence differs from requested content"
            report["file"] = {"path": str(project / filename), "sha256": hashlib.sha256(content.encode()).hexdigest()}
            shell_calls = [t for t in report["native_tools"] if t["name"] == "shell"]
            assert len(shell_calls) == 1
            shell = page.locator('[data-testid="coding-tool-row"][data-call-id=' + json.dumps(shell_calls[0]["call_id"]) + ']')
            expect(shell).to_have_count(1)
            shell.locator("summary").click()
            expect(shell.get_by_label("Actual public tool output", exact=True)).to_contain_text(marker)
            report["shell_tool"] = {"call_id": shell.get_attribute("data-call-id"), "invocation_id": shell.get_attribute("data-invocation-id"), "output_marker": marker}
            reads = [t for t in report["native_tools"] if t["name"] == "read_file"]
            assert len(reads) == 1 and reads[0]["status"] == "completed"
            expect(page.locator('[data-testid="coding-tool-row"][data-call-id=' + json.dumps(reads[0]["call_id"]) + ']')).to_have_count(1)
            release_deadline = time.monotonic() + 30
            while True:
                final = context.request.get(base + "/api/coding-local-acceptance/protection", headers=headers).json()
                if final["coding_holds"] == 0:
                    break
                assert time.monotonic() < release_deadline, "Terminal request did not release host protection"
                page.wait_for_timeout(150)
            report["protection_after_native_terminal"] = final
            ordinary = context.request.post(base + "/v1/chat/completions", headers=headers, timeout=120000,
                data={"model": model["api_model"], "messages": [{"role": "user", "content": "Reply with READY only."}],
                      "max_tokens": 16, "temperature": 0, "stream": False})
            assert ordinary.ok, f"Ordinary authenticated Studio /v1 smoke failed ({ordinary.status})"
            answer = ordinary.json()
            assert answer.get("choices") and answer["choices"][0]["message"].get("content"), "Ordinary Studio response was empty"
            report["ordinary_chat"] = {"status": ordinary.status, "id": answer.get("id"), "model": answer.get("model"),
                                       "usage": answer.get("usage"), "content": answer["choices"][0]["message"]["content"]}
            assert context.request.get(base + "/api/coding-local-acceptance/protection", headers=headers).json()["coding_holds"] == 0
            assert not page.evaluate("window.codingFileChangeObserverErrors") and not page.evaluate("window.localNativeObserverErrors"), "Passive native event observation failed"
            snapshot("local-terminal-desktop")
            page.set_viewport_size({"width": 390, "height": 844})
            snapshot("local-terminal-narrow")
            page.set_viewport_size({"width": 1440, "height": 1000})
            refreshed_catalog = context.request.post(base + f"/api/coding/conversations/{conversation}/models/refresh", headers=headers)
            assert refreshed_catalog.ok
            provider = next(p for p in refreshed_catalog.json() if p["id"] == "studio-local")
            alternate_path = str(task / "models/Qwen3-0.6B-Q4_K_M.gguf")
            alternate = next((m for m in provider["models"] if m["api_model"] == alternate_path), None)
            assert alternate, "Download the real second model with coding_local_setup.py --alternate before busy/retry acceptance"
            if alternate:
                original_pid = final["server_pid"]
                page.get_by_role("button", name="Configure next coding request", exact=True).click()
                picker.get_by_role("button", name="Choose coding model", exact=True).click()
                other = picker.locator(f'button[data-provider="studio-local"][data-model="{alternate["id"]}"]')
                expect(other).to_be_enabled(timeout=60000)
                with page.expect_response(lambda r: r.url == base + f"/api/coding/conversations/{conversation}/configuration" and r.request.method == "POST", timeout=60000) as alternate_configured:
                    other.click()
                assert alternate_configured.value.ok
                expect(page.get_by_test_id("coding-next-model")).to_contain_text("studio-local/" + alternate["id"], timeout=60000)
                page.keyboard.press("Escape")
                composer.fill("Reply READY only. Do not use tools or change files.")
                with page.expect_response(lambda r: r.url == base + f"/api/coding/conversations/{conversation}/prompts" and r.request.method == "POST", timeout=60000) as busy_submission:
                    composer.press("Enter")
                assert busy_submission.value.status == 202
                busy_id = busy_submission.value.json()["request_id"]
                request_id = busy_id
                preparation = page.get_by_test_id("coding-local-preparation")
                expect(preparation).to_contain_text("busy", ignore_case=True, timeout=60000)
                expect(status).to_have_text("Local model busy · explicit retry required", timeout=60000)
                page.wait_for_function("id => window.localNativeRequests[id]?.status === 'failed'", arg=busy_id, timeout=60000)
                snapshot("local-real-busy-desktop")
                page.set_viewport_size({"width": 390, "height": 844})
                snapshot("local-real-busy-narrow")
                page.set_viewport_size({"width": 1440, "height": 1000})
                expect(page.get_by_role("button", name="Retry local selection", exact=True)).to_be_enabled()
                with page.expect_response(lambda r: r.url == base + f"/api/coding/conversations/{conversation}/configuration" and r.request.method == "POST", timeout=60000) as retried:
                    page.get_by_role("button", name="Retry local selection", exact=True).click()
                assert retried.value.ok and retried.value.request.post_data_json == {}, "Explicit retry must validate identity without loading/replaying"
                stable = context.request.get(base + "/api/coding-local-acceptance/protection", headers=headers).json()
                assert stable["coding_holds"] == 0 and stable["server_pid"] == original_pid and stable["primary_loaded"]
                states = page.evaluate("window.localNativeRequests")
                assert set(states) == {busy_id, report["request_id"]}, "Explicit selection retry created/replayed an additional native request"
                assert states[busy_id]["status"] == "failed" and states[report["request_id"]]["status"] == "completed"
                report["busy_retry"] = {"request_id": busy_id, "selected_model": alternate["id"], "terminal": states[busy_id],
                                        "retry_http_status": retried.value.status, "resident_pid_unchanged": original_pid,
                                        "native_requests_after_retry": states}
                # Restore the original next selection without another prompt.
                restored = context.request.post(base + f"/api/coding/conversations/{conversation}/configuration", headers=headers,
                                                data={"provider": "studio-local", "model": model["id"]})
                assert restored.ok
                request_id = None
                report["limitations"] = ["Process recovery is not part of this browser phase."]
            else:
                report["limitations"].append("No second downloaded local identity was available for actual busy/retry scenario.")
            # Leave model shutdown to its authenticated lifecycle after exact
            # terminal release; never kill a server or force-drop native holds.
            unloaded = context.request.post(base + "/api/inference/unload", headers=headers, data={"model_path": model["api_model"]})
            assert unloaded.ok, "Post-terminal gated model cleanup failed"
            report["model_cleanup_http_status"] = unloaded.status
            cleaned = context.request.get(base + "/api/coding-local-acceptance/protection", headers=headers).json()
            assert cleaned["coding_holds"] == 0 and not cleaned["primary_active"] and not cleaned["primary_loaded"], "Gated unload did not confirm actual model-process cleanup"
            report["model_cleanup_observation"] = cleaned
            request_id = None
            observed_requests = page.evaluate("Object.values(window.localNativeRequests)")
            assert all(r["status"] in ("completed", "failed", "cancelled", "interrupted") for r in observed_requests), "Native recovery is refused while any observed request is active"
            prior_file_hash = hashlib.sha256((project / filename).read_bytes()).hexdigest()
            fault = context.request.post(base + "/api/coding-local-acceptance/recover-idle-native", headers=headers, timeout=60000)
            assert fault.ok, f"Idle task-native recovery was refused ({fault.status})"
            recovery = fault.json()
            assert recovery["native_exit_code"] == -9 and recovery["coding_holds"] == 0 and not recovery["model_active"]
            page.goto(base + "/coding")
            expect(page.get_by_role("heading", name="Build with Mimir")).to_be_visible(timeout=60000)
            refresh_saved = page.get_by_role("button", name="Refresh coding conversations", exact=True)
            expect(refresh_saved).to_be_enabled(timeout=60000)
            refresh_saved.click()
            expect(refresh_saved).to_be_enabled(timeout=60000)
            saved = page.locator('[aria-label="Saved coding conversations"] button').filter(has_text=conversation)
            expect(saved).to_be_visible(timeout=60000)
            saved.click()
            expect(page.get_by_test_id("coding-conversation-id")).to_have_text(conversation, timeout=60000)
            expect(page.get_by_test_id("coding-event-status")).to_contain_text("Native event stream connected", timeout=60000)
            refreshed = context.request.post(base + f"/api/coding/conversations/{conversation}/models/refresh", headers=headers)
            assert refreshed.ok
            recovered_choices = refreshed.json()
            assert any(p["id"] == "studio-local" and any(m["id"] == model["id"] for m in p["models"]) for p in recovered_choices)
            recovered_owner = context.request.get(base + "/api/coding-local-acceptance/protection", headers=headers).json()
            assert recovered_owner["coding_holds"] == 0 and not recovered_owner["primary_active"]
            assert isinstance(recovered_owner["native_pid"], int) and recovered_owner["native_pid"] != recovery["native_pid_before"]
            assert hashlib.sha256((project / filename).read_bytes()).hexdigest() == prior_file_hash, "Native recovery replayed or changed prior file effects"
            expect(page.locator('[data-testid="coding-tool-row"][data-call-id=' + json.dumps(shell_calls[0]["call_id"]) + ']')).to_have_count(1, timeout=60000)
            recovery.update(native_pid_after=recovered_owner["native_pid"], catalog_refresh_http_status=refreshed.status,
                            restored_conversation_id=conversation, file_sha256_unchanged=prior_file_hash,
                            owner_after_reopen=recovered_owner)
            report["actual_native_process_recovery"] = recovery
            report["limitations"] = [] if report.get("busy_retry") else ["No second local choice for busy/retry."]
            page.set_viewport_size({"width": 1440, "height": 1000})
            snapshot("local-process-recovered-desktop")
            page.set_viewport_size({"width": 390, "height": 844})
            snapshot("local-process-recovered-narrow")
            browser.close()
            report["status"] = "passed"
    except BaseException as exc:
        report["status"] = "failed"
        report["failure_type"] = type(exc).__name__
        # Keep only failure class; exception strings may contain auth/HTTP details.
        raise
    finally:
        (evidence / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        # Failure cleanup needs parent/native terminal supervision. Do not label
        # a browser disconnect or a sent cancellation as confirmed cleanup.
        if request_id:
            report["remaining_request_id"] = request_id
            (evidence / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
