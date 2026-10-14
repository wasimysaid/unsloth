# SPDX-License-Identifier: AGPL-3.0-only
"""Ticket-239 rendered plan controls; deterministic provider, real native execution.

Only provider replies and explicitly labeled browser transport losses are controlled.
No execution endpoint, native state/history, tool result, or project effect is mocked.
Model-only provider context is inspected for assertions but never saved in evidence.
"""
from __future__ import annotations

import re

from coding_recovery_scenarios import VIEW_FAULT_SCRIPT, captured_state, wait_native_terminal


ACTION_LABELS = {
    "implement": "Implement",
    "implement_fresh": "Implement with fresh context",
    "save_and_stop": "Save and stop",
}


def proposed_plan(name: str, marker: str, filename: str) -> str:
    """A native parseable final-answer proposal, not a prewritten plan artifact."""
    return (f"<proposed_plan>\n# {name}\n"
            f"## Requirements\n{marker}: create `{filename}` in this disposable project only.\n"
            "## Technical Design\nUse the native write_file and read_file tools; do not modify other files.\n"
            f"## Delivery Plan\n### 1. Implement\nWrite `{filename}` with the specified evidence marker.\n"
            "### 2. Verify\nRead the file and report completion.\n</proposed_plan>")


def provider_context(request) -> str:
    """Inspect only message text; callers persist booleans, never this context."""
    parts = []
    for message in request.body.get("messages", []):
        content = message.get("content", "")
        if isinstance(content, str):
            parts.append(content)
        elif isinstance(content, list):
            parts.extend(block["text"] for block in content
                         if isinstance(block, dict) and isinstance(block.get("text"), str))
    return "\n".join(parts)


def action_body(plan: dict, decision: str) -> dict:
    assert decision in ACTION_LABELS, "Unknown plan action"
    assert isinstance(plan.get("id"), str) and plan["id"], "Native plan identity absent"
    assert isinstance(plan.get("revision"), str) and plan["revision"], "Native plan revision absent"
    return {"plan_id": plan["id"], "revision": plan["revision"], "decision": decision}


def validate_action_ack(ack: dict, conversation: str, plan: dict, decision: str) -> None:
    assert decision in ACTION_LABELS, "Unknown plan action"
    assert ack["conversation_id"] == conversation, "Action ACK retargeted conversation"
    assert ack["plan_id"] == plan["id"], "Action ACK retargeted plan"
    assert ack["decision"] == decision, "Action ACK changed decision"
    request_id = ack["request_id"]
    if decision == "save_and_stop":
        assert request_id is None, "Saving a plan must not start implementation"
    else:
        assert isinstance(request_id, str) and request_id, "Implementation did not admit a native request"


