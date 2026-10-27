# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
"""Rendered rich-input contracts through authenticated Studio/native Mimir.

The HTTP provider is deterministic, not a completed real-model workload. Only
explicit negative/recovery cases fault-inject transport; normal admission is real.
"""
from __future__ import annotations

import base64
import json
from pathlib import Path
import re
import struct
import zlib

from coding_run_scenarios import expand_tool, unfold_activity
from coding_ui import opened_id

SKILL_NAME = "project-visual"
SKILL_SENTINEL = "TICKET242_SKILL_BODY_SENTINEL"
def _png_chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))


PNG = (b"\x89PNG\r\n\x1a\n"
       + _png_chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
       + _png_chunk(b"IDAT", zlib.compress(b"\x00\xff\x00\x00"))
       + _png_chunk(b"IEND", b""))


LIVE_PNG = (b"\x89PNG\r\n\x1a\n"
            + _png_chunk(b"IHDR", struct.pack(">IIBBBBB", 128, 128, 8, 2, 0, 0, 0))
            + _png_chunk(b"IDAT", zlib.compress((b"\x00" + b"\xff\x00\x00" * 128) * 128))
            + _png_chunk(b"IEND", b""))
LIVE_SKILL_INSTRUCTION = "For the visual-evidence request, write JSON with keys dominant_color and skill_marker. Set skill_marker to SKILL242_LOADED_FROM_NATIVE_BODY. Do not mention or access credentials."


def prepare_input_project(project: Path, *, live: bool = False) -> None:
    for name in (SKILL_NAME, "project-disabled"):
        path = project / ".agents" / "skills" / name / "SKILL.md"
        path.parent.mkdir(parents = True, exist_ok = True)
        body = f"---\nname: {name}\ndescription: Coding input fixture {name}\n---\n{SKILL_SENTINEL}\nUse the supplied visual context.\n"
        if live and name == SKILL_NAME:
            body += LIVE_SKILL_INSTRUCTION + "\n"
        path.write_text(body)
    config = project / ".mimir" / "settings.json"
    config.parent.mkdir(parents = True, exist_ok = True)
    config.write_text(json.dumps({"skills": {SKILL_NAME: {"enabled": True}, "project-disabled": {"enabled": False}}}) + "\n")


