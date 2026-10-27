# SPDX-License-Identifier: AGPL-3.0-only
"""#249 real coding-route/process-loss scenarios with deterministic provider replies.

These are native/provider fault fixtures, not live-model or local-protection proof.
"""
from __future__ import annotations

from coding_recovery_scenarios import captured_state, wait_native_terminal
from coding_ui import expect_connected, expect_opened, opened_id, saved_row


def run_maintenance_scenarios(page, context, base, provider, first, second_id,
                              report, scenario, snapshot, server_pid):
    import psutil
    from playwright.sync_api import expect

    conversation = opened_id(page)
    headers = {"Authorization": "Bearer " + page.evaluate("localStorage.getItem('unsloth_auth_token')")}
    headers["X-Mimir-Runtime-Generation"] = str(context.request.get(base + "/api/coding/runtime", headers=headers).json()["generation"])
    evidence = report.setdefault("maintenance", {"kind": "deterministic-provider-real-native-process-faults", "requests": []})
    prompt_url = base + f"/api/coding/conversations/{conversation}/prompts"
    restart_url = base + "/api/coding/runtime/restart"

    def owned_process():
        children = [child for child in psutil.Process(server_pid).children()
                    if child.cmdline()[1:] == ["plugin", "run", "studio.frontend"]]
        assert len(children) == 1
        return children[0]

    def reopen(identifier=conversation):
        saved = saved_row(page, identifier)
        with page.expect_response(lambda response: response.url == base + f"/api/coding/conversations/{identifier}/open" and response.request.method == "POST", timeout=60000) as opening:
            saved.click()
        assert opening.value.ok
        headers["X-Mimir-Runtime-Generation"] = str(opening.value.json()["runtime_generation"])
        expect_opened(page, identifier)
        expect_connected(page)

    def request(identifier, text, key):
        response = context.request.post(base + f"/api/coding/conversations/{identifier}/prompts",
                                        headers=headers, data={"submission_key": key, "text": text})
        assert response.status == 202, response.text()
        accepted = response.json()
        evidence["requests"].append(dict(accepted, text=text))
        return accepted

    def restart_from_browser(expected_status=200):
        # The runtime notice offers Restart Mimir only while the runtime is
        # unhealthy; its all-conversation scope is stated before the keyboard action.
        restart = page.get_by_test_id("coding-runtime-restart")
        expect(restart).to_be_enabled(timeout=60000)
        expect(restart).to_have_text("Restart Mimir")
        expect(restart).to_have_attribute("title", "Restarts Mimir for every conversation. Busy conversations refuse it.")
        restart.focus()
        expect(restart).to_be_focused()
        with page.expect_response(lambda response: response.url == restart_url and response.request.method == "POST", timeout=60000) as waiting:
            restart.press("Enter")
        assert waiting.value.status == expected_status, waiting.value.text()
        assert waiting.value.request.post_data_json == {"scope": "all_hosted_conversations"}
        return waiting.value

    # First prove the all-conversation guard with a second busy conversation.
    # A distinct overlapping Start is refused; native queued-state coverage is
    # separate. Admission protects work in conversations not currently viewed.
    initial = owned_process()
    first_ack = request(conversation, "MAINTENANCE_FIRST_ACTIVE", "maintenance-first")
    held_first = provider.request()
    second_ack = request(second_id, "MAINTENANCE_SECOND_ACTIVE", "maintenance-second")
    held_second = provider.request()
    busy_prompt = context.request.post(base + f"/api/coding/conversations/{second_id}/prompts", headers=headers,
                                       data={"submission_key": "maintenance-busy-distinct", "text": "Must not replace active work"})
    assert busy_prompt.status == 409  # The product Start delivery does not invent a queue.
    second_state = captured_state(base, headers, second_id)
    assert second_state["active_request"] == second_ack["request_id"]
    # A healthy runtime renders no maintenance notice or restart control, so the
    # refused all-hosted restart is requested through the authenticated API.
    maintenance = page.get_by_test_id("coding-runtime-maintenance")
    expect(maintenance).to_have_count(0)
    refused = context.request.post(restart_url, headers=headers, data={"scope": "all_hosted_conversations"})
    assert refused.status == 409, refused.text()
    # A refused attempt leaves the viewed owner connected with Stop available.
    expect_connected(page)
    expect(page.get_by_test_id("coding-run-status")).to_have_text("Running", timeout=60000)
    expect(page.get_by_role("button", name="Stop", exact=True)).to_be_enabled()
    expect(maintenance).to_have_count(0)
    snapshot(page, "maintenance-desktop-busy-refusal")
    assert initial.is_running() and owned_process().pid == initial.pid
    assert captured_state(base, headers, conversation)["active_request"] == first_ack["request_id"]
    assert captured_state(base, headers, second_id)["active_request"] == second_ack["request_id"]
    # Explicitly stop one request, then cancel the other exact active identity;
    # refusal must protect the remaining busy hosted conversation in between.
    page.get_by_role("button", name="Stop", exact=True).click()
    wait_native_terminal(base, headers, conversation, first_ack["request_id"], expected_status="cancelled")
    response = context.request.post(restart_url, headers=headers, data={"scope": "all_hosted_conversations"})
    assert response.status == 409 and initial.is_running()
    response = context.request.post(base + f"/api/coding/conversations/{second_id}/requests/{second_ack['request_id']}/cancel", headers=headers)
    assert response.ok
    wait_native_terminal(base, headers, second_id, second_ack["request_id"], expected_status="cancelled")
    held_first.text("CANCELLED_RESPONSE_NOT_REPLAYED")
    held_second.text("CANCELLED_RESPONSE_NOT_REPLAYED")
    scenario("A7-restart-concurrent-refusal", "Two native conversations ran concurrently; distinct busy prompt admission and remaining active work refused authenticated-API all-hosted restart (the UI offers Restart Mimir only for an unhealthy runtime) without PID/request changes; the viewed owner stayed connected with Stop available. Explicit Stop/exact cancellation reached native terminal cleanup first. Native queued-state guard coverage is separate.")

    # Hold a real browser prompt before backend dispatch. Idle native admission
    # is allowed, but that old-tab HTTP request must never target a replacement
    # owner deliberately opened in another tab.
    delayed = []
    # The composer shows Stop instead of Send until the rendered view settles.
    expect(page.get_by_test_id("coding-run-status")).to_contain_text("Stopped", timeout=60000)
    page.route(prompt_url, lambda route: delayed.append(route), times=1)
    page.get_by_label("Coding prompt", exact=True).fill("STALE_TAB_PROMPT_MUST_NOT_RUN")
    page.get_by_label("Coding prompt", exact=True).press("Enter")
    page.wait_for_function("id => localStorage.getItem('unsloth:coding:pending-submission:' + encodeURIComponent(id)) !== null", arg=conversation)
    assert len(delayed) == 1
    stale_generation = headers["X-Mimir-Runtime-Generation"]
    # Idle restart retains saved identity/history, but no owners are automatically
    # reopened. All affected views disconnect rather than becoming clean Stops.
    response = context.request.post(restart_url, headers=headers, data={"scope": "all_hosted_conversations"})
    assert response.ok, response.text()
    assert response.json()["cleanup"]["confirmed"] is True
    assert not initial.is_running()
    replacement = owned_process()
    assert replacement.pid != initial.pid
    evidence["idle_restart"] = dict(response.json(), old_pid=initial.pid, new_pid=replacement.pid)
    other_tab = context.new_page()
    other_tab.goto(base + "/coding")
    saved = saved_row(other_tab, conversation)
    expect(saved).to_be_visible(timeout=60000)
    with other_tab.expect_response(lambda reply: reply.url == base + f"/api/coding/conversations/{conversation}/open" and reply.request.method == "POST", timeout=60000) as opening:
        saved.click()
    assert opening.value.ok and str(opening.value.json()["runtime_generation"]) != stale_generation
    expect_connected(other_tab)
    with page.expect_response(lambda reply: reply.url == prompt_url and reply.request.method == "POST", timeout=60000) as stale_response:
        delayed[0].continue_()
    assert stale_response.value.status == 409
    assert stale_response.value.headers["x-mimir-requires-reopen"] == "true"
    provider.assert_no_request()
    replacement_headers = {**headers, "X-Mimir-Runtime-Generation": str(opening.value.json()["runtime_generation"])}
    before_configuration = captured_state(base, replacement_headers, conversation)["configuration"]
    stale_configuration = context.request.post(base + f"/api/coding/conversations/{conversation}/configuration",
        headers={**headers, "X-Mimir-Runtime-Generation": stale_generation}, data={"reasoning": "high"})
    assert stale_configuration.status == 409
    assert stale_configuration.headers["x-mimir-requires-reopen"] == "true"
    assert captured_state(base, replacement_headers, conversation)["configuration"] == before_configuration
    provider.assert_no_request()
    evidence["stale_configuration"] = {"status": 409, "requires_reopen": True, "replacement_configuration_unchanged": True}
    scenario("A7-stale-configuration-incarnation-fence", "After another tab deliberately reopened the saved ID in a replacement runtime, an old-generation configuration mutation was refused with 409/reopen-required and left native configuration unchanged")
    other_tab.close()
    reopen()
    assert captured_state(base, headers, conversation)["active_request"] is None
    provider.assert_no_request()
    # Fencing cannot erase an uncertain key: explicitly reconcile the same key
    # only after reopening. This never occurs automatically on replacement.
    original_body = delayed[0].request.post_data_json
    retry = page.get_by_test_id("coding-retry-submission")
    expect(retry).to_be_visible(timeout=60000)
    with page.expect_response(lambda reply: reply.url == prompt_url and reply.request.method == "POST", timeout=60000) as retried:
        retry.click()
    assert retried.value.status == 202 and retried.value.request.post_data_json == original_body
    provider.request().text("EXPLICIT_STALE_DELIVERY_RECONCILED")
    wait_native_terminal(base, headers, conversation, retried.value.json()["request_id"])
    expect(page.get_by_test_id("coding-run-status")).to_have_text("Completed", timeout=60000)
    evidence["requests"].append(dict(retried.value.json(), text=original_body["text"]))
    scenario("A7-stale-http-incarnation-fence", "Held an actual browser prompt before dispatch, restarted while natively idle, deliberately reopened the same saved ID in a second browser tab, then released the stale POST. Backend refused the old opening generation with 409/reopen-required and no provider request or new-owner effect.")
    scenario("A7-idle-restart", "Explicit authenticated-API all-hosted restart (no UI restart control while the runtime is healthy) awaited native drain plus zero process exit; new frontend incarnation did not reopen or replay owners, then deliberate reopen retained the original identity.")

    # Complete one real native file tool, hold the next inference, lose the exact
    # supervised process, and verify interrupted saved identity after restart.
    interrupted = request(conversation, "MAINTENANCE_LOST_AFTER_TOOL", "maintenance-interrupted-original")
    provider.request().tool("maintenance-effect", "write_file", {"path": "maintenance-once.txt", "content": "NATIVE_EFFECT_ONCE\n"})
    held = provider.request()
    assert "maintenance-once.txt" in held.tool_result("maintenance-effect")
    assert (first / "maintenance-once.txt").read_text() == "NATIVE_EFFECT_ONCE\n"
    replacement.kill()
    replacement.wait(timeout=30)
    expect(page.get_by_test_id("coding-event-status")).to_contain_text("work may still be running", timeout=60000)
    # Typing stays enabled; the send explanation names the withheld native view.
    expect(page.locator("#coding-send-explanation")).to_have_text("Waiting for a connected, reconstructed native view.")
    expect(page.get_by_test_id("coding-run-status")).not_to_have_text("Completed")
    # The runtime notice must discard the prior generation's successful drain,
    # not contradict the disconnected native view with cached 'running/confirmed'.
    expect(maintenance).to_be_visible(timeout=60000)
    expect(page.get_by_test_id("coding-runtime-status")).to_contain_text("Mimir didn't shut down cleanly", timeout=60000)
    snapshot(page, "maintenance-desktop-process-loss")
    page.set_viewport_size({"width": 390, "height": 844})
    snapshot(page, "maintenance-narrow-process-loss")
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
    page.set_viewport_size({"width": 1440, "height": 1000})
    status = context.request.get(base + "/api/coding/runtime", headers=headers).json()
    assert status["state"] == "disconnected" and status["cleanup"]["confirmed"] is False
    evidence["process_loss"] = dict(status, pid=replacement.pid, request_id=interrupted["request_id"])
    held.text("LOST_PROCESS_RESPONSE_NOT_EXECUTED")
    scenario("A7-active-process-loss", "Killed only the exact supervised product process during an active request after a native file tool; disconnected state with blocked send remained visible, not Completed or Stopped, at desktop/narrow sizes. Runtime notice and native status showed cleanup unconfirmed.")

    # The visible runtime notice action is exercised by keyboard; a running
    # replacement hides the notice and the view still requires deliberate reopen.
    restart_from_browser()
    expect(maintenance).to_have_count(0, timeout=60000)
    expect(page.get_by_test_id("coding-disconnect-banner")).to_contain_text("Reopen this conversation from the sidebar", timeout=60000)
    reopen()
    state = captured_state(base, headers, conversation)
    original = next(item for item in state["requests"] if item["id"] == interrupted["request_id"])
    assert original["status"] == "interrupted" and state["active_request"] is None
    assert original["submission_key"] == interrupted["submission_key"]
    expect(page.get_by_test_id("coding-run-status")).to_contain_text("Interrupted · explicit continuation required", timeout=60000)
    expect(page.get_by_test_id("coding-transcript")).to_contain_text("MAINTENANCE_LOST_AFTER_TOOL")
    provider.assert_no_request()
    duplicate = request(conversation, "MAINTENANCE_LOST_AFTER_TOOL", interrupted["submission_key"])
    assert duplicate["request_id"] == interrupted["request_id"]
    provider.assert_no_request()
    assert captured_state(base, headers, conversation)["active_request"] is None
    snapshot(page, "maintenance-interrupted-reopened")
    scenario("A7-duplicate-key-interrupted", "After explicit process restart and deliberate reopen, same key returned the original interrupted request ID without a provider call, replayed tool, answer, or command; saved history and native identity remained readable.")

    continuation = page.get_by_test_id("coding-continue-interrupted")
    expect(continuation).to_be_visible()
    expect(continuation).to_have_attribute("aria-disabled", "false", timeout=60000)
    continuation.focus()
    expect(continuation).to_be_focused()
    with page.expect_response(lambda response: response.url == prompt_url and response.request.method == "POST", timeout=60000) as waiting:
        continuation.press("Enter")
    assert waiting.value.status == 202
    continued = waiting.value.json()
    assert continued["request_id"] != interrupted["request_id"]
    assert continued["submission_key"] != interrupted["submission_key"]
    evidence["requests"].append(dict(continued, text=waiting.value.request.post_data_json["text"]))
    provider.request().text("EXPLICIT_CONTINUATION_COMPLETED")
    wait_native_terminal(base, headers, conversation, continued["request_id"])
    expect(page.get_by_test_id("coding-run-status")).to_have_text("Completed", timeout=60000)
    expect(page.get_by_test_id("coding-transcript")).to_contain_text("EXPLICIT_CONTINUATION_COMPLETED", timeout=60000)
    assert (first / "maintenance-once.txt").read_text() == "NATIVE_EFFECT_ONCE\n"
    snapshot(page, "maintenance-explicit-continuation")
    scenario("A7-explicit-continuation", "Keyboard Continue on the interrupted-work control created one separate native admission/new key only after explicit activation; real request reached completed/settled terminal state. Prior tool effect was not replayed.")
    report["supervised_pid"] = owned_process().pid


