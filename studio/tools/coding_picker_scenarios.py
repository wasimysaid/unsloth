# SPDX-License-Identifier: AGPL-3.0-only
"""Rendered ticket-244 picker acceptance through the real coding route.

Only the external HTTP provider is deterministic. Studio configuration, native
catalog, plugin execution, prompt admission, and tool continuation are real.
"""
from __future__ import annotations

import re
from urllib.parse import urlencode

from coding_provider_fixture import (
    PICKER_API_A, PICKER_API_B, PICKER_API_PLAIN, PICKER_LEVELS_A,
    PICKER_LEVELS_B, PICKER_MODEL, PICKER_MODEL_LABEL, PICKER_PLAIN_MODEL,
    PICKER_PROVIDER_A, PICKER_PROVIDER_B, PICKER_PROVIDER_LABEL,
)


def assert_viewport_box(box, width, height, *, label):
    """Allow subpixel rounding, not clipped controls or off-screen popovers."""
    assert box and box["width"] > 0 and box["height"] > 0, f"{label} has no rendered box"
    assert box["x"] >= -1 and box["y"] >= -1, f"{label} clips at top/left: {box}"
    assert box["x"] + box["width"] <= width + 1, f"{label} clips at right: {box}"
    assert box["y"] + box["height"] <= height + 1, f"{label} clips at bottom: {box}"


def assert_provider_selection(request, api_model, effort):
    """Inspect only non-secret routing facts; never persist provider context."""
    assert request.body.get("model") == api_model, "Native API-model mapping was lost"
    assert request.body.get("reasoning_effort") == effort, "Native reasoning selection was not applied"


