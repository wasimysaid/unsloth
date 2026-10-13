# SPDX-License-Identifier: AGPL-3.0-only
"""Ticket-245 refresh through rendered Studio, authenticated bridge and native owners.

Only provider responses and isolated models.json inputs are deterministic fixtures.
No browser catalog fulfillment or replacement session engine is used.
"""
from __future__ import annotations

import json
import re

from coding_picker_scenarios import assert_provider_selection, assert_viewport_box
from coding_provider_fixture import PICKER_PROVIDER_A, PICKER_MODEL, PICKER_API_A


def run_catalog_scenarios(page, context, base, provider, native, first, report, scenario, snapshot, restart_server):
    from playwright.sync_api import expect
    import psutil

    conversation = page.get_by_test_id("coding-conversation-id").inner_text()
    headers = {"Authorization": "Bearer " + page.evaluate("localStorage.getItem('unsloth_auth_token')")}
    endpoint = base + f"/api/coding/conversations/{conversation}"
    path = native / "models.json"
    original = json.loads(path.read_text())
    changed = json.loads(path.read_text())
    added_id = "refresh-added"
    identity = f"{PICKER_PROVIDER_A}/{added_id}"
    added = {"name": "Added during coding", "apiModel": "refresh-wire-1", "limit": {"context": 128000},
             "input": ["text"], "reasoning": True, "thinkingLevelMap": {"low": "low", "high": "high"}}
    trigger = page.get_by_role("button", name="Configure next coding request", exact=True)
    picker = page.get_by_test_id("coding-model-picker")
    heading = picker.get_by_role("button", name="Choose coding model", exact=True)
    refresh = picker.get_by_role("button", name="Refresh model choices", exact=True)
    unavailable = picker.get_by_test_id("coding-model-unavailable")
    status = page.get_by_test_id("coding-run-status")
    running = page.get_by_test_id("coding-running-model")
    next_model = page.get_by_test_id("coding-next-model")
    transcript = page.get_by_test_id("coding-transcript")
    send = page.get_by_role("button", name="Send", exact=True)
    composer = page.get_by_label("Coding prompt", exact=True)
    facts = report.setdefault("workload", {"kind": "catalog-deterministic-http-provider-real-native", "requests": []})
    facts["catalog"] = {"identity": identity, "refreshes": [], "viewports": [], "provider_calls": []}
    catalog_facts = facts["catalog"]
    pid = report["supervised_pid"]

    def open_picker():
        if not picker.is_visible():
            trigger.click()
        expect(heading).to_be_visible()
        expect(refresh).to_be_enabled(timeout=60000)

    def close_picker():
        # Selection returns to configuration asynchronously; verify focus before
        # Escape, then await actual dismissal rather than observing exit animation.
        expect(heading).to_be_visible(timeout=60000)
        heading.focus()
        page.keyboard.press("Escape")
        expect(picker).not_to_be_visible()
        expect(trigger).to_be_focused()

    def read_inventory():
        response = context.request.get(endpoint + "/models", headers=headers)
        assert response.ok, response.status
        return response.json()

    def refresh_choices():
        expect(refresh).to_be_enabled(timeout=60000)
        with page.expect_response(lambda r: r.url == endpoint + "/models/refresh" and r.request.method == "POST", timeout=60000) as response:
            refresh.click()
        result = response.value
        assert result.ok, f"Native refresh failed ({result.status}): {result.text()}"
        expect(refresh).to_be_enabled(timeout=60000)
        assert psutil.Process(pid).is_running(), "Refresh restarted the native runtime"
        catalog_facts["refreshes"].append({"conversation_id": conversation, "supervised_pid": pid,
                                          "identities": [[p["id"], m["id"]] for p in result.json() for m in p["models"]]})
        return result.json()

    def set_model():
        heading.click()
        row = picker.get_by_test_id("coding-model-list").locator(f'button[data-provider="{PICKER_PROVIDER_A}"][data-model="{added_id}"]')
        expect(row).to_be_enabled(timeout=60000)
        row.focus()
        row.press("Enter")
        expect(heading).to_be_focused(timeout=60000)
        expect(next_model).to_contain_text(identity, timeout=60000)
        expect(picker).to_be_visible()

    def submit(text):
        composer.fill(text)
        expect(send).to_be_enabled(timeout=60000)
        with page.expect_response(lambda r: r.url == endpoint + "/prompts" and r.request.method == "POST", timeout=60000) as response:
            composer.press("Enter")
        result = response.value
        assert result.status == 202
        ack = result.json()
        assert set(result.request.post_data_json) == {"submission_key", "text"}
        facts["requests"].append({"conversation_id": conversation, "request_id": ack["request_id"]})
        return ack["request_id"]

    def layout(name):
        viewport = page.viewport_size
        assert_viewport_box(picker.bounding_box(), viewport["width"], viewport["height"], label=name)
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
        for label in ("Refresh model choices", "Retry selected model", "Choose replacement"):
            control = picker.get_by_role("button", name=label, exact=True)
            if control.count():
                control.scroll_into_view_if_needed()
                assert_viewport_box(control.bounding_box(), viewport["width"], viewport["height"], label=label)
        catalog_facts["viewports"].append({"scene": name, "viewport": viewport})
        snapshot(page, name)

    # Pin a real request before changing inventory; retain it through a real tool.
    first_request = submit("CATALOG_ACTIVE: execute the explicit fixture tool only")
    held = provider.request()
    assert_provider_selection(held, PICKER_API_A, "high")
    expect(running).to_contain_text(f"{PICKER_PROVIDER_A}/{PICKER_MODEL}", timeout=60000)
    running_before = running.inner_text()
    changed["providers"][PICKER_PROVIDER_A]["models"][added_id] = added
    del changed["providers"][PICKER_PROVIDER_A]["models"][PICKER_MODEL]
    path.write_text(json.dumps(changed))
    open_picker()
    # Folder rediscovery alone must not appear selectable before native refresh.
    assert not any(m["id"] == added_id for p in read_inventory() for m in p["models"])
    refresh_choices()
    expect(unavailable).to_contain_text(f"{PICKER_PROVIDER_A}/{PICKER_MODEL}", timeout=60000)
    expect(unavailable).to_contain_text("No provider or model was substituted", timeout=60000)
    expect(running).to_have_text(running_before)
    provider.assert_no_request()
    layout("catalog-desktop-unavailable-running")
    scenario("A5-catalog-live-add-remove", "Host-backed refresh added a new native selectable identity and removed the selected inventory entry without dropping its selection, changing its live request, or restarting the process")

    # Explicit retry is rejected, not replaced. Replacement is a separate user action.
    unavailable.get_by_role("button", name="Retry selected model", exact=True).click()
    expect(picker.get_by_role("alert")).to_be_visible(timeout=60000)
    expect(next_model).to_contain_text(f"{PICKER_PROVIDER_A}/{PICKER_MODEL}")
    expect(running).to_have_text(running_before)
    unavailable.get_by_role("button", name="Choose replacement", exact=True).click()
    row = picker.get_by_test_id("coding-model-list").locator(f'button[data-provider="{PICKER_PROVIDER_A}"][data-model="{added_id}"]')
    expect(row).to_be_enabled(timeout=60000)
    row.click()
    expect(heading).to_be_focused(timeout=60000)
    expect(next_model).to_contain_text(identity, timeout=60000)
    expect(unavailable).to_have_count(0, timeout=60000)
    expect(running).to_have_text(running_before)
    close_picker()

    # The current coding route deliberately refuses a second prompt while busy;
    # actual native queue/dequeue races are covered by the paired contract suite.
    # This browser check must not bypass or change that admission policy.
    refused = context.request.post(endpoint + "/prompts", headers=headers,
                                   data={"submission_key": "catalog-busy-refused", "text": "CATALOG_BUSY_REFUSED"})
    assert refused.status == 409, refused.text()
    assert "native work is active" in refused.json()["detail"]
    provider.assert_no_request()
    # Refresh changed metadata before the next execution boundary, while the
    # existing request remains pinned to its removed model and original mapping.
    added["name"] = "Changed before next request"
    added["apiModel"] = "refresh-wire-2"
    path.write_text(json.dumps(changed))
    open_picker()
    refresh_choices()
    expect(heading).to_contain_text("Changed before next request", timeout=60000)
    expect(picker).to_contain_text("API model: refresh-wire-2")
    expect(running).to_have_text(running_before)
    close_picker()
    held.tool("catalog-pinned-shell", "shell", {"command": "printf CATALOG_NATIVE_CONTINUATION", "timeout_seconds": 30, "yield_time_ms": 10000})
    continuation = provider.request()
    assert_provider_selection(continuation, PICKER_API_A, "high")
    assert "CATALOG_NATIVE_CONTINUATION" in continuation.tool_result("catalog-pinned-shell")
    continuation.text("CATALOG_FIRST_COMPLETE")
    expect(status).to_have_text("Completed", timeout=60000)
    expect(transcript).to_contain_text("CATALOG_FIRST_COMPLETE", timeout=60000)
    next_request = submit("CATALOG_NEXT_REQUEST")
    next_call = provider.request()
    assert_provider_selection(next_call, "refresh-wire-2", "high")
    next_call.text("CATALOG_NEXT_COMPLETE")
    expect(status).to_have_text("Completed", timeout=60000)
    expect(transcript).to_contain_text("CATALOG_NEXT_COMPLETE", timeout=60000)
    expect(page.get_by_role("button", name="Stop", exact=True)).to_have_count(0)
    catalog_facts["provider_calls"] += [{"request_id": first_request, "api_model": PICKER_API_A, "native_tool_continuation": True},
                                       {"request_id": next_request, "api_model": "refresh-wire-2"}]
    scenario("A4-catalog-active-next-boundary", "Removed running model continued its real native shell request on its pinned wire identity; the route refused concurrent prompt admission, then the next rendered request used the changed native API mapping after refresh; native queue races are separate contract evidence")

    # Invalid source is a native refresh failure, distinct from browser transport faults.
    open_picker()
    path.write_text('{"providers":')
    with page.expect_response(lambda r: r.url == endpoint + "/models/refresh", timeout=60000) as response:
        refresh.click()
    assert response.value.status >= 400, "Invalid discovery source must fail refresh explicitly"
    expect(picker.get_by_role("alert")).to_contain_text("Refresh", timeout=60000)
    expect(next_model).to_contain_text(identity)
    assert any(m["id"] == added_id for p in read_inventory() for m in p["models"])
    path.write_text(json.dumps(changed))
    picker.get_by_role("button", name="Read current inventory", exact=True).click()
    expect(refresh).to_be_enabled(timeout=60000)
    refresh_choices()
    scenario("A5-catalog-refresh-failure-retry", "Native malformed discovery source refused refresh, retained the last controller inventory/selection/history, and recovered only through explicit read and refresh")

    # Commit a real refresh but lose its browser reply. Reopening must read the
    # retained inventory rather than replay the state-changing operation.
    refresh_url = endpoint + "/models/refresh"
    refresh_posts = []
    page.on("request", lambda request: refresh_posts.append(request.url)
            if request.url == refresh_url and request.method == "POST" else None)
    added["name"] = "Native change after lost reply"
    path.write_text(json.dumps(changed))
    committed = []

    def lose_reply(route):
        response = route.fetch()
        assert response.ok
        committed.append(True)
        route.abort("connectionreset")

    page.route(refresh_url, lose_reply, times=1)
    refresh.click()
    expect(picker.get_by_role("alert")).to_contain_text("not confirmed", timeout=60000)
    assert committed == [True] and len(refresh_posts) == 1
    close_picker()
    with page.expect_response(lambda r: r.url == endpoint + "/models" and r.request.method == "GET", timeout=60000):
        trigger.click()
    expect(heading).to_contain_text("Native change after lost reply", timeout=60000)
    expect(refresh).to_be_enabled(timeout=60000)
    assert len(refresh_posts) == 1, "Reopening automatically replayed refresh"

    # Hold only delivery of another committed refresh while the picker closes.
    # This is transport fault injection, not a delayed native discovery test.
    retained_routes = []
    added["name"] = "Native change while picker closed"
    path.write_text(json.dumps(changed))

    def hold_reply(route):
        response = route.fetch()
        assert response.ok
        retained_routes.append(route)

    page.route(refresh_url, hold_reply, times=1)
    refresh.click()
    expect(picker).to_contain_text("Refreshing native model choices", timeout=60000)
    close_picker()
    expect(picker).not_to_be_visible()
    with page.expect_response(lambda r: r.url == endpoint + "/models" and r.request.method == "GET", timeout=60000):
        trigger.click()
    expect(heading).to_contain_text("Native change while picker closed", timeout=60000)
    assert len(retained_routes) == 1 and len(refresh_posts) == 2
    from playwright.sync_api import Error as BrowserError
    for route in retained_routes:
        try:
            route.abort("connectionreset")
        except BrowserError:
            pass  # AbortController may already have ended the browser delivery.
    expect(refresh).to_be_enabled(timeout=60000)
    scenario("A5-catalog-lost-closed-refresh-reconciliation", "Two real native refreshes committed, with browser reply lost/held respectively; close/reopen read native inventory, did not automatically replay either refresh, and ignored stale delivery")

    # Remove the saved identity and reopen after native EOF cleanup: readable
    # history and exact unavailable choice, never an alternate provider default.
    del changed["providers"][PICKER_PROVIDER_A]["models"][added_id]
    path.write_text(json.dumps(changed))
    refresh_choices()
    expect(unavailable).to_contain_text(identity, timeout=60000)
    page.set_viewport_size({"width": 390, "height": 844})
    layout("catalog-narrow-unavailable")
    close_picker()
    # Detach the browser's long-lived HTTP/SSE view before graceful Uvicorn
    # shutdown; native ownership/history remain until awaited plugin cleanup.
    # Otherwise Uvicorn waits for a still-connected HTTP request before lifespan.
    page.goto("about:blank")
    server_pid = restart_server()
    page.goto(base + "/coding")
    if page.viewport_size["width"] < 768:
        page.get_by_role("button", name="Toggle coding sidebar", exact=True).click()
    saved = page.locator('[aria-label="Saved coding conversations"] button').filter(has_text=conversation)
    expect(saved).to_be_visible(timeout=60000)
    saved.click()
    expect(page.get_by_test_id("coding-conversation-id")).to_have_text(conversation, timeout=60000)
    expect(transcript).to_contain_text("CATALOG_NEXT_COMPLETE", timeout=60000)
    expect(next_model).to_contain_text(identity, timeout=60000)
    open_picker()
    expect(unavailable).to_contain_text(identity, timeout=60000)
    layout("catalog-narrow-saved-unavailable")
    provider.assert_no_request()
    scenario("A5-catalog-saved-unavailable-reopen", "After native terminal cleanup and process restart, exact unavailable saved identity reopened with its history readable and no provider/model fallback or automatic prompt replay")

    # Restore the same native identity, refresh then explicitly retry, preserving
    # reasoning. Inventory success alone does not verify provider credentials.
    changed["providers"][PICKER_PROVIDER_A]["models"][added_id] = added
    path.write_text(json.dumps(changed))
    # Refresh now observes the new supervised process, not the retired old one.
    children = [p for p in psutil.Process(server_pid).children()
                if p.cmdline()[1:] == ["plugin", "run", "studio.frontend"]]
    assert len(children) == 1
    pid = children[0].pid
    report["supervised_pid"] = pid
    refresh_choices()
    # Native refresh can resolve inventory disappearance without certifying health;
    # empty configure is the explicit retry of the unchanged selected identity.
    with page.expect_response(lambda r: r.url == endpoint + "/configuration" and r.request.method == "POST", timeout=60000) as retry:
        picker.get_by_role("button", name="Retry selected model", exact=True).click()
    assert retry.value.ok, retry.value.text()
    assert retry.value.request.post_data_json == {}, "Retry replaced or reset the saved selection"
    expect(unavailable).to_have_count(0, timeout=60000)
    expect(next_model).to_contain_text(identity)
    provider.assert_no_request()
    close_picker()
    page.set_viewport_size({"width": 1440, "height": 1000})
    final_request = submit("CATALOG_RETRY_COMPLETE")
    retry_call = provider.request()
    assert_provider_selection(retry_call, "refresh-wire-2", "high")
    retry_call.text("CATALOG_RETRY_COMPLETE")
    expect(status).to_have_text("Completed", timeout=60000)
    expect(transcript).to_contain_text("CATALOG_RETRY_COMPLETE", timeout=60000)
    catalog_facts["provider_calls"].append({"request_id": final_request, "api_model": "refresh-wire-2", "explicit_retry": True})
    snapshot(page, "catalog-restored-terminal")
    scenario("A5-catalog-explicit-retry-replacement", "Retry kept the exact saved identity and reasoning; replacement required a separate explicit choice; restored identity then completed a terminal native request")
    facts["status"] = "passed"
    path.write_text(json.dumps(original))
    report["limitations"].append("Catalog scenarios are deterministic protocol/native tool evidence, not live provider or Studio local-model serving acceptance; combined #246/#255 and human review remain separate gates.")
