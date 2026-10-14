# SPDX-License-Identifier: AGPL-3.0-only
"""Ticket-240 rendered lifecycle checks through authenticated production coding.

Provider replies are deterministic fixtures, including independent review replies;
native ownership, tools, lifecycle and persisted history are real, not UI mocks.
"""
from __future__ import annotations


def run_goal_scenarios(page, context, base, provider, first, report, scenario, snapshot, restart_server):
    from playwright.sync_api import expect

    conversation = page.get_by_test_id("coding-conversation-id").inner_text()
    headers = {"Authorization": "Bearer " + page.evaluate("localStorage.getItem('unsloth_auth_token')")}
    headers["X-Mimir-Runtime-Generation"] = str(context.request.get(base + "/api/coding/runtime", headers=headers).json()["generation"])
    endpoint = base + f"/api/coding/conversations/{conversation}/goal"
    evidence = report.setdefault("goals", {"kind": "deterministic-http-provider-real-native-goals", "actions": []})
    summary = page.get_by_label("Autonomous goal details", exact=True)
    status = page.get_by_test_id("coding-goal-status")
    details = page.get_by_test_id("coding-goal-details")

    def native_state():
        # Obtain the atomic first item of a real native Session View, then release
        # only this inspection view. Never fetch a mutable snapshot or poll history.
        return page.evaluate("""async ({url, headers}) => {
          const abort = new AbortController();
          try {
            const response = await fetch(url, {headers, signal: abort.signal});
            if (!response.ok || !response.body) throw new Error('Native view unavailable');
            const reader = response.body.getReader(); const decoder = new TextDecoder(); let text = '';
            while (true) {
              const item = await reader.read(); if (item.done) throw new Error('Native view ended before capture');
              text += decoder.decode(item.value, {stream:true});
              const end = text.indexOf('\\n\\n');
              if (end < 0) continue;
              const data = text.slice(0,end).split('\\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\\n');
              if (!data) { text = text.slice(end+2); continue; }
              const frame = JSON.parse(data);
              if (frame.event?.type === 'start') return frame.event.state;
              throw new Error('Expected atomic native start capture');
            }
          } finally { abort.abort(); }
        }""", {"url": base + f"/api/coding/conversations/{conversation}/events", "headers": headers})

    def action(name, objective=None):
        # A held provider boundary is stable, but its durable native state item
        # may still be in flight. Act only once the displayed controls match that
        # actual captured boundary. This is synchronization, never command replay.
        captured = native_state()
        expect(page.get_by_test_id("coding-goal")).to_have_attribute("data-goal-revision", captured["goal_controls"]["revision"], timeout=60000)
        button = page.get_by_role("button", name=name.capitalize() + " goal", exact=True)
        expect(button).to_be_enabled(timeout=60000)
        button.focus()
        if objective is not None:
            button.press("Enter")
            field = page.get_by_label("Goal objective", exact=True)
            expect(field).to_be_focused()
            field.fill(objective)
            button = page.get_by_role("button", name="Confirm " + name, exact=True)
        with page.expect_response(lambda response: response.url == endpoint and response.request.method == "POST", timeout=60000) as pending:
            button.focus()
            button.press("Enter")
        ack = pending.value
        assert ack.ok, (name, ack.status, ack.text())
        evidence["actions"].append({"action": name, "conversation_id": conversation,
                                   "revision": ack.request.post_data_json["revision"], **ack.json()})
        if objective is not None:
            expect(page.get_by_label("Goal objective", exact=True)).to_have_count(0, timeout=60000)
            expect(summary).to_be_focused()

    def idle():
        expect(page.get_by_role("button", name="Stop", exact=True)).to_have_count(0, timeout=60000)
        expect(page.get_by_role("button", name="Stopping…", exact=True)).to_have_count(0, timeout=60000)

    summary.focus()
    summary.press("Enter")
    expect(details).to_be_visible()
    expect(status).to_have_text("No autonomous goal")
    # Busy refusal is native, not an optimistic UI gate. Unrelated ordinary work
    # may not be converted into an autonomous goal by clicking Start.
    composer = page.get_by_label("Coding prompt", exact=True)
    composer.fill("Unrelated native work held for goal admission check")
    composer.press("Enter")
    unrelated = provider.request()
    expect(page.get_by_test_id("coding-run-status")).to_have_text("Running", timeout=60000)
    expect(page.get_by_role("button", name="Start goal", exact=True)).to_be_disabled(timeout=60000)
    busy_state = native_state()
    refused = context.request.post(endpoint, data={"revision": busy_state["goal_controls"]["revision"], "action": "start", "objective": "Must not replace unrelated work"}, headers=headers)
    assert refused.status == 409
    unrelated.text("Unrelated native work settled.")
    idle()
    scenario("A2-goal-unrelated-busy-refusal", "Native owner refused Start during unrelated request, matching actionable disabled UI; no guard bypass or replacement of active work")
    action("start", "Verify goal-evidence.txt using native tools and independent review")
    provider_request = provider.request()
    state = native_state()
    evidence["start_capture_goal"] = state["goal"]
    evidence["start_capture_controls"] = state["goal_controls"]
    expect(status).to_have_text("Goal running", timeout=60000)
    assert state["goal"]["phase"] == "active"
    original_goal_id = state["goal"]["id"]
    initial_revision = state["goal_controls"]["revision"]
    evidence["goal_id"] = original_goal_id
    snapshot(page, "goal-desktop-running")
    scenario("A2-goal-start", "Keyboard start accepted native goal/request identity; compact summary rendered running from native view")

    action("edit", "Verify edited goal-evidence.txt using native tools and independent review")
    expect(page.get_by_test_id("coding-goal-objective")).to_contain_text("edited", timeout=60000)
    stale = context.request.post(endpoint, data={"revision": initial_revision, "action": "clear"}, headers=headers)
    assert stale.status == 409, "Old goal revision must reject a stale control"
    assert native_state()["goal"]["id"] == original_goal_id
    scenario("A7-goal-stale", "Native revision rejected old clear controls after goal edit; no replacement or replay")
    provider_request.text("A model claim of success at an ordinary turn end is not verified completion.")
    provider_request = provider.request()  # Native autonomous continuation, not Studio replay.
    expect(status).to_have_text("Goal running", timeout=60000)
    expect(status).not_to_have_text("Independently verified completion")
    expect(page.get_by_role("button", name="Stop", exact=True)).to_be_enabled()
    action("pause")
    expect(status).to_have_text("Goal paused", timeout=60000)
    provider_request.text("This canceled fixture reply must not continue the goal.")
    idle()
    expect(status).to_have_text("Goal paused")
    snapshot(page, "goal-desktop-paused")
    scenario("A2-goal-busy-edit-pause", "Goal-owned inference admitted native edit/pause while busy; pause canceled only its goal-owned root and awaited native settlement, Stop remained separately available; ordinary model success claim was not verified completion")

    action("resume")
    provider_request = provider.request()
    expect(status).to_have_text("Goal running", timeout=60000)
    provider_request.tool("goal-block", "update_goal", {"action": "blocked", "message": "Fixture external prerequisite: required project input is unavailable"})
    # Native handle_tool_use ends paused/blocked work at the completed tool batch;
    # it deliberately makes no further provider call for a closing model claim.
    idle()
    expect(status).to_have_text("Goal blocked", timeout=60000)
    expect(details).to_contain_text("required project input is unavailable")
    blocked = native_state()
    assert blocked["active_request"] is None
    assert blocked["goal"]["id"] == original_goal_id
    assert blocked["goal"]["phase"] == "blocked" and blocked["goal"]["completion"] is None
    assert any(item["id"] == evidence["actions"][-1]["request_id"] and item["status"] == "completed" for item in blocked["requests"])
    provider.assert_no_request()
    snapshot(page, "goal-desktop-blocked")
    scenario("A2-goal-blocked", "Native update_goal tool blocked continuation with actionable reason; no success inferred from tool acceptance")

    # The native command executes once but its browser acknowledgment is lost.
    # Only transport is fault-injected; reconstruction still uses native views.
    uncertain_commands = []
    def lose_goal_ack(route):
        response = route.fetch()
        assert response.ok
        uncertain_commands.append(response.json())
        route.abort("connectionreset")
    page.route(endpoint, lose_goal_ack, times=1)
    page.get_by_role("button", name="Edit goal", exact=True).click()
    page.get_by_label("Goal objective", exact=True).fill("Edited after an unconfirmed native acknowledgment")
    page.get_by_role("button", name="Confirm edit", exact=True).click()
    expect(page.get_by_test_id("coding-goal-notice")).to_contain_text("Fresh native goal state inspected", timeout=60000)
    expect(page.get_by_test_id("coding-goal-objective")).to_have_text("Edited after an unconfirmed native acknowledgment")
    expect(page.get_by_role("button", name="Confirm edit", exact=True)).to_be_disabled()
    assert len(uncertain_commands) == 1
    provider.assert_no_request()
    page.get_by_role("button", name="Cancel goal draft", exact=True).click()
    expect(summary).to_be_focused()
    snapshot(page, "goal-desktop-uncertain-reconciled")
    scenario("A7-goal-uncertain-action", "Lost acknowledgment of real native edit triggered fresh captured-view reconciliation without command replay; retained draft was stale and disabled after reconstruction")

    action("resume")
    request = provider.request()
    # The public native report uses active_form for in-progress items, not the
    # private structured step field. Exercise that actual presentation contract.
    request.tool("goal-status", "update_status", {"items": [{"step": "Create and verify GOAL_CHECKLIST_EVIDENCE", "active_form": "Writing GOAL_CHECKLIST_EVIDENCE with native tools", "status": "in_progress"}, {"step": "Independently review goal completion", "active_form": "Reviewing evidence", "status": "pending"}]})
    request = provider.request()
    assert "Status updated (2 items)" in request.tool_result("goal-status")
    assert "GOAL_CHECKLIST_EVIDENCE" in request.tool_result("goal-status")
    expect(page.get_by_test_id("coding-goal-progress-report")).to_contain_text("GOAL_CHECKLIST_EVIDENCE", timeout=60000)
    expect(status).not_to_have_text("Independently verified completion")
    snapshot(page, "goal-desktop-work-checklist")
    scenario("A2-goal-checklist-updates", "Native update_status work checklist appeared from public captured tool output in expandable goal details, explicitly not goal-specific verified completion")
    request.tool("goal-file", "write_file", {"path": "goal-evidence.txt", "content": "GOAL_NATIVE_EVIDENCE\n"})
    request = provider.request()
    assert "goal-evidence.txt" in request.tool_result("goal-file")
    request.tool("goal-read", "read_file", {"paths": ["goal-evidence.txt"]})
    request = provider.request()
    assert "GOAL_NATIVE_EVIDENCE" in request.tool_result("goal-read")
    request.tool("goal-finish", "finish_goal", {"checklist": [{"requirement": "goal-evidence.txt contains GOAL_NATIVE_EVIDENCE", "evidence": "Native write_file and read_file verified GOAL_NATIVE_EVIDENCE"}], "limitations": "Deterministic provider fixture, not a live-model acceptance workload."})
    review = provider.request()
    review.text('{"verdict":"gap","reason":"Repeat read_file to close GOAL_REVIEW_GAP before acceptance."}')
    request = provider.request()
    expect(page.get_by_test_id("coding-goal-review-gap")).to_contain_text("GOAL_REVIEW_GAP", timeout=60000)
    expect(status).not_to_have_text("Independently verified completion")
    snapshot(page, "goal-desktop-review-gap")
    request.tool("goal-review-read", "read_file", {"paths": ["goal-evidence.txt"]})
    request = provider.request()
    assert "GOAL_NATIVE_EVIDENCE" in request.tool_result("goal-review-read")
    request.tool("goal-finish-accepted", "finish_goal", {"checklist": [{"requirement": "goal-evidence.txt contains GOAL_NATIVE_EVIDENCE", "evidence": "Native write_file and repeated read_file verified GOAL_NATIVE_EVIDENCE"}], "limitations": "Deterministic provider fixture, not a live-model acceptance workload."})
    provider.request().text('{"verdict":"accept","reason":"The native tool results verify the goal file requirement."}')
    request = provider.request()
    request.text("Goal completed after independent verification.")
    idle()
    expect(status).to_have_text("Independently verified completion", timeout=60000)
    expect(page.get_by_label("Independently verified goal checklist")).to_contain_text("GOAL_NATIVE_EVIDENCE")
    assert (first / "goal-evidence.txt").read_text() == "GOAL_NATIVE_EVIDENCE\n"
    state = native_state()
    assert state["goal"]["completion"]["checklist"]
    evidence["verified_completion"] = state["goal"]["completion"]
    snapshot(page, "goal-desktop-verified")
    scenario("A2-goal-verified", "Native tools created/read the file; separate native completion reviewer accepted evidence; only persisted completion checklist rendered verified (review/provider are deterministic fixtures)")

    page.set_viewport_size({"width": 390, "height": 844})
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
    summary.focus()
    summary.press("Enter")
    expect(details).not_to_be_visible()
    summary.press("Enter")
    expect(details).to_be_visible()
    expect(summary).to_be_focused()
    snapshot(page, "goal-narrow-verified-keyboard")
    scenario("A10-goal-narrow-keyboard", "390x844 goal disclosure keyboard toggles without lost focus or horizontal overflow; verified checklist is bounded/scrollable")
    page.set_viewport_size({"width": 1440, "height": 1000})

    action("clear")
    expect(status).to_have_text("Goal cleared", timeout=60000)
    action("start", "Reopen this interrupted goal only after explicit resume")
    held = provider.request()
    expect(status).to_have_text("Goal running", timeout=60000)
    before = native_state()["goal_controls"]["revision"]
    # Release only the browser's SSE view before the acceptance server restart.
    # Detaching must not cancel or release the held autonomous root. Then lose
    # the exact native owner abruptly, distinct from a clean quit/manual pause.
    page.goto(base + "/api/auth/status")
    detached = native_state()
    assert detached["active_request"] == evidence["actions"][-1]["request_id"]
    assert detached["goal"]["phase"] == "active"
    provider.assert_no_request()
    evidence["restart_path"] = "view detached, then verified native owner killed and exited; no claim of awaited request cleanup"
    restart_server(native_crash=True)
    # Deliberate reopening after actual native owner process loss/release, never replay.
    page.goto(base + "/coding")
    page.get_by_role("button", name="Refresh coding conversations", exact=True).click()
    with page.expect_response(lambda response: response.url == base + f"/api/coding/conversations/{conversation}/open" and response.request.method == "POST", timeout=60000) as reopened:
        page.locator('[aria-label="Saved coding conversations"] button').filter(has_text=conversation).click()
    assert reopened.value.ok
    expect(status).to_have_text("Interrupted · explicit resume required", timeout=60000)
    idle()
    provider.assert_no_request()
    stale = context.request.post(endpoint, data={"revision": before, "action": "resume"}, headers=headers)
    assert stale.status == 409, "Old owner incarnation must reject controls after reopening"
    headers["X-Mimir-Runtime-Generation"] = str(reopened.value.json()["runtime_generation"])
    summary.focus()
    summary.press("Enter")
    expect(details).to_be_visible()
    snapshot(page, "goal-desktop-reopened-interrupted")
    scenario("A7-goal-reopen", "Actual native owner loss and deliberate reopen retained goal as interrupted/paused, no auto-resume or provider replay; old owner controls rejected. Abrupt process exit is not awaited request cleanup.")
    action("resume")
    provider.request().tool("goal-pause-tool", "update_goal", {"action": "pause", "message": "Explicit continuation verified; pause for handoff"})
    idle()
    expect(status).to_have_text("Goal paused", timeout=60000)
    paused = native_state()
    assert paused["active_request"] is None
    assert paused["goal"]["phase"] == "paused" and paused["goal"]["cause"] == "user_input"
    assert paused["goal"]["reason"] == "Explicit continuation verified; pause for handoff"
    assert paused["goal"]["completion"] is None
    assert any(item["id"] == evidence["actions"][-1]["request_id"] and item["status"] == "completed" for item in paused["requests"])
    provider.assert_no_request()
    action("edit", "BOUNDED_GOAL_OBJECTIVE_" + "x" * 20000)
    expect(page.get_by_test_id("coding-goal-clipped")).to_contain_text("only part", timeout=60000)
    page.get_by_role("button", name="Edit goal", exact=True).click()
    expect(page.get_by_label("Goal objective", exact=True)).to_have_value("")
    expect(page.get_by_role("button", name="Confirm edit", exact=True)).to_be_disabled()
    page.get_by_role("button", name="Cancel goal draft", exact=True).click()
    page.set_viewport_size({"width": 390, "height": 844})
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
    snapshot(page, "goal-narrow-clipped-objective")
    scenario("A10-goal-bounded-display", "Native large goal was explicitly labeled clipped; edit did not reuse the displayed prefix as a full objective, and 390x844 layout remained bounded without horizontal overflow")
    page.set_viewport_size({"width": 1440, "height": 1000})
    action("clear")
    expect(status).to_have_text("Goal cleared", timeout=60000)
    provider.assert_no_request()
    evidence["status"] = "passed"
