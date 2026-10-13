# SPDX-License-Identifier: AGPL-3.0-only
"""Ticket-252 Settings scenarios: real auth/HTTP/plugin/native; no fake completion.

Only explicitly labelled browser transport faults are injected. The provider is
an external deterministic HTTP fixture, not a model-success claim. Inventory and
reload acknowledgments always come from the running native product.
"""
from __future__ import annotations

import json
from pathlib import Path
import shutil
import time
from urllib.parse import parse_qs, urlparse

DISABLED_PLUGIN = "ticket252.disabled"
NONLIVE_PLUGIN = "ticket252.tui-only"
EFFECTIVE_SKILL = "ticket252-effective"
DISABLED_SKILL = "ticket252-disabled"


def prepare_extension_fixtures(state_root: Path, native: Path, plugin_package: Path) -> list[Path]:
    """Create packages that can be installed/prelinked but must never activate.

    Reuse the actual product component bytes, not a fabricated Wasm success stub.
    Disabled policy and TUI-only eligibility independently prohibit activation in
    this headless run. Native installer admission is exercised by the caller.
    Skills use native HOME discovery, which is independent of agent-dir.
    """
    settings_path = native / "settings.json"
    settings = json.loads(settings_path.read_text())
    settings.setdefault("plugins", {})[DISABLED_PLUGIN] = {"enabled": False}
    settings.setdefault("skills", {})[DISABLED_SKILL] = {"enabled": False}
    settings_path.write_text(json.dumps(settings) + "\n")
    for name in (EFFECTIVE_SKILL, DISABLED_SKILL):
        directory = state_root / ".mimir" / "skills" / name
        directory.mkdir(parents=True)
        (directory / "SKILL.md").write_text(
            f"---\nname: {name}\ndescription: Task-owned Settings inventory fixture\n---\n\n"
            "TICKET252_SKILL_BODY_NOT_PUBLIC: Read-only acceptance fixture.\n"
        )
    packages = []
    for identifier, frontends in ((DISABLED_PLUGIN, '["headless"]'), (NONLIVE_PLUGIN, '["tui"]')):
        package = state_root / "extension-packages" / identifier
        package.mkdir(parents=True)
        (package / "mimir-plugin.toml").write_text(
            f'manifest_version = 1\nid = "{identifier}"\nversion = "0.1.0"\n'
            f'artifact = "plugin.wasm"\nlifetime = "runtime"\nfrontends = {frontends}\n'
        )
        shutil.copyfile(plugin_package / "plugin.wasm", package / "plugin.wasm")
        packages.append(package)
    return packages


def advance_disabled_fixture_version(manifest: Path) -> None:
    """Change only task-owned, never-live package metadata to detect a stale UI.

    Native can observe this file independently of reload. The browser assertion
    proves an automatic inventory read after acknowledgment, not an activation
    replacement or a metadata change caused by reload itself.
    """
    content = manifest.read_text()
    assert f'id = "{DISABLED_PLUGIN}"' in content, "Not the task-owned disabled fixture"
    assert content.count('version = "0.1.0"') == 1, "Unexpected fixture version"
    manifest.write_text(content.replace('version = "0.1.0"', 'version = "0.2.0"'))


def plugin_by_id(inventory: dict, identifier: str) -> dict:
    matches = [item for item in inventory["inventory"]["plugins"] if item["id"] == identifier]
    assert len(matches) == 1, f"Expected exactly one native inventory entry for {identifier}"
    return matches[0]


