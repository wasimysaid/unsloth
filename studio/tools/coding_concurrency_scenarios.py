# SPDX-License-Identifier: AGPL-3.0-only
"""Ticket #247: rendered overlap admission and independent real native tool work.

The deterministic HTTP provider controls replies, not Studio execution or history.
Gate files are explicit test inputs; completion files are written only by native tools.
"""
from __future__ import annotations

import json
import re
import time


def run_concurrency_scenarios(page, context, base, provider, first, second, second_id,
                              alias, report, scenario, snapshot):
    import psutil
    from playwright.sync_api import expect

    first_id = page.get_by_test_id("coding-conversation-id").inner_text()
    headers = {"Authorization": "Bearer " + page.evaluate("localStorage.getItem('unsloth_auth_token')")}
    headers["X-Mimir-Runtime-Generation"] = str(context.request.get(base + "/api/coding/runtime", headers=headers).json()["generation"])
    evidence = report.setdefault("concurrency", {"kind": "deterministic-provider-real-native-tools", "requests": []})
    composer = page.get_by_label("Coding prompt", exact=True)
    status = page.get_by_test_id("coding-run-status")
    saved = page.locator('[aria-label="Saved coding conversations"] button')
    prompts = []
    page.on("request", lambda request: prompts.append(request.url)
            if request.method == "POST" and request.url.endswith("/prompts") else None)
    parked = []

    def receive(marker):
        for item in parked:
            if any(marker in json.dumps(message.get("content")) for message in item.body.get("messages", []) if message.get("role") == "user"):
                parked.remove(item)
                return item
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            item = provider.request(timeout=max(0.1, deadline-time.monotonic()))
            if any(marker in json.dumps(message.get("content")) for message in item.body.get("messages", []) if message.get("role") == "user"):
                return item
            parked.append(item)
        raise AssertionError("Expected native provider request was not delivered")

    def choose(identifier):
        saved.filter(has_text=identifier).click()
        expect(page.get_by_test_id("coding-conversation-id")).to_have_text(identifier, timeout=60000)
        expect(page.get_by_test_id("coding-event-status")).to_contain_text("Native event stream connected", timeout=60000)

    def enter(text):
        composer.fill(text)
        expect(page.get_by_role("button", name="Send", exact=True)).to_be_enabled(timeout=60000)
        composer.press("Enter")

    def accepted(text, identifier):
        with page.expect_response(lambda response: response.url == base + f"/api/coding/conversations/{identifier}/prompts", timeout=60000) as response:
            enter(text)
        assert response.value.status == 202
        ack = response.value.json()
        assert ack["conversation_id"] == identifier
        evidence["requests"].append(ack)
        expect(status).to_have_text("Running", timeout=60000)
        return ack

    def wait_file(path):
        deadline = time.monotonic() + 30
        while not path.is_file() and time.monotonic() < deadline:
            page.wait_for_timeout(50)
        assert path.is_file(), f"Native tool did not create {path.name}"

    def tool_start(marker, folder):
        request = receive(marker)
        request.tool(marker, "shell", {
            "command": f"echo $$ > {marker}.pid; printf STARTED > {marker}.started; while [ ! -f {marker}.release ]; do sleep 0.1; done; printf NATIVE_COMPLETED > {marker}.completed",
            "timeout_seconds": 180, "yield_time_ms": 30000,
        })
        wait_file(folder / f"{marker}.pid")
        wait_file(folder / f"{marker}.started")
        process = psutil.Process(int((folder / f"{marker}.pid").read_text()))
        assert marker in " ".join(process.cmdline()), "Tool PID identity mismatch"
        return process

    first_ack = accepted("CONCURRENT_A: run a gated native shell", first_id)
    process_a = tool_start("CONCURRENT_A", first)
    choose(second_id)
    second_ack = accepted("CONCURRENT_B: independent gated native shell", second_id)
    process_b = tool_start("CONCURRENT_B", second)
    assert process_a.is_running() and process_b.is_running()
    assert not (first / "CONCURRENT_A.completed").exists()
    assert not (second / "CONCURRENT_B.completed").exists()
    snapshot(page, "concurrency-independent-running")
    scenario("A1-A6-independent-tool-concurrency", "Two independent requests and actual gated shell processes simultaneously running under one supervised native runtime; IDs recorded; no global Studio serialization")
    evidence["tool_processes"] = [{"pid": process_a.pid, "created": process_a.create_time()}, {"pid": process_b.pid, "created": process_b.create_time()}]

    # Create through a symlink spelling while the canonical first project is busy.
    page.get_by_role("button", name="Choose another project", exact=True).click()
    page.get_by_label("Host folder path", exact=True).fill(str(alias))
    page.get_by_role("button", name="Browse", exact=True).click()
    expect(page.get_by_test_id("coding-browsed-path")).to_have_text(str(first))
    with page.expect_response(lambda response: response.url == base + "/api/coding/conversations" and response.request.method == "POST", timeout=60000) as response:
        page.get_by_role("button", name="Open project", exact=True).click()
    assert response.value.status == 201
    alias_id = response.value.json()["id"]
    assert alias_id not in (first_id, second_id)
    report["conversation_ids"].append(alias_id)
    expect(page.get_by_test_id("coding-conversation-id")).to_have_text(alias_id, timeout=60000)
    expect(page.get_by_test_id("coding-run-status")).to_have_text("Ready", timeout=60000)
    expect(page.get_by_test_id("coding-canonical-cwd")).to_have_text(str(first))
    count = len(prompts)
    enter("OVERLAP_CANCELLED: do not execute")
    dialog = page.get_by_role("alertdialog", name="Other work is active in this project")
    expect(dialog).to_be_visible(timeout=60000)
    expect(dialog.get_by_test_id("coding-overlap-cwd")).to_have_text(str(first))
    expect(dialog).to_contain_text("not a filesystem lock, sandbox")
    expect(dialog).to_contain_text("nested-workspace detector")
    expect(dialog).to_contain_text("does not grant authority over another owner")
    expect(dialog.get_by_role("button", name="Cancel prompt", exact=True)).to_be_focused()
    assert len(prompts) == count, "Warning came after prompt HTTP submission"
    snapshot(page, "concurrency-overlap-desktop")
    page.keyboard.press("Enter")
    expect(dialog).not_to_be_visible()
    expect(composer).to_be_focused()
    expect(page.get_by_test_id("coding-unsent-draft")).to_have_value("OVERLAP_CANCELLED: do not execute")
    assert len(prompts) == count and process_a.is_running() and process_b.is_running()
    scenario("A6-A10-overlap-before-submission", "Canonical symlink overlap rendered before any prompt POST; Cancel has initial focus, Enter cancels only this known-unsent prompt and restores focus; native tools stay running")

    page.set_viewport_size({"width": 390, "height": 844})
    enter("OVERLAP_ESCAPE: keep this draft")
    expect(dialog).to_be_visible(timeout=60000)
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
    box = dialog.bounding_box()
    assert box and box["x"] >= 0 and box["x"]+box["width"] <= 390 and box["y"] >= 0 and box["y"]+box["height"] <= 844
    for name in ("Cancel prompt", "Continue anyway"):
        button = dialog.get_by_role("button", name=name, exact=True)
        expect(button).to_be_visible()
        rect = button.bounding_box()
        assert rect and rect["y"]+rect["height"] <= 844
    snapshot(page, "concurrency-overlap-narrow")
    page.keyboard.press("Tab")
    expect(dialog.get_by_role("button", name="Continue anyway", exact=True)).to_be_focused()
    page.keyboard.press("Tab")
    expect(dialog.locator("summary")).to_be_focused()  # Focus cycles inside the warning.
    page.keyboard.press("Escape")
    expect(dialog).not_to_be_visible()
    expect(composer).to_be_focused()
    assert len(prompts) == count
    scenario("A10-overlap-narrow-keyboard", "390x844: warning/actions fully in viewport, no document overflow; keyboard focus trapped, Escape cancels without prompt submission and restores composer focus")

    enter("OVERLAP_DISCONNECTED_CANCEL: preserve draft without authority")
    expect(dialog).to_be_visible(timeout=60000)
    event_url = base + f"/api/coding/conversations/{alias_id}/events"
    def outage(route):
        route.abort("connectionreset")
    page.route(event_url, outage)
    page.evaluate("window.codingDropView = true")
    expect(status).to_contain_text("Disconnected", timeout=60000)
    expect(dialog.get_by_role("button", name="Continue anyway", exact=True)).to_be_disabled()
    page.keyboard.press("Escape")
    expect(dialog).not_to_be_visible()
    expect(page.get_by_test_id("coding-event-status")).to_be_focused()
    assert len(prompts) == count
    snapshot(page, "concurrency-disconnected-cancel-focus")
    page.evaluate("window.codingDropView = false")
    page.unroute(event_url, outage)
    expect(status).to_have_text("Ready", timeout=60000)
    scenario("A10-overlap-disconnected-cancel-focus", "Fault-injected browser stream loss disables Continue; Escape cancels only the known-unadmitted draft and restores focus to meaningful native status while composer is disabled")

    # A direct unconfirmed submission must be refused before native admission too.
    race_body = {"submission_key": "route-unconfirmed-overlap", "text": "OVERLAP_ROUTE_GUARD"}
    refusal = context.request.post(base + f"/api/coding/conversations/{alias_id}/prompts", data=race_body, headers=headers)
    assert refusal.status == 409 and refusal.json()["detail"]["code"] == "overlap_required"
    assert refusal.json()["detail"]["overlap"] == {"cwd": str(first), "conversations": [{"id": first_id}]}
    scenario("A6-overlap-native-route-guard", "Authenticated prompt without explicit confirmation refused with canonical overlap DTO and no request ID; native admission guard closes preflight race")

    enter("OVERLAP_CONFIRMED: intentional concurrent work")
    expect(dialog).to_be_visible(timeout=60000)
    # Initial Cancel focus; Tab continues using the keyboard, not mouse.
    page.keyboard.press("Tab")
    expect(dialog.get_by_role("button", name="Continue anyway", exact=True)).to_be_focused()
    delayed = []
    prompt_url = base + f"/api/coding/conversations/{alias_id}/prompts"
    page.route(prompt_url, lambda route: delayed.append(route), times=1)
    page.keyboard.press("Enter")
    expect(dialog).not_to_be_visible()
    expect(page.get_by_test_id("coding-event-status")).to_be_focused()
    expect(composer).to_be_disabled()
    assert len(delayed) == 1, "Prompt transport was not gated"
    with page.expect_response(lambda response: response.url == prompt_url, timeout=60000) as response:
        delayed[0].continue_()  # Delay only; forward to the real authenticated route.
    assert response.value.status == 202
    scenario("A10-overlap-delayed-continuation-focus", "Warning dismissal while prompt HTTP is delayed restores focus to enabled native status, not disabled composer; releasing transport reaches real native admission")
    assert response.value.request.post_data_json["overlap_confirmed"] is True
    alias_ack = response.value.json()
    evidence["requests"].append(alias_ack)
    held_alias = receive("OVERLAP_CONFIRMED")
    expect(status).to_have_text("Running", timeout=60000)
    page.get_by_role("button", name="Stop", exact=True).click()
    expect(status).to_contain_text("Stopped", timeout=60000)
    held_alias.text("This cancelled provider reply must not become new work")
    assert process_a.is_running() and process_b.is_running()
    scenario("A6-overlap-explicit-continuation", "Keyboard Continue sends the warned prompt with explicit confirmation and accepts a distinct native request; exact Stop leaves both prior tools running")

    page.set_viewport_size({"width": 1440, "height": 1000})
    choose(first_id)
    expect(page.get_by_test_id("coding-request-id")).to_contain_text(first_ack["request_id"])
    page.get_by_role("button", name="Stop", exact=True).click()
    expect(status).to_contain_text("Stopped", timeout=60000)
    assert not process_a.is_running(), "Stopped was shown before native tool cleanup"
    assert process_b.is_running(), "Stopping first conversation cancelled independent tool"
    assert not (first / "CONCURRENT_A.completed").exists()
    choose(second_id)
    expect(page.get_by_test_id("coding-request-id")).to_contain_text(second_ack["request_id"])
    expect(status).to_have_text("Running")
    # The gate is test input; only the real native shell creates completed output.
    (second / "CONCURRENT_B.release").write_text("release\n")
    wait_file(second / "CONCURRENT_B.completed")
    final = receive("CONCURRENT_B")
    tool_output = final.tool_result("CONCURRENT_B")
    if "Process running" in tool_output:
        match = re.search(r"session ID (\d+)", tool_output)
        assert match, "Retained shell session identity missing"
        final.tool("CONCURRENT_B_inspect", "shell", {"action": "inspect", "session_id": int(match[1]), "yield_time_ms": 30000})
        final = receive("CONCURRENT_B")
        tool_output = final.tool_result("CONCURRENT_B_inspect")
    assert "Process completed" in tool_output and "exit code 0" in tool_output, tool_output
    final.text("CONCURRENT_B_SETTLED: verified real native shell output")
    expect(status).to_have_text("Completed", timeout=60000)
    assert not process_b.is_running()
    assert (second / "CONCURRENT_B.completed").read_text() == "NATIVE_COMPLETED"
    # Any first-session follow-up that raced cancellation has no remaining owner.
    for item in parked:
        item.text("Cancelled request settled; do not resume")
    parked.clear()
    while not provider.requests.empty():
        provider.request(timeout=1).text("Cancelled request settled; do not resume")
    snapshot(page, "concurrency-independent-settled")
    evidence["settlement"] = {"first_cancelled_tool_reaped": True, "second_completed_tool_reaped": True, "second_output": "NATIVE_COMPLETED", "overlap_cancelled": True}
    scenario("A7-cancellation-isolation-settlement", "Stop settled exact first request and reaped its shell, without cancelling independent second request; second native shell wrote expected output and reached Completed with process reaped")
    # The outer driver expects the original first conversation for recovery checks.
    choose(first_id)