def input_scenarios(page, context, base, provider, project, report, scenario, snapshot):
    from playwright.sync_api import expect

    conversation = opened_id(page)
    prompt = page.get_by_label("Coding prompt", exact = True)
    send = page.get_by_role("button", name = "Send", exact = True)
    status = page.get_by_test_id("coding-run-status")
    transcript = page.get_by_test_id("coding-transcript")
    headers = {"Authorization": "Bearer " + page.evaluate("localStorage.getItem('unsloth_auth_token')")}
    headers["X-Mimir-Runtime-Generation"] = str(context.request.get(base + "/api/coding/runtime", headers=headers).json()["generation"])
    prompts = base + f"/api/coding/conversations/{conversation}/prompts"
    evidence = report.setdefault("workload", {"kind": "deterministic-rich-input-native-contract", "requests": []})
    skills_response = context.request.get(base + f"/api/coding/conversations/{conversation}/skills", headers = headers)
    assert skills_response.ok
    skills = skills_response.json()["skills"]
    found = [skill for skill in skills if skill["qualified_name"] == SKILL_NAME]
    assert len(found) == 1, skills
    selected = found[0]
    assert selected["path"] == str(project / ".agents" / "skills" / SKILL_NAME / "SKILL.md")
    assert not any(skill["name"] == "project-disabled" for skill in skills)
    assert SKILL_SENTINEL not in skills_response.text(), "Discovery must not load/expose a skill body"
    provider.assert_no_request()
    scenario("A2-input-effective-skills", "Selected trusted project's native enabled/disabled configuration and exact descriptor path are honored; discovery is metadata only, no provider call")

    files = page.get_by_label("Image files", exact = True)
    files.set_input_files({"name": "bad.svg", "mimeType": "image/svg+xml", "buffer": b"<svg/>"})
    expect(page.get_by_role("alert").filter(has_text = "PNG, JPEG, WebP or GIF images only")).to_be_visible()
    files.set_input_files({"name": "corrupt.png", "mimeType": "image/png", "buffer": PNG[:8] + b"invalid"})
    expect(page.get_by_role("alert").filter(has_text = "cannot be decoded")).to_be_visible()
    # The composer's per-image bound is 10 MiB (input.ts MAX_IMAGE_BYTES).
    files.set_input_files({"name": "huge.png", "mimeType": "image/png", "buffer": PNG[:8] + b"x" * (10 * 1024 * 1024)})
    expect(page.get_by_role("alert").filter(has_text = "at most 10 MiB")).to_be_visible()
    expect(page.get_by_role("list", name = "Attached images")).to_have_count(0)
    scenario("A2-image-rejections", "SVG, corrupt PNG and oversized image remain explicit actionable composer failures, no accepted attachment or native request")
    files.set_input_files({"name": "visual.png", "mimeType": "image/png", "buffer": PNG})
    inspect = page.get_by_role("button", name = "Inspect visual.png", exact = True)
    expect(inspect).to_be_visible()
    inspect.click()
    expect(page.get_by_role("dialog")).to_be_visible()
    expect(page.get_by_role("img", name = "visual.png", exact = True)).to_be_visible()
    page.keyboard.press("Escape")
    expect(page.get_by_role("dialog")).not_to_be_visible()
    expect(prompt).to_be_focused()
    page.get_by_role("button", name = "Remove visual.png", exact = True).click()
    expect(inspect).to_have_count(0)
    expect(prompt).to_be_focused()
    files.set_input_files({"name": "visual.png", "mimeType": "image/png", "buffer": PNG})
    scenario("A10-image-inspect-remove-focus", "Valid image renders thumbnail, keyboard Escape dismisses preview, remove and preview dismissal restore composer focus")

    # "@" opens one flat mention listbox; rows carry the native kind and name.
    mention_list = page.get_by_test_id("coding-mention-list")
    option = mention_list.locator(f'[data-mention-kind="skill"][data-mention-name="{SKILL_NAME}"]')
    selected_mentions = page.get_by_label("Selected mentions", exact = True)
    # Repeated literal text must not inherit a deleted selected occurrence.
    prompt.fill("@project")
    expect(option).to_be_visible()
    # Enter picks the active option; wait until it is this exact skill.
    expect(option).to_have_attribute("aria-selected", "true")
    prompt.press("Enter")
    expect(selected_mentions).to_contain_text(SKILL_NAME)
    prompt.press("End")
    prompt.type(f"@{SKILL_NAME} ")
    expect(selected_mentions).to_contain_text(SKILL_NAME)
    prompt.evaluate("(node, length) => node.setSelectionRange(0, length)", len(SKILL_NAME) + 2)
    prompt.press("Delete")
    expect(prompt).to_have_value(f"@{SKILL_NAME} ")
    expect(selected_mentions).to_have_count(0)
    provider.assert_no_request()
    scenario("A2-mention-occurrence-edit", "Deleting a selected occurrence while identical unselected text remains removes the canonical skill association; no accidental native invocation")

    prompt.fill("😀 @project")
    expect(option).to_be_visible()
    expect(option).to_have_attribute("aria-selected", "true")
    prompt.press("Enter")  # Select mention, NOT Send.
    expect(prompt).to_have_value(f"😀 @{SKILL_NAME} ")
    expect(selected_mentions).to_contain_text(SKILL_NAME)
    provider.assert_no_request()
    prompt.press("End")
    prompt.type("Inspect this visual context.")
    # Prefix edit shifts native byte offsets; selected identity/path must survive.
    prompt.press("Home")
    prompt.type("é ")
    expected_text = f"é 😀 @{SKILL_NAME} Inspect this visual context."
    expect(prompt).to_have_value(expected_text)
    expect(selected_mentions).to_contain_text(SKILL_NAME)
    snapshot(page, "inputs-desktop-ready")
    page.set_viewport_size({"width": 390, "height": 844})
    expect(inspect).to_be_visible()
    expect(page.get_by_role("button", name = "Attach images", exact = True)).to_be_visible()
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
    # There is no mention button: a typed "@" opens the listbox while focus stays
    # in the prompt. Escape dismisses it; the probe text is then erased again.
    prompt.press("End")
    prompt.type(" @")
    expect(mention_list).to_be_visible()
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
    snapshot(page, "inputs-narrow-skills")
    prompt.press("Escape")
    expect(mention_list).to_have_count(0)
    expect(prompt).to_be_focused()
    prompt.press("Backspace")
    prompt.press("Backspace")
    expect(prompt).to_have_value(expected_text)
    expect(selected_mentions).to_contain_text(SKILL_NAME)
    snapshot(page, "inputs-narrow-ready")
    page.set_viewport_size({"width": 1440, "height": 1000})
    scenario("A10-input-layout-keyboard", "1440x1000 and 390x844: attachment/mention controls unclipped; Enter chooses exact mention without sending, Escape returns focus; Unicode prefix edits preserve ranges")

    with page.expect_response(lambda response: response.url == prompts and response.request.method == "POST", timeout = 60000) as waiting:
        send.click()
    response = waiting.value
    assert response.status == 202, response.text()
    body = response.request.post_data_json
    ack = response.json()
    assert body["text"] == expected_text
    assert body["skill_mentions"] == [{"name": selected["qualified_name"], "path": selected["path"], "start": 8, "end": 8 + len(("@" + SKILL_NAME).encode())}]
    assert base64.b64decode(body["images"][0]["data"]) == PNG
    evidence["requests"].append({"conversation_id": conversation, "submission_key": body["submission_key"], "request_id": ack["request_id"], "inputs": {"skill": selected["qualified_name"], "native_ranges": body["skill_mentions"], "images": 1}})
    request = provider.request()
    native_context = json.dumps(request.body)
    assert SKILL_SENTINEL in native_context, "Selected skill body was not consumed by the native coding request"
    content_parts = [part for message in request.body.get("messages", []) if isinstance(message.get("content"), list) for part in message["content"]]
    image_parts = [part for part in content_parts if part.get("type") == "image_url"]
    assert image_parts and image_parts[-1]["image_url"]["url"].startswith("data:image/"), "Native provider input omitted visual context"
    cancellations = []
    page.on("request", lambda value: cancellations.append(value.url) if value.url.endswith("/cancel") else None)
    prompt.fill("@project")
    expect(option).to_be_visible()
    prompt.press("Escape")
    expect(option).to_have_count(0)
    expect(status).to_have_text("Running")
    assert not cancellations, "Dismissal must not cancel native work"
    prompt.fill("")
    scenario("A10-mention-escape-running", "While native work is active, Escape dismisses mention suggestions without issuing cancellation or changing Running")
    request.text("RICH_INPUT_NATIVE_COMPLETED")
    expect(transcript).to_contain_text("RICH_INPUT_NATIVE_COMPLETED", timeout = 60000)
    expect(status).to_have_text("Completed", timeout = 60000)
    expect(page.get_by_role("button", name = "Stop", exact = True)).to_have_count(0)
    expect(inspect).to_have_count(0)
    scenario("A2-rich-input-native-terminal", "Authenticated coding route admitted exact text, descriptor path, UTF-8 ranges and bytes; native provider fixture consumed both skill body and image content; actual request reached terminal completion")

    # A definite transport refusal is fault-injected solely for the recovery UI.
    files.set_input_files({"name": "retained.png", "mimeType": "image/png", "buffer": PNG})
    prompt.fill("Retain this rejected visual input")
    page.route(prompts, lambda route: route.fulfill(status = 400, content_type = "application/json", body = json.dumps({"detail": "Fault-injected pre-admission image refusal"})), times = 1)
    send.click()
    expect(page.get_by_test_id("coding-input-recovery")).to_contain_text("Not sent")
    page.get_by_test_id("coding-input-recovery").get_by_role("button", name = "Restore input", exact = True).click()
    expect(prompt).to_have_value("Retain this rejected visual input")
    expect(page.get_by_role("list", name = "Attached images")).to_be_visible()
    provider.assert_no_request()
    scenario("A2-input-rejected-restore-fixture", "Explicit pre-admission HTTP refusal (fault-injected) retains actionable visual draft without accepted transcript; Restore recovers the exact text/image association")

    # Forward once to the actual backend, then lose its reply. The still-live
    # native SSE must reconcile acceptance; a duplicate of the original rich
    # snapshot must return its identity rather than start another workload.
    # Explicit retry while view evidence is delayed is covered by run-session's
    # deterministic contract tests, not an invented browser lifecycle state.
    lost = {}
    def lose_reply(route):
        result = route.fetch()
        assert result.status == 202
        lost.update(ack = result.json(), body = route.request.post_data_json)
        route.abort("connectionreset")
    page.route(prompts, lose_reply, times = 1)
    with page.expect_event("requestfailed", predicate = lambda request: request.url == prompts and request.method == "POST", timeout = 60000):
        send.click()
    expect(status).to_have_text("Running", timeout = 60000)
    expect(page.get_by_test_id("coding-input-recovery")).to_have_count(0, timeout = 60000)
    duplicate = context.request.post(prompts, data = lost["body"], headers = headers)
    assert duplicate.status == 202
    assert duplicate.json()["request_id"] == lost["ack"]["request_id"]
    request = provider.request()
    request.text("RICH_INPUT_RECOVERY_COMPLETED")
    expect(transcript).to_contain_text("RICH_INPUT_RECOVERY_COMPLETED", timeout = 60000)
    expect(status).to_have_text("Completed", timeout = 60000)
    provider.assert_no_request()
    evidence["requests"].append({"conversation_id": conversation, "submission_key": lost["body"]["submission_key"], "request_id": lost["ack"]["request_id"], "recovery": "response-loss exact rich retry"})
    scenario("A2-input-response-loss-reconciliation", "Actual native accepted rich input, response loss fault-injected; ordered SSE reconciled the key and a duplicate original byte/key snapshot returned the same request; one native workload reached terminal completion")
    snapshot(page, "inputs-terminal")
    evidence["status"] = "passed"


