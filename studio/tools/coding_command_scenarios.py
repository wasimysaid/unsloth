# SPDX-License-Identifier: AGPL-3.0-only
"""Ticket-243 coding-route assertions. Native outcomes, not button-presence tests."""
from __future__ import annotations

import json
import re
import uuid

from coding_recovery_scenarios import captured_state
from coding_ui import expect_ready, open_context_usage, open_saved, opened_id, run_command, type_command


def run_command_scenarios(page, context, base, provider, first, report, scenario, snapshot):
    from playwright.sync_api import expect

    conversation = opened_id(page)
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
    display = next((item for item in commands if item["name"] == "echo"), None)
    assert display and display["aliases"] == ["say"] and display["argument"] == "text" and display["availability"] == "any", "Current SDK-contributed command must be discovered effectively"
    display_name = display["name"]
    # Discovery is the composer's command list: typing "/" as the first token
    # reads the effective native registry (GET .../commands) and lists it.
    listing = page.get_by_test_id("coding-mention-list")
    composer.fill("")
    composer.focus()
    with page.expect_response(lambda response: response.url == endpoint + "/commands" and response.request.method == "GET", timeout=60000) as discovered:
        page.keyboard.type("/")
    assert discovered.value.ok and discovered.value.json()["commands"] == commands
    expect(listing).to_be_visible()
    expect(listing).to_have_attribute("aria-label", "Commands")
    for item in commands:
        row = listing.locator(f'[data-mention-kind="command"][data-mention-name="/{item["name"]}"]')
        expect(row).to_have_count(1)
        expect(row).to_contain_text(item["description"])
        if item["argument"]:
            expect(row).to_contain_text(f"<{item['argument']}>")
        expect(row).not_to_have_attribute("aria-disabled", "true")  # Idle: every effective command is selectable.
    snapshot(page, "commands-desktop-discovery")
    composer.fill("/" + display["aliases"][0])
    expect(listing.locator(f'[data-mention-kind="command"][data-mention-name="/{display_name}"]')).to_have_attribute("aria-selected", "true")
    composer.fill("/not-a-command-243")
    expect(listing).to_contain_text("No matching commands")
    expect(listing.get_by_role("option")).to_have_count(0)
    composer.press("Escape")
    expect(listing).to_have_count(0)
    expect(composer).to_be_focused()
    composer.fill("")
    scenario("A2-A10-effective-command-discovery", "Typing / read the effective native registry; names, descriptions and optional arguments rendered as selectable composer command rows, alias search selected its command, unmatched search reported no matches and Escape closed the list keeping prompt focus at 1440x1000")

    def command(name, tail="", known=True):
        text = "/" + name + (" " + tail if tail else "")
        if known:
            type_command(page, text)
        else:
            # No row can match an unsupported name; dismiss the list so Enter
            # runs exactly the typed text instead of completing another command.
            composer.fill(text)
            composer.press("Escape")
        with page.expect_response(lambda response: response.url == endpoint + "/commands" and response.request.method == "POST", timeout=90000) as waiting:
            composer.press("Enter")
        response = waiting.value
        result = response.json()
        outcomes["outcomes"].append({"name": name, "status": response.status, "result": result})
        return response, result

    for name in ("no-such-command-243", "quit"):
        response, _ = command(name, known=False)
        assert response.status in (400, 404)
        expect(page.get_by_test_id("coding-command-error")).to_be_visible()
        provider.assert_no_request()
    bypass = context.request.post(endpoint + "/prompts", headers=headers, data={"submission_key": "slash-bypass-243", "text": "/unknown"})
    assert bypass.status == 400
    scenario("A2-unsupported-no-model-fallback", "Unknown and terminal-only command attempts, including direct slash prompt bypass, are refused without any provider request")

    # Native built-in read-only display; rendering must not create a public turn.
    before = transcript.inner_text()
    response, result = command("say", "browser contributed alias")
    assert result["text"] == "guest:browser contributed alias"
    assert response.ok and result["outcome"] == "display"
    outcome = page.get_by_test_id("coding-command-outcome")
    expect(outcome).to_contain_text(result["text"])
    expect(outcome.get_by_role("button", name="Dismiss", exact=True)).to_be_visible()
    assert transcript.inner_text() == before
    provider.assert_no_request()
    scenario("A2-transient-native-display", "Contributed echo alias returned native display; browser rendered it only in the dismissible command outcome outside the unchanged public transcript")

    # A native handled mode command must not be mistaken for submitted work.
    handled_name = next((item["name"] for item in commands if item["name"] == "plan"), None)
    assert handled_name, "Native no-task plan command must be discovered"
    if handled_name:
        response, result = command(handled_name)
        assert response.ok and result["outcome"] == "handled"
        # A handled outcome renders no transient display or error; its native
        # effect is the selected configuration, shown by the Plan mode chip.
        expect(page.get_by_test_id("coding-plan-mode")).to_be_visible(timeout=60000)
        expect(page.get_by_test_id("coding-command-outcome")).to_have_count(0)
        expect(page.get_by_test_id("coding-command-error")).to_have_count(0)
        assert captured_state(base, headers, conversation)["configuration"]["mode"] == "plan"
        response, result = command(handled_name)
        assert response.ok and result["outcome"] == "handled"
        provider.assert_no_request()
        scenario("A2-native-handled", "Native mode handling changed next configuration without claiming a model request or public message")

        delivered = []
        receipt_outage = {"active": True}
        uncertainty = page.get_by_test_id("coding-command-uncertainty")
        check = uncertainty.get_by_role("button", name="Check again", exact=True)
        blocker = page.locator("#coding-send-explanation")
        def lose_command_reply(route):
            # Discovery GETs share this URL; only the first command POST loses its reply.
            if route.request.method != "POST" or delivered:
                route.continue_()
                return
            response = route.fetch(timeout=60000)
            assert response.ok and response.json()["outcome"] == "handled"
            delivered.append({"operation_id": route.request.post_data_json["operation_id"], "result": response.json()})
            route.abort("connectionreset")
        def block_receipt(route):
            route.abort("connectionreset") if receipt_outage["active"] else route.continue_()
        page.route(endpoint + "/commands/*", block_receipt)
        page.route(endpoint + "/commands", lose_command_reply)
        try:
            run_command(page, "/" + handled_name)
            # The fresh view reconciles automatically, but the exact receipt is unavailable.
            expect(uncertainty).to_contain_text(f"/{handled_name} may or may not have run. It was not repeated.", timeout=60000)
            expect(check).to_be_enabled(timeout=60000)
            assert len(delivered) == 1
            expect(blocker).to_have_text("Waiting for the native command outcome.", timeout=60000)
            page.reload()
            open_saved(page, base, conversation, ready=False)
            expect(uncertainty).to_contain_text(f"/{handled_name} may or may not have run. It was not repeated.", timeout=60000)
            # The reopened view's own automatic receipt read must have failed before the outage ends.
            expect(check).to_be_enabled(timeout=60000)
            expect(blocker).to_have_text("Waiting for the native command outcome.", timeout=60000)
            snapshot(page, "commands-reloaded-uncertainty")
            receipt_outage["active"] = False
            with page.expect_response(lambda response: response.url == endpoint + "/commands/" + delivered[0]["operation_id"], timeout=60000) as receipt_reply:
                check.click()
            receipt = receipt_reply.value.json()
            assert receipt["status"] == "completed" and receipt["result"] == delivered[0]["result"]
            expect(uncertainty).to_have_count(0)
            # The restored handled outcome renders no panel or error; its native effect is Plan mode.
            expect(page.get_by_test_id("coding-command-error")).to_have_count(0)
            expect(page.get_by_test_id("coding-plan-mode")).to_be_visible(timeout=60000)
            expect_ready(page)
            assert len(delivered) == 1
            outcomes["reconciled_operation"] = delivered[0]["operation_id"]
        finally:
            page.unroute(endpoint + "/commands/*", block_receipt)
            page.unroute(endpoint + "/commands", lose_command_reply)
        response, result = command(handled_name)
        assert response.ok and result["outcome"] == "handled"
        provider.assert_no_request()
        scenario("A7-uncertain-native-command-receipt", "Lost state-changing mode response and receipt outage forced fresh-view reconstruction; browser reload/reopen retained the delivery identity and send block, Check again read the exact native receipt and restored the real handled outcome, no command was replayed")

    response, accepted = command("ask", "Create context for ticket 243 and keep this public history.")
    assert response.ok and accepted["outcome"] == "submitted"
    outcomes["requests"].append(accepted)
    pending = provider.request()
    # A submitted outcome renders no panel; the exact request is the native running one.
    expect(page.get_by_test_id("coding-run-status")).to_have_text("Running", timeout=60000)
    expect(page.get_by_role("button", name="Stop", exact=True)).to_be_visible(timeout=60000)
    assert captured_state(base, headers, conversation)["active_request"] == accepted["request_id"]
    scenario("A2-contributed-native-submitted", "Contributed ask command submitted real native work with the exact request identity; browser did not infer terminal completion from dispatch")
    compression_name = next((item["name"] for item in commands if item["name"] == "compress" or "compress" in item["aliases"]), None)
    assert compression_name, "Native model-context compression must be available"
    # While Running the composer shows Stop and ignores Enter, so busy admission
    # is exercised through the authenticated coding command route.
    busy = context.request.post(endpoint + "/commands", headers=headers, data={"operation_id": str(uuid.uuid4()), "name": compression_name, "tail": ""})
    outcomes["busy_refusal"] = {"status": busy.status, "body": busy.json()}
    assert busy.status == 409, busy.text()
    assert "busy" in busy.json()["detail"].lower() or "idle" in busy.json()["detail"].lower()
    pending.text("Public ticket 243 reply retained after compression. " * 80)
    expect(page.get_by_test_id("coding-run-status")).to_have_text("Completed", timeout=60000)
    expect(page.get_by_role("button", name="Stop", exact=True)).to_have_count(0, timeout=60000)
    expect(transcript).to_contain_text("Public ticket 243 reply retained after compression.")
    scenario("A2-native-busy-admission", "Compression sent through the authenticated coding API (the composer cannot run commands while Running) was rejected natively while a real HTTP-provider request was running; accepted request settled normally")

    # Diagnostics have no browser surface; read them through the authenticated route.
    public_history = transcript.inner_text()
    for kind in ("context", "tokens", "retry", "execution"):
        response = context.request.get(endpoint + f"/diagnostics/{kind}", headers=headers)
        assert response.ok, response.text()
        data = response.json()
        assert data["kind"] == kind and data["conversation_id"] == conversation
        assert len(json.dumps(data).encode()) <= 65536
        assert all(key not in json.dumps(data).lower() for key in ("authorization", "api_key", "api-key", "bearer "))
        outcomes["diagnostics"].append(data)
    # The composer's context ring is the only rendered usage surface; it exists
    # exactly when native usage reports a context window.
    ring = page.get_by_test_id("coding-context-usage")
    window = (captured_state(base, headers, conversation).get("usage") or {}).get("context_window")
    if window:
        usage = open_context_usage(page)
        expect(usage).to_contain_text("tokens")
        snapshot(page, "commands-desktop-context")
        page.keyboard.press("Escape")
        expect(usage).to_have_count(0)
        expect(ring).to_be_focused()
    else:
        expect(ring).to_have_count(0)
    assert transcript.inner_text() == public_history
    provider.assert_no_request()
    scenario("A2-bounded-private-diagnostics", "Authenticated context/token/retry/execution routes returned bounded native data with no credentials; the context ring reflected native usage and the public transcript stayed unchanged")

    compression = page.get_by_test_id("coding-compression-status")
    with page.expect_response(lambda response: response.url == endpoint + "/commands" and response.request.method == "POST", timeout=90000) as compressing:
        type_command(page, "/" + compression_name).press("Enter")
        # Respond only to the real summary provider request while native compression owns its lifecycle.
        summary = provider.request(timeout=90)
        expect(compression).to_have_text("Compacting context…", timeout=90000)
        summary.text("Summary: ticket 243 public conversation was retained. No filesystem effects were requested.")
    compressed = compressing.value.json()
    outcomes["outcomes"].append({"name": compression_name, "status": compressing.value.status, "result": compressed})
    assert compressing.value.ok and compressed["outcome"] == "submitted" and compressed["request_id"], compressed
    expect(compression).to_have_count(0, timeout=90000)
    native = captured_state(base, headers, conversation)["compression"]
    assert native["request_id"] == compressed["request_id"] and native["status"] == "completed", native
    expect(transcript).to_contain_text("Create context for ticket 243")
    expect(transcript).to_contain_text("Public ticket 243 reply retained after compression.")
    snapshot(page, "commands-desktop-compressed")
    scenario("A2-native-compression-history", "Native summary request reached terminal compression for the exact submitted request, the footer showed compaction only while it ran, and prior public input/reply remain readable")

    page.set_viewport_size({"width": 390, "height": 844})
    composer.fill("")
    composer.focus()
    page.keyboard.type("/")
    expect(listing).to_be_visible()
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
    box = listing.bounding_box()
    assert box and box["x"] >= 0 and box["x"] + box["width"] <= 391 and box["y"] >= 0, "Command list must stay inside the narrow viewport"
    snapshot(page, "commands-narrow-discovery")
    page.keyboard.press("Escape")
    expect(listing).to_have_count(0)
    expect(composer).to_be_focused()
    composer.fill("")
    page.keyboard.type("/" + display["aliases"][0])
    expect(listing.locator(f'[data-mention-kind="command"][data-mention-name="/{display_name}"]')).to_have_attribute("aria-selected", "true")
    page.keyboard.press("Tab")
    expect(composer).to_have_value(f"/{display_name} ")
    expect(listing).to_have_count(0)
    page.keyboard.type("narrow keyboard display")
    with page.expect_response(lambda response: response.url == endpoint + "/commands" and response.request.method == "POST", timeout=60000) as narrow_command:
        page.keyboard.press("Enter")
    narrow = narrow_command.value.json()
    assert narrow_command.value.ok and narrow["outcome"] == "display" and narrow["text"] == "guest:narrow keyboard display", narrow
    assert {key: narrow_command.value.request.post_data_json[key] for key in ("name", "tail")} == {"name": display_name, "tail": "narrow keyboard display"}
    expect(outcome).to_contain_text(narrow["text"])
    expect(outcome).to_be_in_viewport()
    provider.assert_no_request()
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
    box = outcome.bounding_box()
    assert box and box["x"] >= 0 and box["x"] + box["width"] <= 391, "Command outcome must stay inside the narrow viewport"
    dismiss = outcome.get_by_role("button", name="Dismiss", exact=True)
    dismiss.focus(); dismiss.press("Enter")
    expect(outcome).to_have_count(0)
    if (captured_state(base, headers, conversation).get("usage") or {}).get("context_window"):
        ring.focus(); ring.press("Enter")
        usage = page.get_by_role("dialog").filter(has_text="Context window")
        expect(usage).to_be_visible()
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
        box = usage.bounding_box()
        assert box and box["x"] >= 0 and box["x"] + box["width"] <= 391 and box["y"] >= 0 and box["y"] + box["height"] <= 844, "Context usage must remain unclipped"
        snapshot(page, "commands-narrow-context")
        page.keyboard.press("Escape")
        expect(usage).to_have_count(0)
        expect(ring).to_be_focused()
    scenario("A10-narrow-command-context-focus", "390x844: keyboard-opened command list stayed in the viewport and Escape kept prompt focus; alias search, Tab completion and Enter ran the native display command; the dismissible outcome and context-usage popover stayed reachable without horizontal overflow and Escape restored ring focus")
    page.set_viewport_size({"width": 1440, "height": 1000})
