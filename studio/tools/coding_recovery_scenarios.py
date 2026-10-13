# SPDX-License-Identifier: AGPL-3.0-only
"""Ticket-236 actual-browser recovery scenarios with explicit transport faults.

Every accepted request, public history page and tool result comes from the real
Studio route/plugin/native harness. Provider replies and the labeled recovering
reset are deterministic fixtures, not live-model acceptance.
"""
from __future__ import annotations

import json
import re
import urllib.request


VIEW_FAULT_SCRIPT = """(() => {
  const fetchNative = window.fetch.bind(window);
  window.codingDropView = false;
  window.fetch = async (...args) => {
    const response = await fetchNative(...args);
    const url = String(args[0] instanceof Request ? args[0].url : args[0]);
    if (!url.includes('/api/coding/conversations/') || !url.endsWith('/events') || !response.ok || !response.body) return response;
    const reader = response.body.getReader();
    return new Response(new ReadableStream({ async start(controller) {
      try {
        for (;;) {
          const {done, value} = await reader.read();
          if (window.codingDropView) {
            await reader.cancel();
            controller.error(new TypeError('Acceptance-only lost browser stream'));
            return;
          }
          if (done) { controller.close(); return; }
          controller.enqueue(value);
        }
      } catch (error) { controller.error(error); }
    }, cancel() { return reader.cancel(); } }), {status: response.status, headers: response.headers});
  };
})();"""


def captured_state(base, headers, conversation):
    """One fresh atomic view capture, not lifecycle polling or mutable history."""
    request = urllib.request.Request(base + f"/api/coding/conversations/{conversation}/events", headers=headers)
    with urllib.request.urlopen(request, timeout=60) as response:
        for _ in range(20):
            line = response.readline()
            if line.startswith(b"data: "):
                item = json.loads(line[6:])
                assert item["event"]["type"] == "start"
                return item["event"]["state"]
    raise AssertionError("The real native view did not supply its first capture")