def live_input_scenario(page, context, base, project, report, scenario, snapshot):
    """One bounded workload through the existing configured native provider."""
    import time
    from playwright.sync_api import expect

    conversation = opened_id(page)
    prompt = page.get_by_label("Coding prompt", exact = True)
    status = page.get_by_test_id("coding-run-status")
    evidence = report.setdefault("workload", {"kind": "live-existing-provider-rich-input", "requests": [], "deadline_seconds": 180})
    # The composer's model chip names the configured model ("Model: <name>[ · effort]").
    evidence["configured_model"] = (page.get_by_test_id("coding-model-trigger").get_attribute("aria-label") or "").removeprefix("Model: ")
    # Prepare instructions before opening: native owns the effective skill snapshot.
    # Use a resolvable visual fixture rather than the 1px transport-contract image.
    page.get_by_label("Image files", exact = True).set_input_files({"name": "visual.png", "mimeType": "image/png", "buffer": LIVE_PNG})
    prompt.fill("@project")
    selected = (page.get_by_test_id("coding-mention-list")
                .locator(f'[data-mention-kind="skill"][data-mention-name="{SKILL_NAME}"]')
                .filter(has_text = f"Coding input fixture {SKILL_NAME}"))
    expect(selected).to_be_visible(timeout = 60000)
    # The real profile also discovers global skills whose descriptions match
    # 'project'; choose this exact descriptor rather than assuming list order.
    selected.click()
    expect(page.get_by_label("Selected mentions", exact = True)).to_contain_text(SKILL_NAME)
    prompt.press("End")
    prompt.type("Visual-evidence request: inspect the attached image and identify its dominant color, without guessing from filename. In this disposable project only, use write_file to create image-skill-evidence.txt as instructed by the selected skill, then read_file to verify it. Make no other changes and report completion briefly.")
    snapshot(page, "live-inputs-ready")
    with page.expect_response(lambda response: response.url == base + f"/api/coding/conversations/{conversation}/prompts" and response.request.method == "POST", timeout = 60000) as waiting:
        page.get_by_role("button", name = "Send", exact = True).click()
    response = waiting.value
    if response.status != 202:
        evidence.update(status = "blocked", incomplete_reason = f"Existing provider rich-input admission refused ({response.status}): {response.text()}")
        scenario("A2-live-rich-input", evidence["incomplete_reason"])
        report["scenarios"][-1]["status"] = "blocked"
        report["limitations"].append(evidence["incomplete_reason"])
        return
    ack = response.json()
    body = response.request.post_data_json
    assert body["skill_mentions"] == [{"name": SKILL_NAME, "path": str(project / ".agents" / "skills" / SKILL_NAME / "SKILL.md"), "start": 0, "end": len(("@" + SKILL_NAME).encode())}]
    assert len(body["images"]) == 1 and base64.b64decode(body["images"][0]["data"]) == LIVE_PNG
    evidence["requests"].append({"conversation_id": conversation, "request_id": ack["request_id"], "submission_key": body["submission_key"], "skill_mentions": body.get("skill_mentions"), "images": len(body.get("images", []))})
    outcome = project / "image-skill-evidence.txt"
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        label = status.inner_text()
        if label.startswith(("Completed", "Failed", "Stopped", "Interrupted", "Disconnected")):
            break
        page.wait_for_timeout(250)
    evidence["terminal_status"] = status.inner_text()
    evidence["public_alerts"] = page.get_by_role("alert").all_inner_texts()
    snapshot(page, "live-inputs-terminal")
    if evidence["terminal_status"] != "Completed" or not outcome.is_file():
        evidence.update(status = "blocked", incomplete_reason = "Existing ChatGPT/native rich-input workload did not complete the requested file outcome within 180 seconds: " + evidence["terminal_status"] + "; " + "; ".join(evidence["public_alerts"]))
        scenario("A2-live-rich-input", evidence["incomplete_reason"])
        report["scenarios"][-1]["status"] = "blocked"
        report["limitations"].append(evidence["incomplete_reason"])
        return
    result = json.loads(outcome.read_text())
    assert str(result["dominant_color"]).lower() == "red", result
    assert result["skill_marker"] == "SKILL242_LOADED_FROM_NATIVE_BODY", result
    # Settled activity is folded; rows show native verbs ("Write …", "Read …").
    unfold_activity(page)
    tools = page.get_by_test_id("coding-tool-row")
    expect(tools.filter(has_text = re.compile(r"^Write\b")).last).to_contain_text("image-skill-evidence.txt")
    read = tools.filter(has_text = re.compile(r"^Read\b")).last
    expand_tool(read)
    expect(read.get_by_label("Tool output", exact = True)).to_contain_text("SKILL242_LOADED_FROM_NATIVE_BODY")
    evidence.update(status = "passed", filesystem_result = result)
    scenario("A2-live-rich-input", "Existing configured provider completed the authenticated coding route with image semantic recognition, selected skill-only instruction, real native write/read effects and terminal completion")
