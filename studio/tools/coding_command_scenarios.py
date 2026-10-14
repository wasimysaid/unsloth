# SPDX-License-Identifier: AGPL-3.0-only
"""Ticket-243 coding-route assertions. Native outcomes, not button-presence tests."""
from __future__ import annotations

import json
import re
import uuid


def run_command_scenarios(page, context, base, provider, first, report, scenario, snapshot):
    from playwright.sync_api import expect

    conversation = page.get_by_test_id("coding-conversation-id").inner_text()
    headers = {"Authorization": "Bearer " + page.evaluate("localStorage.getItem('unsloth_auth_token')")}
    headers["X-Mimir-Runtime-Generation"] = str(context.request.get(base + "/api/coding/runtime", headers=headers).json()["generation"])
    endpoint = base + f"/api/coding/conversations/{conversation}"
    composer = page.get_by_label("Coding prompt", exact=True)
    transcript = page.get_by_test_id("coding-transcript")
    outcomes = report.setdefault("commands", {"outcomes": [], "diagnostics": [], "requests": []})

    for method, suffix, body in (("GET", "/commands", None), ("POST", "/commands", {"operation_id": "auth-op", "name": "compress"}), ("GET", "/commands/auth-op", None), *[("GET", f"/diagnostics/{kind}", None) for kind in ("context", "tokens", "retry", "execution")]):
        response = context.request.fetch(endpoint + suffix, method=method, data=body)
        assert response.status in (401, 403)
    scenario("A6-commands-diagnostics-auth", "Every new command/diagnostic surface rejects unauthenticated conversation-ID access")

    native_catalog = context.request.get(endpoint + "/commands", headers=headers)
    assert native_catalog.ok
    catalog = native_catalog.json()
    assert catalog["conversation_id"] == conversation
    commands = catalog["commands"]
    assert commands and all(set(("name", "description", "aliases", "argument", "availability")).issubset(command) for command in commands)
    report["commands"]["catalog"] = commands
    trigger = page.get_by_role("button", name="Commands", exact=True)
    trigger.focus()
    trigger.press("Enter")
    dialog = page.get_by_role("dialog", name="Native commands", exact=True)
    expect(dialog).to_be_visible()
    expect(page.get_by_label("Search native commands")).to_be_focused()
    expect(dialog.get_by_role("button", name=f"Select /{commands[0]['name']}", exact=True)).to_be_visible()
    page.get_by_label("Search native commands").fill("not-a-command-243")
    expect(dialog).to_contain_text("No matching supported commands")
    page.get_by_label("Search native commands").fill("")
    snapshot(page, "commands-desktop-discovery")
    page.keyboard.press("Escape")
    expect(trigger).to_be_focused()
    scenario("A2-A10-effective-command-discovery", "Effective native names/aliases/descriptions/optional arguments/availability rendered; keyboard open/search/Escape restored trigger focus at 1440x1000")

    def command(name, tail=""):
        composer.fill("/" + name + (" " + tail if tail else ""))
        with page.expect_response(lambda response: response.url == endpoint + "/commands" and response.request.method == "POST", timeout=90000) as waiting:
            composer.press("Enter")
        response = waiting.value
        result = response.json()
        outcomes["outcomes"].append({"name": name, "status": response.status, "result": result})
        return response, result

    for name in ("no-such-command-243", "quit"):
        response, _ = command(name)
        assert response.status in (400, 404)
        expect(page.get_by_test_id("coding-command-error")).to_be_visible()
        provider.assert_no_request()
    bypass = context.request.post(endpoint + "/prompts", headers=headers, data={"submission_key": "slash-bypass-243", "text": "/unknown"})
    assert bypass.status == 400
    scenario("A2-unsupported-no-model-fallback", "Unknown and terminal-only command attempts, including direct slash prompt bypass, are refused without any provider request")

    # Native built-in read-only display; rendering must not create a public turn.
    display = next((item for item in commands if item["name"] == "echo"), None)
    assert display and display["aliases"] == ["say"] and display["argument"] == "text" and display["availability"] == "any", "Current SDK-contributed command must be discovered effectively"
    display_name = display["name"]
    before = transcript.inner_text()
    response, result = command("say", "browser contributed alias")
    assert result["text"] == "guest:browser contributed alias"
    assert response.ok and result["outcome"] == "display"
    expect(page.get_by_test_id("coding-command-outcome")).to_contain_text("Transient native display")
    assert transcript.inner_text() == before
    provider.assert_no_request()
    scenario("A2-transient-native-display", "Contributed echo alias returned native display; browser identifies it as transient and public transcript is unchanged")

    # A native handled mode command must not be mistaken for submitted work.
    handled_name = next((item["name"] for item in commands if item["name"] == "plan"), None)
    assert handled_name, "Native no-task plan command must be discovered"
    if handled_name:
        response, result = command(handled_name)
        assert response.ok and result["outcome"] == "handled"
        expect(page.get_by_test_id("coding-command-outcome")).to_contain_text("Handled by Mimir")
        response, result = command(handled_name)
        assert response.ok and result["outcome"] == "handled"
        provider.assert_no_request()
        scenario("A2-native-handled", "Native mode handling changed next configuration without claiming a model request or public message")

        delivered = []
        receipt_outage = {"active": True}
        def lose_command_reply(route):
            response = route.fetch(timeout=60000)
            assert response.ok and response.json()["outcome"] == "handled"
            delivered.append({"operation_id": route.request.post_data_json["operation_id"], "result": response.json()})
            route.abort("connectionreset")
        def block_receipt(route):
            route.abort("connectionreset") if receipt_outage["active"] else route.continue_()
        page.route(endpoint + "/commands/*", block_receipt)
        page.route(endpoint + "/commands", lose_command_reply, times=1)
        composer.fill("/" + handled_name); composer.press("Enter")
        expect(page.get_by_test_id("coding-command-uncertainty")).to_contain_text("Fresh native view inspected", timeout=60000)
        assert len(delivered) == 1
        expect(composer).to_be_disabled()
        page.reload()
        reopen = page.locator('[aria-label="Saved coding conversations"] button').filter(has_text=conversation)
        expect(reopen).to_be_visible(timeout=60000); reopen.click()
        expect(page.get_by_test_id("coding-conversation-id")).to_have_text(conversation, timeout=60000)
        expect(page.get_by_test_id("coding-command-uncertainty")).to_contain_text("Fresh native view inspected", timeout=60000)
        expect(composer).to_be_disabled()
        snapshot(page, "commands-reloaded-uncertainty")
        receipt_outage["active"] = False
        with page.expect_response(lambda response: response.url == endpoint + "/commands/" + delivered[0]["operation_id"], timeout=60000) as receipt_reply:
            page.get_by_role("button", name="Inspect command outcome", exact=True).click()
        receipt = receipt_reply.value.json()
        assert receipt["status"] == "completed" and receipt["result"] == delivered[0]["result"]
        expect(page.get_by_test_id("coding-command-uncertainty")).to_have_count(0)
        expect(page.get_by_test_id("coding-command-outcome")).to_contain_text("Handled by Mimir")
        assert len(delivered) == 1
        outcomes["reconciled_operation"] = delivered[0]["operation_id"]
        page.unroute(endpoint + "/commands/*", block_receipt)
        response, result = command(handled_name)
        assert response.ok and result["outcome"] == "handled"
        provider.assert_no_request()
        scenario("A7-uncertain-native-command-receipt", "Lost state-changing mode response and receipt outage forced fresh-view reconstruction; browser reload/reopen retained the delivery identity and mutation block, exact native receipt restored the real handled outcome, no command was replayed")

    response, accepted = command("ask", "Create context for ticket 243 and keep this public history.")
    assert response.ok and accepted["outcome"] == "submitted"
    expect(page.get_by_test_id("coding-command-outcome")).to_contain_text(accepted["request_id"])
    outcomes["requests"].append(accepted)
    scenario("A2-contributed-native-submitted", "Contributed ask command submitted real native work with the exact request identity; browser did not infer terminal completion from dispatch")
    pending = provider.request()
    expect(page.get_by_role("button", name="Stop", exact=True)).to_be_visible(timeout=60000)
    compression_name = next((item["name"] for item in commands if item["name"] == "compress" or "compress" in item["aliases"]), None)
    assert compression_name, "Native model-context compression must be available"
    busy = context.request.post(endpoint + "/commands", headers=headers, data={"operation_id": str(uuid.uuid4()), "name": compression_name, "tail": ""})
    outcomes["busy_refusal"] = {"status": busy.status, "body": busy.json()}
    assert busy.status == 409, busy.text()
    assert "busy" in busy.json()["detail"].lower() or "idle" in busy.json()["detail"].lower()
    pending.text("Public ticket 243 reply retained after compression. " * 80)
    expect(page.get_by_test_id("coding-run-status")).to_have_text("Completed", timeout=60000)
    expect(page.get_by_role("button", name="Stop", exact=True)).to_have_count(0, timeout=60000)
    expect(transcript).to_contain_text("Public ticket 243 reply retained after compression.")
    scenario("A2-native-busy-admission", "Compression was rejected natively while a real HTTP-provider request was running; accepted request settled normally")

    public_history = transcript.inner_text()
    diagnostic_trigger = page.get_by_role("button", name="Inspect current-session context and usage", exact=True)
    diagnostic_trigger.focus()
    diagnostic_trigger.press("Enter")
    diagnostic_dialog = page.get_by_role("dialog", name="Current-session diagnostics", exact=True)
    expect(diagnostic_dialog).to_be_visible()
    for kind in ("context", "tokens", "retry", "execution"):
        with page.expect_response(lambda response: response.url == endpoint + f"/diagnostics/{kind}", timeout=60000) as waiting:
            page.get_by_role("button", name=f"{kind.capitalize()} diagnostics", exact=True).click()
        response = waiting.value
        assert response.ok
        data = response.json()
        assert data["kind"] == kind and data["conversation_id"] == conversation
        assert len(json.dumps(data).encode()) <= 65536
        assert all(key not in json.dumps(data).lower() for key in ("authorization", "api_key", "api-key", "bearer "))
        outcomes["diagnostics"].append(data)
        expect(page.get_by_test_id("coding-diagnostic-result")).to_be_visible()
    snapshot(page, "commands-desktop-diagnostics")
    page.keyboard.press("Escape")
    expect(diagnostic_trigger).to_be_focused()
    assert transcript.inner_text() == public_history
    scenario("A2-bounded-private-diagnostics", "Context/token/retry/execution requests returned bounded native data outside the unchanged public transcript, with no credentials")

    # Respond only to the real summary provider request while native compression owns its lifecycle.
    composer.fill("/" + compression_name)
    composer.press("Enter")
    summary = provider.request(timeout=90)
    summary.text("Summary: ticket 243 public conversation was retained. No filesystem effects were requested.")
    expect(page.get_by_test_id("coding-compression-status")).to_contain_text("completed", timeout=90000)
    expect(page.get_by_test_id("coding-compression-status")).to_contain_text("public conversation history is retained")
    expect(transcript).to_contain_text("Create context for ticket 243")
    expect(transcript).to_contain_text("Public ticket 243 reply retained after compression.")
    expect(page.get_by_test_id("coding-command-outcome")).to_contain_text("Submitted native request", timeout=90000)
    snapshot(page, "commands-desktop-compressed")
    scenario("A2-native-compression-history", "Native summary request reached terminal compression, truthful outcome rendered, and prior public input/reply remain readable")

    page.set_viewport_size({"width": 390, "height": 844})
    trigger.focus(); trigger.press("Enter")
    expect(dialog).to_be_visible()
    page.get_by_label("Search native commands").fill(display_name)
    choice = dialog.get_by_role("button", name=f"Select /{display_name}", exact=True)
    choice.focus(); choice.press("Enter")
    expect(choice).to_have_attribute("aria-pressed", "true")
    execute = dialog.get_by_role("button", name="Execute native command", exact=True)
    execute.focus()
    with page.expect_response(lambda response: response.url == endpoint + "/commands" and response.request.method == "POST", timeout=60000) as narrow_command:
        execute.press("Enter")
    assert narrow_command.value.ok and narrow_command.value.json()["outcome"] == "display"
    expect(dialog).to_contain_text("Transient native display")
    provider.assert_no_request()
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
    title = dialog.get_by_role("heading", name="Native commands", exact=True).bounding_box()
    assert title and title["y"] >= 0 and title["y"] + title["height"] <= 844, "Command heading must remain unclipped after native display"
    for label in ("Search native commands",):
        box = page.get_by_label(label).bounding_box()
        assert box and box["x"] >= 0 and box["x"] + box["width"] <= 391
    snapshot(page, "commands-narrow-discovery")
    page.keyboard.press("Escape")
    expect(trigger).to_be_focused()
    diagnostic_trigger.focus(); diagnostic_trigger.press("Enter")
    page.get_by_role("button", name="Context diagnostics", exact=True).click()
    expect(page.get_by_test_id("coding-diagnostic-result")).to_be_visible()
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
    title = page.get_by_role("heading", name="Current-session diagnostics", exact=True).bounding_box()
    assert title and title["y"] >= 0 and title["y"] + title["height"] <= 844, "Diagnostic heading must remain unclipped after inspection"
    snapshot(page, "commands-narrow-diagnostics")
    page.keyboard.press("Escape")
    expect(diagnostic_trigger).to_be_focused()
    scenario("A10-narrow-command-context-focus", "390x844: full-width dismissible commands/diagnostics, keyboard selection, reachable controls, Escape focus restoration and no horizontal overflow")
    page.set_viewport_size({"width": 1440, "height": 1000})
