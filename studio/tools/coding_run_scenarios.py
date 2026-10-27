# SPDX-License-Identifier: AGPL-3.0-only
"""Rendered ticket-235 scenarios. No browser execution API is fulfilled or mocked."""
from __future__ import annotations

import re
import time

from coding_ui import open_saved, opened_id

# Rows show the native presentation verb ("Write: path", "Read: path", a shell
# call's "Run <command>"), never the tool name itself.
TOOL_VERBS = {"write_file": "Write", "read_file": "Read", "shell": "Run"}


def unfold_activity(page):
    """A settled turn folds its activity group; its tool rows mount only when unfolded."""
    from playwright.sync_api import expect
    folded = page.locator('[data-testid="coding-activity-group"] > button[aria-expanded="false"]')
    for _ in range(folded.count()):
        folded.first.click()
    expect(folded).to_have_count(0, timeout=60000)


def expand_tool(row):
    """Expand one tool row from its header with the keyboard; returns the header."""
    from playwright.sync_api import expect
    toggle = row.locator("button[aria-expanded]").first
    if toggle.get_attribute("aria-expanded") != "true":
        toggle.focus()
        toggle.press("Enter")
    expect(toggle).to_have_attribute("aria-expanded", "true", timeout=60000)
    return toggle


def tool_result(row):
    """An expanded row's actual result: its output, or its reported file changes."""
    return row.get_by_label("Tool output", exact=True).or_(row.get_by_test_id("coding-file-changes"))


