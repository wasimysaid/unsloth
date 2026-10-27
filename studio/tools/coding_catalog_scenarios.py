# SPDX-License-Identifier: AGPL-3.0-only
"""Ticket-245 refresh through rendered Studio, authenticated bridge and native owners.

Only provider responses and isolated models.json inputs are deterministic fixtures.
No browser catalog fulfillment or replacement session engine is used.
"""
from __future__ import annotations

import json
import re

from coding_picker_scenarios import assert_provider_selection, assert_viewport_box, trigger_label
from coding_provider_fixture import PICKER_PROVIDER_A, PICKER_MODEL, PICKER_API_A
from coding_ui import expect_ready, opened_id, saved_row


def run_catalog_scenarios(page, context, base, provider, native, first, report, scenario, snapshot, restart_server):
    from playwright.sync_api import expect
    import psutil

    conversation = opened_id(page)
    headers = {"Authorization": "Bearer " + page.evaluate("localStorage.getItem('unsloth_auth_token')")}
    headers["X-Mimir-Runtime-Generation"] = str(context.request.get(base + "/api/coding/runtime", headers=headers).json()["generation"])
    endpoint = base + f"/api/coding/conversations/{conversation}"
    path = native / "models.json"
    original = json.loads(path.read_text())
    changed = json.loads(path.read_text())
    added_id = "refresh-added"
    identity = f"{PICKER_PROVIDER_A}/{added_id}"
    added = {"name": "Added during coding", "apiModel": "refresh-wire-1", "limit": {"context": 128000},
             "input": ["text"], "reasoning": True, "thinkingLevelMap": {"low": "low", "high": "high"}}
    # The trigger names the model label and committed effort. A selection missing
    # from the inventory falls back to its native local model ID plus "Unavailable".
    trigger = page.get_by_test_id("coding-model-trigger")
    picker = page.get_by_test_id("coding-model-picker")
    heading = picker.get_by_role("button", name="Choose model", exact=True)
    search = picker.get_by_role("textbox", name="Search models", exact=True)
    back = picker.get_by_role("button", name="Back", exact=True)
    # Refresh lives on the model list page, not the configuration page.
    refresh = picker.get_by_role("button", name="Refresh models", exact=True)
    listing = picker.get_by_test_id("coding-model-list")
    added_row = listing.locator(f'button[data-provider="{PICKER_PROVIDER_A}"][data-model="{added_id}"]')
    unavailable = picker.get_by_test_id("coding-model-unavailable")
    # Native selection_unavailable, rendered above the transcript.
    selection_unavailable = page.get_by_test_id("coding-selection-unavailable")
    status = page.get_by_test_id("coding-run-status")
    transcript = page.get_by_test_id("coding-transcript")
    send = page.get_by_role("button", name="Send", exact=True)
    composer = page.get_by_label("Coding prompt", exact=True)
    facts = report.setdefault("workload", {"kind": "catalog-deterministic-http-provider-real-native", "requests": []})
    facts["catalog"] = {"identity": identity, "refreshes": [], "viewports": [], "provider_calls": []}
    catalog_facts = facts["catalog"]
    pid = report["supervised_pid"]

    def retained(model_id):
        # Exact retained local ID, never a substituted provider default.
        return re.compile("^Model: " + re.escape(model_id) + "(?: · .+)?$")

    def open_picker(models=False):
        if not picker.is_visible():
            trigger.click()
        expect(picker).to_be_visible()
        if models and not search.is_visible():
            heading.click()
        elif not models and search.is_visible():
            back.click()
        if models:
            expect(search).to_be_visible()
            expect(refresh).to_be_enabled(timeout=60000)
        else:
            expect(heading).to_be_visible()

    def close_picker():
        # Escape on the model list returns to configuration; verify focus before
        # the dismissing Escape, then await actual dismissal rather than the exit animation.
        if search.is_visible():
            search.press("Escape")
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
        open_picker(models=True)
        with page.expect_response(lambda r: r.url == endpoint + "/models/refresh" and r.request.method == "POST", timeout=60000) as response:
            refresh.click()
        result = response.value
        assert result.ok, f"Native refresh failed ({result.status}): {result.text()}"
        expect(refresh).to_be_enabled(timeout=60000)
        assert psutil.Process(pid).is_running(), "Refresh restarted the native runtime"
        catalog_facts["refreshes"].append({"conversation_id": conversation, "supervised_pid": pid,
                                          "identities": [[p["id"], m["id"]] for p in result.json() for m in p["models"]]})
        return result.json()

    def configure_reply(waiting, body):
        result = waiting.value
        assert result.ok, f"Native configuration failed ({result.status}): {result.text()}"
        assert result.request.post_data_json == body, "Configuration replaced or reset the saved selection"
        accepted = result.json()
        assert (accepted.get("provider"), accepted.get("model")) == (PICKER_PROVIDER_A, added_id), "Native configuration accepted a different identity"
        return accepted

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
        # Resize/scroll schedules popover collision positioning asynchronously.
        # Await the same full-viewport requirement rather than measuring its old
        # desktop coordinates during that positioning frame.
        expect(picker).to_be_in_viewport(ratio=1)
        assert_viewport_box(picker.bounding_box(), viewport["width"], viewport["height"], label=name)
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
        for label, control in (("Refresh models", refresh),
                               ("Retry", unavailable.get_by_role("button", name="Retry", exact=True)),
                               ("Choose another", unavailable.get_by_role("button", name="Choose another", exact=True))):
            if control.count():
                control.scroll_into_view_if_needed()
                assert_viewport_box(control.bounding_box(), viewport["width"], viewport["height"], label=label)
        catalog_facts["viewports"].append({"scene": name, "viewport": viewport})
        snapshot(page, name)

    # Pin a real request before changing inventory; retain it through a real tool.
    first_request = submit("CATALOG_ACTIVE: execute the explicit fixture tool only")
    held = provider.request()
    assert_provider_selection(held, PICKER_API_A, "high")
    # The held provider call above is the running selection; the rendered status
    # only shows that native work is still active.
    expect(status).to_have_text("Running", timeout=60000)
    changed["providers"][PICKER_PROVIDER_A]["models"][added_id] = added
    del changed["providers"][PICKER_PROVIDER_A]["models"][PICKER_MODEL]
    path.write_text(json.dumps(changed))
    open_picker(models=True)
    # Folder rediscovery alone must not appear selectable before native refresh.
    assert not any(m["id"] == added_id for p in read_inventory() for m in p["models"])
    refresh_choices()
    expect(added_row).to_be_visible(timeout=60000)
    expect(unavailable).to_contain_text("Model unavailable", timeout=60000)
    expect(selection_unavailable).to_be_visible(timeout=60000)
    # The removed selection is retained as-is: no other row became selected.
    expect(trigger).to_have_attribute("aria-label", retained(PICKER_MODEL), timeout=60000)
    expect(trigger).to_contain_text("Unavailable")
    expect(listing.locator('button[data-model][aria-pressed="true"]')).to_have_count(0)
    expect(status).to_have_text("Running")
    provider.assert_no_request()
    layout("catalog-desktop-unavailable-running")
    scenario("A5-catalog-live-add-remove", "Host-backed refresh added a new native selectable identity and removed the selected inventory entry without dropping its selection, substituting another row, changing its live request, or restarting the process")

    # Explicit retry is rejected, not replaced. Replacement is a separate user action.
    unavailable.get_by_role("button", name="Retry", exact=True).click()
    expect(picker.get_by_role("alert")).to_be_visible(timeout=60000)
    expect(trigger).to_have_attribute("aria-label", retained(PICKER_MODEL))
    expect(status).to_have_text("Running")
    # "Choose another" is offered on the configuration page only.
    back.click()
    unavailable.get_by_role("button", name="Choose another", exact=True).click()
    expect(search).to_be_focused(timeout=60000)
    expect(added_row).to_be_enabled(timeout=60000)
    with page.expect_response(lambda r: r.url == endpoint + "/configuration" and r.request.method == "POST", timeout=60000) as replaced:
        added_row.click()
    configure_reply(replaced, {"provider": PICKER_PROVIDER_A, "model": added_id})
    expect(heading).to_be_focused(timeout=60000)
    expect(trigger).to_have_attribute("aria-label", trigger_label(added["name"], "high"), timeout=60000)
    expect(unavailable).to_have_count(0, timeout=60000)
    expect(selection_unavailable).to_have_count(0, timeout=60000)
    expect(status).to_have_text("Running")
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
    refresh_choices()
    expect(added_row).to_contain_text("Changed before next request", timeout=60000)
    # The API mapping is not displayed; the list indexes it from the native inventory.
    search.fill("refresh-wire-2")
    expect(listing.locator("button[data-model]")).to_have_count(1)
    expect(added_row).to_be_visible()
    search.fill("")
    back.click()
    expect(heading).to_contain_text("Changed before next request", timeout=60000)
    expect(trigger).to_have_attribute("aria-label", trigger_label("Changed before next request", "high"), timeout=60000)
    expect(status).to_have_text("Running")
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
    open_picker(models=True)
    path.write_text('{"providers":')
    with page.expect_response(lambda r: r.url == endpoint + "/models/refresh", timeout=60000) as response:
        refresh.click()
    assert response.value.status >= 400, "Invalid discovery source must fail refresh explicitly"
    failure = picker.get_by_role("alert")
    expect(failure).to_contain_text(re.compile("refresh", re.I), timeout=60000)
    expect(added_row).to_be_visible()
    expect(trigger).to_have_attribute("aria-label", trigger_label("Changed before next request", "high"))
    assert any(m["id"] == added_id for p in read_inventory() for m in p["models"])
    path.write_text(json.dumps(changed))
    # The failure's Retry is an explicit read of the retained inventory, not a refresh.
    with page.expect_response(lambda r: r.url == endpoint + "/models" and r.request.method == "GET", timeout=60000) as reread:
        failure.get_by_role("button", name="Retry", exact=True).click()
    assert reread.value.ok, reread.value.status
    expect(failure).to_have_count(0, timeout=60000)
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
    expect(picker.get_by_role("alert")).to_contain_text("Coding response unconfirmed", timeout=60000)
    assert committed == [True] and len(refresh_posts) == 1
    close_picker()
    # Reopening after a failed read reads the retained native inventory once.
    with page.expect_response(lambda r: r.url == endpoint + "/models" and r.request.method == "GET", timeout=60000):
        trigger.click()
    expect(heading).to_contain_text("Native change after lost reply", timeout=60000)
    open_picker(models=True)
    assert len(refresh_posts) == 1, "Reopening automatically replayed refresh"

    # Hold only delivery of another committed refresh while the picker closes.
    # This is transport fault injection, not a delayed native discovery test.
    # Closing does not abandon the in-flight refresh, so its late delivery applies.
    retained_routes = []
    added["name"] = "Native change while picker closed"
    path.write_text(json.dumps(changed))

    def hold_reply(route):
        response = route.fetch()
        assert response.ok
        retained_routes.append((route, response))

    page.route(refresh_url, hold_reply, times=1)
    refresh.click()
    expect(refresh).to_be_disabled(timeout=60000)
    close_picker()
    expect(picker).not_to_be_visible()
    trigger.click()
    expect(heading.locator('[aria-label="Loading models"]')).to_be_visible(timeout=60000)
    expect(heading).to_contain_text("Native change after lost reply")
    assert len(retained_routes) == 1 and len(refresh_posts) == 2
    for route, response in retained_routes:
        route.fulfill(response=response)
    expect(heading).to_contain_text("Native change while picker closed", timeout=60000)
    expect(heading.locator('[aria-label="Loading models"]')).to_have_count(0, timeout=60000)
    open_picker(models=True)
    assert len(refresh_posts) == 2, "Reopening automatically replayed refresh"
    scenario("A5-catalog-lost-closed-refresh-reconciliation", "Two real native refreshes committed, with browser reply lost/held respectively; the lost reply was reported unconfirmed and reopen read native inventory; the held refresh stayed pending across close/reopen and its late delivery applied; neither refresh was automatically replayed")

    # Remove the saved identity and reopen after native EOF cleanup: readable
    # history and exact unavailable choice, never an alternate provider default.
    del changed["providers"][PICKER_PROVIDER_A]["models"][added_id]
    path.write_text(json.dumps(changed))
    refresh_choices()
    expect(unavailable).to_contain_text("Model unavailable", timeout=60000)
    expect(trigger).to_have_attribute("aria-label", retained(added_id), timeout=60000)
    expect(listing.locator('button[data-model][aria-pressed="true"]')).to_have_count(0)
    page.set_viewport_size({"width": 390, "height": 844})
    trigger.scroll_into_view_if_needed()
    layout("catalog-narrow-unavailable")
    close_picker()
    # Detach the browser's long-lived HTTP/SSE view before graceful Uvicorn
    # shutdown; native ownership/history remain until awaited plugin cleanup.
    # Otherwise Uvicorn waits for a still-connected HTTP request before lifespan.
    page.goto("about:blank")
    server_pid = restart_server()
    page.goto(base + "/coding")
    if page.viewport_size["width"] < 768:
        page.get_by_role("button", name="Toggle sidebar", exact=True).click()
    # The narrow sidebar is a sheet that closes on open, so the open reply (not
    # the row's aria-current) identifies the reopened native conversation.
    saved = saved_row(page, conversation)
    expect(saved).to_be_visible(timeout=60000)
    with page.expect_response(lambda r: r.url == endpoint + "/open" and r.request.method == "POST", timeout=60000) as reopened:
        saved.click()
    assert reopened.value.ok and reopened.value.json()["id"] == conversation, reopened.value.text()
    expect_ready(page)
    expect(transcript).to_contain_text("CATALOG_NEXT_COMPLETE", timeout=60000)
    expect(trigger).to_have_attribute("aria-label", retained(added_id), timeout=60000)
    expect(trigger).to_contain_text("Unavailable", timeout=60000)
    expect(selection_unavailable).to_be_visible(timeout=60000)
    open_picker()
    expect(unavailable).to_contain_text("Model unavailable", timeout=60000)
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
        unavailable.get_by_role("button", name="Retry", exact=True).click()
    accepted = configure_reply(retry, {})
    assert accepted.get("reasoning") == "high", "Retry reset the saved reasoning"
    expect(unavailable).to_have_count(0, timeout=60000)
    expect(selection_unavailable).to_have_count(0, timeout=60000)
    expect(trigger).to_have_attribute("aria-label", trigger_label(added["name"], "high"), timeout=60000)
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
