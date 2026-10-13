# SPDX-License-Identifier: AGPL-3.0-only
"""Ticket 251 rendered MCP scenarios using real production routes/native owners.

Only explicitly reported browser HTTP-response loss is injected. ProviderFixture
is deterministic external protocol input, not a live-model claim. Every MCP
connection, gateway invocation, inventory and operation record is native.
"""
from __future__ import annotations

import json
from pathlib import Path
import re
import time
from urllib.parse import quote, urlparse
import uuid

from coding_mcp_stdio_fixture import definition, read_events, write_control


SERVER = "configured"
ACTIONS = {"apply": "Apply saved MCP configuration", "reconnect": "Reconnect configured servers"}
CORRELATION_PREFIX = "unsloth:coding:pending-mcp:"
# Public identity evidence only. Historical rows need not retain live invocation
# IDs; capture exact native IDs before checkpoints replace provisional tool rows.
MCP_TOOL_CAPTURE = r"""(() => {
  const original = window.fetch.bind(window);
  window.codingMcpToolIdentities = [];
  window.fetch = async (...args) => {
    const response = await original(...args);
    const url = String(args[0] instanceof Request ? args[0].url : args[0]);
    if (!/\/api\/coding\/conversations\/[^/]+\/events$/.test(url) || !response.ok || !response.body) return response;
    const reader = response.clone().body.getReader();
    void (async () => {
      let buffer = ''; const decoder = new TextDecoder();
      try {
        for (;;) {
          const {done, value} = await reader.read(); if (done) break;
          buffer += decoder.decode(value, {stream:true});
          let end;
          while ((end = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, end).trimEnd(); buffer = buffer.slice(end + 1);
            if (!line.startsWith('data: ')) continue;
            const event = JSON.parse(line.slice(6)).event;
            if (event?.type !== 'activity') continue;
            for (const row of event.rows ?? []) {
              const tool = row.tool;
              if (!tool || tool.name !== 'mcp' || !tool.invocation_id) continue;
              const items = window.codingMcpToolIdentities;
              if (items.some(item => item.call_id === tool.call_id && item.invocation_id === tool.invocation_id)) continue;
              if (items.length >= 128) throw new Error('MCP identity evidence exceeded bound');
              items.push({call_id:tool.call_id, invocation_id:tool.invocation_id, request_id:row.request_id ?? tool.request_id ?? null});
            }
          }
          if (buffer.length > 2 * 1024 * 1024) throw new Error('MCP public event exceeded bound');
        }
      } catch (error) {
        if (!(error instanceof TypeError || error.name === 'AbortError')) window.codingMcpCaptureError = String(error);
      } finally { await reader.cancel().catch(() => {}); }
    })();
    return response;
  };
})();"""
STORAGE_VALUES = "() => ({localStorage: Object.values(localStorage), sessionStorage: Object.values(sessionStorage)})"
CORRELATION_STORES = """() => Object.fromEntries(['localStorage', 'sessionStorage'].map(name =>
    [name, Object.fromEntries(Object.entries(window[name]).filter(([key]) =>
        key.startsWith('unsloth:coding:pending-mcp:')))]))"""
EDITOR_MONITOR_START = """() => {
    const editor = document.getElementById('mcp-definition');
    const configuration = document.querySelector('section[aria-label="MCP configuration"]');
    const states = [];
    const capture = () => states.push({disabled: editor.disabled,
        focused: document.activeElement === editor, busy: configuration.getAttribute('aria-busy') === 'true'});
    const observer = new MutationObserver(capture);
    observer.observe(editor, {attributes: true, attributeFilter: ['disabled']});
    observer.observe(configuration, {attributes: true, attributeFilter: ['aria-busy']});
    document.addEventListener('focusin', capture, true);
    document.addEventListener('focusout', capture, true);
    capture();
    window.mcpBackgroundEditorMonitor = {stop: () => {
        capture(); observer.disconnect();
        document.removeEventListener('focusin', capture, true);
        document.removeEventListener('focusout', capture, true);
        return states;
    }};
}"""
EDITOR_MONITOR_STOP = """() => {
    const states = window.mcpBackgroundEditorMonitor.stop();
    delete window.mcpBackgroundEditorMonitor;
    return states;
}"""


def correlation_key(conversation: str) -> str:
    return CORRELATION_PREFIX + quote(conversation, safe = "~!*'()")


def assert_correlation_storage(stores: dict, conversation: str, operation: str,
                               kind: str, name: str | None = None) -> dict:
    """Exact delivery metadata only, owned by the submitting tab, not shared auth storage."""
    key = correlation_key(conversation)
    assert key not in stores["localStorage"], "MCP delivery identity leaked into cross-tab localStorage"
    raw = stores["sessionStorage"].get(key)
    assert isinstance(raw, str), "Submitting tab lost its exact MCP delivery identity"
    value = json.loads(raw)
    assert isinstance(value, dict) and type(value.get("version")) is int
    assert value == {"version": 1, "conversation_id": conversation, "id": operation, "kind": kind, "name": name}, "Stored correlation contains wrong identity or non-correlation data"
    return value


def assert_private_storage_absent(values: dict, *texts: str) -> None:
    for name in ("localStorage", "sessionStorage"):
        for text in texts:
            assert not any(value == text or (len(text) >= 20 and text in value)
                           for value in values[name]), f"Raw draft/definition content was persisted to {name}"


def assert_editor_observation(states: list[dict]) -> None:
    assert states, "Missing rendered editor observation evidence"
    assert all(state == {"disabled": False, "focused": True, "busy": False} for state in states), "Read-only background observation disabled the editor or stole focus"