def run_scenarios(page, context, base, provider, first, second_id, report, scenario, snapshot, *, live=False):
    from playwright.sync_api import expect
    import psutil

    conversation = opened_id(page)
    composer = page.get_by_label("Coding prompt", exact=True)
    transcript = page.get_by_test_id("coding-transcript")
    status = page.get_by_test_id("coding-run-status")
    send = page.get_by_role("button", name="Send", exact=True)
    headers = {"Authorization": "Bearer " + page.evaluate("localStorage.getItem('unsloth_auth_token')")}
    headers["X-Mimir-Runtime-Generation"] = str(context.request.get(base + "/api/coding/runtime", headers=headers).json()["generation"])
    evidence = report.setdefault("workload", {"kind": "live" if live else "deterministic-http-provider-real-native-tools", "requests": []})
    page.evaluate("""() => {
      window.codingAcceptanceStates = [];
      const capture = () => { const e = document.querySelector('[data-testid="coding-run-status"]');
        if (e && window.codingAcceptanceStates.at(-1) !== e.textContent) window.codingAcceptanceStates.push(e.textContent); };
      window.codingAcceptanceObserver = new MutationObserver(capture);
      window.codingAcceptanceObserver.observe(document.body, {subtree:true, childList:true, characterData:true}); capture();
    }""")

    def submit(text):
        composer.fill(text)
        expect(send).to_be_enabled(timeout=60000)
        with page.expect_response(lambda response: response.url == base + f"/api/coding/conversations/{conversation}/prompts" and response.request.method == "POST", timeout=60000) as waiting:
            composer.press("Enter")
        response = waiting.value
        assert response.status == 202, f"Prompt admission failed ({response.status})"
        body = response.request.post_data_json
        assert set(body) == {"submission_key", "text"} and body["text"] == text
        ack = response.json()
        identifier = ack["request_id"]
        assert ack["conversation_id"] == conversation and ack["submission_key"] == body["submission_key"]
        assert isinstance(identifier, str) and identifier
        evidence["requests"].append({"conversation_id": conversation, "submission_key": body["submission_key"], "request_id": identifier})
        return identifier, body

    def settled():
        expect(page.get_by_role("button", name="Stop", exact=True)).to_have_count(0, timeout=60000)
        expect(page.get_by_role("button", name="Stopping…", exact=True)).to_have_count(0, timeout=60000)
        # Empty composer may intentionally disable Send. A fresh draft tests native
        # settlement/admission readiness, rather than the composer text condition.
        composer.fill("next draft")
        expect(send).to_be_enabled(timeout=60000)
        composer.fill("")
        evidence.setdefault("terminal_statuses", []).append(status.inner_text())

    if live:
        evidence["deadline_seconds"] = 180
        identifier, _ = submit("In this disposable project only, use these native tools sequentially, not parallel or a combined shell-file operation: first use shell to run printf STUDIO_LIVE_TERMINAL_EVIDENCE; then use write_file to create studio-live-evidence.txt containing STUDIO_LIVE_FILE_EVIDENCE followed by a newline; finally use read_file to verify it. Do not read credentials or modify other files. Report completion briefly.")
        expect(status).not_to_contain_text("Loading", timeout=60000)
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            if (first / "studio-live-evidence.txt").is_file() and page.get_by_role("button", name="Stop", exact=True).count() == 0:
                break
            if re.search(r"failed|disconnected|completed|stopped|interrupted", status.inner_text(), re.I):
                break
            page.wait_for_timeout(250)
        snapshot(page, "live-terminal")
        evidence["terminal_status"] = status.inner_text()
        evidence["public_alerts"] = page.get_by_role("alert").all_inner_texts()
        if not (first / "studio-live-evidence.txt").is_file():
            evidence["status"] = "failed" if re.search(r"failed|disconnected|completed|ready|stopped|interrupted", status.inner_text(), re.I) else "blocked"
            evidence["incomplete_reason"] = "Existing native provider route did not reach the requested file outcome within the 180-second probe: " + status.inner_text() + "; external-versus-product cause not established by public diagnostics."
            scenario("A9-live-provider", evidence["incomplete_reason"])
            report["scenarios"][-1]["status"] = evidence["status"]
            report["limitations"].append(evidence["incomplete_reason"])
            return
        settled()
        expect(status).to_have_text("Completed", timeout=60000)
        assert (first / "studio-live-evidence.txt").read_text() == "STUDIO_LIVE_FILE_EVIDENCE\n"
        unfold_activity(page)
        live_rows = page.get_by_test_id("coding-tool-row")
        def live_row(name):
            return live_rows.filter(has_text=re.compile("^" + TOOL_VERBS[name] + r"\b")).last
        expect(live_row("write_file")).to_contain_text("studio-live-evidence.txt", timeout=60000)
        for name, output in (("shell", "STUDIO_LIVE_TERMINAL_EVIDENCE"), ("read_file", "STUDIO_LIVE_FILE_EVIDENCE")):
            expand_tool(live_row(name))
            expect(live_row(name).get_by_label("Tool output", exact=True)).to_contain_text(output, timeout=60000)
        assert live_rows.count() >= 3, "Live file outcome alone does not prove terminal/read tools"
        evidence["status"] = "passed"
        scenario("A9-live-provider", f"Existing native provider profile completed rendered request {identifier}, real terminal/file/read outcomes; no credentials in browser prompt")
        return

    (first / "unrelated.txt").write_text("preserve me\n")
    initial_prompt = "ACCEPTANCE_REAL_TOOLS: write evidence.txt, read it and verify with a real terminal; leave unrelated.txt unchanged"
    identifier, body = submit(initial_prompt)
    request = provider.request()
    expect(status).to_contain_text(re.compile("running", re.I), timeout=60000)
    snapshot(page, "desktop-running")
    # Idempotency retries the same accepted native submission, not another owner.
    duplicate = context.request.post(base + f"/api/coding/conversations/{conversation}/prompts", data=body, headers=headers)
    assert duplicate.status == 202 and duplicate.json()["request_id"] == identifier
    busy = context.request.post(base + f"/api/coding/conversations/{conversation}/prompts",
                                data={"submission_key": "acceptance-busy-distinct-key", "text": "Must reject busy without provider replay"}, headers=headers)
    assert busy.status == 409, f"Native active-request admission must reject distinct Start ({busy.status})"
    # The UI shows no request IDs; the same-key ack above proves the exact request.
    expect(status).to_have_text("Running")
    provider.assert_no_request()
    scenario("A1-busy-native-admission", "Distinct submission rejected as native busy while same-key retry retained exact accepted request; no second execution loop/provider replay")
    request.tool("acceptance-write", "write_file", {"path": "evidence.txt", "content": "REAL_NATIVE_TOOL_EVIDENCE\n"})
    request = provider.request()
    assert "evidence.txt" in request.tool_result("acceptance-write")
    request.tool("acceptance-read", "read_file", {"paths": ["evidence.txt"]})
    request = provider.request()
    assert "REAL_NATIVE_TOOL_EVIDENCE" in request.tool_result("acceptance-read")
    request.tool("acceptance-shell", "shell", {"command": "printf REAL_NATIVE_TERMINAL_EVIDENCE; test \"$(cat evidence.txt)\" = REAL_NATIVE_TOOL_EVIDENCE", "timeout_seconds": 30, "yield_time_ms": 10000})
    request = provider.request()
    assert "REAL_NATIVE_TERMINAL_EVIDENCE" in request.tool_result("acceptance-shell")
    request.text("ACCEPTANCE_COMPLETE: verified native file and terminal")
    settled()
    assert (first / "evidence.txt").read_text() == "REAL_NATIVE_TOOL_EVIDENCE\n"
    assert (first / "unrelated.txt").read_text() == "preserve me\n"
    expect(transcript).to_contain_text("ACCEPTANCE_COMPLETE", timeout=60000)
    expect(transcript.get_by_text(initial_prompt, exact=True)).to_have_count(1)
    expect(transcript).not_to_contain_text("Must reject busy without provider replay")
    unfold_activity(page)
    rows = page.get_by_test_id("coding-tool-row")
    assert rows.count() >= 3
    evidence["tool_identities"] = []
    for call, name, output in (("acceptance-write", "write_file", "evidence.txt"),
                               ("acceptance-read", "read_file", "REAL_NATIVE_TOOL_EVIDENCE"),
                               ("acceptance-shell", "shell", "REAL_NATIVE_TERMINAL_EVIDENCE")):
        # Output details are intentionally unmounted while collapsed.
        row = page.locator(f'[data-testid="coding-tool-row"][data-call-id="{call}"]')
        expect(row).to_have_count(1)
        header = expand_tool(row)
        expect(header).to_contain_text(TOOL_VERBS[name])
        expect(tool_result(row)).to_contain_text(output)
        detail = row.get_attribute("data-invocation-id")
        assert detail and detail not in ("undefined", "null"), "Native invocation identity missing from public tool row"
        evidence["tool_identities"].append({"call_id": call, "name": name, "public_identity": detail})
    # Call identities are row attributes, not text: mark each row in document order.
    public_text = transcript.evaluate("""root => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      let text = '';
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
        else if (node.dataset?.testid === 'coding-tool-row') text += '\\n' + node.dataset.callId + '\\n';
      }
      return text;
    }""")
    chronology = [public_text.index(value) for value in (initial_prompt, "acceptance-write", "acceptance-read", "acceptance-shell", "ACCEPTANCE_COMPLETE")]
    assert chronology == sorted(chronology), "Rendered native messages/tools are not chronological"
    # Actual public output was expanded with keyboard only above.
    shell_row = page.locator('[data-testid="coding-tool-row"][data-call-id="acceptance-shell"]')
    expect(shell_row.get_by_label("Tool output", exact=True)).to_contain_text("REAL_NATIVE_TERMINAL_EVIDENCE")
    snapshot(page, "desktop-tools-public-output")
    scenario("A1-native-identities-tools", "Enter admission + same-key retry preserved one input and exact native request; chronological real write/read/shell rows, identities, outputs and host file checked; public shell output expanded by keyboard")

    submit("ACCEPTANCE_BOUNDED_OUTPUT")
    provider.request().text("PUBLIC_BOUND_START " + "x" * 40000 + " PUBLIC_TAIL_OUTSIDE_BOUND")
    settled()
    expect(transcript).to_contain_text("PUBLIC_BOUND_START", timeout=60000)
    expect(transcript).to_contain_text("clipped", timeout=60000)
    expect(transcript).not_to_contain_text("PUBLIC_TAIL_OUTSIDE_BOUND")
    snapshot(page, "desktop-output-clipped")
    scenario("A2-public-output-bound", "40000-byte provider text bounded by native public projection; explicit clipping disclosure and omitted tail verified")

    # A deterministic tool failure is real host execution, not a simulated result.
    submit("ACCEPTANCE_TOOL_FAILURE: demonstrate failing native shell")
    provider.request().tool("acceptance-failed-shell", "shell", {"command": "printf REAL_TOOL_FAILURE >&2; exit 7", "timeout_seconds": 30, "yield_time_ms": 10000})
    request = provider.request()
    assert "REAL_TOOL_FAILURE" in request.tool_result("acceptance-failed-shell")
    request.text("ACCEPTANCE_FAILURE_EXPLAINED: command failed with exit 7")
    settled()
    unfold_activity(page)
    failed_row = page.locator('[data-testid="coding-tool-row"][data-call-id="acceptance-failed-shell"]')
    expand_tool(failed_row)
    expect(failed_row).to_have_attribute("data-tool-status", "failed")
    # The header and command echo the input; the output region is the actual result.
    expect(failed_row.get_by_label("Tool output", exact=True)).to_contain_text("REAL_TOOL_FAILURE")
    expect(failed_row.get_by_label("Tool output", exact=True)).to_contain_text("exit code 7")
    snapshot(page, "desktop-tool-failed")
    scenario("A7-actual-tool-failure", "Native shell exit 7 and actual stderr inspectable in rendered tool details")

    submit("ACCEPTANCE_PROVIDER_FAILURE")
    provider.request().fail()
    expect(status).to_contain_text(re.compile("failed", re.I), timeout=60000)
    settled()
    # The alert carries the native completion error text itself.
    expect(page.get_by_test_id("coding-event-status").get_by_role("alert").first).to_have_text(re.compile(r"\S"), timeout=60000)
    snapshot(page, "desktop-provider-failed")
    scenario("A7-provider-failure", "External HTTP provider 400 reached native failed evidence and rendered non-color Failed state")

    # Detach a running second browser view without cancelling its native owner.
    first_id = conversation
    open_saved(page, base, second_id)
    conversation = second_id
    other_id, _ = submit("ACCEPTANCE_UNRELATED_HELD_REQUEST")
    other_request = provider.request()
    expect(status).to_contain_text(re.compile("running", re.I), timeout=60000)
    # Only disconnect the browser transport, never fulfill execution or history.
    # The fault holds until lifted so automatic retries cannot hide Disconnected.
    events_url = base + f"/api/coding/conversations/{second_id}/events"
    def reset_events(route):
        route.abort("connectionreset")
    page.route(events_url, reset_events)
    open_saved(page, base, second_id, ready=False)
    expect(status).to_contain_text("Disconnected", timeout=60000)
    expect(status).to_contain_text("work may still be running")
    snapshot(page, "desktop-disconnected-work-unconfirmed")
    page.unroute(events_url, reset_events)
    page.get_by_test_id("coding-disconnect-banner").get_by_role("button", name="Reconnect", exact=True).click()
    expect(status).to_contain_text(re.compile("running", re.I), timeout=60000)
    expect(page.get_by_test_id("coding-disconnect-banner")).to_have_count(0, timeout=60000)
    provider.assert_no_request()
    scenario("A7-disconnected-running", "Browser stream fault showed Disconnected/work may still be running; native reconnect recovered exact running request without provider replay")
    open_saved(page, base, first_id)
    conversation = first_id
    # Cancellation happens while shell executes (before its retained yield).
    active, _ = submit("ACCEPTANCE_CANCEL_REAL_SHELL")
    request = provider.request()
    expect(status).to_have_text("Running", timeout=60000)
    expect(page.get_by_test_id("coding-event-status").get_by_role("alert")).to_have_count(0)
    request.tool("acceptance-held-shell", "shell", {"command": "echo $$ > cancellation.pid; exec sleep 120", "timeout_seconds": 180, "yield_time_ms": 10000})
    deadline = time.monotonic() + 30
    while not (first / "cancellation.pid").is_file() and time.monotonic() < deadline:
        page.wait_for_timeout(50)
    assert (first / "cancellation.pid").is_file(), "Native shell never started"
    pid = int((first / "cancellation.pid").read_text())
    process = psutil.Process(pid)
    assert "sleep" in process.name() and "120" in process.cmdline(), "PID identity did not match acceptance shell"
    created = process.create_time()
    wrong = context.request.post(base + f"/api/coding/conversations/{second_id}/requests/{active}/cancel", headers=headers)
    assert wrong.ok and wrong.json().get("cancel_requested") is False, "Wrong-conversation cancellation must not accept this request"
    assert process.is_running(), "Wrong conversation killed accepted native work"
    stop = page.get_by_role("button", name="Stop", exact=True)
    stop.focus()
    with page.expect_response(lambda response: response.url == base + f"/api/coding/conversations/{conversation}/requests/{active}/cancel" and response.request.method == "POST", timeout=60000) as waiting:
        stop.press("Enter")
        stopping_button = page.get_by_role("button", name="Stopping…", exact=True)
        if stopping_button.count():
            expect(stopping_button).to_be_disabled()
            expect(page.get_by_test_id("coding-event-status").get_by_role("alert")).to_have_count(0)
            snapshot(page, "desktop-stopping")
    assert waiting.value.ok and waiting.value.json().get("cancel_requested") is True
    settled()
    assert not psutil.pid_exists(pid) or psutil.Process(pid).create_time() != created, "UI settled before exact native process cleanup"
    states = page.evaluate("window.codingAcceptanceStates")
    evidence["rendered_states"] = states
    for required_state in ("loading", "running", "failed", "disconnected", "stopping"):
        assert any(required_state in state.lower() for state in states), f"{required_state} must be rendered, not inferred from HTTP acceptance"
    evidence["cancelled_process"] = {"pid": pid, "create_time": created, "settled": True, "request_id": active, "wrong_conversation_id": second_id}
    snapshot(page, "desktop-cancelled-cleanup")
    scenario("A7-exact-cancel-cleanup", "Keyboard Stop targeted accepted request; wrong-conversation cancel refused; rendered Stopping retained until native settlement; exact sleep process gone")
    open_saved(page, base, second_id)
    conversation = second_id
    # Still running: the held provider request (other_id) completes below.
    expect(status).to_contain_text(re.compile("running", re.I), timeout=60000)
    other_request.text("UNRELATED_REQUEST_COMPLETED_AFTER_OTHER_CANCEL")
    settled()
    expect(transcript).to_contain_text("UNRELATED_REQUEST_COMPLETED_AFTER_OTHER_CANCEL", timeout=60000)
    scenario("A7-detach-unrelated-owner", "Detached second conversation preserved exact active request and completed after first conversation cancellation; no unrelated owner close")
    open_saved(page, base, first_id)
    conversation = first_id
    expect(transcript).to_contain_text("ACCEPTANCE_COMPLETE", timeout=60000)
    expect(transcript).not_to_contain_text("UNRELATED_REQUEST_COMPLETED_AFTER_OTHER_CANCEL")

    page.set_viewport_size({"width": 390, "height": 844})
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "Narrow transcript causes horizontal document overflow"
    unfold_activity(page)
    narrow_tool = page.locator('[data-testid="coding-tool-row"][data-call-id="acceptance-failed-shell"]')
    expand_tool(narrow_tool)
    public_output = narrow_tool.get_by_label("Tool output", exact=True)
    public_output.focus()
    expect(public_output).to_be_focused()
    expect(public_output).to_be_visible()
    expect(public_output).to_contain_text("REAL_TOOL_FAILURE")
    snapshot(page, "narrow-tool-inspection")
    submit("ACCEPTANCE_NARROW_KEYBOARD")
    provider.request().text("ACCEPTANCE_NARROW_KEYBOARD_COMPLETED")
    settled()
    expect(transcript).to_contain_text("ACCEPTANCE_NARROW_KEYBOARD_COMPLETED", timeout=60000)
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
    snapshot(page, "narrow-keyboard-completed")
    scenario("A10-narrow-run-keyboard", "390x844 executed transcript has no horizontal overflow; keyboard tool inspection and Enter submission reached native terminal completion")
    page.set_viewport_size({"width": 1440, "height": 1000})
    provider.assert_no_request()
    evidence["status"] = "passed"
