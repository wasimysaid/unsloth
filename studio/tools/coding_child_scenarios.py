# SPDX-License-Identifier: AGPL-3.0-only
"""Ticket-241 rendered inspection with real native delegation, not a live model.

The external provider supplies deterministic replies only. Native Mimir owns
launch, continuation, journaling, outcomes and completion delivery. Browser
faults affect the view transport only, never execution or retained history.
"""
from __future__ import annotations

import hashlib
import json
import re


FIRST_OBJECTIVE = "CHILD_INSPECT_ATTEMPT_ONE"
SECOND_OBJECTIVE = "CHILD_INSPECT_ATTEMPT_TWO"
FIRST_RESULT = "CHILD_ONE_RETAINED_RESULT"
FIRST_TAIL = "CHILD_ONE_TAIL_OUTSIDE_PUBLIC_BOUND"
FINAL_RESULT = "PARENT_INTEGRATED_BOTH_CHILD_ATTEMPTS"

# Observe public SSE metadata without fulfilling APIs or saving provider context.
# A tee preserves the application's stream, including backpressure/cancellation.
CHILD_EVENT_CAPTURE = r"""(() => {
  const original = window.fetch.bind(window);
  window.codingChildEvents = [];
  let connection = 0;
  window.fetch = async (...args) => {
    const response = await original(...args);
    const url = String(args[0] instanceof Request ? args[0].url : args[0]);
    if (!url.includes('/api/coding/conversations/') || !url.endsWith('/events') || !response.ok || !response.body) return response;
    const generation = ++connection;
    const reader = response.clone().body.getReader();
    (async () => {
      let buffer = ''; const decoder = new TextDecoder();
      try {
        for (;;) {
          const {done, value} = await reader.read(); if (done) break;
          buffer += decoder.decode(value, {stream:true});
          let end;
          while ((end = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, end).trimEnd(); buffer = buffer.slice(end + 1);
            if (!line.startsWith('data: ')) continue;
            const item = JSON.parse(line.slice(6)), event = item.event;
            if (window.codingChildEvents.length >= 4096) throw new Error('Child evidence metadata bound exceeded');
            window.codingChildEvents.push({connection:generation, position:item.position, type:event.type,
              child:event.child || null, cut:event.cut || null,
              children:event.children || null, root:event.root?.cut || null});
          }
        }
      } catch (error) {
        // Native view detach/reopen intentionally aborts an existing fetch.
        if (error.name !== 'AbortError' && !(error instanceof TypeError)) window.codingChildCaptureError = String(error);
      }
      finally { reader.releaseLock(); }
    })();
    return response;
  };
})();"""


def admitted_identity(receipt: str, attempt: int) -> tuple[str, int]:
    match = re.search(r"ID (agent-[^,\s]+), attempt (\d+)", receipt)
    assert match, "Actual native background admission receipt omitted child/attempt identity"
    assert int(match[2]) == attempt, "Native admission did not retain the expected attempt"
    return match[1], int(match[2])


def assert_outcome(detail: dict, handle: str, attempt: int, status: str) -> dict:
    outcome = detail.get("outcome")
    assert outcome and (outcome.get("handle"), outcome.get("attempt")) == (handle, attempt), "Retained outcome was absent or retargeted to a different attempt"
    assert outcome["status"] == status, "Retained outcome terminal status mismatched"
    # The native contract identifies an outcome by (handle, attempt). There is
    # no independent outcome UUID, so never invent one in the acceptance report.
    return outcome


def validate_child_events(events: list[dict], handle: str) -> dict:
    last = {}
    scopes = {1: set(), 2: set()}
    lifecycles = {1: [], 2: []}
    for event in events:
        generation, position = event["connection"], event["position"]
        assert isinstance(position, int) and position > last.get(generation, -1), "Native view positions were not strictly ordered within a connection"
        last[generation] = position
        child = event.get("child")
        if not child or child.get("handle") != handle:
            continue
        attempt = child.get("attempt")
        assert attempt in scopes, "Child event omitted or changed exact attempt identity"
        kind = event["type"]
        scopes[attempt].add(kind)
        if kind == "child":
            lifecycles[attempt].append(child["status"])
        if kind == "checkpoint":
            assert event["cut"]["journal"] == {"child": handle}, "Child checkpoint used the root or wrong journal"
    for attempt, required in ((1, {"child", "activity", "checkpoint"}), (2, {"child", "activity"})):
        assert required <= scopes[attempt], f"Missing actual child {attempt} lifecycle/activity/history evidence: {scopes[attempt]}"
    assert "completed" in lifecycles[1] and "failed" in lifecycles[2], "Launch acceptance was mistaken for child settlement"
    return {"connections": len(last), "events": len(events), "attempt_event_types": {str(key): sorted(value) for key, value in scopes.items()},
            "lifecycle_statuses": {str(key): value for key, value in lifecycles.items()}}