def run_picker_scenarios(page, context, base, provider, first, report, scenario, snapshot):
    from playwright.sync_api import expect

    assert provider is not None, "Picker acceptance requires the deterministic external provider"
    conversation = page.get_by_test_id("coding-conversation-id").inner_text()
    identity_a = f"{PICKER_PROVIDER_A}/{PICKER_MODEL}"
    identity_b = f"{PICKER_PROVIDER_B}/{PICKER_MODEL}"
    identity_plain = f"{PICKER_PROVIDER_B}/{PICKER_PLAIN_MODEL}"
    trigger = page.get_by_role("button", name="Configure next coding request", exact=True)
    popover = page.get_by_test_id("coding-model-picker")
    heading = popover.get_by_role("button", name="Choose coding model", exact=True)
    search = popover.get_by_role("textbox", name="Search coding models", exact=True)
    back = popover.get_by_role("button", name="Back to model configuration", exact=True)
    listing = popover.get_by_test_id("coding-model-list")
    slider = popover.get_by_role("slider", name="Reasoning effort", exact=True)
    next_model = page.get_by_test_id("coding-next-model")
    running_model = page.get_by_test_id("coding-running-model")
    status = page.get_by_test_id("coding-run-status")
    send = page.get_by_role("button", name="Send", exact=True)
    composer = page.get_by_label("Coding prompt", exact=True)
    headers = {"Authorization": "Bearer " + page.evaluate("localStorage.getItem('unsloth_auth_token')")}
    evidence = report.setdefault("workload", {"kind": "picker-deterministic-http-provider-real-native", "requests": []})
    evidence["picker"] = {"identities": [identity_a, identity_b, identity_plain],
                          "wire_models": [PICKER_API_A, PICKER_API_B, PICKER_API_PLAIN],
                          "viewports": [], "provider_calls": []}
    facts = evidence["picker"]

    # This is the actual native catalog endpoint, not a browser route fulfillment.
    catalog_response = context.request.get(base + "/api/coding/catalog?" + urlencode({"cwd": str(first)}), headers=headers)
    assert catalog_response.ok, f"Native catalog failed ({catalog_response.status})"
    catalog = catalog_response.json()
    assert isinstance(catalog, list), "Native catalog must preserve provider records"
    native_rows = {(p["id"], m["id"]): m for p in catalog for m in p["models"]}
    providers = {p["id"]: p for p in catalog}
    assert providers[PICKER_PROVIDER_A]["name"] == providers[PICKER_PROVIDER_B]["name"] == PICKER_PROVIDER_LABEL
    for identifier, api, levels in ((PICKER_PROVIDER_A, PICKER_API_A, PICKER_LEVELS_A),
                                    (PICKER_PROVIDER_B, PICKER_API_B, PICKER_LEVELS_B)):
        native = native_rows[identifier, PICKER_MODEL]
        assert native["name"] == PICKER_MODEL_LABEL and native["api_model"] == api
        assert native["reasoning"] == {"levels": list(levels)}
        assert native["default_reasoning"] == "high", "Fixture must exercise a native default different from its low override"
    plain = native_rows[PICKER_PROVIDER_B, PICKER_PLAIN_MODEL]
    assert plain["api_model"] == PICKER_API_PLAIN
    assert plain["reasoning"] == "unsupported" and plain["default_reasoning"] is None
    facts["native_catalog_count"] = len(native_rows)

    def row(provider_id, model_id=PICKER_MODEL):
        return listing.locator(f'button[data-provider="{provider_id}"][data-model="{model_id}"]')

    def favorite(provider_id, model_id=PICKER_MODEL):
        return listing.get_by_role("button", name=f"Favorite {provider_id}/{model_id}", exact=True)

    def open_config():
        if not popover.is_visible():
            trigger.click()
        expect(popover).to_be_visible()
        expect(heading).to_be_visible()
        expect(heading).to_be_enabled(timeout=60000)

    def open_list():
        heading.click()
        expect(search).to_be_visible()
        expect(search).to_be_focused()
        # Filters intentionally persist within an open picker; reset explicitly.
        search.fill("")
        popover.get_by_role("button", name="All providers", exact=True).click()
        favorites = popover.get_by_role("button", name="Favorites", exact=True)
        if favorites.get_attribute("aria-pressed") == "true":
            favorites.click()

    def configured(identity, api_model, effort):
        expect(popover).to_be_visible()
        expect(search).to_have_count(0)
        expect(heading).to_contain_text(identity, timeout=60000)
        expect(heading).to_be_focused()
        expect(popover).to_contain_text("API model: " + api_model, timeout=60000)
        expect(next_model).to_contain_text(identity, timeout=60000)
        if effort is None:
            expect(slider).to_have_count(0)
            expect(popover.get_by_test_id("coding-reasoning-control")).to_have_count(0)
        else:
            expect(slider).to_have_attribute("aria-valuetext", effort, timeout=60000)
            expect(next_model).to_contain_text(effort, timeout=60000)

    def select(provider_id, model_id=PICKER_MODEL, *, keyboard=False):
        open_list()
        selected = row(provider_id, model_id)
        expect(selected).to_be_enabled(timeout=60000)
        with page.expect_response(lambda response: response.url == base + f"/api/coding/conversations/{conversation}/configuration" and response.request.method == "POST", timeout=60000) as waiting:
            if keyboard:
                selected.focus()
                expect(selected).to_be_focused()
                selected.press("Enter")
            else:
                selected.click()
        response = waiting.value
        assert response.ok, f"Native model configuration failed ({response.status})"
        assert response.request.post_data_json == {"provider": provider_id, "model": model_id}, "Model selection used labels/API mapping or remembered effort instead of native identity/default"
        facts.setdefault("model_selections", []).append({"provider": provider_id, "model": model_id, "keyboard": keyboard})
        native = native_rows[provider_id, model_id]
        configured(f"{provider_id}/{model_id}", native["api_model"], native["default_reasoning"])

    def layout(label):
        viewport = page.viewport_size
        box = popover.bounding_box()
        assert_viewport_box(box, viewport["width"], viewport["height"], label="picker")
        composer_box = page.locator('[aria-label="Coding composer"]').bounding_box()
        trigger_box = trigger.bounding_box()
        assert composer_box and trigger_box
        assert_viewport_box(trigger_box, viewport["width"], viewport["height"], label="trigger")
        assert trigger_box["x"] + trigger_box["width"] / 2 >= composer_box["x"] + composer_box["width"] / 2, "Picker trigger is not at composer right"
        assert trigger_box["x"] + trigger_box["width"] >= composer_box["x"] + composer_box["width"] * 0.75, "Picker trigger does not reach composer right edge"
        assert trigger_box["y"] >= composer_box["y"] + composer_box["height"] / 2, "Picker trigger is not at composer bottom"
        assert trigger_box["y"] + trigger_box["height"] <= composer_box["y"] + composer_box["height"] + 1
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "Document overflows horizontally"
        if search.is_visible():
            navigation = popover.get_by_role("navigation", name="Model providers")
            nav_box = navigation.bounding_box()
            assert nav_box
            # Both collision-fixture providers fit; neither may be half hidden
            # behind a shortened navigation viewport on a narrow screen.
            for identifier in (PICKER_PROVIDER_A, PICKER_PROVIDER_B):
                button_box = navigation.locator(f'button[data-provider-nav="{identifier}"]').bounding_box()
                assert button_box and button_box["y"] >= nav_box["y"] - 1
                assert button_box["y"] + button_box["height"] <= nav_box["y"] + nav_box["height"] + 1, "Provider navigation control is clipped"
        facts["viewports"].append({"scene": label, "viewport": viewport, "popover": box, "trigger": trigger_box})
        snapshot(page, label)

    trigger.focus()
    trigger.press("Enter")
    expect(popover).to_be_visible()
    expect(heading).to_be_focused()
    expect(popover).to_contain_text("Next-request selection")
    layout("picker-desktop-config")
    heading.press("Enter")
    expect(search).to_be_focused()
    expect(listing.locator("button[data-model]")).to_have_count(len(native_rows), timeout=60000)
    rendered = listing.locator("button[data-model]").evaluate_all("buttons => buttons.map(b => [b.dataset.provider, b.dataset.model])")
    assert {tuple(item) for item in rendered} == set(native_rows), "Rendered inventory differs from native catalog"
    expect(row(PICKER_PROVIDER_A)).to_contain_text(identity_a)
    expect(row(PICKER_PROVIDER_B)).to_contain_text(identity_b)
    expect(row(PICKER_PROVIDER_A)).to_contain_text(PICKER_MODEL_LABEL)
    expect(row(PICKER_PROVIDER_B)).to_contain_text(PICKER_MODEL_LABEL)
    layout("picker-desktop-list")
    assert listing.evaluate("e => e.scrollHeight > e.clientHeight && ['auto', 'scroll'].includes(getComputedStyle(e).overflowY)"), "Native catalog list must scroll within the popover"
    row(PICKER_PROVIDER_A, "scroll-31").scroll_into_view_if_needed()
    assert listing.evaluate("e => e.scrollTop > 0"), "Scrolling a native row did not scroll the model list"
    layout("picker-desktop-list-scrolled")
    listing.evaluate("e => { e.scrollTop = 0; }")
    back.click()
    expect(heading).to_be_focused()
    expect(popover).to_be_visible()
    scenario("A10-picker-configuration-list-back", "Actual native catalog rendered in one scrollable popover; clickable selected heading, keyboard opening/search focus and Back return retain popover")

    # Explicit selection avoids depending on whether opening connects a default.
    select(PICKER_PROVIDER_A)
    open_list()
    expect(row(PICKER_PROVIDER_A)).to_have_attribute("aria-pressed", "true")
    expect(row(PICKER_PROVIDER_B)).to_have_attribute("aria-pressed", "false")
    for identifier, other in ((PICKER_PROVIDER_A, PICKER_PROVIDER_B), (PICKER_PROVIDER_B, PICKER_PROVIDER_A)):
        nav = popover.locator(f'button[data-provider-nav="{identifier}"]')
        expect(nav).to_contain_text(identifier)
        expect(nav).to_contain_text(PICKER_PROVIDER_LABEL)
        nav.click()
        expect(nav).to_have_attribute("aria-pressed", "true")
        expect(row(identifier)).to_have_count(1)
        expect(row(other)).to_have_count(0)
    popover.get_by_role("button", name="All providers", exact=True).click()
    search.fill(PICKER_PLAIN_MODEL)
    expect(listing.locator("button[data-model]")).to_have_count(1)
    expect(row(PICKER_PROVIDER_B, PICKER_PLAIN_MODEL)).to_be_visible()
    search.fill("NO_SUCH_NATIVE_MODEL_244")
    expect(listing.locator("button[data-model]")).to_have_count(0)
    expect(popover).to_contain_text("No matching models in Mimir's catalog")
    search.fill(PICKER_PROVIDER_LABEL)
    expect(listing.locator("button[data-model]")).to_have_count(len(native_rows))
    search.fill(PICKER_MODEL_LABEL)
    expect(listing.locator("button[data-model]")).to_have_count(2)
    search.press("ArrowDown")
    expect(row(PICKER_PROVIDER_A)).to_be_focused()
    search.focus()
    search.press("Tab")
    expect(search).not_to_be_focused()
    expect(next_model).to_contain_text(identity_a)  # Tab navigates focus, not providers.
    back.click()
    expect(heading).to_be_focused()
    scenario("A10-picker-search-provider-collisions", "Identical provider/model labels retain distinct IDs, selected indication and ID-bearing provider navigation; search by native local ID, empty results, and ordinary Tab focus")

    open_list()
    favorite_a, favorite_b = favorite(PICKER_PROVIDER_A), favorite(PICKER_PROVIDER_B)
    expect(favorite_a).to_have_attribute("aria-pressed", "false")
    expect(favorite_b).to_have_attribute("aria-pressed", "false")
    favorite_a.click()
    expect(favorite_a).to_have_attribute("aria-pressed", "true")
    expect(favorite_b).to_have_attribute("aria-pressed", "false")
    favorites = popover.get_by_role("button", name="Favorites", exact=True)
    favorites.click()
    expect(listing.locator("button[data-model]")).to_have_count(1)
    expect(row(PICKER_PROVIDER_A)).to_be_visible()
    favorites.click()
    favorite_b.click()
    favorite_a.click()
    favorites.click()
    expect(listing.locator("button[data-model]")).to_have_count(1)
    expect(row(PICKER_PROVIDER_B)).to_be_visible()
    snapshot(page, "picker-favorite-identity-filter")
    favorites.click()
    back.click()
    page.keyboard.press("Escape")
    expect(popover).not_to_be_visible()
    expect(trigger).to_be_focused()
    open_config()
    open_list()
    expect(favorite(PICKER_PROVIDER_A)).to_have_attribute("aria-pressed", "false")
    expect(favorite(PICKER_PROVIDER_B)).to_have_attribute("aria-pressed", "true")
    back.click()
    scenario("A10-picker-identity-favorites", "Favorites independently key the provider/local-model pair despite exact label collisions; filter shows only the chosen identity and state survives close/reopen")

    expect(slider).to_have_attribute("aria-valuemin", "0")
    expect(slider).to_have_attribute("aria-valuemax", str(len(PICKER_LEVELS_A) - 1))
    slider.focus()
    slider.press("Home")
    expect(slider).to_have_attribute("aria-valuenow", "0", timeout=60000)
    expect(slider).to_have_attribute("aria-valuetext", "low", timeout=60000)
    expect(next_model).to_contain_text("low", timeout=60000)
    expect(slider).to_be_enabled(timeout=60000)
    slider.press("ArrowRight")
    expect(slider).to_have_attribute("aria-valuenow", "1", timeout=60000)
    expect(slider).to_have_attribute("aria-valuetext", "medium", timeout=60000)
    expect(next_model).to_contain_text("medium", timeout=60000)
    expect(slider).to_be_enabled(timeout=60000)
    slider.press("End")
    expect(slider).to_have_attribute("aria-valuetext", "high", timeout=60000)
    expect(next_model).to_contain_text("high", timeout=60000)
    expect(slider).to_be_enabled(timeout=60000)
    slider.press("Home")
    expect(next_model).to_contain_text("low", timeout=60000)
    select(PICKER_PROVIDER_B, keyboard=True)
    expect(slider).to_have_attribute("aria-valuemax", str(len(PICKER_LEVELS_B) - 1))
    select(PICKER_PROVIDER_A)
    # Returning to A must restore high, not its previous per-model low override.
    expect(slider).to_have_attribute("aria-valuetext", "high")
    select(PICKER_PROVIDER_B, PICKER_PLAIN_MODEL)
    configured(identity_plain, PICKER_API_PLAIN, None)
    snapshot(page, "picker-unsupported-effort")
    select(PICKER_PROVIDER_A)
    scenario("A5-picker-reasoning-default-reset", "Keyboard Home/ArrowRight/End select only native discrete efforts; model switches restore new native high default rather than old overrides; no slider/control for unsupported model; selection returns without dismissal")

    page.set_viewport_size({"width": 390, "height": 844})
    layout("picker-narrow-config")
    open_list()
    layout("picker-narrow-list")
    row(PICKER_PROVIDER_A, "scroll-31").scroll_into_view_if_needed()
    layout("picker-narrow-list-scrolled")
    search.focus()
    search.press("Escape")
    expect(heading).to_be_focused()
    expect(popover).to_be_visible()
    page.keyboard.press("Escape")
    expect(popover).not_to_be_visible()
    expect(trigger).to_be_focused()
    scenario("A10-picker-narrow-clipping-focus", "390x844 configuration/list/scrolled list remain in viewport with bottom-right trigger and no horizontal overflow; search Escape returns to configuration, second Escape restores trigger focus")
    page.set_viewport_size({"width": 1440, "height": 1000})

    def submit(text):
        composer.fill(text)
        expect(send).to_be_enabled(timeout=60000)
        with page.expect_response(lambda response: response.url == base + f"/api/coding/conversations/{conversation}/prompts" and response.request.method == "POST", timeout=60000) as waiting:
            composer.press("Enter")
        response = waiting.value
        assert response.status == 202, f"Native prompt admission failed ({response.status})"
        body = response.request.post_data_json
        assert set(body) == {"submission_key", "text"}, "Model configuration was snapshotted into a prompt"
        ack = response.json()
        assert ack["conversation_id"] == conversation and ack["submission_key"] == body["submission_key"]
        evidence["requests"].append({"conversation_id": conversation, "request_id": ack["request_id"], "submission_key": body["submission_key"]})
        return ack["request_id"]

    def settled(marker):
        expect(page.get_by_role("button", name="Stop", exact=True)).to_have_count(0, timeout=60000)
        expect(status).to_have_text("Completed", timeout=60000)
        expect(page.get_by_test_id("coding-transcript")).to_contain_text(marker, timeout=60000)

    first_request = submit("ACCEPTANCE_PICKER_ACTIVE: execute only the explicit fixture tool")
    request = provider.request()
    assert_provider_selection(request, PICKER_API_A, "high")
    expect(status).to_contain_text(re.compile("running", re.I), timeout=60000)
    expect(running_model).to_contain_text(identity_a, timeout=60000)
    expect(running_model).to_contain_text("high")
    running_before = running_model.inner_text()
    open_config()
    select(PICKER_PROVIDER_B)
    expect(slider).to_be_enabled(timeout=60000)
    slider.focus()
    slider.press("Home")
    expect(next_model).to_contain_text(identity_b, timeout=60000)
    expect(next_model).to_contain_text("minimal", timeout=60000)
    expect(running_model).to_have_text(running_before)
    expect(page.get_by_test_id("coding-request-id")).to_contain_text(first_request)
    provider.assert_no_request()
    snapshot(page, "picker-running-versus-next")
    page.keyboard.press("Escape")
    # Release the held external request with a real native tool; its continuation
    # still belongs to A/high even though the next configuration is B/minimal.
    request.tool("picker-held-shell", "shell", {"command": "printf PICKER_NATIVE_CONTINUATION", "timeout_seconds": 30, "yield_time_ms": 10000})
    continuation = provider.request()
    assert_provider_selection(continuation, PICKER_API_A, "high")
    assert "PICKER_NATIVE_CONTINUATION" in continuation.tool_result("picker-held-shell")
    facts["provider_calls"].append({"request_id": first_request, "api_model": PICKER_API_A, "reasoning_effort": "high", "native_tool_continuation_same_selection": True})
    continuation.text("PICKER_FIRST_COMPLETE")
    settled("PICKER_FIRST_COMPLETE")
    second_request = submit("ACCEPTANCE_PICKER_NEXT: respond to the fixture only")
    request = provider.request()
    assert_provider_selection(request, PICKER_API_B, "minimal")
    expect(running_model).to_contain_text(identity_b, timeout=60000)
    expect(running_model).to_contain_text("minimal")
    facts["provider_calls"].append({"request_id": second_request, "api_model": PICKER_API_B, "reasoning_effort": "minimal"})
    request.text("PICKER_SECOND_COMPLETE")
    settled("PICKER_SECOND_COMPLETE")
    provider.assert_no_request()
    snapshot(page, "picker-next-boundary-complete")
    scenario("A4-picker-running-versus-next", "Held real native provider call remains A/high while rendered next selection changes to B/minimal; real shell continuation retains A/high; next admitted request uses B wire model/minimal; prompts contain no model snapshot")
    evidence["status"] = "passed"
    report["limitations"].append("Picker workload proves deterministic protocol selection and a real native tool continuation, not live-provider/local-model inference, queued-request races, or later local-load/protection work (#246/#255).")
