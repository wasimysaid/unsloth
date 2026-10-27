# SPDX-License-Identifier: AGPL-3.0-only
"""Shared rendered /coding steps for the acceptance drivers.

Choosing a folder only selects where the next conversation runs; the landing
composer's Send creates it and then sends the typed text once. Drivers that need
an idle conversation without a prompt create it through the authenticated native
HTTP API and open it deliberately from the sidebar. Nothing here is mocked.
"""
from __future__ import annotations

import re
from urllib.parse import urlparse

SAVED = '[aria-label="Saved coding conversations"]'
# Below 768px the sidebar is a sheet whose rows are mounted only while it is open.
MOBILE_SIDEBAR = '[data-sidebar="sidebar"][data-mobile="true"]'
# The composer's screen-reader explanation names the first send blocker. An open,
# connected conversation without one explains how Enter sends instead.
SENDABLE = re.compile(r"^Enter sends")
CONNECTED = re.compile(r"^(?!Loading native conversation|Disconnected)")


def _expect():
    from playwright.sync_api import expect
    return expect


def prompt(page):
    return page.get_by_label("Coding prompt", exact=True)


def saved_row(page, identifier):
    return page.locator(f'{SAVED} button[data-conversation-id="{identifier}"]')


def show_sidebar(page):
    """Open the narrow-layout sidebar sheet when needed; returns whether this call opened it."""
    expect = _expect()
    if not page.evaluate("matchMedia('(max-width: 767px)').matches"):
        return False
    if page.locator(MOBILE_SIDEBAR + '[data-state="open"]').count():
        return False
    # A row click closes the sheet; let that exit finish before reopening it.
    expect(page.locator(MOBILE_SIDEBAR)).to_have_count(0, timeout=60000)
    page.get_by_role("button", name="Toggle sidebar", exact=True).click()
    expect(page.locator(SAVED)).to_be_attached(timeout=60000)
    return True


def hide_sidebar(page):
    page.keyboard.press("Escape")
    _expect()(page.locator(MOBILE_SIDEBAR)).to_have_count(0, timeout=60000)


def opened_id(page):
    """The open conversation's native ID, read from its current sidebar row."""
    shown = show_sidebar(page)
    row = page.locator(f'{SAVED} button[aria-current="true"]')
    _expect()(row).to_have_count(1, timeout=60000)
    identifier = row.get_attribute("data-conversation-id")
    if shown:
        hide_sidebar(page)
    return identifier


def expect_opened(page, identifier, *, timeout=60000):
    shown = show_sidebar(page)
    _expect()(saved_row(page, identifier)).to_have_attribute("aria-current", "true", timeout=timeout)
    if shown:
        hide_sidebar(page)


def expect_connected(page, *, timeout=60000):
    """A reconstructed native view: neither loading nor disconnected."""
    expect = _expect()
    expect(page.get_by_test_id("coding-run-status")).to_have_text(CONNECTED, timeout=timeout)
    expect(page.get_by_test_id("coding-disconnect-banner")).to_have_count(0, timeout=timeout)


def expect_ready(page, *, timeout=60000):
    """Prompt editable in a connected view with no pending send blocker."""
    expect = _expect()
    expect(prompt(page)).to_be_editable(timeout=timeout)
    expect(page.locator("#coding-send-explanation")).to_have_text(SENDABLE, timeout=timeout)


def create_conversation(context, base, headers, project, **body):
    """POST the native creation directly; no prompt is sent."""
    response = context.request.post(base + "/api/coding/conversations", headers=headers,
                                    data={"cwd": str(project), **body}, timeout=90000)
    assert response.status == 201, f"Native creation failed ({response.status}): {response.text()}"
    return response.json()


def refresh_saved(page):
    expect = _expect()
    show_sidebar(page)
    refresh = page.get_by_role("button", name="Refresh conversations", exact=True)
    expect(refresh).to_be_enabled(timeout=60000)
    with page.expect_response(lambda response: urlparse(response.url).path == "/api/coding/conversations"
                              and response.request.method == "GET", timeout=60000):
        refresh.click()
    expect(refresh).to_be_enabled(timeout=60000)


def open_saved(page, base, identifier, *, refresh=False, ready=True):
    """Deliberately open a saved conversation from the sidebar; returns the open response.

    Every confirmed opening, including a same-ID reopening, mounts a fresh view,
    so the previous transcript is awaited out before the new view is checked."""
    show_sidebar(page)
    if refresh:
        refresh_saved(page)
    row = saved_row(page, identifier)
    _expect()(row).to_be_visible(timeout=60000)
    previous = page.query_selector('[data-testid="coding-transcript"]')
    with page.expect_response(lambda response: response.url == base + f"/api/coding/conversations/{identifier}/open"
                              and response.request.method == "POST", timeout=60000) as opened:
        row.click()
    assert opened.value.ok, f"Open failed ({opened.value.status}): {opened.value.text()}"
    assert opened.value.json()["id"] == identifier, opened.value.json()
    if previous is not None:
        page.wait_for_function("node => !node.isConnected", arg=previous, timeout=60000)
    expect_opened(page, identifier)
    if ready:
        expect_ready(page)
    return opened.value


def create_and_open(page, context, base, headers, project, **body):
    """API creation, then sidebar refresh and deliberate open; returns (created, opened)."""
    created = create_conversation(context, base, headers, project, **body)
    return created, open_saved(page, base, created["id"], refresh=True)


def type_command(page, text):
    """Fill a native slash command. A bare `/name` waits until the open command
    list selects exactly that command, so Enter runs it instead of completing
    another match while discovery is still loading."""
    field = prompt(page)
    field.fill(text)
    name = text.strip()
    if " " not in name:
        option = page.get_by_test_id("coding-mention-list").locator(
            f'[data-mention-kind="command"][data-mention-name="{name}"]')
        _expect()(option).to_have_attribute("aria-selected", "true", timeout=60000)
    return field


def run_command(page, text):
    """Type `/name args` into the prompt and press Enter (POST .../commands)."""
    type_command(page, text).press("Enter")


def enter_plan_mode(page, base, identifier):
    """Native `/plan` command; returns its command response."""
    with page.expect_response(lambda response: response.url == base + f"/api/coding/conversations/{identifier}/commands"
                              and response.request.method == "POST", timeout=60000) as command:
        run_command(page, "/plan")
    _expect()(page.get_by_test_id("coding-plan-mode")).to_be_visible(timeout=60000)
    return command.value


def leave_plan_mode(page, base, identifier):
    """The plan-mode chip's Leave control (POST .../mode build); returns its response."""
    with page.expect_response(lambda response: response.url == base + f"/api/coding/conversations/{identifier}/mode"
                              and response.request.method == "POST", timeout=60000) as mode:
        page.get_by_role("button", name="Leave plan mode", exact=True).click()
    _expect()(page.get_by_test_id("coding-plan-mode")).to_have_count(0, timeout=60000)
    return mode.value


def open_context_usage(page):
    """Click the context ring; returns its popover (text "Context window", "N / M tokens")."""
    page.get_by_test_id("coding-context-usage").click()
    popover = page.get_by_role("dialog").filter(has_text="Context window")
    _expect()(popover).to_be_visible(timeout=60000)
    return popover