def run_child_scenarios(page, context, base, provider, first, second_id, report, scenario, snapshot):
    from playwright.sync_api import expect

    conversation = page.get_by_test_id("coding-conversation-id").inner_text()
    headers = {"Authorization": "Bearer " + page.evaluate("localStorage.getItem('unsloth_auth_token')")}
    evidence = report.setdefault("children", {"kind": "deterministic-http-provider-real-native-delegation", "requests": [], "outcomes": [], "inspection_reads": [], "events": []})
    prompt_url = base + f"/api/coding/conversations/{conversation}/prompts"
    event_url = base + f"/api/coding/conversations/{conversation}/events"
    child_url = lambda handle, attempt: base + f"/api/coding/conversations/{conversation}/children/{handle}/attempts/{attempt}"
    inspector = page.get_by_role("dialog", name="Subagent inspector", exact=True)
    status = page.get_by_test_id("coding-run-status")
    saved = page.locator('[aria-label="Saved coding conversations"] button')

    def read_detail(handle, attempt):
        response = context.request.get(child_url(handle, attempt), headers=headers, timeout=60000)
        assert response.ok, f"Actual child inspection failed ({response.status})"
        detail = response.json()
        evidence["inspection_reads"].append({"handle": handle, "attempt": attempt, "http_status": response.status,
                                             "completion_pending": (detail.get("child") or {}).get("completion_pending"),
                                             "outcome_status": (detail.get("outcome") or {}).get("status")})
        return detail

    def row(handle, attempt):
        return page.locator(f'[data-testid="coding-child-row"][data-child-handle="{handle}"][data-child-attempt="{attempt}"]')

    def open_inspector(handle, attempt, expected_status):
        trigger = row(handle, attempt)
        expect(trigger).to_be_visible(timeout=60000)
        expect(trigger).to_have_accessible_name(re.compile(rf".*attempt {attempt}.*", re.I))
        expect(trigger).to_contain_text(expected_status, ignore_case=True, timeout=60000)
        trigger.focus()
        trigger.press("Enter")
        expect(inspector).to_be_visible(timeout=60000)
        expect(inspector).to_have_attribute("data-testid", "coding-child-inspector")
        expect(inspector).to_contain_text(handle)
        expect(inspector).to_contain_text(f"Attempt {attempt}")
        expect(inspector).to_contain_text("Transcript")
        expect(inspector).to_contain_text("Activity")
        expect(inspector).to_contain_text("Retained result")
        assert_no_child_controls()
        return trigger

    def assert_no_child_controls():
        forbidden = re.compile(r"^(launch|continue|steer|stop|send message|replace)(\b| )", re.I)
        expect(inspector.get_by_role("button", name=forbidden)).to_have_count(0)

    def dismiss(trigger):
        inspector.get_by_role("button", name="Close subagent inspector", exact=True).focus()
        page.keyboard.press("Escape")
        expect(inspector).to_have_count(0)
        expect(trigger).to_be_focused()

    def capture_events():
        assert not page.evaluate("window.codingChildCaptureError || null"), "SSE evidence capture failed"
        evidence["events"].extend(page.evaluate("window.codingChildEvents.splice(0)"))

    page.get_by_label("Coding prompt", exact=True).fill("CHILD_INSPECT_PARENT: delegate an inspection, integrate its result, continue the exact retained child, then integrate the failed attempt")
    with page.expect_response(lambda response: response.url == prompt_url and response.request.method == "POST", timeout=60000) as waiting:
        page.get_by_label("Coding prompt", exact=True).press("Enter")
    assert waiting.value.status == 202
    ack = waiting.value.json()
    evidence["requests"].append(ack)
    expect(status).to_have_text("Running", timeout=60000)

    # This file is a known disposable input, not an expected child result.
    # Native child read_file will execute and journal its actual bounded output.
    (first / "child-large-input.txt").write_text("CHILD_LARGE_INPUT_BEGIN\n" + "x" * 40000 + "\nCHILD_LARGE_INPUT_TAIL\n")
    provider.request().tool("child-launch", "agent", {
        "operation": {"kind": "launch", "agent": "explore"}, "brief": {"objective": FIRST_OBJECTIVE, "scope": "Read child-large-input.txt in this disposable project; no edits"},
        "description": "Inspect oversized native content", "run_in_background": True})
    parent = provider.request_matching(lambda request: not request.is_child(FIRST_OBJECTIVE))
    handle, attempt = admitted_identity(parent.tool_result("child-launch"), 1)
    evidence["handle"] = handle
    evidence["attempts"] = [attempt]
    child = provider.request_matching(lambda request: request.is_child(FIRST_OBJECTIVE))
    trigger = open_inspector(handle, 1, "running")
    # Inspector must not trap the parent-session cancellation control.
    stop = page.get_by_role("button", name="Stop", exact=True)
    expect(stop).to_be_visible()
    expect(stop).to_be_enabled()
    stop.focus()
    expect(stop).to_be_focused()
    expect(inspector).to_be_visible()
    expect(inspector).not_to_contain_text(FIRST_RESULT)
    snapshot(page, "children-desktop-running")
    dismiss(trigger)
    scenario("A2-child-admission-not-terminal", f"Actual native functions.agent admitted {handle} attempt 1; keyboard inspector showed running, not completed; main-session Stop remained available and no child controls were exposed")

    child.tool("child-read-large", "read_file", {"paths": ["child-large-input.txt"]})
    child = provider.request_matching(lambda request: request.is_child(FIRST_OBJECTIVE))
    assert "CHILD_LARGE_INPUT_BEGIN" in child.tool_result("child-read-large")
    # Terminal content exceeds the public transcript and retained-result bounds.
    child.text(FIRST_RESULT + " " + "y" * 40000 + " " + FIRST_TAIL)
    expect(row(handle, 1)).to_contain_text("completed", timeout=60000)
    trigger = open_inspector(handle, 1, "completed")
    expect(inspector).to_contain_text(FIRST_RESULT, timeout=60000)
    expect(inspector).to_contain_text(re.compile(r"clipped|omitted|bounded", re.I), timeout=60000)
    expect(inspector).not_to_contain_text(FIRST_TAIL)
    assert len(inspector.inner_text()) < 60000, "Inspector expanded oversized result without a public bound"
    box = inspector.bounding_box()
    assert box and box["x"] >= 600 and box["x"] + box["width"] <= 1441, "Desktop inspector was not a right-hand panel"
    detail = read_detail(handle, 1)
    first_outcome = assert_outcome(detail, handle, 1, "completed")
    assert first_outcome["result_clipped"] and FIRST_RESULT in first_outcome["result"] and FIRST_TAIL not in first_outcome["result"]
    assert detail["child"]["completion_pending"] is True, "Inspection consumed completion still owed to the held parent"
    cut = detail["child"]["cut"]
    assert cut["journal"] == {"child": handle}
    response = context.request.post(base + f"/api/coding/conversations/{conversation}/entries", headers=headers,
                                    data={"cut": cut, "anchor": "latest", "max_entries": 32, "max_bytes": 8192})
    assert response.ok
    child_page = response.json()
    assert child_page["cut"] == cut and child_page["bytes"] <= 8192
    assert any(item.get("clipped") for item in child_page["rows"]), "Large child history omitted no explicit bounded-content disclosure"
    evidence["bounded_history"] = {"cut": cut, "bytes": child_page["bytes"], "row_ids": [item["id"] for item in child_page["rows"]]}
    evidence["outcomes"].append(dict(first_outcome, public_result_sha256=hashlib.sha256(first_outcome["result"].encode()).hexdigest()))
    snapshot(page, "children-desktop-completed-oversized")
    dismiss(trigger)
    scenario("A2-child-bounded-retained-outcome", f"{handle} attempt 1 completed; exact child journal cut bounded read, clipped oversized transcript/result and retained outcome inspected repeatedly while completion_pending stayed true")

    # Inspecting/reading the outcome cannot satisfy the parent completion debt.
    # Move the held model boundary via the native waiting tool, then verify the
    # next real provider input contains the completion supplied by Mimir.
    parent.tool("parent-await-one", "wait_for_updates", {"timeout_seconds": 30})
    parent = provider.request_matching(lambda request: not request.is_child(FIRST_OBJECTIVE))
    parent_content = json.dumps(parent.body.get("messages", []))
    assert FIRST_RESULT in parent_content and handle in parent_content, "Inspection stole completion owed to native parent"
    evidence["parent_completion_delivery"] = [{"handle": handle, "attempt": 1, "result_marker": FIRST_RESULT, "received_after_inspection": True}]
    provider.assert_no_request()

    parent.tool("child-continue", "agent", {
        "operation": {"kind": "continue", "handle": handle}, "brief": {"objective": SECOND_OBJECTIVE, "scope": "Demonstrate a terminal provider failure without changing any project files"},
        "description": "Continue retained inspection worker", "run_in_background": True})
    parent = provider.request_matching(lambda request: not request.is_child(SECOND_OBJECTIVE))
    assert admitted_identity(parent.tool_result("child-continue"), 2) == (handle, 2)
    evidence["attempts"].append(2)
    child = provider.request_matching(lambda request: request.is_child(SECOND_OBJECTIVE))
    expect(row(handle, 2)).to_contain_text("running", timeout=60000)
    expect(row(handle, 1)).to_contain_text("completed")
    historical = assert_outcome(read_detail(handle, 1), handle, 1, "completed")
    assert historical == first_outcome, "Continuation overwrote retained attempt-one outcome"
    trigger = open_inspector(handle, 1, "completed")
    expect(inspector).to_contain_text(FIRST_RESULT)
    expect(inspector).not_to_contain_text("completion owed")
    snapshot(page, "children-desktop-historical-attempt-one")
    # Attempt navigation is inspection only, not a launch/continuation control.
    inspector.get_by_role("button", name="Attempt 2", exact=True).focus()
    page.keyboard.press("Enter")
    expect(inspector).to_have_attribute("data-child-attempt", "2")
    expect(inspector.get_by_role("region", name="Subagent retained result", exact=True)).not_to_contain_text(FIRST_RESULT)
    inspector.get_by_role("button", name="Attempt 1", exact=True).focus()
    page.keyboard.press("Enter")
    expect(inspector).to_have_attribute("data-child-attempt", "1")
    expect(inspector).to_contain_text(FIRST_RESULT, timeout=60000)
    evidence["keyboard_attempt_navigation"] = [{"handle": handle, "from_attempt": 1, "to_attempt": 2}, {"handle": handle, "from_attempt": 2, "to_attempt": 1}]
    dismiss(trigger)

    # Lose only a browser subscription, then reopen this exact native identity.
    page.route(event_url, lambda route: route.abort("connectionreset"), times=1)
    saved.filter(has_text=conversation).click()
    expect(status).to_contain_text("Disconnected", timeout=60000)
    snapshot(page, "children-desktop-disconnected")
    saved.filter(has_text=conversation).click()
    expect(page.get_by_test_id("coding-event-status")).to_contain_text("Native event stream connected", timeout=60000)
    expect(page.get_by_test_id("coding-request-id")).to_contain_text(ack["request_id"])
    expect(row(handle, 1)).to_contain_text("completed", timeout=60000)
    expect(row(handle, 2)).to_contain_text("running", timeout=60000)
    provider.assert_no_request()
    scenario("A2-child-continuation-disconnect", f"Continuation admitted the same {handle} attempt 2 while attempt 1 stayed completed and retained; browser-only disconnect/same-ID reopen recovered both attempts without native/provider replay")

    page.set_viewport_size({"width": 390, "height": 844})
    trigger = open_inspector(handle, 2, "running")
    box = inspector.bounding_box()
    transcript_box = page.get_by_test_id("coding-transcript").bounding_box()
    assert box and transcript_box and abs(box["x"] - transcript_box["x"]) <= 1 and abs(box["width"] - transcript_box["width"]) <= 1, "Narrow inspector did not fill the available coding transcript width"
    assert box["x"] >= 0 and box["x"] + box["width"] <= 391
    evidence["narrow_inspector_box"] = box
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "Narrow inspector created horizontal document overflow"
    # Non-modal inspector leaves main Stop outside the panel usable.
    expect(stop).to_be_visible()
    expect(stop).to_be_enabled()
    stop.focus()
    expect(stop).to_be_focused()
    expect(inspector).to_be_visible()
    snapshot(page, "children-narrow-running")
    dismiss(trigger)
    scenario("A10-child-narrow-keyboard", "390x844 full-width inspector, no horizontal overflow; Enter activation, Escape dismissal and exact activating-row focus restored; inspection-only controls and main-session Stop available")

    child.fail()
    expect(row(handle, 2)).to_contain_text("failed", timeout=60000)
    trigger = open_inspector(handle, 2, "failed")
    expect(inspector).to_contain_text("failed", ignore_case=True)
    second_detail = read_detail(handle, 2)
    second_outcome = assert_outcome(second_detail, handle, 2, "failed")
    assert second_outcome["error"], "Failed native child omitted its retained terminal error"
    assert second_detail["child"]["completion_pending"] is True
    expect(inspector).to_contain_text(second_outcome["error"], timeout=60000)
    evidence["outcomes"].append(second_outcome)
    snapshot(page, "children-narrow-failed")
    dismiss(trigger)
    parent.tool("parent-await-two", "wait_for_updates", {"timeout_seconds": 30})
    parent = provider.request_matching(lambda request: not request.is_child(SECOND_OBJECTIVE))
    parent_content = json.dumps(parent.body.get("messages", []))
    assert handle in parent_content and json.dumps(second_outcome["error"])[1:-1] in parent_content, "Failed completion was not delivered to native parent after inspection"
    evidence["parent_completion_delivery"].append({"handle": handle, "attempt": 2, "error_received_after_inspection": True})
    parent.text(FINAL_RESULT)
    expect(status).to_have_text("Completed", timeout=60000)
    expect(page.get_by_test_id("coding-transcript")).to_contain_text(FINAL_RESULT, timeout=60000)
    expect(stop).to_have_count(0)
    provider.assert_no_request()
    capture_events()
    evidence["ordered_view"] = validate_child_events(evidence["events"], handle)
    scenario("A2-child-parent-completion-debt", f"Native parent received completed attempt 1 and failed attempt 2 after browser retained-outcome inspection; integrated both and settled request {ack['request_id']}")

    # Full navigation must reconstruct historical row identities from native
    # saved data, not just the previous tab's in-memory live child inventory.
    page.reload()
    page.get_by_role("button", name="Toggle coding sidebar", exact=True).click()
    saved.filter(has_text=conversation).click()
    expect(page.get_by_test_id("coding-event-status")).to_contain_text("Native event stream connected", timeout=60000)
    expect(row(handle, 1)).to_contain_text("completed", timeout=60000)
    expect(row(handle, 2)).to_contain_text("failed", timeout=60000)
    trigger = open_inspector(handle, 1, "completed")
    expect(inspector).to_contain_text(FIRST_RESULT, timeout=60000)
    assert assert_outcome(read_detail(handle, 1), handle, 1, "completed") == first_outcome
    snapshot(page, "children-narrow-reopened-historical")
    inspector.get_by_role("button", name="Close subagent inspector", exact=True).click()
    expect(trigger).to_be_focused()
    trigger = open_inspector(handle, 2, "failed")
    assert assert_outcome(read_detail(handle, 2), handle, 2, "failed") == second_outcome
    snapshot(page, "children-narrow-reopened-failed")
    dismiss(trigger)
    page.set_viewport_size({"width": 1440, "height": 1000})
    trigger = open_inspector(handle, 2, "failed")
    snapshot(page, "children-desktop-reopened-failed")
    dismiss(trigger)
    scenario("A2-child-saved-historical-inspection", f"Full page reload/saved reopen reconstructed exact {handle} attempts 1/2 and unchanged completed/failed outcomes; keyboard and Close-button dismissal restored focus")
    evidence["status"] = "passed"