def assert_operation(record: dict, identifier: str, conversation: str, kind: str,
                     status: str = "completed") -> None:
    assert record["operation_id"] == identifier, "Native operation identity changed"
    assert record["session_id"] == conversation, "MCP operation changed session owner"
    assert record["kind"] == kind and record["name"] is None
    assert status in ("running", "completed", "failed"), "Unknown is absence of a receipt, not an invented terminal status"
    assert record["status"] == status, f"Expected native {status}: {record}"
    assert isinstance(record["saved_revision"], str) and record["saved_revision"]
    assert record["applied_revision"] is None or isinstance(record["applied_revision"], str)
    assert type(record["live_available"]) is bool
    assert type(record["configured_tools"]) is int
    if status == "completed":
        assert record["error"] is None and record["live_available"] is True
        assert record["configured_tools"] == 1, "Acknowledgment is not actual echo-tool inventory"
        assert record["applied_revision"] == record["saved_revision"]
    if status == "failed":
        assert record["error"], "Native failure must give an actionable error"


def configured_row(inventory: dict) -> dict:
    rows = [row for row in inventory["live"] if row["name"] == SERVER and row["ownership"] == "configured"]
    assert len(rows) == 1, "Configured server must have exactly one session-owned inventory row"
    return rows[0]


def assert_connected(inventory: dict) -> None:
    row = configured_row(inventory)
    assert inventory["live_available"] is True
    assert row["status"] and row["status"]["connected"] is True
    assert row["status"]["tools"] == 1 and row["pending_apply"] is False
    assert inventory["configured_tools"] == 1
    assert inventory["saved_revision"] == inventory["applied_revision"]


def fixture_processes(events: Path) -> list[dict]:
    """Record identity before cleanup; PID alone is not cleanup authority."""
    import psutil
    fixture = str(Path(__file__).with_name("coding_mcp_stdio_fixture.py").resolve())
    result = []
    for event in read_events(events):
        if event["event"] != "start":
            continue
        item = {"pid": event["pid"], "start_time_ns": event["time_ns"], "already_exited": True}
        try:
            process = psutil.Process(event["pid"])
            created = process.create_time()
            # A fixture that has exited but remains a same-incarnation zombie is
            # not settled. Its cmdline is unavailable, so retain birth identity.
            if process.status() == psutil.STATUS_ZOMBIE and 0 <= event["time_ns"] / 1e9 - created < 10:
                item.update(already_exited = False, create_time = created, command = None)
            else:
                command = process.cmdline()
                if fixture in command and str(events.resolve()) in command:
                    item.update(already_exited = False, create_time = created, command = command)
        except psutil.NoSuchProcess:
            pass
        result.append(item)
    return result


def process_settled(identity: dict) -> bool:
    import psutil
    if identity["already_exited"]:
        return True
    try:
        process = psutil.Process(identity["pid"])
        if process.create_time() != identity["create_time"]:
            return True
        if process.status() == psutil.STATUS_ZOMBIE:
            return False  # Exited but not reaped is not awaited cleanup.
        return process.cmdline() != identity["command"] or not process.is_running()
    except psutil.ZombieProcess:
        return False
    except psutil.NoSuchProcess:
        return True