def run_plan_scenarios(page, context, base, provider, first, second_id, report,
                       scenario, snapshot, *, opening_generation):
    from playwright.sync_api import expect

    assert provider is not None, "Plan acceptance requires the deterministic external provider"
    conversation = page.get_by_test_id("coding-conversation-id").inner_text()
    headers = {"Authorization": "Bearer " + page.evaluate("localStorage.getItem('unsloth_auth_token')"),
               "X-Mimir-Runtime-Generation": str(opening_generation)}
    prefix = base + f"/api/coding/conversations/{conversation}"
    action_url, mode_url, event_url = [prefix + suffix for suffix in ("/plan-actions", "/mode", "/events")]
    composer = page.get_by_label("Coding prompt", exact=True)
    transcript = page.get_by_test_id("coding-transcript")
    status = page.get_by_test_id("coding-run-status")
    card = page.get_by_test_id("coding-current-plan")
    mode_output = page.get_by_test_id("coding-plan-mode")
    evidence = report.setdefault("plan", {"kind": "deterministic-http-provider-real-native-plan-actions",
                                          "requests": [], "actions": [], "plans": [], "tool_identities": []})
    current_request = None

    def state():
        return captured_state(base, headers, conversation)

    def reopen(identifier=conversation):
        saved = page.locator('[aria-label="Saved coding conversations"] button').filter(has_text=identifier)
        expect(saved).to_be_visible(timeout=60000)
        with page.expect_response(lambda response: response.url == base + f"/api/coding/conversations/{identifier}/open"
                                  and response.request.method == "POST", timeout=60000) as opening:
            saved.click()
        assert opening.value.ok
        headers["X-Mimir-Runtime-Generation"] = str(opening.value.json()["runtime_generation"])
        expect(page.get_by_test_id("coding-conversation-id")).to_have_text(identifier, timeout=60000)
        expect(page.get_by_test_id("coding-event-status")).to_contain_text("Native event stream connected", timeout=60000)

    def mode(value):
        radio = page.get_by_role("group", name="Coding mode").get_by_role("radio", name=value.title(), exact=True)
        expect(radio).to_be_enabled(timeout=60000)
        with page.expect_response(lambda response: response.url == mode_url and response.request.method == "POST", timeout=60000) as waiting:
            radio.focus()
            radio.press("Space")
        assert waiting.value.ok, f"Native mode change failed ({waiting.value.status})"
        assert waiting.value.request.post_data_json == {"mode": value}
        assert waiting.value.json() == {"conversation_id": conversation, "mode": value}
        expect(radio).to_be_checked(timeout=60000)
        expect(mode_output).to_have_text("Native mode: " + value, timeout=60000)
        assert state()["configuration"]["mode"] == value

    def submit(text):
        nonlocal current_request
        composer.fill(text)
        expect(page.get_by_role("button", name="Send", exact=True)).to_be_enabled(timeout=60000)
        with page.expect_response(lambda response: response.url == prefix + "/prompts" and response.request.method == "POST", timeout=60000) as waiting:
            composer.press("Enter")
        assert waiting.value.status == 202, f"Prompt admission failed ({waiting.value.status})"
        ack = waiting.value.json()
        assert ack["conversation_id"] == conversation and ack["request_id"]
        evidence["requests"].append(ack)
        current_request = ack["request_id"]
        return ack

    def settled(marker=None):
        assert current_request, "No native request was admitted"
        wait_native_terminal(base, headers, conversation, current_request)
        expect(status).to_have_text("Completed", timeout=60000)
        expect(page.get_by_role("button", name="Stop", exact=True)).to_have_count(0, timeout=60000)
        if marker:
            # Inspecting bounded earlier history deliberately suspends live
            # transcript merging. Explicitly return to the live window before
            # asserting output from this newly completed native request.
            latest = page.get_by_role("button", name="Jump to latest", exact=True)
            if latest.is_visible():
                latest.focus()
                latest.press("Enter")
            expect(transcript).to_contain_text(marker, timeout=60000)
        native = state()
        assert native["active_request"] is None, "Rendered completion preceded native settlement"
        completed = next(item for item in native["requests"] if item["id"] == current_request)
        assert completed["status"] == "completed", completed
        evidence.setdefault("terminal_outcomes", []).append({"request_id": current_request, "status": completed["status"]})

    def plan_capture(marker, expected_status="review_pending"):
        expect(card).to_be_visible(timeout=60000)
        native = state()["plan"]
        assert native and native["status"] == expected_status, native
        assert marker in native["markdown"] and native["id"] and native["path"] and native["name"]
        assert isinstance(native["revision"], str) and native["revision"]
        evidence["plans"].append({key: native[key] for key in ("id", "name", "path", "status", "revision")})
        expect(card).to_have_attribute("data-plan-id", native["id"], timeout=60000)
        return native

    def expand():
        summary = card.locator("summary")
        expect(summary).to_have_count(1)
        summary.focus()
        expect(summary).to_be_focused()
        if card.get_attribute("open") is None:
            summary.press("Enter")
        expect(card).to_have_attribute("open", "")
        return summary

    def reject(plan, decision, reason):
        response = context.request.post(action_url, data=action_body(plan, decision), headers=headers, timeout=60000)
        assert response.status == 409, f"Native {reason} action was not rejected ({response.status}): {response.text()}"
        evidence.setdefault("rejections", []).append({"reason": reason, "plan_id": plan["id"],
                                                       "revision": plan["revision"], "decision": decision,
                                                       "status": response.status, "detail": response.json()})
        provider.assert_no_request()

    def act(plan, decision):
        nonlocal current_request
        expand()
        button = page.get_by_role("button", name=ACTION_LABELS[decision], exact=True)
        expect(button).to_be_enabled(timeout=60000)
        with page.expect_response(lambda response: response.url == action_url and response.request.method == "POST", timeout=60000) as waiting:
            button.focus()
            button.press("Enter")
        response = waiting.value
        assert response.ok, f"Native plan action failed ({response.status}): {response.text()}"
        assert response.request.post_data_json == action_body(plan, decision)
        ack = response.json()
        validate_action_ack(ack, conversation, plan, decision)
        evidence["actions"].append(ack)
        if ack["request_id"]:
            current_request = ack["request_id"]
            expect(page.get_by_test_id("coding-request-id")).to_contain_text(ack["request_id"], timeout=60000)
        return ack

    def tool_row(call, name, marker):
        row = page.locator(f'[data-testid="coding-tool-row"][data-call-id="{call}"]')
        expect(row).to_have_count(1, timeout=60000)
        summary = row.locator("summary")
        summary.focus()
        if row.get_attribute("open") is None:
            summary.press("Enter")
        expect(row.locator("pre")).to_be_visible()
        expect(row).to_contain_text(name, timeout=60000)
        expect(row).to_contain_text(marker, timeout=60000)
        identity = row.locator("p").first.inner_text()
        assert "call " + call in identity, "Native call identity missing: " + repr(identity)
        assert re.search(r"invocation (?!undefined|null|not supplied)\S+", identity), "Native invocation identity missing: " + repr(identity)
        evidence["tool_identities"].append({"call_id": call, "name": name, "public_identity": identity})

    def build(request, label, filename):
        request.tool(label + "-write", "write_file", {"path": filename, "content": label + "\n"})
        followup = provider.request()
        assert filename in followup.tool_result(label + "-write")
        followup.tool(label + "-read", "read_file", {"paths": [filename]})
        followup = provider.request()
        assert label in followup.tool_result(label + "-read")
        followup.text(label + "_COMPLETED")
        settled(label + "_COMPLETED")
        assert (first / filename).read_text() == label + "\n"
        tool_row(label + "-write", "write_file", filename)
        tool_row(label + "-read", "read_file", label)

    def propose(name, marker, filename):
        mode("plan")
        prompt = "PLAN_CONTEXT_" + marker
        submit(prompt)
        request = provider.request()
        assert prompt in provider_context(request)
        request.text(proposed_plan(name, marker, filename))
        settled()
        return plan_capture(marker), prompt

    # Attempt a real native write while the admitted run is in Plan mode. The
    # provider reports only the proposal; it does not pre-create either artifact.
    mode("plan")
    initial = "PLAN_CONTEXT_ORIGINAL_239"
    submit(initial)
    request = provider.request()
    assert 'mode="plan"' in provider_context(request)
    request.tool("plan-denied-write", "write_file", {"path": "plan-must-not-write.txt", "content": "MUST_NOT_EXIST\n"})
    request = provider.request()
    refusal = request.tool_result("plan-denied-write")
    assert "Plan mode is read-only" in refusal, refusal
    assert not (first / "plan-must-not-write.txt").exists()
    request.text(proposed_plan("Keep original context", "PLAN_KEEP_239", "plan-keep.txt"))
    settled()
    original_plan = plan_capture("PLAN_KEEP_239")
    tool_row("plan-denied-write", "write_file", "Plan mode is read-only")
    scenario("A2-native-plan-write-refusal", "Rendered Plan selection supplied a real write_file call; native read-only policy refused execution, the exact call/invocation identities and refusal were visible, no file was created, and a native saved review plan settled")

    # Mode selection changes native configuration only; the pending plan stays
    # exactly the same artifact/lifecycle and does not admit a provider request.
    mode("build")
    unchanged = state()["plan"]
    assert unchanged == original_plan
    provider.assert_no_request()
    mode("plan")
    assert state()["plan"] == original_plan
    provider.assert_no_request()
    scenario("A2-mode-is-not-plan-acceptance", "Keyboard Build/Plan selection matched authoritative native configuration without accepting, revising, or implementing the pending plan")

    # Expand/collapse with native summary keyboard behavior at both viewports;
    # controls and full plan text must stay reachable without horizontal overflow.
    for width, height, label in ((1440, 1000, "desktop"), (390, 844, "narrow")):
        page.set_viewport_size({"width": width, "height": height})
        summary = expand()
        assert transcript.evaluate("el => el.clientHeight >= 128"), "Expanded plan collapsed the transcript viewport"
        expect(card.locator("pre")).to_contain_text("PLAN_KEEP_239")
        summary.press("Tab")
        content = card.get_by_role("region", name="Current native plan content", exact=True)
        expect(content).to_be_focused()
        content.press("End")
        page.wait_for_function("el => el.scrollTop + el.clientHeight >= el.scrollHeight - 1",
                               arg=content.element_handle(), timeout=10000)
        content.press("Tab")
        for name in ACTION_LABELS.values():
            button = page.get_by_role("button", name=name, exact=True)
            expect(button).to_be_enabled()
            expect(button).to_be_focused()
            assert button.evaluate("el => { const r=el.getBoundingClientRect(); return r.left>=0 && r.right<=innerWidth; }")
            button.press("Tab")
        summary.focus()
        summary.press("Space")
        expect(card).not_to_have_attribute("open", "")
        expect(summary).to_be_focused()
        summary.press("Enter")
        expect(card).to_have_attribute("open", "")
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
        snapshot(page, "plan-" + label + "-review-keyboard")
        composer.scroll_into_view_if_needed()
        expect(composer).to_be_in_viewport(ratio=0.9)
        snapshot(page, "plan-" + label + "-composer-reachable")
    page.set_viewport_size({"width": 1440, "height": 1000})
    reopen(second_id)
    reopen()
    restored = plan_capture("PLAN_KEEP_239")
    assert restored == original_plan
    expand()
    expect(transcript).to_contain_text(initial)
    scenario("A10-plan-keyboard-focus-layout", "1440x1000 and 390x844: summary expanded/collapsed with Enter/Space and retained focus; each action was keyboard-focusable inside the viewport; native plan content and identity survived deliberate saved-history reopen")

    stale = dict(original_plan, id="definitely-not-the-current-native-plan")
    reject(stale, "implement", "stale-plan-id")
    # Keep the revision well-formed so native current-artifact validation, not
    # transport syntax validation, is what rejects this action.
    stale_revision = original_plan["revision"][:-1] + ("0" if original_plan["revision"][-1] != "0" else "1")
    reject(dict(original_plan, revision=stale_revision), "implement", "stale-plan-revision")
    assert state()["plan"] == original_plan
    scenario("A2-stale-plan-validation", "Authenticated coding route rejected a mismatched native plan ID and revision with 409, left the exact current plan untouched and reached no provider")

    # A second held Plan prompt creates real native busy admission, not a timer
    # pretending the implementation is active. Controls expose disabled reasons.
    busy_ack = submit("PLAN_BUSY_NATIVE_239")
    held = provider.request()
    expect(status).to_have_text("Running", timeout=60000)
    expand()
    for name in ACTION_LABELS.values():
        expect(page.get_by_role("button", name=name, exact=True)).to_be_disabled()
    expect(card).to_contain_text(re.compile("busy|running|wait|active", re.I))
    for decision in ACTION_LABELS:
        reject(original_plan, decision, "native-busy")
    assert state()["active_request"] == busy_ack["request_id"]
    # Native configuration may select the next mode while work is active. This
    # direct authenticated coding command must not rewrite the admitted Plan run.
    changed = context.request.post(mode_url, data={"mode": "build"}, headers=headers, timeout=60000)
    assert changed.ok and changed.json() == {"conversation_id": conversation, "mode": "build"}
    expect(mode_output).to_have_text("Native mode: build", timeout=60000)
    held.tool("plan-running-denied-write", "write_file", {"path": "plan-running-must-not-write.txt", "content": "MUST_NOT_EXIST\n"})
    followup = provider.request()
    assert "Plan mode is read-only" in followup.tool_result("plan-running-denied-write")
    assert not (first / "plan-running-must-not-write.txt").exists()
    followup.text("PLAN_BUSY_COMPLETED_239")
    settled("PLAN_BUSY_COMPLETED_239")
    assert state()["plan"] == original_plan and state()["configuration"]["mode"] == "build"
    tool_row("plan-running-denied-write", "write_file", "Plan mode is read-only")
    scenario("A2-native-busy-plan-controls", "All three plan commands were rejected by native busy admission while a real provider turn was held; rendered disabled controls explained the busy reason and current request/plan identities were unchanged")
    scenario("A2-mode-does-not-rewrite-running-plan", "Authenticated mode command selected authoritative Build for future work while the existing native Plan request still refused a real write_file; exact running request settled without changing or accepting its pending plan")

    ack = act(original_plan, "implement")
    request = provider.request()
    text = provider_context(request)
    assert initial in text, "Current-context implementation lost the original prompt"
    assert original_plan["markdown"] in text, "Current-context implementation lost the proposed plan"
    # Native current-context guidance refers to the already-visible proposal;
    # only fresh handoff adds an accepted_plan checkpoint wrapper.
    assert "The user accepted the plan you proposed. Implement it now." in text
    assert original_plan["path"] in text, "Implementation guidance targeted a different plan artifact"
    expect(mode_output).to_have_text("Native mode: build", timeout=60000)
    assert state()["configuration"]["mode"] == "build"
    build(request, "PLAN_KEEP_NATIVE_239", "plan-keep.txt")
    completed = plan_capture("PLAN_KEEP_239", "completed")
    assert completed["id"] == original_plan["id"]
    reject(original_plan, "implement", "completed-plan-replay")
    evidence.setdefault("context_outcomes", []).append({"decision": "implement", "request_id": ack["request_id"],
                                                        "prior_context_retained": True, "mode": "build"})
    scenario("A2-implement-current-context", "Keyboard Implement admitted the exact native plan/request, retained original provider context, switched to authoritative Build, executed real write/read tools, settled Completed, and refused completed-plan replay")

    fresh_plan, fresh_prompt = propose("Fresh context implementation", "PLAN_FRESH_239", "plan-fresh.txt")
    assert fresh_plan["id"] != original_plan["id"]
    reject(original_plan, "implement_fresh", "superseded-plan")
    ack = act(fresh_plan, "implement_fresh")
    request = provider.request()
    text = provider_context(request)
    assert initial not in text and fresh_prompt not in text, "Fresh implementation retained earlier model context"
    assert "PLAN_FRESH_239" in text and "<accepted_plan>" in text
    assert state()["configuration"]["mode"] == "build"
    expect(mode_output).to_have_text("Native mode: build", timeout=60000)
    build(request, "PLAN_FRESH_NATIVE_239", "plan-fresh.txt")
    completed = plan_capture("PLAN_FRESH_239", "completed")
    assert completed["id"] == fresh_plan["id"]
    expect(transcript).to_contain_text(initial)
    expect(transcript).to_contain_text(fresh_prompt)
    evidence["context_outcomes"].append({"decision": "implement_fresh", "request_id": ack["request_id"],
                                         "prior_context_retained": False, "public_history_retained": True, "mode": "build"})
    scenario("A2-implement-fresh-context", "Native fresh-plan action admitted an exact request in Build with accepted plan but neither earlier prompt in model context; real write/read settled Completed while public conversation history remained inspectable")

    save_plan, save_prompt = propose("Save without implementation", "PLAN_SAVE_239", "plan-save-must-not-exist.txt")
    act(save_plan, "save_and_stop")
    expect(mode_output).to_have_text("Native mode: build", timeout=60000)
    saved = plan_capture("PLAN_SAVE_239", "saved_stopped")
    assert saved["id"] == save_plan["id"] and state()["active_request"] is None
    provider.assert_no_request()
    assert not (first / "plan-save-must-not-exist.txt").exists()
    reject(save_plan, "save_and_stop", "saved-plan-replay")
    # A reload starts a new rendered view; it must reconstruct the native saved
    # lifecycle rather than treat the previous plan proposal as actionable/live.
    page.reload()
    reopen()
    assert plan_capture("PLAN_SAVE_239", "saved_stopped") == saved
    expand()
    expect(transcript).to_contain_text(save_prompt)
    expect(page.get_by_role("button", name=ACTION_LABELS["implement"], exact=True)).to_be_enabled()
    expect(page.get_by_role("button", name=ACTION_LABELS["implement_fresh"], exact=True)).to_be_enabled()
    expect(page.get_by_role("button", name=ACTION_LABELS["save_and_stop"], exact=True)).to_be_disabled()
    provider.assert_no_request()
    snapshot(page, "plan-saved-stopped-reopened")
    evidence["context_outcomes"].append({"decision": "save_and_stop", "request_id": None, "mode": "build",
                                         "implementation_started": False, "saved_history_reopened": True})
    scenario("A2-save-stop-history", "Save and stop persisted the exact native artifact as saved-stopped in Build without any provider call, request admission or file write; actual reload/reopen retained identity/content/status, exposed deliberate implementation choices for the saved current plan and disabled redundant saving")

    lost_plan, _ = propose("Lost acknowledgement implementation", "PLAN_LOST_ACK_239", "plan-lost-ack.txt")
    page.add_init_script(VIEW_FAULT_SCRIPT)
    page.evaluate(VIEW_FAULT_SCRIPT)
    page.reload()
    reopen()
    expand()
    outage = {"active": True}
    deliveries = []
    attempts = []

    def block_reconnect(route):
        route.abort("connectionreset") if outage["active"] else route.continue_()

    def count_action(request):
        if request.url == action_url and request.method == "POST":
            attempts.append(request.post_data_json)

    def lose_ack(route):
        assert route.request.post_data_json == action_body(lost_plan, "implement")
        response = route.fetch(timeout=60000)
        assert response.ok, response.text()
        ack = response.json()
        validate_action_ack(ack, conversation, lost_plan, "implement")
        deliveries.append(ack)
        route.abort("connectionreset")  # Native acceptance happened; only ACK delivery is lost.

    page.on("request", count_action)
    page.route(event_url, block_reconnect)
    page.route(action_url, lose_ack, times=1)
    try:
        page.evaluate("window.codingDropView = true")
        page.get_by_role("button", name="Implement", exact=True).focus()
        page.keyboard.press("Enter")
        # Pump browser callbacks until the real ACK has been dropped before
        # waiting synchronously on the external provider's queue.
        expect(page.get_by_test_id("coding-event-status")).to_contain_text("work may still be running", timeout=60000)
        request = provider.request()
        assert len(deliveries) == 1
        current_request = deliveries[0]["request_id"]
        evidence["actions"].append(dict(deliveries[0], acknowledgement_lost=True))
        expect(page.get_by_role("region", name="Coding project and prompt", exact=True)
               .get_by_role("alert").filter(has_text=re.compile("unconfirmed", re.I))).to_be_visible(timeout=60000)
        for name in ACTION_LABELS.values():
            expect(page.get_by_role("button", name=name, exact=True)).to_be_disabled()
        for width, height, label in ((1440, 1000, "desktop"), (390, 844, "narrow")):
            page.set_viewport_size({"width": width, "height": height})
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
            snapshot(page, "plan-" + label + "-uncertain-action")
        page.set_viewport_size({"width": 1440, "height": 1000})
        # Complete real tools while the browser remains disconnected. Native
        # settlement is independently observed; it is not inferred from a file.
        request.tool("PLAN_LOST_ACK_239-write", "write_file", {"path": "plan-lost-ack.txt", "content": "PLAN_LOST_ACK_NATIVE_239\n"})
        followup = provider.request()
        assert "plan-lost-ack.txt" in followup.tool_result("PLAN_LOST_ACK_239-write")
        followup.tool("PLAN_LOST_ACK_239-read", "read_file", {"paths": ["plan-lost-ack.txt"]})
        followup = provider.request()
        assert "PLAN_LOST_ACK_NATIVE_239" in followup.tool_result("PLAN_LOST_ACK_239-read")
        followup.text("PLAN_LOST_ACK_COMPLETED_239")
        wait_native_terminal(base, headers, conversation, deliveries[0]["request_id"])
        assert (first / "plan-lost-ack.txt").read_text() == "PLAN_LOST_ACK_NATIVE_239\n"
        page.evaluate("window.codingDropView = false")
        outage["active"] = False
        expect(page.get_by_test_id("coding-event-status")).to_contain_text("Native event stream connected", timeout=60000)
        expect(page.get_by_test_id("coding-plan-reconciliation")).to_contain_text("No command was replayed", timeout=60000)
        settled("PLAN_LOST_ACK_COMPLETED_239")
        expect(page.get_by_test_id("coding-request-id")).to_contain_text(deliveries[0]["request_id"])
        recovered = plan_capture("PLAN_LOST_ACK_239", "completed")
        assert recovered["id"] == lost_plan["id"] and state()["configuration"]["mode"] == "build"
        assert attempts == [action_body(lost_plan, "implement")], "Uncertain plan command was replayed"
        provider.assert_no_request()
        tool_row("PLAN_LOST_ACK_239-write", "write_file", "plan-lost-ack.txt")
        tool_row("PLAN_LOST_ACK_239-read", "read_file", "PLAN_LOST_ACK_NATIVE_239")
        snapshot(page, "plan-action-reconciled")
        evidence["lost_ack"] = {"action_attempts": len(attempts), "accepted": deliveries[0],
                                "authoritative_status": recovered["status"], "native_terminal_observed": True}
        scenario("A7-uncertain-plan-action-reconnect", "Real native implementation ACK was lost after acceptance and view transport disconnected; UI withheld another plan action at desktop/narrow sizes; automatic authoritative reconnect recovered exact plan/request/mode and Completed real tools, with one POST and no provider replay")
    finally:
        outage["active"] = False
        page.evaluate("window.codingDropView = false")
        page.unroute(event_url, block_reconnect)
        page.unroute(action_url, lose_ack)
        page.remove_listener("request", count_action)
    reject(lost_plan, "implement", "lost-ack-accepted-command-replay")
    page.reload()
    reopen()
    final_plan = plan_capture("PLAN_LOST_ACK_239", "completed")
    assert final_plan["id"] == lost_plan["id"]
    expand()
    expect(card).to_contain_text("PLAN_LOST_ACK_239")
    for name in ACTION_LABELS.values():
        expect(page.get_by_role("button", name=name, exact=True)).to_be_disabled()
    card.locator("summary").press("Space")
    expect(card).not_to_have_attribute("open", "")
    for old_plan, marker, lifecycle_label in ((original_plan, "PLAN_KEEP_239", "Implementation completed"),
                                               (save_plan, "PLAN_SAVE_239", "Saved · implementation not started")):
        history = page.get_by_test_id("coding-historical-plan").and_(page.locator('[data-plan-id="' + old_plan["id"] + '"]')).last
        expect(history).to_be_visible(timeout=60000)
        summary = history.locator("summary")
        summary.focus()
        if history.get_attribute("open") is None:
            summary.press("Enter")
        expect(history.get_by_test_id("coding-plan-content")).to_contain_text(marker)
        expect(summary).to_contain_text(lifecycle_label)
        expect(history.get_by_role("button")).to_have_count(0)
        summary.scroll_into_view_if_needed()
        expect(summary).to_be_in_viewport(ratio=1)
        expect(history.get_by_test_id("coding-plan-content")).to_be_in_viewport()
        snapshot(page, "plan-history-" + marker.lower())
    snapshot(page, "plan-historical-content-reopened")
    scenario("A2-historical-plan-lifecycle", "After reload/reopen and newer plan implementation, historical cards preserved original native plan identities, content and completed/saved-stopped lifecycles; historical records exposed no action buttons")
    provider.assert_no_request()
    evidence["status"] = "passed"
