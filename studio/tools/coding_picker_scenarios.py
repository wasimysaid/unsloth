# SPDX-License-Identifier: AGPL-3.0-only
"""Rendered ticket-244 picker acceptance through the real coding route.

Only the external HTTP provider is deterministic. Studio configuration, native
catalog, plugin execution, prompt admission, and tool continuation are real.
"""
from __future__ import annotations

import re
import json
from urllib.parse import urlencode

from coding_provider_fixture import (
    PICKER_API_A, PICKER_API_B, PICKER_API_PLAIN, PICKER_LEVELS_A,
    PICKER_LEVELS_B, PICKER_MODEL, PICKER_MODEL_LABEL, PICKER_PLAIN_MODEL,
    PICKER_PROVIDER_A, PICKER_PROVIDER_B, PICKER_PROVIDER_LABEL,
)
from coding_ui import opened_id


def effort_label(level):
    """Shared picker effort labels."""
    return "Extra High" if level == "xhigh" else level[:1].upper() + level[1:]


def trigger_label(name, effort):
    """Shared composer trigger names the native model and committed effort."""
    return f"Model: {name}" + (f", {effort}" if effort else "")


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


def picker_trigger(page):
    return page.get_by_test_id("coding-model-selector").locator("button.composer-model-chip")


def picker_panel(page):
    return page.locator("[data-composer-model-picker]")


def picker_row(page, provider_id, model_id):
    identity = json.dumps([provider_id, model_id], separators=(",", ":"), ensure_ascii=False)
    return page.locator("[data-model-id=" + json.dumps(identity) + "]")


def open_model_list(page):
    from playwright.sync_api import expect
    panel = picker_panel(page)
    if not panel.is_visible():
        picker_trigger(page).click()
    search = panel.get_by_role("textbox", name="Search models", exact=True)
    if not search.is_visible():
        panel.get_by_role("button", name=re.compile(": show all models$")).click()
    expect(search).to_be_visible()
    panel.get_by_role("tab", name="Connected models", exact=True).click()
    search.fill("")
    return panel


def run_picker_scenarios(page, context, base, provider, first, report, scenario, snapshot):
    from playwright.sync_api import expect
    assert provider is not None
    conversation = opened_id(page)
    trigger = picker_trigger(page)
    popover = picker_panel(page)
    search = popover.get_by_role("textbox", name="Search models", exact=True)
    listing = popover.locator("[data-model-picker-list]")
    slider = popover.get_by_role("slider", name="Effort", exact=True)
    status = page.get_by_test_id("coding-run-status")
    send = page.get_by_role("button", name="Send", exact=True)
    composer = page.get_by_label("Coding prompt", exact=True)
    headers = {"Authorization": "Bearer " + page.evaluate("localStorage.getItem('unsloth_auth_token')")}
    evidence = report.setdefault("workload", {"kind": "picker-deterministic-http-provider-real-native", "requests": []})
    facts = evidence["picker"] = {"viewports": [], "provider_calls": []}
    response = context.request.get(base + "/api/coding/catalog?" + urlencode({"cwd": str(first)}), headers=headers)
    assert response.ok
    native_rows = {(p["id"], m["id"]): m for p in response.json() for m in p["models"]}
    endpoint = base + f"/api/coding/conversations/{conversation}/configuration"

    def open_config():
        open_model_list(page)

    def select(provider_id, model_id=PICKER_MODEL, *, keyboard=False):
        open_config()
        row = picker_row(page, provider_id, model_id)
        with page.expect_response(lambda r: r.url == endpoint and r.request.method == "POST", timeout=60000) as waiting:
            if keyboard:
                row.focus()
                row.press("Enter")
            else:
                row.click()
        response = waiting.value
        assert response.ok
        assert response.request.post_data_json == {"provider": provider_id, "model": model_id}
        accepted = response.json()
        assert (accepted["provider"], accepted["model"]) == (provider_id, model_id)
        model = native_rows[provider_id, model_id]
        expect(trigger).to_have_attribute("aria-label", trigger_label(model["name"], model["default_reasoning"]), timeout=60000)
        open_config()
        return accepted

    def commit_effort(key, level, levels):
        with page.expect_response(lambda r: r.url == endpoint and r.request.method == "POST", timeout=60000) as waiting:
            slider.press(key)
        response = waiting.value
        assert response.ok and response.request.post_data_json == {"reasoning": level}
        accepted = response.json()
        assert accepted["reasoning"] == level
        expect(slider).to_have_attribute("aria-valuetext", effort_label(level), timeout=60000)
        facts.setdefault("effort_commits", []).append({"key": key, "accepted": accepted})
        return accepted

    open_config()
    expect(listing.get_by_role("option")).to_have_count(len(native_rows))
    search.fill(PICKER_API_B)
    expect(listing.get_by_role("option")).to_have_count(1)
    expect(picker_row(page, PICKER_PROVIDER_B, PICKER_MODEL)).to_be_visible()
    search.fill("")
    select(PICKER_PROVIDER_A)
    commit_effort("Home", "low", PICKER_LEVELS_A)
    commit_effort("ArrowRight", "medium", PICKER_LEVELS_A)
    commit_effort("End", "high", PICKER_LEVELS_A)
    select(PICKER_PROVIDER_B, keyboard=True)
    select(PICKER_PROVIDER_B, PICKER_PLAIN_MODEL)
    expect(slider).to_have_count(0)
    select(PICKER_PROVIDER_A)
    for viewport in ({"width": 1440, "height": 1000}, {"width": 390, "height": 844}):
        page.set_viewport_size(viewport)
        expect(popover).to_be_in_viewport(ratio=1)
        assert_viewport_box(popover.bounding_box(), viewport["width"], viewport["height"], label="picker")
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
        facts["viewports"].append(viewport)
        snapshot(page, f"picker-{viewport['width']}")
    page.keyboard.press("Escape")
    page.set_viewport_size({"width": 1440, "height": 1000})
    scenario("shared-picker-native-selection", "Upstream picker retains native identities, API search, keyboard effort, default reset and narrow layout")

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
    # The picker stays enabled while native work runs. The running selection is
    # the held provider call above; the next one is the native configure reply.
    open_config()
    select(PICKER_PROVIDER_B)
    expect(slider).to_be_enabled(timeout=60000)
    slider.focus()
    next_configuration = commit_effort("Home", "minimal", PICKER_LEVELS_B)
    assert (next_configuration.get("provider"), next_configuration.get("model")) == (PICKER_PROVIDER_B, PICKER_MODEL)
    facts["next_configuration_while_running"] = {"request_id": first_request, "accepted": next_configuration}
    expect(status).to_have_text("Running")
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
    facts["provider_calls"].append({"request_id": second_request, "api_model": PICKER_API_B, "reasoning_effort": "minimal"})
    request.text("PICKER_SECOND_COMPLETE")
    settled("PICKER_SECOND_COMPLETE")
    provider.assert_no_request()
    snapshot(page, "picker-next-boundary-complete")
    scenario("A4-picker-running-versus-next", "Held real native provider call remains A/high while the rendered picker changes the native next configuration (configure reply and trigger) to B/minimal; real shell continuation retains A/high; next admitted request uses B wire model/minimal; prompts contain no model snapshot")
    evidence["status"] = "passed"
    report["limitations"].append("Picker workload proves deterministic protocol selection and a real native tool continuation, not live-provider/local-model inference, queued-request races, or later local-load/protection work (#246/#255).")