def run_recovery_scenarios(page, context, base, provider, first, second_id, report,
                           scenario, snapshot, restart_server):
    from playwright.sync_api import expect

    conversation = page.get_by_test_id("coding-conversation-id").inner_text()
    headers = {"Authorization": "Bearer " + page.evaluate("localStorage.getItem('unsloth_auth_token')")}
    evidence = report.setdefault("recovery", {"kind": "deterministic-transport-faults-real-native-execution", "requests": []})
    prompt_url = base + f"/api/coding/conversations/{conversation}/prompts"
    event_url = base + f"/api/coding/conversations/{conversation}/events"
    entry_url = base + f"/api/coding/conversations/{conversation}/entries"

    def reopen(target=page, identifier=conversation):
        saved = target.locator('[aria-label="Saved coding conversations"] button').filter(has_text=identifier)
        expect(saved).to_be_visible(timeout=60000)
        saved.click()
        expect(target.get_by_test_id("coding-conversation-id")).to_have_text(identifier, timeout=60000)
        expect(target.get_by_test_id("coding-event-status")).to_contain_text("Native event stream connected", timeout=60000)

    def settled(marker):
        expect(page.get_by_test_id("coding-run-status")).to_have_text("Completed", timeout=60000)
        expect(page.get_by_test_id("coding-transcript")).to_contain_text(marker, timeout=60000)
        expect(page.get_by_role("button", name="Stop", exact=True)).to_have_count(0)

    def submit(text):
        page.get_by_label("Coding prompt", exact=True).fill(text)
        with page.expect_response(lambda response: response.url == prompt_url and response.request.method == "POST", timeout=60000) as waiting:
            page.get_by_label("Coding prompt", exact=True).press("Enter")
        assert waiting.value.status == 202
        body = waiting.value.request.post_data_json
        ack = waiting.value.json()
        evidence["requests"].append(dict(ack, text=text))
        return ack, body

    # Actual full-page navigation, refresh and a tab closure while provider work
    # is held. The browser is never the native cancellation/lease owner.
    ack, _ = submit("RECOVERY_NAVIGATION_HELD")
    held = provider.request()
    page.goto(base + "/api/auth/status")
    provider.assert_no_request()
    page.goto(base + "/coding")
    reopen()
    expect(page.get_by_test_id("coding-run-status")).to_have_text("Running", timeout=60000)
    expect(page.get_by_test_id("coding-request-id")).to_contain_text(ack["request_id"])
    page.reload()
    reopen()
    tab = context.new_page()
    tab.goto(base + "/coding")
    reopen(tab)
    tab.close()
    expect(page.get_by_test_id("coding-request-id")).to_contain_text(ack["request_id"])
    provider.assert_no_request()
    scenario("A7-navigation-refresh-tab", "Actual full-page navigation, refresh, deliberate reopen and closing a second viewing tab retained the exact running native request; no provider replay")

    # Persistent outage through several automatic retries. Stop remains live/
    # unknown, never inferred cancelled. Recovery uses a fresh real native view.
    outage = {"active": True}
    def disconnect(route):
        route.abort("connectionreset") if outage["active"] else route.continue_()
    page.route(event_url, disconnect)
    reopen_button = page.locator('[aria-label="Saved coding conversations"] button').filter(has_text=conversation)
    reopen_button.click()
    expect(page.get_by_test_id("coding-event-status")).to_contain_text("work may still be running", timeout=60000)
    snapshot(page, "recovery-desktop-disconnected")
    page.set_viewport_size({"width": 390, "height": 844})
    snapshot(page, "recovery-narrow-disconnected")
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
    page.set_viewport_size({"width": 1440, "height": 1000})
    page.wait_for_timeout(1600)
    expect(page.get_by_test_id("coding-event-status")).to_contain_text("work may still be running")
    outage["active"] = False
    expect(page.get_by_test_id("coding-event-status")).to_contain_text("Native event stream connected", timeout=60000)
    expect(page.get_by_test_id("coding-request-id")).to_contain_text(ack["request_id"])
    provider.assert_no_request()
    page.unroute(event_url, disconnect)
    scenario("A7-automatic-authoritative-reconnect", "Outage persisted over automatic retries at 1440x1000 and 390x844; banner retained work-unknown state; automatic fresh captured view recovered the original running request without user replay")

    # Failing the bounded captured-cut read must not advertise complete history.
    incomplete = {"active": True}
    def fail_history(route):
        route.abort("connectionreset") if incomplete["active"] else route.continue_()
    page.route(entry_url, fail_history)
    reopen_button.click()
    expect(page.get_by_test_id("coding-event-status")).to_contain_text("work may still be running", timeout=60000)
    expect(page.get_by_label("Coding prompt", exact=True)).to_be_disabled()
    snapshot(page, "recovery-incomplete-history")
    incomplete["active"] = False
    expect(page.get_by_test_id("coding-event-status")).to_contain_text("Native event stream connected", timeout=60000)
    page.unroute(entry_url, fail_history)
    scenario("A1-incomplete-history", "Injected bounded-entry transport failure withheld connected/ready state and disabled submission until automatic captured-cut reconstruction succeeded")

    reset = context.request.post(base + f"/api/coding-acceptance/reset/{conversation}", headers=headers)
    assert reset.ok
    reopen_button.click()
    expect(page.get_by_test_id("coding-run-status")).to_contain_text("Recovering", timeout=60000)
    expect(page.get_by_label("Coding prompt", exact=True)).to_be_disabled()
    snapshot(page, "recovery-native-cut-reset")
    held.tool("recovery-write", "write_file", {"path": "recovery.txt", "content": "RECOVERY_NATIVE_FILE\n"})
    request = provider.request()
    assert "recovery.txt" in request.tool_result("recovery-write")
    request.text("RECOVERY_NATIVE_COMPLETED")
    settled("RECOVERY_NATIVE_COMPLETED")
    assert (first / "recovery.txt").read_text() == "RECOVERY_NATIVE_FILE\n"
    rows = page.get_by_test_id("coding-tool-row").filter(has_text="recovery-write")
    expect(rows).to_have_count(1)
    expect(page.get_by_test_id("coding-transcript").get_by_text("RECOVERY_NAVIGATION_HELD", exact=True)).to_have_count(1)
    reopen_button.click()
    expect(page.get_by_test_id("coding-run-status")).to_have_text("Completed", timeout=60000)
    expect(rows).to_have_count(1)
    expect(rows).not_to_contain_text(" · running")
    scenario("A1-reset-recovering-checkpoint", "Acceptance-only transport duplicated a real atomic native start as recovering reset; real tool/checkpoint settled recovery, one input/tool row remained, filesystem effect verified and reopen did not make historical activity live")

    # A failed-before-delivery attempt survives frontend reload. The UI retries
    # with the original durable key, not a new submission.
    captured = []
    def lose_before_delivery(route):
        captured.append(route.request.post_data_json)
        route.abort("connectionreset")
    page.route(prompt_url, lose_before_delivery, times=1)
    page.get_by_label("Coding prompt", exact=True).fill("RECOVERY_RETRY_AFTER_RELOAD")
    page.get_by_label("Coding prompt", exact=True).press("Enter")
    expect(page.get_by_role("button", name=re.compile("Retry.*submission", re.I))).to_be_visible(timeout=60000)
    assert len(captured) == 1
    provider.assert_no_request()
    page.reload()
    reopen()
    retry = page.get_by_role("button", name=re.compile("Retry.*submission", re.I))
    expect(retry).to_be_visible(timeout=60000)
    with page.expect_response(lambda response: response.url == prompt_url and response.request.method == "POST", timeout=60000) as waiting:
        retry.click()
    assert waiting.value.status == 202
    assert waiting.value.request.post_data_json == captured[0]
    ack_retry = waiting.value.json()
    evidence["requests"].append(dict(ack_retry, text=captured[0]["text"]))
    provider.request().text("RECOVERY_RETRY_COMPLETED")
    settled("RECOVERY_RETRY_COMPLETED")
    scenario("A7-pending-key-frontend-restart", "Transport aborted before delivery; actual reload/deliberate reopen retained pending input and retry sent exactly the original persisted submission key/text, completing one native request")

    # Install a browser-only stream-loss shim. It discards received transport
    # bytes, not native state, and never fabricates an acceptance/history result.
    page.add_init_script(VIEW_FAULT_SCRIPT)
    page.reload()
    reopen()
    cancel_ack, _ = submit("RECOVERY_LOST_CANCEL_ACK")
    cancelled_provider = provider.request()
    cancellations = []
    cancel_url = base + f"/api/coding/conversations/{conversation}/requests/{cancel_ack['request_id']}/cancel"
    def lose_cancel_ack(route):
        response = route.fetch(timeout=60000)
        assert response.ok and response.json()["cancel_requested"] is True
        cancellations.append(response.json())
        route.abort("connectionreset")
    page.route(cancel_url, lose_cancel_ack)
    page.evaluate("window.codingDropView = true")
    page.get_by_role("button", name="Stop", exact=True).click()
    expect(page.get_by_test_id("coding-event-status")).to_contain_text("work may still be running", timeout=60000)
    snapshot(page, "recovery-cancel-ack-lost")
    wait_native_terminal(base, headers, conversation, cancel_ack["request_id"], expected_status="cancelled")
    page.evaluate("window.codingDropView = false")
    expect(page.get_by_test_id("coding-run-status")).to_contain_text("Stopped", timeout=60000)
    assert len(cancellations) == 1, "Uncertain non-prompt commands must never be automatically replayed"
    page.unroute(cancel_url, lose_cancel_ack)
    provider.assert_no_request()
    scenario("A7-uncertain-nonprompt-reconciliation", "Actual cancel ACK was lost after native acceptance; Stop was not replayed, unknown/stopping state stayed until automatic fresh native capture confirmed terminal cancellation")
    # Release only the fixture's already-cancelled HTTP response, not native work.
    cancelled_provider.text("CANCELLED_FIXTURE_RESPONSE_NOT_EXECUTED")
    lost = []
    def lose_after_acceptance(route):
        body = route.request.post_data_json
        persisted = page.evaluate("id => JSON.parse(localStorage.getItem('unsloth:coding:pending-submission:' + encodeURIComponent(id)))", conversation)
        assert persisted and persisted["conversation_id"] == conversation and persisted["key"] == body["submission_key"] and persisted["text"] == body["text"], "Submission identity must be durable before uncertain delivery"
        response = route.fetch(timeout=60000)
        assert response.status == 202
        lost.append({"body": body, "ack": response.json()})
        route.abort("connectionreset")
    page.route(prompt_url, lose_after_acceptance, times=1)
    page.evaluate("window.codingDropView = true")
    page.get_by_label("Coding prompt", exact=True).fill("RECOVERY_LOST_ACCEPTED_ACK")
    page.get_by_label("Coding prompt", exact=True).press("Enter")
    expect(page.get_by_test_id("coding-event-status")).to_contain_text("work may still be running", timeout=60000)
    request = provider.request()
    assert len(lost) == 1
    request.text("RECOVERY_LOST_ACK_COMPLETED")
    state = captured_state(base, headers, conversation)
    # Wait for native settlement via a fresh ordered view, not historical text or
    # arbitrary sleep. The helper below consumes completion if the capture is busy.
    if state["active_request"] is not None:
        wait_native_terminal(base, headers, conversation, lost[0]["ack"]["request_id"])
    snapshot(page, "recovery-accepted-ack-lost")
    # Backend/plugin restart is deliberate, only after authoritative terminal
    # settlement. Browser storage and native history remain unchanged.
    restart_server()
    page.reload()
    reopen()
    settled("RECOVERY_LOST_ACK_COMPLETED")
    expect(page.get_by_role("button", name=re.compile("Retry.*submission", re.I))).to_have_count(0)
    duplicate = context.request.post(prompt_url, data=lost[0]["body"], headers=headers)
    assert duplicate.status == 202
    assert duplicate.json() == lost[0]["ack"], "Restarted native deduplication must return original accepted identity"
    provider.assert_no_request()
    expect(page.get_by_test_id("coding-transcript").get_by_text("RECOVERY_LOST_ACCEPTED_ACK", exact=True)).to_have_count(1)
    evidence["requests"].append(dict(lost[0]["ack"], text=lost[0]["body"]["text"]))
    scenario("A7-lost-ack-plugin-frontend-restart", "Real native acceptance ACK was dropped after durable browser-key persistence; hidden work completed; clean backend/plugin restart plus browser reload rebuilt native history, reconciled delivery, and duplicate same-key HTTP submission returned the original identity without provider execution")
    snapshot(page, "recovery-desktop-reopened")
    page.set_viewport_size({"width": 390, "height": 844})
    snapshot(page, "recovery-narrow-reopened")
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
    page.set_viewport_size({"width": 1440, "height": 1000})

    # Lost non-keyed opening acknowledgment: inspect the shared native catalog
    # and deliberately reopen its exact identity instead of creating another copy.
    uncertain_project = first.parent / "uncertain-opening-project"
    uncertain_project.mkdir()
    created = []
    create_url = base + "/api/coding/conversations"
    def lose_create_ack(route):
        if route.request.method != "POST":
            route.continue_()
            return
        response = route.fetch(timeout=60000)
        assert response.status == 201
        created.append(response.json())
        route.abort("connectionreset")
    page.route(create_url, lose_create_ack)
    page.get_by_role("button", name="Choose another project", exact=True).click()
    page.get_by_label("Host folder path", exact=True).fill(str(uncertain_project))
    page.get_by_role("button", name="Browse", exact=True).click()
    expect(page.get_by_test_id("coding-browsed-path")).to_have_text(str(uncertain_project))
    page.get_by_role("button", name="Open project", exact=True).click()
    expect(page.get_by_role("alert").filter(has_text="Opening is unconfirmed")).to_be_visible(timeout=60000)
    expect(page.get_by_role("button", name="Open project", exact=True)).to_be_disabled()
    assert len(created) == 1
    page.get_by_role("button", name="Cancel", exact=True).click()
    snapshot(page, "recovery-opening-ack-lost")
    identifier = created[0]["id"]
    reopen(identifier=identifier)
    expect(page.get_by_test_id("coding-canonical-cwd")).to_have_text(str(uncertain_project))
    assert len(created) == 1
    page.unroute(create_url, lose_create_ack)
    report["conversation_ids"].append(identifier)
    reopen()
    scenario("A7-uncertain-opening-reconciliation", "Real create ACK was lost; UI inspected authenticated native history, blocked another creation, and deliberately reopened the exact saved identity without substituting cwd or assuming generic exactly-once")

    prompt_attempts = []
    def count_prompt(request):
        if request.url == prompt_url and request.method == "POST":
            prompt_attempts.append(request.url)
    page.on("request", count_prompt)
    page.evaluate("""() => {
      const original = Storage.prototype.setItem;
      window.codingRestoreStorage = () => { Storage.prototype.setItem = original; };
      Storage.prototype.setItem = function(key, value) {
        if (key.startsWith('unsloth:coding:pending-submission:')) throw new DOMException('Acceptance-only quota failure', 'QuotaExceededError');
        return original.call(this, key, value);
      };
    }""")
    marker = "RECOVERY_UNSENT_DRAFT_MUST_BE_RETAINED"
    page.get_by_label("Coding prompt", exact=True).fill(marker)
    page.get_by_label("Coding prompt", exact=True).press("Enter")
    draft = page.get_by_test_id("coding-unsent-draft")
    expect(draft).to_have_value(marker, timeout=60000)
    expect(page.get_by_test_id("coding-submission-storage-error")).to_be_visible()
    expect(page.get_by_label("Coding prompt", exact=True)).to_be_disabled()
    draft.focus()
    draft.press("Control+a")
    assert draft.evaluate("el => el.selectionStart === 0 && el.selectionEnd === el.value.length")
    assert not prompt_attempts, "Persistence failure must prevent HTTP delivery"
    provider.assert_no_request()
    snapshot(page, "recovery-storage-quota-draft-desktop")
    page.set_viewport_size({"width": 390, "height": 844})
    snapshot(page, "recovery-storage-quota-draft-narrow")
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
    page.set_viewport_size({"width": 1440, "height": 1000})
    page.evaluate("window.codingRestoreStorage()")
    page.remove_listener("request", count_prompt)
    page.reload()
    reopen()
    scenario("A7-durable-storage-fails-closed", "Actual rendered composer.send with injected quota failure made zero HTTP/provider submissions; unsent text remained selectable by keyboard with explicit memory-only/copy-before-leaving warning at desktop/narrow sizes")
    evidence["status"] = "passed"


def wait_native_terminal(base, headers, conversation, request_id, *, expected_status="completed"):
    request = urllib.request.Request(base + f"/api/coding/conversations/{conversation}/events", headers=headers)
    with urllib.request.urlopen(request, timeout=60) as response:
        while True:
            line = response.readline()
            assert line, "Native view disconnected before settlement"
            if not line.startswith(b"data: "):
                continue
            event = json.loads(line[6:])["event"]
            if event["type"] in ("start", "reset"):
                state = event["state"]
                if state["active_request"] != request_id and any(item["id"] == request_id and item["status"] == expected_status for item in state["requests"]):
                    return
            if event["type"] == "completed" and event["request_id"] == request_id:
                assert not event.get("failed") and event.get("error") is None
                return