def verify_shutdown(page, context, base, provider, report, scenario):
    """Exercise the production lifespan shutdown, not the server helper's exit."""
    headers = {"Authorization": "Bearer " + page.evaluate("localStorage.getItem('unsloth_auth_token')")}
    headers["X-Mimir-Runtime-Generation"] = str(context.request.get(base + "/api/coding/runtime", headers=headers).json()["generation"])
    conversation = opened_id(page)
    response = context.request.post(base + f"/api/coding/conversations/{conversation}/prompts", headers=headers,
                                    data={"submission_key": "shutdown-active", "text": "SHUTDOWN_NATIVE_ACTIVE"})
    assert response.status == 202
    held = provider.request()
    result = context.request.post(base + "/api/coding-acceptance/shutdown", headers=headers, timeout=90000)
    assert result.ok
    status = result.json()
    assert status["state"] == "stopped" and status["cleanup"]["confirmed"] is True
    assert status["cleanup"]["exit_code"] == 0 and status["cleanup"]["forced"] is False
    report["native_shutdown"] = dict(status, request_id=response.json()["request_id"])
    held.text("SHUTDOWN_CANCELLED_RESPONSE_NOT_EXECUTED")
    provider.assert_no_request()
    scenario("A7-native-shutdown-drain", "Production backend shutdown cancelled/drained active native work, awaited session and process cleanup, and returned explicit native confirmation plus zero exit without forced termination.")