def run_apply_reconnect_scenarios(page, context, playwright, base, headers, paths,
                                 conversation_id, provider, report, scenario, snapshot, expect):
    prefix = f"/api/coding/conversations/{conversation_id}/mcp"
    panel = page.get_by_role("main", name = "Mimir Settings", exact = True)
    configuration = panel.get_by_role("region", name = "MCP configuration", exact = True)
    views = page.get_by_role("navigation", name = "Coding views", exact = True)
    settings_tab = views.get_by_role("button", name = "Mimir Settings", exact = True)
    conversation_tab = views.get_by_role("button", name = "Conversation", exact = True)
    events, control = paths["mcp_events"], paths["mcp_control"]
    evidence = report.setdefault("apply_reconnect", {"kind": "deterministic-http-provider-real-native-mcp",
                                                   "operations": [], "inspections": [], "requests": [],
                                                   "tool_calls": [], "transport_faults": []})
    posts, gets, all_requests = [], [], []

    def observe(request):
        path = urlparse(request.url).path
        all_requests.append({"method": request.method, "path": path})
        if path in (prefix + "/apply", prefix + "/reconnect") and request.method == "POST":
            posts.append({"kind": path.rsplit("/", 1)[1], **request.post_data_json})
        if path.startswith(prefix + "/operations/") and request.method == "GET":
            gets.append(path.rsplit("/", 1)[1])
    page.on("request", observe)

    def wait_for(predicate, description, timeout = 30):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return
            page.wait_for_timeout(50)
        raise AssertionError(description + f" (deadline {timeout}s)")

    def inventory():
        response = context.request.get(base + prefix + "/inventory", headers = headers, timeout = 60000)
        assert response.ok, f"Native inventory HTTP {response.status}"
        value = response.json()
        evidence.setdefault("inventories", []).append(value)
        return value

    def inspect(operation):
        response = context.request.get(base + prefix + "/operations/" + operation,
                                       headers = headers, timeout = 60000)
        assert response.ok, f"Read-only operation inspection HTTP {response.status}"
        value = response.json()
        evidence["inspections"].append({"operation_id": operation, **value})
        assert set(value) == {"operation", "inventory"}
        if value["operation"] is not None:
            assert value["operation"]["operation_id"] == operation
            assert value["operation"]["session_id"] == conversation_id
        return value

    def terminal_operation(operation, kind, expected = "completed"):
        deadline = time.monotonic() + 60
        while True:
            value = inspect(operation)
            record = value["operation"]
            assert record is not None, "Acknowledged native operation disappeared"
            if record["status"] != "running":
                assert_operation(record, operation, conversation_id, kind, expected)
                return value
            assert_operation(record, operation, conversation_id, kind, "running")
            if time.monotonic() >= deadline:
                raise AssertionError("Native MCP operation did not settle within 60 seconds")
            page.wait_for_timeout(200)

    def show_settings():
        settings_tab.click()
        expect(panel).to_be_visible()
        expect(configuration).to_have_attribute("aria-busy", "false", timeout = 60000)

    def retained():
        expect(editor).to_have_value(unsaved)
        expect(revision).to_have_text(revision_text)
        assert paths["global"].read_bytes() == saved_bytes, "Operation changed saved configuration"
        assert_private_storage_absent(page.evaluate(STORAGE_VALUES), unsaved, enabled)

    def command(kind, expected = "completed", during = None):
        button = panel.get_by_role("button", name = ACTIONS[kind], exact = True)
        expect(button).to_be_enabled(timeout = 60000)
        button.focus()
        expect(button).to_be_focused()
        with page.expect_response(lambda response: urlparse(response.url).path == prefix + "/" + kind
                                  and response.request.method == "POST", timeout = 60000) as waiting:
            button.press("Enter")
            if during:
                during()
        response = waiting.value
        expect(configuration).to_have_attribute("aria-busy", "false", timeout = 60000)
        operation = response.request.post_data_json["operation_id"]
        if expected == "busy":
            assert response.status == 409, f"Native safe-idle admission must refuse busy ({response.status})"
            alert = panel.get_by_role("alert")
            expect(alert).to_contain_text(re.compile("busy|active|running|idle|request|tool", re.I))
            expect(alert).to_be_focused()
            evidence.setdefault("busy_refusals", []).append({"kind": kind, "operation_id": operation,
                                                           "http_status": response.status, "error": response.json()})
        else:
            assert response.ok, f"MCP {kind} HTTP {response.status}"
            acknowledgment = response.json()
            assert_operation(acknowledgment, operation, conversation_id, kind,
                             "running" if acknowledgment["status"] == "running" else expected)
            evidence.setdefault("acknowledgments", []).append(acknowledgment)
            checked = terminal_operation(operation, kind, expected)
            result = checked["operation"]
            if acknowledgment["status"] != "running":
                assert result == acknowledgment, "Native operation inspection disagrees with terminal POST"
            evidence["operations"].append(result)
            if expected == "completed":
                assert_connected(checked["inventory"])
                outcome = panel.get_by_test_id("mcp-operation-result")
                expect(outcome).to_contain_text(kind.title() + " completed", timeout = 60000)
                expect(outcome).to_contain_text("1 configured tools observed at outcome")
                expect(outcome).to_contain_text("Saved effective revision at admission: " + result["saved_revision"])
                expect(outcome).to_contain_text("Applied revision at outcome: " + result["applied_revision"])
                applied = panel.get_by_test_id("mcp-applied-state")
                expect(applied).to_contain_text("1 configured tools currently observed", timeout = 60000)
                expect(applied).to_contain_text("1 tools observed from this connection")
            else:
                expect(panel.get_by_test_id("mcp-operation-result")).to_contain_text(kind.title() + " failed", timeout = 60000)
                expect(panel.get_by_role("alert")).to_be_focused()
        retained()
        return operation

    def submit(marker):
        conversation_tab.click()
        expect(page.get_by_test_id("coding-conversation-id")).to_have_text(conversation_id)
        composer = page.get_by_label("Coding prompt", exact = True)
        composer.fill(marker)
        expect(page.get_by_role("button", name = "Send", exact = True)).to_be_enabled(timeout = 60000)
        with page.expect_response(lambda response: urlparse(response.url).path == f"/api/coding/conversations/{conversation_id}/prompts"
                                  and response.request.method == "POST", timeout = 60000) as waiting:
            composer.press("Enter")
        response = waiting.value
        assert response.status == 202
        request_id = response.json()["request_id"]
        evidence["requests"].append({"request_id": request_id, "scenario_marker": marker,
                                     "submission_key": response.request.post_data_json["submission_key"]})
        held = provider.request(timeout = 60)
        expect(page.get_by_test_id("coding-run-status")).to_have_text("Running", timeout = 60000)
        return request_id, held

    def finish(request, marker):
        request.text(marker)
        conversation_tab.click()
        expect(page.get_by_test_id("coding-transcript")).to_contain_text(marker, timeout = 60000)
        expect(page.get_by_test_id("coding-run-status")).to_have_text("Completed", timeout = 60000)
        provider.assert_no_request()
        show_settings()
        retained()

    def gateway(marker):
        request_id, request = submit(marker)
        list_call = marker + "-list"
        request.tool(list_call, "mcp", {"action": "list_tools", "server": SERVER})
        request = provider.request()
        listing = request.tool_result(list_call)
        assert '"echo"' in listing, "Real native gateway did not discover the actual remote echo tool"
        echo_call = marker + "-echo"
        request.tool(echo_call, "mcp", {"action": "call_tool", "server": SERVER,
                                      "tool": "echo", "arguments": {"text": marker}})
        request = provider.request()
        result = request.tool_result(echo_call)
        assert marker in result and "pid" in result, "Native gateway result lacks actual stdio echo/PID"
        row = page.get_by_test_id("coding-tool-row").filter(has_text = echo_call).last
        expect(row).to_contain_text(marker, timeout = 60000)
        assert row.get_attribute("data-call-id") == echo_call
        wait_for(lambda: page.evaluate("call => window.codingMcpToolIdentities.find(item => item.call_id === call)", echo_call),
                 "Native live MCP invocation identity was not observed")
        identity = page.evaluate("call => window.codingMcpToolIdentities.find(item => item.call_id === call)", echo_call)
        assert isinstance(identity["invocation_id"], str) and identity["invocation_id"] not in ("", "undefined", "null")
        assert identity["request_id"] == request_id, "Native tool identity changed its request owner"
        assert page.evaluate("window.codingMcpCaptureError ?? null") is None
        echo_events = [event for event in read_events(events) if event["event"] == "echo" and event["text"] == marker]
        assert len(echo_events) == 1, "Tool executed more than once or never reached real stdio fixture"
        evidence["tool_calls"].append({"request_id": request_id, "list_call_id": list_call,
                                      "echo_call_id": echo_call, "public_identity": identity,
                                      "result": result, "stdio_event": echo_events[0]})
        finish(request, marker + "-complete")

    report["active_scenario"] = "A8-251-save-distinct-from-apply"
    show_settings()
    before = inventory()
    assert before["configured_tools"] == 0
    # Ticket-250 suite leaves a browser-added editor open. Deliberately discard
    # that draft, then use the real native editor/save path for configured echo.
    if panel.get_by_label("MCP definition JSON", exact = True).count():
        panel.get_by_role("button", name = "Discard draft", exact = True).click()
        panel.get_by_role("button", name = "Confirm discard draft", exact = True).click()
    with page.expect_response(lambda response: urlparse(response.url).path == prefix + "/edit", timeout = 60000):
        panel.get_by_role("button", name = "Edit configured", exact = True).click()
    editor = panel.get_by_label("MCP definition JSON", exact = True)
    enabled = json.dumps(definition(events, control), indent = 2)
    editor.fill(enabled)
    with page.expect_response(lambda response: urlparse(response.url).path == prefix + "/save", timeout = 60000) as waiting:
        panel.get_by_role("button", name = "Save configuration", exact = True).click()
    response = waiting.value
    assert response.ok
    saved = response.json()["draft"]
    assert json.loads(saved["json"]) == json.loads(enabled)
    assert json.loads(paths["global"].read_text())["mcpServers"][SERVER] == json.loads(enabled)
    expect(configuration).to_have_attribute("aria-busy", "false", timeout = 60000)
    pending = inventory()
    assert configured_row(pending)["pending_apply"] and configured_row(pending)["status"] is None
    assert pending["saved_revision"] != pending["applied_revision"]
    assert pending["configured_tools"] == 0 and not read_events(events), "Save launched an MCP connection"
    expect(panel.get_by_test_id("mcp-save-result")).to_contain_text("Persisted revision: " + saved["revision"])
    unsaved = json.dumps({"command": "ticket251-unsaved-must-not-execute", "enabled": False}, indent = 2)
    editor.fill(unsaved)
    revision = panel.get_by_text(re.compile(r"^Editing revision: "))
    revision_text = revision.inner_text()
    saved_bytes = paths["global"].read_bytes()
    evidence["saved_editor_revision"] = saved["revision"]
    evidence["saved_runtime_revision"] = pending["saved_revision"]
    snapshot("desktop-251-saved-pending-unsaved-draft")
    scenario("A8-251-save-distinct-from-apply", "Real enabled stdio definition saved, native revisions differ and no process/tool exists; separate unsaved draft retained")

    with page.expect_response(lambda response: urlparse(response.url).path == prefix + "/inventory", timeout = 60000):
        panel.get_by_role("button", name = "Refresh inventory", exact = True).click()
    expect(configuration).to_have_attribute("aria-busy", "false", timeout = 60000)
    retained()
    assert not posts and not read_events(events), "Refresh secretly applied/reconnected saved configuration"
    scenario("A8-251-refresh-readonly", "Rendered Refresh inventory preserved unsaved form/edit revision and saved pending configuration, with no apply/reconnect POST or MCP process creation")

    report["active_scenario"] = "A8-251-apply-running-completed"
    write_control(control, initialize = "hold")
    def running():
        wait_for(lambda: any(event["event"] == "held" and event["method"] == "initialize" for event in read_events(events)),
                 "Actual native configured connection never reached held initialize")
        expect(panel).to_contain_text(re.compile("Applying saved native MCP configuration|Apply in progress"))
        for name in ACTIONS.values():
            expect(panel.get_by_role("button", name = name, exact = True)).to_be_disabled()
        native = inspect(posts[-1]["operation_id"])["operation"]
        assert native is not None and native["status"] == "running", "In-progress UI has no native running operation"
        snapshot("desktop-251-apply-running")
        write_control(control)
    try:
        command("apply", during = running)
    finally:
        write_control(control)
    connections = fixture_processes(events)
    assert len(connections) == 1 and not connections[0]["already_exited"]
    panel.get_by_test_id("mcp-operation-result").scroll_into_view_if_needed()
    snapshot("desktop-251-apply-completed")
    gateway("TICKET251_APPLIED_ECHO")
    scenario("A8-251-apply-running-completed", "Keyboard Apply reached real held initialize, native running→completed and one configured tool; gateway list/echo verified PID, call/invocation/request identity, saved editor revision and unsaved draft unchanged")

    report["active_scenario"] = "A7-A8-251-busy-native-request"
    request_id, held = submit("TICKET251_HELD_NATIVE_REQUEST")
    show_settings()
    for kind in ACTIONS:
        command(kind, "busy")
    assert len(fixture_processes(events)) == 1, "Busy refusal replaced configured connection"
    assert_connected(inventory())
    conversation_tab.click()
    expect(page.get_by_test_id("coding-request-id")).to_contain_text(request_id)
    expect(page.get_by_test_id("coding-run-status")).to_have_text("Running")
    provider.assert_no_request()
    show_settings()
    retained()
    snapshot("desktop-251-busy-refusal-draft")
    finish(held, "TICKET251_HELD_REQUEST_FINISHED_NOT_CANCELLED")
    scenario("A7-A8-251-busy-native-request", "Both actual native commands refused 409 while provider request remained Running with exact request ID; no replay, Stop, cancellation, process replacement or draft/revision/disk mutation")

    report["active_scenario"] = "A7-A8-251-busy-native-mcp-tool"
    write_control(control, echo = "hold")
    request_id, request = submit("TICKET251_HELD_NATIVE_MCP_TOOL")
    call_id = "ticket251-held-mcp-echo"
    request.tool(call_id, "mcp", {"action": "call_tool", "server": SERVER,
                                  "tool": "echo", "arguments": {"text": "TICKET251_HELD_MCP_ECHO"}})
    try:
        wait_for(lambda: any(event["event"] == "held" and event["method"] == "tools/call" for event in read_events(events)),
                 "Native MCP tool did not reach actual held stdio request")
        show_settings()
        for kind in ACTIONS:
            command(kind, "busy")
        page.set_viewport_size({"width": 390, "height": 844})
        alert = panel.get_by_role("alert")
        expect(alert).to_be_focused()
        alert.scroll_into_view_if_needed()
        box = alert.bounding_box()
        assert box and box["x"] >= 0 and box["x"] + box["width"] <= 390
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
        snapshot("narrow-251-busy-native-mcp-tool")
        retained()
    finally:
        write_control(control)
    request = provider.request()
    result = request.tool_result(call_id)
    assert "TICKET251_HELD_MCP_ECHO" in result
    evidence["tool_calls"].append({"request_id": request_id, "echo_call_id": call_id, "result": result,
                                  "kind": "held-real-native-mcp-tool"})
    finish(request, "TICKET251_HELD_MCP_TOOL_FINISHED_NOT_CANCELLED")
    page.set_viewport_size({"width": 1440, "height": 1000})
    scenario("A7-A8-A10-251-busy-native-mcp-tool", "Actual gateway invocation held at remote tools/call; both commands refused without cancelling it; narrow alert focus/layout and draft retention verified, tool then completed naturally")

    report["active_scenario"] = "A8-251-reconnect-owned-lifetime"
    first_connection = fixture_processes(events)[0]
    command("reconnect")
    assert process_settled(first_connection), "Completed reconnect returned before old configured PID settled"
    assert len(fixture_processes(events)) == 2
    gateway("TICKET251_RECONNECTED_ECHO")
    assert evidence["tool_calls"][0]["stdio_event"]["pid"] != evidence["tool_calls"][-1]["stdio_event"]["pid"]
    evidence["reconnect_cleanup"] = {"old_connection": first_connection, "settled_before_completed_ack": True}
    panel.get_by_test_id("mcp-operation-result").scroll_into_view_if_needed()
    snapshot("desktop-251-reconnect-completed")
    scenario("A8-251-reconnect-owned-lifetime", "Real reconnect replaced only configured stdio PID, awaited old PID settlement before acknowledgment; new native gateway echo retained session and real configured ownership")

    report["active_scenario"] = "A8-A10-251-native-connection-failed-recovery"
    write_control(control, initialize = "fail")
    try:
        command("reconnect", "failed")
        failed = inventory()
        row = configured_row(failed)
        assert row["status"] and not row["status"]["connected"] and row["status"]["error"]
        assert failed["configured_tools"] == 0
        snapshot("desktop-251-native-connection-failed")
        page.set_viewport_size({"width": 390, "height": 844})
        panel.get_by_role("alert").scroll_into_view_if_needed()
        expect(panel.get_by_role("alert")).to_be_focused()
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
        snapshot("narrow-251-native-connection-failed")
        retained()
    finally:
        write_control(control)
    command("reconnect")
    gateway("TICKET251_FAILED_CONNECTION_RECOVERED_ECHO")
    page.set_viewport_size({"width": 1440, "height": 1000})
    scenario("A8-A10-251-native-connection-failed-recovery", "Controlled actual initialize failure produced failed operation, disconnected configured inventory and zero tools, focused readable desktop/narrow alert and unchanged saved bytes/editor revision/draft; deliberate reconnect recovered and echoed")

    report["active_scenario"] = "A8-251-apply-connection-failed-recovery"
    for fail in (True, False):
        # A changed saved transport record (not the unsaved form) forces apply
        # through the real connection owner, including its actual failure path.
        value = definition(events, control)
        if fail:
            value["env"] = {"TICKET251_APPLY_VERSION": "controlled-failure"}
        editor.fill(json.dumps(value, indent = 2))
        before_connections = len(fixture_processes(events))
        prior_editor_revision = revision_text
        with page.expect_response(lambda response: urlparse(response.url).path == prefix + "/save"
                                  and response.request.method == "POST", timeout = 60000) as waiting:
            panel.get_by_role("button", name = "Save configuration", exact = True).click()
        assert waiting.value.ok
        next_saved = waiting.value.json()["draft"]
        expect(configuration).to_have_attribute("aria-busy", "false", timeout = 60000)
        assert next_saved["revision"] not in prior_editor_revision
        saved_bytes = paths["global"].read_bytes()
        revision_text = revision.inner_text()
        editor.fill(unsaved)
        retained()
        pending = inventory()
        assert configured_row(pending)["pending_apply"]
        assert pending["saved_revision"] != pending["applied_revision"]
        assert len(fixture_processes(events)) == before_connections, "Saving changed configured connection"
        if fail:
            write_control(control, initialize = "fail")
        try:
            command("apply", "failed" if fail else "completed")
            if fail:
                failed = inventory()
                assert configured_row(failed)["status"]["error"] and failed["configured_tools"] == 0
                snapshot("desktop-251-apply-connection-failed")
        finally:
            write_control(control)
        evidence.setdefault("explicit_saved_revisions", []).append(next_saved["revision"])
    gateway("TICKET251_FAILED_APPLY_RECOVERED_ECHO")
    scenario("A8-251-apply-connection-failed-recovery", "Explicitly saved changed stdio definition remained pending until Apply; real initialize error failed application with zero configured tools and saved bytes/revision/unsaved draft retained; explicit saved-definition restoration and Apply recovered actual echo")

    report["active_scenario"] = "A8-251-lost-response-readonly-reconcile"
    for kind in ACTIONS:
        target = base + prefix + "/" + kind
        lookup_pattern = base + prefix + "/operations/*"
        upstream, held_inspections = [], []
        lookup_mode = {"hold": False, "resume": False}
        def inspection_unavailable(route):
            if lookup_mode["resume"]:
                route.continue_()
            elif lookup_mode["hold"]:
                # Retain the browser HTTP request, not a fabricated native result.
                held_inspections.append({"route": route, "settled": False})
            else:
                route.abort("connectionreset")
        page.route(lookup_pattern, inspection_unavailable)
        def lose_response(route):
            response = route.fetch(timeout = 60000)
            assert response.ok
            upstream.append(response.json())
            route.abort("connectionreset")
        page.route(target, lose_response)
        try:
            # Pending admission renders "unconfirmed" before the POST settles;
            # first prove the real successful native reply was actually lost.
            with page.expect_event("requestfailed", predicate = lambda request:
                                   request.url == target and request.method == "POST", timeout = 60000):
                panel.get_by_role("button", name = ACTIONS[kind], exact = True).click()
            expect(panel).to_contain_text("MCP operation unconfirmed", timeout = 60000)
        finally:
            page.unroute(target, lose_response)
        assert len(upstream) == 1
        operation = posts[-1]["operation_id"]
        assert_operation(upstream[0], operation, conversation_id, kind, upstream[0]["status"])
        native_terminal = terminal_operation(operation, kind)["operation"]
        evidence["operations"].append(native_terminal)
        retained()
        for name in ACTIONS.values():
            expect(panel.get_by_role("button", name = name, exact = True)).to_be_disabled()
        post_count = len(posts)
        correlation = assert_correlation_storage(page.evaluate(CORRELATION_STORES), conversation_id, operation, kind)
        evidence.setdefault("tab_correlations", []).append(correlation)
        if kind == "apply":
            report["active_scenario"] = "A8-A10-251-unconfirmed-background-edit-save-error"
            expect(configuration).to_have_attribute("aria-busy", "false", timeout = 60000)
            lookup_mode["hold"] = True
            wait_for(lambda: bool(held_inspections), "Periodic read-only inspection was not held", timeout = 10)
            expect(editor).to_be_enabled()
            # A real native invalid-save response owns the editor error, while
            # the actual successful runtime operation remains unconfirmed here.
            unsaved = "{"
            editor.fill(unsaved)
            with page.expect_response(lambda response: urlparse(response.url).path == prefix + "/save"
                                      and response.request.method == "POST", timeout = 60000) as failed_save:
                panel.get_by_role("button", name = "Save configuration", exact = True).click()
            assert failed_save.value.status == 400, "Native invalid JSON must reject persistence"
            expect(configuration).to_have_attribute("aria-busy", "false", timeout = 60000)
            alert = panel.get_by_role("alert")
            message = alert.locator("p").first
            expect(message).to_contain_text(re.compile("invalid|json|definition", re.I))
            expect(alert).to_contain_text("draft and original revision are retained")
            expect(alert).to_be_focused()
            save_error = message.inner_text()
            retained()
            unsaved = json.dumps({"command": "ticket251-unsaved-background-edit", "enabled": False,
                                  "args": ["TICKET251_BACKGROUND_DRAFT_PRIVATE"]}, indent = 2)
            editor.fill(unsaved)
            expect(editor).to_be_focused()
            inspection_counts = []
            page.evaluate(EDITOR_MONITOR_START)
            try:
                for index, viewport in enumerate(((1440, 1000), (390, 844))):
                    page.set_viewport_size({"width": viewport[0], "height": viewport[1]})
                    wait_for(lambda: len(held_inspections) > index, "Next periodic inspection was not held", timeout = 10)
                    expect(editor).to_be_enabled()
                    expect(editor).to_be_focused()
                    # Type through the actual rendered textarea while a GET is
                    # outstanding, then fail that read without touching native state.
                    page.keyboard.press("Control+End")
                    page.keyboard.insert_text(" ")
                    unsaved += " "
                    entry = held_inspections[index]
                    assert urlparse(entry["route"].request.url).path == prefix + "/operations/" + operation
                    with page.expect_event("requestfailed", predicate = lambda request:
                                           urlparse(request.url).path == prefix + "/operations/" + operation,
                                           timeout = 10000):
                        entry["route"].abort("connectionreset")
                    entry["settled"] = True
                    page.wait_for_timeout(100)
                    expect(panel.get_by_test_id("mcp-inventory-unavailable")).to_be_visible()
                    expect(panel).to_contain_text("MCP operation unconfirmed")
                    expect(configuration).to_have_attribute("aria-busy", "false")
                    expect(message).to_have_text(save_error)
                    expect(editor).to_be_enabled()
                    expect(editor).to_be_focused()
                    retained()
                    assert_correlation_storage(page.evaluate(CORRELATION_STORES), conversation_id, operation, kind)
                    assert len(posts) == post_count, "Observation/save-error recovery replayed a runtime command"
                    inspection_counts.append(gets.count(operation))
                    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
                    size = "desktop" if index == 0 else "narrow"
                    snapshot(size + "-251-unconfirmed-background-editor-focus")
                    alert.scroll_into_view_if_needed()
                    snapshot(size + "-251-unconfirmed-background-save-error")
            finally:
                editor_states = page.evaluate(EDITOR_MONITOR_STOP)
                # Preserve trace/error evidence even when an assertion detects
                # an actual disabling/focus regression before scenario completion.
                evidence["background_editing"] = {
                    "operation_id": operation, "native_terminal_status": native_terminal["status"],
                    "failed_save_status": failed_save.value.status, "save_error": save_error,
                    "editor_revision": revision_text, "inspection_get_counts": inspection_counts,
                    "held_then_failed_inspections": sum(entry["settled"] for entry in held_inspections),
                    "editor_states": editor_states,
                    "saved_configuration_unchanged": paths["global"].read_bytes() == saved_bytes,
                    "runtime_mutation_posts": sum(post["operation_id"] == operation for post in posts),
                    "viewports": [[1440, 1000], [390, 844]],
                }
            assert_editor_observation(editor_states)
            assert inspection_counts[1] > inspection_counts[0], "No separate periodic reconciliation request was observed"
            evidence["background_editing"]["draft_privacy_verified"] = True
            scenario("A8-A10-251-unconfirmed-background-edit-save-error", "Actual successful apply POST reply lost; periodic inspection GETs held then failed while textarea stayed editable/focused at desktop/narrow sizes; real invalid native save error, unsaved correction and original edit revision survived background observations without persistence or runtime replay")
            page.set_viewport_size({"width": 1440, "height": 1000})
            report["active_scenario"] = "A8-251-lost-response-readonly-reconcile"
        if kind == "reconnect":
            # Raw editor text is intentionally NOT persisted across full reload.
            # Only transport correlation may survive to reconcile the exact ID.
            previous_editor_revision = revision_text
            connections_before_reload = len(fixture_processes(events))
            # A separate tab must not inherit/clear the submitting tab's receipt.
            other_tab = context.new_page()
            try:
                other_tab.goto(base + "/coding")
                other_stores = other_tab.evaluate(CORRELATION_STORES)
                key = correlation_key(conversation_id)
                assert key not in other_stores["sessionStorage"] and key not in other_stores["localStorage"]
            finally:
                other_tab.close()
            assert_correlation_storage(page.evaluate(CORRELATION_STORES), conversation_id, operation, kind)
            page.reload()
            # Coding deliberately starts without an active owner after reload;
            # reopen the SAME saved identity, never create a replacement session.
            saved_conversation = page.locator('[aria-label="Saved coding conversations"] button').filter(has_text = conversation_id)
            expect(saved_conversation).to_be_visible(timeout = 60000)
            with page.expect_response(lambda response: urlparse(response.url).path == f"/api/coding/conversations/{conversation_id}/open"
                                      and response.request.method == "POST", timeout = 60000) as reopened:
                saved_conversation.click()
            assert reopened.value.ok
            assert len(fixture_processes(events)) == connections_before_reload, "Browser reload/reopen restarted configured MCP"
            expect(page.get_by_test_id("coding-event-status")).to_contain_text("Native event stream connected", timeout = 60000)
            expect(page.get_by_test_id("coding-conversation-id")).to_have_text(conversation_id)
            show_settings()
            expect(panel).to_contain_text("MCP operation unconfirmed", timeout = 60000)
            expect(editor).to_have_count(0)
            for name in ACTIONS.values():
                expect(panel.get_by_role("button", name = name, exact = True)).to_be_disabled()
            restored_correlation = assert_correlation_storage(page.evaluate(CORRELATION_STORES), conversation_id, operation, kind)
            assert restored_correlation == correlation, "Reload changed per-tab delivery identity"
            assert_private_storage_absent(page.evaluate(STORAGE_VALUES), unsaved, enabled, "TICKET251_BACKGROUND_DRAFT_PRIVATE")
            assert paths["global"].read_bytes() == saved_bytes
            evidence["reload_reconciliation"] = {"operation_id": operation, "session_id": conversation_id,
                                                   "prior_editor_revision": previous_editor_revision,
                                                   "storage": "sessionStorage", "correlation": restored_correlation,
                                                   "second_tab_correlation_absent": True, "cross_tab_localStorage_identity_absent": True,
                                                   "raw_draft_persisted": False, "mutation_replayed": False}
            snapshot("desktop-251-unconfirmed-reload-correlation-only")
        expect(panel.get_by_role("button", name = "Reconcile MCP operation", exact = True)).to_be_visible()
        # Restore observation and let the bounded read-only poll settle. This
        # avoids racing an explicit click against the same automatic terminal GET;
        # keyboard Reconcile itself is exercised on the unknown receipt below.
        with page.expect_response(lambda response: urlparse(response.url).path == prefix + "/operations/" + operation
                                  and response.ok, timeout = 60000) as waiting:
            lookup_mode["resume"] = True
            # Release held routes BEFORE unroute: Playwright may automatically
            # handle them during unroute, making a later continue_ invalid.
            for entry in held_inspections:
                if not entry["settled"]:
                    entry["route"].continue_()
                    entry["settled"] = True
            page.unroute(lookup_pattern, inspection_unavailable)
        assert waiting.value.ok
        result = waiting.value.json()
        assert result["operation"] == native_terminal
        assert_connected(result["inventory"])
        expect(panel).to_contain_text(kind.title() + " completed", timeout = 60000)
        wait_for(lambda: correlation_key(conversation_id) not in page.evaluate(CORRELATION_STORES)["sessionStorage"],
                 "Terminal reconciliation did not clear this tab's delivery correlation", timeout = 10)
        assert correlation_key(conversation_id) not in page.evaluate(CORRELATION_STORES)["localStorage"]
        if kind == "apply":
            expect(panel.get_by_role("alert").locator("p").first).to_have_text(save_error)
        assert len(posts) == post_count and gets[-1] == operation, "Reconciliation replayed a mutation"
        assert sum(post["operation_id"] == operation for post in posts) == 1 and gets.count(operation) > 0
        if kind == "reconnect":
            with page.expect_response(lambda response: urlparse(response.url).path == prefix + "/edit", timeout = 60000) as fresh_editor:
                panel.get_by_role("button", name = "Edit configured", exact = True).click()
            assert fresh_editor.value.ok
            expect(configuration).to_have_attribute("aria-busy", "false", timeout = 60000)
            editor.fill(unsaved)
            revision_text = revision.inner_text()
            evidence["reload_reconciliation"]["fresh_editor_revision"] = revision_text
        retained()
        evidence["transport_faults"].append({"kind": kind, "operation_id": operation,
                                             "fault": "browser discarded actual native POST response; browser inspection GET temporarily unavailable",
                                             "native_acknowledgment": upstream[0],
                                             "read_only_reconciliation": True, "post_count": 1})
        snapshot("desktop-251-" + kind + "-reconciled")
    scenario("A8-251-lost-response-readonly-reconcile", "Both real apply/reconnect settled natively after lost browser responses and unavailable browser inspections; exact terminal read-only reconciliation restored outcomes with one POST each; same-page drafts/revisions retained")
    scenario("A8-251-reload-correlation-only", "Exact correlation-only sessionStorage receipt stayed scoped to the submitting tab and survived reload/reopen of the same native identity; absent from localStorage/second tab, no raw drafts/definitions persisted, and native terminal reconciliation cleared the receipt without MCP restart/replay")

    report["active_scenario"] = "A1-251-auth-negative"
    unauth = playwright.request.new_context(base_url = base)
    try:
        denied = []
        for method, path, data in (("post", prefix + "/apply", {"operation_id": str(uuid.uuid4())}),
                                   ("post", prefix + "/reconnect", {"operation_id": str(uuid.uuid4()), "name": SERVER}),
                                   ("get", prefix + "/operations/" + evidence["operations"][0]["operation_id"], None)):
            response = getattr(unauth, method)(path, **({"data": data} if data is not None else {}))
            assert response.status in (401, 403), f"MCP operation surface bypassed authentication ({response.status})"
            denied.append({"method": method, "path": path, "status": response.status})
        evidence["unauthenticated_requests"] = denied
    finally:
        unauth.dispose()
    scenario("A1-251-auth-negative", "Known conversation/operation and valid bodies refused on apply, reconnect and read-only operation inspection without Studio auth")

    # Last: a command lost before reaching native has no operation receipt. It
    # must remain unknown and require inspection, never automatic replay/restart.
    report["active_scenario"] = "A8-251-unknown-not-replayed"
    target = base + prefix + "/apply"
    def never_delivered(route):
        route.abort("connectionreset")
    page.route(target, never_delivered)
    starts_before = len(fixture_processes(events))
    try:
        panel.get_by_role("button", name = ACTIONS["apply"], exact = True).click()
        expect(panel).to_contain_text("MCP operation unconfirmed", timeout = 60000)
    finally:
        page.unroute(target, never_delivered)
    operation = posts[-1]["operation_id"]
    assert_correlation_storage(page.evaluate(CORRELATION_STORES), conversation_id, operation, "apply")
    assert inspect(operation)["operation"] is None, "Undelivered command should be unknown natively"
    post_count = len(posts)
    for _ in range(2):
        reconcile = panel.get_by_role("button", name = "Reconcile MCP operation", exact = True)
        expect(reconcile).to_be_enabled(timeout = 60000)
        reconcile.focus()
        expect(reconcile).to_be_focused()
        with page.expect_response(lambda response: urlparse(response.url).path == prefix + "/operations/" + operation,
                                  timeout = 60000) as waiting:
            reconcile.press("Enter")
        assert waiting.value.ok and waiting.value.json()["operation"] is None
        expect(configuration).to_have_attribute("aria-busy", "false", timeout = 60000)
        for name in ACTIONS.values():
            expect(panel.get_by_role("button", name = name, exact = True)).to_be_disabled()
        retained()
    assert len(posts) == post_count and len(fixture_processes(events)) == starts_before
    snapshot("desktop-251-unknown-operation")
    evidence["transport_faults"].append({"kind": "apply", "operation_id": operation,
                                         "fault": "browser POST aborted before native delivery",
                                         "native_operation": None, "explicit_reconciliation_gets": 2, "replayed": False})
    scenario("A8-251-unknown-not-replayed", "Undelivered browser POST has actual native null operation; repeated keyboard read-only reconciliation leaves actions blocked and draft/revisions intact, with no connection replacement, replay or hidden restart")
    assert_connected(inventory())
    deliberate_reopens = [request for request in all_requests if request["method"] == "POST" and request["path"].endswith("/open")]
    assert deliberate_reopens == [{"method": "POST", "path": f"/api/coding/conversations/{conversation_id}/open"}], "Unexpected hidden session reopen"
    assert not any(request["method"] == "POST" and (request["path"].endswith(("/stop", "/cancel", "/plugins/reload"))
                   or request["path"] == "/api/coding/conversations") for request in all_requests), "MCP Settings forced stop/create/reload"
    evidence["mutation_requests"] = posts
    evidence["reconciliation_gets"] = gets
    evidence["fixture_events"] = read_events(events)
    evidence["connection_processes_before_shutdown"] = fixture_processes(events)
    evidence["request_log"] = all_requests
    report.pop("active_scenario", None)
    conversation_tab.click()
    expect(page.get_by_test_id("coding-conversation-id")).to_have_text(conversation_id)