def assert_inventory(inventory: dict, conversation: str) -> None:
    assert inventory["conversation_id"] == conversation, "Inventory targets the wrong native conversation"
    disabled = plugin_by_id(inventory, DISABLED_PLUGIN)
    nonlive = plugin_by_id(inventory, NONLIVE_PLUGIN)
    frontend = plugin_by_id(inventory, "studio.frontend")
    assert disabled["installed"] is True and disabled["enabled"] is False and disabled["live"] is False
    assert nonlive["installed"] is True and nonlive["enabled"] is True and nonlive["selected"] is False and nonlive["live"] is False
    assert frontend["selected_frontend"] is True and frontend["live"] is True
    assert inventory["inventory"]["session_id"] == conversation
    assert inventory["inventory"]["session_live_available"] is True
    assert inventory["inventory"]["runtime_live_available"] is True
    skills = {item["name"] for item in inventory["skills"]}
    assert EFFECTIVE_SKILL in skills and DISABLED_SKILL not in skills
    assert "TICKET252_SKILL_BODY_NOT_PUBLIC" not in json.dumps(inventory), "Skill instructions leaked into inspection"


def assert_same_activation(before: dict, after: dict) -> None:
    """Require native activation identity, not just an unchanged process PID."""
    assert before["live"] is True and after["live"] is True
    assert before.get("mount_id"), "Native inventory must expose the selected frontend mount identity"
    assert after.get("mount_id") == before["mount_id"], "Scoped reload replaced the process frontend activation"


