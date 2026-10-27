# SPDX-License-Identifier: AGPL-3.0-only
"""Controlled-clock retirement through authenticated Studio and real native ownership.

The separately compiled acceptance component freezes only the retention clock.
Native busy admission, close, saved history and project trust are not simulated.
The error rendering case is explicitly a browser HTTP fault; actual native cleanup
failure ownership is covered by the native contract fixtures, not this browser fault.
"""
from __future__ import annotations

import json
import time

from coding_run_scenarios import unfold_activity
from coding_ui import expect_connected, expect_opened, opened_id, saved_row

RETENTION_NS = 30 * 60 * 1_000_000_000


def run_retirement_scenarios(page, context, base, provider, first, second_id,
                             report, scenario, snapshot):
    from playwright.sync_api import expect

    conversation = opened_id(page)
    headers = {"Authorization": "Bearer " + page.evaluate("localStorage.getItem('unsloth_auth_token')")}
    clock_url = base + "/api/coding-acceptance/retention-clock"
    evidence = report.setdefault("retirement", {"kind": "controlled-clock-real-native-ownership", "clock_steps": []})

    def clock(advance=0):
        response = context.request.post(clock_url, data={"advance_ns": advance}, headers=headers, timeout=60000)
        assert response.ok, f"Acceptance clock command failed: {response.status} {response.text()}"
        value = response.json()
        evidence["clock_steps"].append(value)
        return value

    def owner(value, identifier=conversation):
        return next((item for item in value["owners"] if item["conversation_id"] == identifier), None)

    def wait_owner(predicate):
        deadline = time.monotonic() + 60
        while True:
            value = clock()
            item = owner(value)
            if item is not None and predicate(item):
                return value
            assert time.monotonic() < deadline, "Native owner did not reach the expected state"
            page.wait_for_timeout(50)

    def switch(identifier):
        button = saved_row(page, identifier)
        if not button.is_visible():
            page.get_by_role("button", name="Toggle sidebar", exact=True).click()
        expect(button).to_be_visible(timeout=60000)
        button.click()
        expect_opened(page, identifier)
        expect_connected(page)

    # Clock controls are authenticated even in the isolated acceptance composition.
    unauthenticated = context.request.post(clock_url, data={"advance_ns": 0})
    assert unauthenticated.status in (401, 403)
    scenario("A6-retention-fixture-auth", "Acceptance-only clock endpoint rejects missing Studio authorization")

    # A quiet inference stream remains native busy after all viewers leave.
    prompt_url = base + f"/api/coding/conversations/{conversation}/prompts"
    page.get_by_label("Coding prompt", exact=True).fill("RETIREMENT_HELD_NATIVE_WORK")
    with page.expect_response(lambda response: response.url == prompt_url and response.request.method == "POST", timeout=60000) as waiting:
        page.get_by_label("Coding prompt", exact=True).press("Enter")
    assert waiting.value.status == 202
    evidence["request"] = waiting.value.json()
    headers["X-Mimir-Runtime-Generation"] = waiting.value.request.headers["x-mimir-runtime-generation"]
    pending = provider.request()
    switch(second_id)
    wait_owner(lambda item: not item["viewed"] and not item["quiescent"])
    assert owner(clock(RETENTION_NS * 2)) is not None
    provider.assert_no_request()
    scenario("A7-retention-busy-exclusion", "Sixty controlled minutes are not inferred from silence: 60 controlled minutes with no viewers and held native request did not release the owner")

    # Perform an actual native file edit, then await native settlement without a
    # viewer. This is fixture/provider evidence, never live-model acceptance.
    pending.tool("retirement-write", "write_file", {"path": "retirement.txt", "content": "RETAINED_NATIVE_HISTORY\n"})
    next_turn = provider.request()
    assert "retirement.txt" in next_turn.tool_result("retirement-write")
    next_turn.text("RETIREMENT_NATIVE_COMPLETED")
    wait_owner(lambda item: not item["viewed"] and item["quiescent"])
    assert (first / "retirement.txt").read_text() == "RETAINED_NATIVE_HISTORY\n"
    assert owner(clock(RETENTION_NS - 1)) is not None

    # A new view interrupts the nearly-expired interval. Removing it creates a
    # fresh interval; age of the conversation or last transcript entry is irrelevant.
    switch(conversation)
    wait_owner(lambda item: item["viewed"])
    clock(RETENTION_NS * 2)
    switch(second_id)
    wait_owner(lambda item: not item["viewed"] and item["quiescent"])
    before_expiry = clock(RETENTION_NS - 1)
    assert owner(before_expiry) is not None
    expired = clock(1)
    assert owner(expired) is None
    retired = next(item for item in expired["retired"] if item["conversation_id"] == conversation)
    assert retired["released"] and retired["lease_released"]
    scenario("A7-retention-exact-duration-view-reset", "Actual view reopened at 30min-1ns interrupts eligibility; after last detach, 30min-1ns retains owner and exact 30min awaits native close and confirms execution lease release")

    listing = context.request.get(base + "/api/coding/conversations", headers=headers)
    assert listing.ok
    saved = next(item for item in listing.json()["conversations"] if item["id"] == conversation)
    assert saved["cwd"] == str(first) and not saved["live"]

    # Retirement leaves the supervised process epoch unchanged. A stale browser
    # must stop retrying views, not silently reacquire an execution attachment.
    events = context.request.get(base + f"/api/coding/conversations/{conversation}/events", headers=headers, timeout=60000)
    assert events.status == 404, events.text()
    assert events.headers["x-mimir-requires-reopen"] == "true"
    runtime = context.request.get(base + "/api/coding/runtime", headers=headers).json()
    assert str(runtime["generation"]) == headers["X-Mimir-Runtime-Generation"]
    assert owner(clock()) is None, "Read-only view retry reacquired the retired owner"
    provider.assert_no_request()
    evidence["retired_view"] = {"status": events.status, "requires_reopen": True, "generation": runtime["generation"], "owner_reacquired": False}
    scenario("A7-retired-view-deliberate-reopen", "Same-generation events GET returned 404/reopen-required after real idle retirement, with no execution owner acquisition or provider replay")

    # Deliberate reopen reuses the same history and canonical project despite the
    # isolated saved ancestor distrust. No prompt or work is replayed.
    switch(conversation)
    # No reopen notice exists; the restored view shows nothing running and no work.
    expect(page.get_by_test_id("coding-run-status")).to_have_text("Completed", timeout=60000)
    expect(page.get_by_test_id("coding-working")).to_have_count(0)
    expect(page.get_by_test_id("coding-transcript")).to_contain_text("RETIREMENT_NATIVE_COMPLETED", timeout=60000)
    # The footer shows the folder name; its title is the canonical cwd.
    expect(page.get_by_test_id("coding-canonical-cwd")).to_have_attribute("title", str(first))
    unfold_activity(page)
    row = page.locator('[data-testid="coding-tool-row"][data-call-id="retirement-write"]')
    expect(row).to_have_count(1)
    expect(row).to_have_attribute("data-tool-status", "completed")
    provider.assert_no_request()
    snapshot(page, "retirement-desktop-reopened")
    page.set_viewport_size({"width": 390, "height": 844})
    snapshot(page, "retirement-narrow-reopened")
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
    page.set_viewport_size({"width": 1440, "height": 1000})
    scenario("A6-retirement-history-trust-reopen", "Same native ID/canonical folder/history and completed file effect restored with non-persisting effective trust; no automatic provider continuation; reopened view inspected at 1440x1000 and 390x844")

    # Projection-only HTTP failure fixture: never claim it executed native cleanup.
    # Native failure tests separately prove retained ownership and retry semantics.
    switch(second_id)
    failure = "Idle cleanup failed. Resources may still be owned; inspect native diagnostics before retrying."
    open_url = base + f"/api/coding/conversations/{conversation}/open"
    page.route(open_url, lambda route: route.fulfill(status=502, content_type="application/json", body=json.dumps({"detail": failure})), times=1)
    saved_button = saved_row(page, conversation)
    saved_button.focus()
    saved_button.press("Enter")
    expect(page.get_by_test_id("coding-opening-error")).to_contain_text(failure, timeout=60000)
    expect_opened(page, second_id)
    snapshot(page, "retirement-desktop-cleanup-error")
    page.set_viewport_size({"width": 390, "height": 844})
    snapshot(page, "retirement-narrow-cleanup-error")
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
    page.set_viewport_size({"width": 1440, "height": 1000})
    expect(saved_button).to_be_enabled(timeout=60000)
    switch(conversation)
    expect(page.get_by_test_id("coding-opening-error")).to_have_count(0)
    provider.assert_no_request()
    scenario("A7-retirement-error-rendering-http-fixture", "Explicit 502 projection fault retained current identity, showed cleanup uncertainty without claiming release, and allowed inspected deliberate retry; keyboard Enter and desktop/narrow rendering checked. Native cleanup failure is not simulated by this UI fault.")