def run_extension_scenarios(page, context, base, provider, first_id, second_id,
                            report, scenario, snapshot, *, native: Path):
    from playwright.sync_api import expect
    import psutil

    headers = {"Authorization": "Bearer " + page.evaluate("localStorage.getItem('unsloth_auth_token')")}
    evidence = report.setdefault("extensions", {"kind": "real-native-settings", "operations": [],
                                               "transport_faults": [], "inventories": []})
    first_url = base + f"/api/coding/conversations/{first_id}/extensions"
    reload_url = base + f"/api/coding/conversations/{first_id}/plugins/reload"
    posts = []
    queries = []
    def record_request(request):
        if request.url == reload_url and request.method == "POST":
            posts.append(request.post_data_json["operation_id"])
        if urlparse(request.url).path == urlparse(first_url).path and request.method == "GET":
            queries.append(parse_qs(urlparse(request.url).query).get("operation_id", [None])[0])
    page.on("request", record_request)

    def inspect(identifier, operation=None):
        url = base + f"/api/coding/conversations/{identifier}/extensions"
        response = context.request.get(url, params={"operation_id": operation} if operation else {}, headers=headers, timeout=60000)
        assert response.ok, f"Native inventory HTTP failure ({response.status})"
        inventory = response.json()
        assert inventory["conversation_id"] == identifier
        evidence["inventories"].append(inventory)
        return inventory

    def select(identifier):
        page.locator('[aria-label="Saved coding conversations"] button').filter(has_text=identifier).click()
        expect(page.get_by_test_id("coding-conversation-id")).to_have_text(identifier, timeout=60000)
        expect(page.get_by_test_id("coding-event-status")).to_contain_text("Native event stream connected", timeout=60000)

    def open_settings(*, mobile=False):
        if mobile:
            toggle = page.get_by_role("button", name="Toggle coding sidebar", exact=True)
            toggle.focus()
            toggle.press("Enter")
            expect(page.locator('[data-mobile="true"][data-sidebar="sidebar"]')).to_be_visible()
        trigger = page.get_by_role("button", name="Mimir Settings", exact=True)
        expect(trigger).to_be_visible()
        trigger.focus()
        trigger.press("Enter")
        expect(page.locator('[data-settings-dialog]')).to_be_visible(timeout=60000)
        expect(page.get_by_test_id("mimir-settings")).to_be_visible(timeout=60000)
        expect(page.get_by_test_id("mimir-settings-target")).to_have_text(first_id, timeout=60000)
        expect(page.get_by_test_id("mimir-runtime-diagnostics")).to_contain_text("studio.frontend", timeout=60000)
        if mobile:
            expect(page.locator('[data-mobile="true"][data-sidebar="sidebar"]')).not_to_be_visible()
        return page.get_by_test_id("mimir-settings")

    def close_settings(*, mobile=False):
        page.keyboard.press("Escape")
        expect(page.locator('[data-settings-dialog]')).not_to_be_visible()
        # The mobile sidebar closes/unmounts its Settings opener. The header
        # toggle survives both sheet dismissal and desktop→mobile replacement.
        name = "Toggle coding sidebar" if mobile else "Mimir Settings"
        expect(page.get_by_role("button", name=name, exact=True)).to_be_focused()

    def submit_held(identifier, text):
        select(identifier)
        prompt = page.get_by_label("Coding prompt", exact=True)
        prompt.fill(text)
        expect(page.get_by_role("button", name="Send", exact=True)).to_be_enabled(timeout=60000)
        with page.expect_response(lambda response: response.url == base + f"/api/coding/conversations/{identifier}/prompts" and response.request.method == "POST", timeout=60000) as waiting:
            prompt.press("Enter")
        assert waiting.value.status == 202
        request_id = waiting.value.json()["request_id"]
        held = provider.request(timeout=60)
        expect(page.get_by_test_id("coding-run-status")).to_have_text("Running", timeout=60000)
        expect(page.get_by_test_id("coding-request-id")).to_contain_text(request_id)
        return request_id, held

    def reload_with_keyboard():
        button = page.get_by_role("button", name="Reload plugins for this conversation", exact=True)
        expect(button).to_be_enabled(timeout=60000)
        button.focus()
        expect(button).to_be_focused()
        with page.expect_response(lambda response: response.url == reload_url and response.request.method == "POST", timeout=60000) as waiting:
            button.press("Enter")
        response = waiting.value
        assert response.ok, f"Native reload HTTP failure ({response.status})"
        operation = response.request.post_data_json["operation_id"]
        result = response.json()
        assert result["operation_id"] == operation
        evidence["operations"].append(result)
        return operation, result

    def assert_runtime_retained(before_frontend):
        after = inspect(first_id)
        assert_same_activation(before_frontend, plugin_by_id(after, "studio.frontend"))
        process = psutil.Process(report["supervised_pid"])
        assert process.is_running() and process.cmdline()[1:] == ["plugin", "run", "studio.frontend"]
        return after

    baseline = inspect(first_id)
    assert_inventory(baseline, first_id)
    other_baseline = inspect(second_id)
    assert_inventory(other_baseline, second_id)
    frontend_before = plugin_by_id(baseline, "studio.frontend")
    panel = open_settings()
    expect(panel.get_by_role("list", name="Effective native skills", exact=True)).to_contain_text(EFFECTIVE_SKILL)
    expect(panel.get_by_role("list", name="Effective native skills", exact=True)).not_to_contain_text(DISABLED_SKILL)
    for identifier, expected in ((DISABLED_PLUGIN, ("Installed", "Disabled", "Not live")),
                                 (NONLIVE_PLUGIN, ("Installed", "Enabled", "Not selected", "Not live"))):
        row = panel.get_by_role("listitem").filter(has_text=identifier)
        expect(row).to_have_count(1)
        for text in expected:
            expect(row).to_contain_text(text)
    expect(panel).to_contain_text("Frontend replacement requires")
    snapshot(page, "settings-desktop-inventory")
    scenario("A8-effective-inventory", "Actual Settings modal targeted first native ID; effective skill present, disabled skill absent; real installed disabled and headless-ineligible packages not live; retained runtime frontend identified")
    refresh = panel.get_by_role("button", name="Refresh view and inventory", exact=True)
    refresh.focus()
    refresh.press("Enter")
    expect(refresh).to_be_enabled(timeout=60000)
    assert not posts, "View/inventory refresh must not submit plugin reload"
    disabled_row = panel.get_by_role("listitem").filter(has_text=DISABLED_PLUGIN)
    expect(disabled_row).to_contain_text("0.1.0")
    advance_disabled_fixture_version(native / "plugins" / DISABLED_PLUGIN / "mimir-plugin.toml")
    # Let the normal native catalog watcher settle; this probe specifically needs
    # the idle/immediate-ack path, not a race with background file reconciliation.
    page.wait_for_timeout(1500)
    assert plugin_by_id(inspect(first_id), DISABLED_PLUGIN)["version"] == "0.2.0"
    # The displayed inventory is deliberately the old metadata. No manual view
    # refresh occurs here: terminal POST acknowledgment must trigger a real GET.
    expect(disabled_row).not_to_contain_text("0.2.0")
    with page.expect_response(lambda response: urlparse(response.url).path == urlparse(first_url).path and response.request.method == "GET", timeout=60000) as inventory_read:
        operation, result = reload_with_keyboard()
    assert result["status"] == "applied", "Idle reload must have native applied evidence"
    expect(page.get_by_test_id("mimir-plugin-reload-status")).to_contain_text("Applied", timeout=60000)
    assert inventory_read.value.ok
    fresh = inventory_read.value.json()
    evidence["inventories"].append(fresh)
    assert plugin_by_id(fresh, DISABLED_PLUGIN)["version"] == "0.2.0"
    expect(disabled_row).to_contain_text("0.2.0", timeout=60000)
    evidence["ack_inventory_freshness"] = {"plugin_id": DISABLED_PLUGIN, "before_version": "0.1.0", "after_version": "0.2.0", "automatic_native_get": True}
    assert inspect(first_id, operation)["inventory"]["reload"]["operation_id"] == operation
    assert inspect(second_id)["inventory"]["reload"] == other_baseline["inventory"]["reload"], "Reload changed unrelated session operation state"
    assert_runtime_retained(frontend_before)
    scenario("A8-idle-scoped-reload", "Keyboard refresh made no POST; first-ID reload applied with native operation evidence, unrelated session operation untouched and native frontend mount/PID retained")
    scenario("A8-terminal-ack-fresh-inventory", "Task-owned disabled installed package metadata changed 0.1.0→0.2.0; immediate applied acknowledgment automatically read actual native inventory and rendered new version without manual refresh (not an activation-replacement claim)")

    # Read errors are browser transport faults, not invented native error results.
    def fail_inventory(route):
        route.abort("connectionreset")
    page.route(first_url + "*", fail_inventory)
    try:
        refresh.press("Enter")
        expect(panel.get_by_role("alert")).to_contain_text("last view is stale", timeout=60000)
        expect(panel.get_by_role("button", name="Reload plugins for this conversation", exact=True)).to_be_disabled()
        expect(panel.get_by_role("list", name="Effective native skills", exact=True)).to_contain_text(EFFECTIVE_SKILL)
        snapshot(page, "settings-desktop-stale-inventory")
    finally:
        page.unroute(first_url + "*", fail_inventory)
    evidence["transport_faults"].append({"surface": "inventory GET", "fault": "connectionreset", "native_result_fabricated": False})
    refresh.press("Enter")
    expect(refresh).to_be_enabled(timeout=60000)
    expect(panel.get_by_role("alert")).to_have_count(0, timeout=60000)
    scenario("A8-inventory-stale-recovery", "Browser-only inventory GET fault preserved stale view with text warning and disabled reload; real native refresh recovered")
    close_settings()

    # Both conversations run through the actual external provider while first
    # scoped reload is deferred; release only first and keep second genuinely busy.
    other_request_id, other_held = submit_held(second_id, "TICKET252_UNRELATED_HELD_PROVIDER")
    request_id, held = submit_held(first_id, "TICKET252_TARGET_HELD_PROVIDER")
    evidence["held_requests"] = {"target": request_id, "unrelated": other_request_id}
    panel = open_settings()
    operation, result = reload_with_keyboard()
    assert result["status"] == "deferred", "Busy admission must defer, never pretend applied"
    reload_status = page.get_by_test_id("mimir-plugin-reload-status")
    expect(reload_status).to_contain_text("Deferred", timeout=60000)
    expect(reload_status).to_contain_text("Not applied yet")
    expect(panel.get_by_role("button", name="Reload plugins for this conversation", exact=True)).to_be_disabled()
    assert inspect(first_id, operation)["inventory"]["reload"]["status"] == "deferred"
    provider.assert_no_request()
    snapshot(page, "settings-desktop-deferred")
    held.text("TICKET252_TARGET_PROVIDER_COMPLETED")
    expect(reload_status).to_contain_text("Applied", timeout=60000)
    applied = inspect(first_id, operation)["inventory"]["reload"]
    assert applied["operation_id"] == operation and applied["status"] == "applied"
    evidence["operations"].append(applied)
    assert_runtime_retained(frontend_before)
    assert inspect(second_id)["inventory"]["reload"] == other_baseline["inventory"]["reload"]
    snapshot(page, "settings-desktop-eventual-applied")
    close_settings()
    select(second_id)
    expect(page.get_by_test_id("coding-run-status")).to_have_text("Running", timeout=60000)
    expect(page.get_by_test_id("coding-request-id")).to_contain_text(other_request_id)
    provider.assert_no_request()
    other_held.text("TICKET252_UNRELATED_COMPLETED_AFTER_TARGET_RELOAD")
    expect(page.get_by_test_id("coding-run-status")).to_have_text("Completed", timeout=60000)
    expect(page.get_by_test_id("coding-transcript")).to_contain_text("TICKET252_UNRELATED_COMPLETED_AFTER_TARGET_RELOAD", timeout=60000)
    scenario("A8-busy-deferred-eventual-scoped", "Native busy first request yielded Deferred/Not applied yet until real provider completed; GET same operation confirmed Applied. Detached second request remained Running with same ID and then completed; frontend mount/PID unchanged")
    select(first_id)
    panel = open_settings()

    # Detach while the actual native acknowledgment is delayed at the browser
    # boundary. Forward the original real response unchanged only after B is
    # selected; no synthetic completion/status body is created.
    delayed = []
    def delay_reload_response(route):
        response = route.fetch(timeout=60000)
        assert response.ok
        operation = route.request.post_data_json["operation_id"]
        result = response.json()
        assert result["operation_id"] == operation and result["session_id"] == first_id
        evidence["operations"].append(result)
        delayed.append((route, response, operation))
    page.route(reload_url, delay_reload_response)
    forwarded = False
    try:
        button = panel.get_by_role("button", name="Reload plugins for this conversation", exact=True)
        expect(button).to_be_enabled(timeout=60000)
        button.focus()
        button.press("Enter")
        deadline = time.monotonic() + 60
        while not delayed and time.monotonic() < deadline:
            page.wait_for_timeout(50)
        assert len(delayed) == 1, "Native acknowledgment did not reach browser transport staging"
        target = panel.locator("select")
        target.select_option(second_id)
        expect(page.get_by_test_id("mimir-settings-target")).to_have_text(second_id, timeout=60000)
        expect(button).to_be_enabled(timeout=60000)
        with page.expect_response(lambda response: response.url == reload_url and response.request.method == "POST", timeout=60000) as detached_reply:
            delayed[0][0].fulfill(response=delayed[0][1])
            forwarded = True
        assert detached_reply.value.ok
        expect(page.get_by_test_id("mimir-settings-target")).to_have_text(second_id)
        expect(reload_status).to_have_text("")
        assert inspect(second_id)["inventory"]["reload"] == other_baseline["inventory"]["reload"]
        snapshot(page, "settings-desktop-detached-ack-second")
        target.select_option(first_id)
        expect(page.get_by_test_id("mimir-settings-target")).to_have_text(first_id, timeout=60000)
        expect(button).to_be_enabled(timeout=60000)
        expect(reload_status).to_contain_text("Applied")
        assert inspect(first_id, delayed[0][2])["inventory"]["reload"]["operation_id"] == delayed[0][2]
        assert posts.count(delayed[0][2]) == 1
    finally:
        page.unroute(reload_url, delay_reload_response)
        if delayed and not forwarded:
            delayed[0][0].abort("connectionreset")
    evidence["transport_faults"].append({"surface": "reload POST response", "fault": "delivery delayed until second target selected; original native response forwarded unchanged", "operation_id": delayed[0][2], "native_result_fabricated": False})
    scenario("A8-detached-ack-original-target", "Actual native acknowledgment delayed until Settings selected second ID; original response forwarded unchanged left second target/status untouched and settled first target without POST retry")

    # Execute POST against actual HTTP/native and discard only its browser reply.
    # Suppress reads through A→B→A and tab/modal remounts to expose Unconfirmed;
    # never retry a possibly accepted POST. Every A read must retain its UUID.
    lost = []
    def lose_reload_response(route):
        response = route.fetch(timeout=60000)
        assert response.ok
        native_result = response.json()
        operation = route.request.post_data_json["operation_id"]
        assert native_result["operation_id"] == operation
        lost.append(operation)
        evidence["operations"].append(native_result)
        route.abort("connectionreset")
    page.route(reload_url, lose_reload_response)
    page.route(first_url + "*", fail_inventory)
    try:
        button = panel.get_by_role("button", name="Reload plugins for this conversation", exact=True)
        expect(button).to_be_enabled(timeout=60000)
        button.focus()
        button.press("Enter")
        expect(reload_status).to_contain_text("Unconfirmed", timeout=60000)
        expect(button).to_be_disabled()
        deadline = time.monotonic() + 60
        while not lost and time.monotonic() < deadline:
            page.wait_for_timeout(50)
        assert len(lost) == 1
        snapshot(page, "settings-desktop-unconfirmed")
        query_start, post_count = len(queries), len(posts)
        target = panel.locator("select")
        target.select_option(second_id)
        expect(page.get_by_test_id("mimir-settings-target")).to_have_text(second_id, timeout=60000)
        expect(button).to_be_enabled(timeout=60000)
        expect(reload_status).to_have_text("")
        with page.expect_request(lambda request: urlparse(request.url).path == urlparse(first_url).path and request.method == "GET", timeout=60000):
            target.select_option(first_id)
        expect(page.get_by_test_id("mimir-settings-target")).to_have_text(first_id, timeout=60000)
        expect(reload_status).to_contain_text("Unconfirmed", timeout=60000)
        expect(button).to_be_disabled()
        snapshot(page, "settings-desktop-unconfirmed-target-roundtrip")

        # Existing Settings tab navigation actually unmounts/recreates the Mimir
        # panel. No module variables are read or modified by the browser driver.
        other_tab = page.get_by_test_id("settings-tab-keyboard-shortcuts")
        other_tab.focus()
        other_tab.press("Enter")
        expect(panel).to_have_count(0)
        with page.expect_request(lambda request: urlparse(request.url).path == urlparse(first_url).path and request.method == "GET", timeout=60000):
            mimir_tab = page.get_by_test_id("settings-tab-mimir")
            mimir_tab.focus()
            mimir_tab.press("Enter")
        expect(panel).to_be_visible(timeout=60000)
        expect(reload_status).to_contain_text("Unconfirmed", timeout=60000)
        expect(button).to_be_disabled()
        snapshot(page, "settings-desktop-unconfirmed-tab-remount")
        close_settings()
        with page.expect_request(lambda request: urlparse(request.url).path == urlparse(first_url).path and request.method == "GET", timeout=60000):
            panel = open_settings()
        expect(reload_status).to_contain_text("Unconfirmed", timeout=60000)
        expect(button).to_be_disabled()
        remount_queries = queries[query_start:]
        assert len(remount_queries) >= 3 and all(operation == lost[0] for operation in remount_queries), "Target/tab/modal remount lost original reload UUID correlation"
        assert len(posts) == post_count, "View navigation retried execution POST"
        evidence["unconfirmed_navigation"] = {"operation_id": lost[0], "reconciliation_queries": remount_queries, "target_roundtrip": True, "tab_remount": True, "modal_remount": True, "post_retry": False}
        snapshot(page, "settings-desktop-unconfirmed-modal-remount")
    finally:
        page.unroute(reload_url, lose_reload_response)
        page.unroute(first_url + "*", fail_inventory)
    evidence["transport_faults"].append({"surface": "reload POST response", "fault": "connectionreset after real route.fetch", "operation_id": lost[0], "native_result_fabricated": False})
    refresh = panel.get_by_role("button", name="Refresh view and inventory", exact=True)
    expect(refresh).to_be_enabled(timeout=60000)
    refresh.focus()
    refresh.press("Enter")
    expect(reload_status).to_contain_text("Applied", timeout=60000)
    expect(panel.get_by_role("button", name="Reload plugins for this conversation", exact=True)).to_be_enabled(timeout=60000)
    assert lost[0] in queries, "Uncertain reload was not reconciled with GET operation_id"
    assert posts.count(lost[0]) == 1 and len(posts) == post_count, "Lost response caused execution POST retry"
    confirmed = inspect(first_id, lost[0])["inventory"]["reload"]
    assert confirmed["operation_id"] == lost[0] and confirmed["status"] == "applied"
    assert_runtime_retained(frontend_before)
    scenario("A8-uncertain-native-reconciliation", "Actual native POST completed but browser reply was dropped; A→B→A and Settings tab/modal remounts retained Unconfirmed/disabled reload and original UUID in all A GETs; exact-ID native reconciliation recovered Applied before enabling reload, without another POST")

    page.set_viewport_size({"width": 390, "height": 844})
    expect(panel).to_be_visible()
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "Settings causes narrow horizontal document overflow"
    target = panel.locator("select")
    target.focus()
    expect(target).to_be_focused()
    target.select_option(second_id)
    expect(page.get_by_test_id("mimir-settings-target")).to_have_text(second_id, timeout=60000)
    expect(panel.get_by_role("list", name="Effective native skills", exact=True)).to_contain_text(EFFECTIVE_SKILL, timeout=60000)
    target.select_option(first_id)
    expect(page.get_by_test_id("mimir-settings-target")).to_have_text(first_id, timeout=60000)
    expect(panel.get_by_role("button", name="Reload plugins for this conversation", exact=True)).to_be_enabled(timeout=60000)
    target.select_option("")
    expect(panel).to_contain_text("Inspecting Settings does not grant project trust")
    expect(panel.get_by_role("button", name="Reload plugins for this conversation", exact=True)).to_be_disabled()
    target.select_option(first_id)
    expect(panel.get_by_role("button", name="Reload plugins for this conversation", exact=True)).to_be_enabled(timeout=60000)
    snapshot(page, "settings-narrow-inventory")
    panel.get_by_role("button", name="Reload plugins for this conversation", exact=True).focus()
    snapshot(page, "settings-narrow-reload-focus")
    close_settings(mobile=True)
    snapshot(page, "settings-narrow-resize-toggle-focus")
    panel = open_settings(mobile=True)
    expect(panel.get_by_role("button", name="Reload plugins for this conversation", exact=True)).to_be_enabled(timeout=60000)
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
    snapshot(page, "settings-narrow-mobile-sheet-opener")
    close_settings(mobile=True)
    snapshot(page, "settings-narrow-sheet-toggle-focus")
    page.set_viewport_size({"width": 1440, "height": 1000})
    open_settings()
    snapshot(page, "settings-desktop-reconciled")
    close_settings()
    evidence["focus_restoration"] = {"desktop": "Mimir Settings", "desktop_to_narrow": "Toggle coding sidebar", "mobile_sheet": "Toggle coding sidebar"}
    scenario("A10-settings-keyboard-narrow", "Actual existing Settings modal opened by Enter, scoped target selectable at 390x844 without document overflow; no-target explanation disables reload; desktop Escape restores Settings opener, resize and mobile-sheet opening restore surviving Toggle coding sidebar")
    evidence["reload_posts"] = posts
    evidence["reconciliation_queries"] = queries
    evidence["status"] = "passed"
    provider.assert_no_request()
    page.remove_listener("request", record_request)
