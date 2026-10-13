# SPDX-License-Identifier: AGPL-3.0-only
"""Opening-slice access and transport tests. Native/browser tests cover real owners."""
from __future__ import annotations

import asyncio
import json
import struct
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from auth import storage
from auth.authentication import create_access_token
from core.coding_runtime import CodingRuntime, CodingRuntimeError, MAX_FRAME
from routes.coding import router


@pytest.fixture
def coding_app(monkeypatch, tmp_path):
    monkeypatch.setattr(storage, "DB_PATH", tmp_path / "auth" / "auth.db")
    storage.create_initial_user("unsloth", "isolated-test-password", "isolated-signing-secret-234-long-enough")
    app = FastAPI()
    app.include_router(router, prefix = "/api/coding")
    return app, {"Authorization": "Bearer " + create_access_token("unsloth")}


@pytest.mark.asyncio
@pytest.mark.parametrize("method,path,body", [
    ("GET", "/projects/browse", None),
    ("GET", "/catalog?cwd=/", None),
    ("GET", "/diagnostics", None),
    ("GET", "/conversations/known-id/extensions", None),
    ("POST", "/conversations/known-id/plugins/reload", {"operation_id": "exact-operation"}),
    ("GET", "/conversations", None),
    ("POST", "/conversations", {"cwd": "/"}),
    ("POST", "/conversations/known-id/open", None),
    ("GET", "/conversations/known-id/events", None),
    ("GET", "/conversations/known-id/mcp/inventory", None),
    ("POST", "/conversations/known-id/mcp/edit", {"source": "native-source", "name": "server"}),
    ("POST", "/conversations/known-id/mcp/save", {"edit_id": "edit-1", "revision": "r1", "json": "{}"}),
    ("POST", "/conversations/known-id/mcp/release", {"edit_id": "edit-1"}),
    ("GET", "/conversations/known-id/overlap", None),
    ("POST", "/conversations/known-id/prompts", {"submission_key": "exact-key", "text": "work"}),
    ("POST", "/conversations/known-id/configuration", {"provider": "native-provider", "model": "native-model"}),
    ("POST", "/conversations/known-id/requests/exact-request/cancel", None),
    ("POST", "/conversations/known-id/entries", {"cut": {"journal": "root", "leaf": None}}),
    ("GET", "/conversations/known-id/commands", None),
    ("POST", "/conversations/known-id/commands", {"operation_id": "command-op", "name": "compress", "tail": ""}),
    ("GET", "/conversations/known-id/commands/command-op", None),
    ("GET", "/conversations/known-id/diagnostics/context", None),
    ("GET", "/conversations/known-id/diagnostics/tokens", None),
    ("GET", "/conversations/known-id/diagnostics/retry", None),
    ("GET", "/conversations/known-id/diagnostics/execution", None),
    ("GET", "/conversations/known-id/children/agent-exact/attempts/1", None),
])
async def test_every_surface_requires_existing_studio_auth(coding_app, method, path, body):
    app, _ = coding_app
    async with httpx.AsyncClient(transport = httpx.ASGITransport(app = app), base_url = "http://test") as client:
        for headers in ({}, {"Authorization": "Bearer invalid"}):
            response = await client.request(method, "/api/coding" + path, json = body, headers = headers)
            assert response.status_code in (401, 403)
    assert not hasattr(app.state, "coding_runtime"), "authentication must precede native process startup"


@pytest.mark.asyncio
async def test_browse_is_canonical_bounded_os_discovery(coding_app, tmp_path):
    app, headers = coding_app
    project = tmp_path / "project"
    project.mkdir()
    (project / "src").mkdir()
    (project / "file.txt").write_text("not a folder")
    alias = tmp_path / "alias"
    alias.symlink_to(project, target_is_directory = True)
    denied = tmp_path / "denied"
    denied.mkdir(mode = 0)
    async with httpx.AsyncClient(transport = httpx.ASGITransport(app = app), base_url = "http://test", headers = headers) as client:
        good = await client.get("/api/coding/projects/browse", params = {"path": str(alias)})
        assert good.status_code == 200
        assert good.json()["path"] == str(project.resolve())
        assert [row["name"] for row in good.json()["entries"]] == ["src"]
        for path, status in ((project / "absent", 404), (project / "file.txt", 400), (denied, 403)):
            response = await client.get("/api/coding/projects/browse", params = {"path": str(path)})
            assert response.status_code == status
            assert response.json()["detail"]
    denied.chmod(0o700)
    assert not hasattr(app.state, "coding_runtime"), "browsing does not grant native trust"


@pytest.mark.asyncio
async def test_browse_symlink_loop_is_an_actionable_invalid_directory(coding_app, tmp_path):
    app, headers = coding_app
    loop = tmp_path / "loop"
    loop.symlink_to(loop, target_is_directory = True)
    async with httpx.AsyncClient(transport = httpx.ASGITransport(app = app), base_url = "http://test", headers = headers) as client:
        response = await client.get("/api/coding/projects/browse", params = {"path": str(loop)})
    assert response.status_code == 400
    assert "path" in response.json()["detail"]
    assert not hasattr(app.state, "coding_runtime")


@pytest.mark.asyncio
async def test_idle_cleanup_failure_is_not_reported_as_successful_reopen(coding_app):
    app, headers = coding_app
    message = "Idle cleanup failed. Resources may still be owned; inspect native diagnostics before retrying."
    class FailedCleanupRuntime:
        async def command(self, method, params):
            assert method == "open"
            assert params == {"conversation_id": "saved-id"}
            raise CodingRuntimeError("failed", message)
    app.state.coding_runtime = FailedCleanupRuntime()
    async with httpx.AsyncClient(transport = httpx.ASGITransport(app = app), base_url = "http://test", headers = headers) as client:
        response = await client.post("/api/coding/conversations/saved-id/open")
    assert response.status_code == 502
    assert response.json() == {"detail": message}


@pytest.mark.asyncio
async def test_open_never_accepts_a_replacement_working_directory(coding_app):
    app, headers = coding_app
    class RecordingRuntime:
        async def command(self, method, params):
            assert method == "open"
            assert params == {"conversation_id": "saved-id"}
            raise CodingRuntimeError("busy", "Conversation is in use by another process; close that owner first.")
    app.state.coding_runtime = RecordingRuntime()
    async with httpx.AsyncClient(transport = httpx.ASGITransport(app = app), base_url = "http://test", headers = headers) as client:
        response = await client.post("/api/coding/conversations/saved-id/open", json = {"cwd": "/replacement"})
        assert response.status_code == 409
        assert "another process" in response.json()["detail"]
        bad = await client.post("/api/coding/conversations", json = {"cwd": "/", "trust": False})
        assert bad.status_code == 422


@pytest.mark.asyncio
async def test_stream_id_does_not_implicitly_open_or_grant_trust(coding_app):
    app, headers = coding_app
    class RecordingRuntime:
        async def subscribe(self, conversation_id):
            assert conversation_id == "not-open"
            raise CodingRuntimeError("not_found", "Deliberately reopen this conversation first.")
    app.state.coding_runtime = RecordingRuntime()
    async with httpx.AsyncClient(transport = httpx.ASGITransport(app = app), base_url = "http://test", headers = headers) as client:
        response = await client.get("/api/coding/conversations/not-open/events")
        assert response.status_code == 404


@pytest.mark.asyncio
async def test_run_stop_and_history_preserve_exact_native_identities(coding_app):
    app, headers = coding_app
    calls = []
    class RecordingRuntime:
        async def command(self, method, params):
            calls.append((method, params))
            if method == "prompt":
                return {"request_id": "native-request", "submission_key": params["submission_key"]}
            if method == "cancel":
                return {"conversation_id": params["conversation_id"], "request_id": params["request_id"], "cancel_requested": True}
            return {"cut": params["cut"], "entries": [], "older": False, "newer": False}
    app.state.coding_runtime = RecordingRuntime()
    async with httpx.AsyncClient(transport = httpx.ASGITransport(app = app), base_url = "http://test", headers = headers) as client:
        response = await client.post("/api/coding/conversations/exact-conversation/prompts", json = {"submission_key": "same-key", "text": "Please work"})
        assert response.status_code == 202
        assert response.json()["request_id"] == "native-request"
        response = await client.post("/api/coding/conversations/exact-conversation/requests/native-request/cancel")
        assert response.status_code == 200
        assert response.json() == {"conversation_id": "exact-conversation", "request_id": "native-request", "cancel_requested": True}, "cancel acceptance must not fabricate terminal settlement"
        cut = {"journal": "root", "leaf": "captured-leaf"}
        response = await client.post("/api/coding/conversations/exact-conversation/entries", json = {"cut": cut})
        assert response.status_code == 200
        assert response.json()["cut"] == cut
        invalid = await client.post("/api/coding/conversations/exact-conversation/prompts", json = {"submission_key": "same-key", "text": "work", "api_key": "must-not-pass"})
        assert invalid.status_code == 422
    assert calls == [
        ("prompt", {"conversation_id": "exact-conversation", "submission_key": "same-key", "text": "Please work", "overlap_confirmed": False}),
        ("cancel", {"conversation_id": "exact-conversation", "request_id": "native-request"}),
        ("read_entries", {"conversation_id": "exact-conversation", "cut": cut, "anchor": "latest", "max_entries": 100, "max_bytes": 262144}),
    ]


@pytest.mark.asyncio
async def test_child_inspection_forwards_exact_attempt_and_native_cut_without_controls(coding_app):
    app, headers = coding_app
    calls = []
    outcome = {"handle": "agent-exact", "attempt": 1, "status": "completed", "result": "earlier result", "error": None}
    class RecordingRuntime:
        async def command(self, method, params):
            calls.append((method, params))
            if method == "child_detail":
                if params["attempt"] == 3:
                    raise CodingRuntimeError("not_found", "Attempt was not found.")
                # Native children is on attempt 2; don't invent an old child/cut.
                return {"child": None, "outcome": outcome}
            return {"cut": params["cut"], "rows": [], "older": False, "newer": False}
    app.state.coding_runtime = RecordingRuntime()
    prefix = "/api/coding/conversations/exact-conversation"
    cut = {"journal": {"child": "agent-exact"}, "leaf": "captured-child-leaf"}
    async with httpx.AsyncClient(transport = httpx.ASGITransport(app = app), base_url = "http://test", headers = headers) as client:
        response = await client.get(prefix + "/children/agent-exact/attempts/1")
        assert response.status_code == 200
        assert response.json() == {"child": None, "outcome": outcome}
        response = await client.post(prefix + "/entries", json = {"cut": cut})
        assert response.status_code == 200
        assert response.json()["cut"] == cut
        response = await client.get(prefix + "/children/agent-exact/attempts/3")
        assert response.status_code == 404
        for attempt in ["0", "-1", "4294967296", "not-an-attempt"]:
            response = await client.get(prefix + "/children/agent-exact/attempts/" + attempt)
            assert response.status_code == 422
        for journal in ["child", {"child": ""}, {"child": "agent-exact", "private": True}, {"child": "x" * 129}]:
            response = await client.post(prefix + "/entries", json = {"cut": {"journal": journal, "leaf": None}})
            assert response.status_code == 422
        for action in ["launch", "continue", "steer", "stop"]:
            response = await client.post(prefix + "/children/agent-exact/attempts/1/" + action)
            assert response.status_code == 404
    assert calls == [
        ("child_detail", {"conversation_id": "exact-conversation", "handle": "agent-exact", "attempt": 1}),
        ("read_entries", {"conversation_id": "exact-conversation", "cut": cut, "anchor": "latest", "max_entries": 100, "max_bytes": 262144}),
        ("child_detail", {"conversation_id": "exact-conversation", "handle": "agent-exact", "attempt": 3}),
    ]


@pytest.mark.asyncio
async def test_private_framing_rejects_oversized_output_and_settles_pending():
    stream = asyncio.StreamReader()
    stream.feed_data(struct.pack(">I", MAX_FRAME + 1))
    runtime = CodingRuntime()
    runtime.process = SimpleNamespace(stdout = stream, returncode = 0)
    future = asyncio.get_running_loop().create_future()
    runtime._pending[1] = future
    await runtime._read_responses()
    with pytest.raises(CodingRuntimeError, match = "disconnected"):
        await future
    with pytest.raises(CodingRuntimeError, match = "disconnected"):
        await runtime.start()


@pytest.mark.asyncio
@pytest.mark.parametrize("error", [None, {}, {"code": "invalid"}, {"code": [], "message": "bad"}, {"code": "invalid", "message": []}])
async def test_malformed_error_frame_settles_matching_pending_command(error):
    stream = asyncio.StreamReader()
    runtime = CodingRuntime()
    runtime.process = SimpleNamespace(stdout = stream, returncode = 0)
    future = asyncio.get_running_loop().create_future()
    runtime._pending[1] = future
    data = json.dumps({"id": 1, "error": error}).encode()
    stream.feed_data(struct.pack(">I", len(data)) + data)
    stream.feed_eof()
    await runtime._read_responses()
    with pytest.raises(CodingRuntimeError, match = "disconnected"):
        await asyncio.wait_for(future, timeout = 0.1)
    assert not runtime._pending


@pytest.mark.asyncio
async def test_private_framing_matches_ids_not_arrival_order():
    stream = asyncio.StreamReader()
    runtime = CodingRuntime()
    runtime.process = SimpleNamespace(stdout = stream, returncode = 0)
    futures = [asyncio.get_running_loop().create_future() for _ in range(2)]
    runtime._pending = {1: futures[0], 2: futures[1]}
    for identifier in (2, 1):
        data = json.dumps({"id": identifier, "result": {"conversation_id": str(identifier)}}).encode()
        stream.feed_data(struct.pack(">I", len(data)) + data)
    stream.feed_eof()
    await runtime._read_responses()
    assert [await future for future in futures] == [{"conversation_id": "1"}, {"conversation_id": "2"}]


@pytest.mark.asyncio
async def test_view_start_in_same_pipe_read_is_not_lost():
    stream = asyncio.StreamReader()
    runtime = CodingRuntime()
    runtime.process = SimpleNamespace(stdout = stream, returncode = 0)
    future = asyncio.get_running_loop().create_future()
    runtime._pending[1] = future
    start = {"subscription": "view-1", "position": 7, "event": {"type": "start", "recovering": False}}
    for payload in ({"id": 1, "result": {"subscription": "view-1"}}, start):
        data = json.dumps(payload).encode()
        stream.feed_data(struct.pack(">I", len(data)) + data)
    reader = asyncio.create_task(runtime._read_responses())
    assert await future == {"subscription": "view-1"}
    assert await runtime._subscriptions["view-1"].get() == start
    stream.feed_eof()
    await reader


@pytest.mark.asyncio
async def test_slow_view_gets_explicit_reconstruction_error_not_partial_suffix():
    stream = asyncio.StreamReader()
    runtime = CodingRuntime()
    runtime.process = SimpleNamespace(stdout = stream, returncode = 0)
    queue = asyncio.Queue(maxsize = 2)
    runtime._subscriptions["view-1"] = queue
    barrier = asyncio.get_running_loop().create_future()
    runtime._pending[1] = barrier
    for position in range(4):
        data = json.dumps({"subscription": "view-1", "position": position, "event": {"type": "state"}}).encode()
        stream.feed_data(struct.pack(">I", len(data)) + data)
    data = json.dumps({"id": 1, "result": {}}).encode()
    stream.feed_data(struct.pack(">I", len(data)) + data)
    reader = asyncio.create_task(runtime._read_responses())
    await barrier
    failure = await queue.get()
    assert isinstance(failure, CodingRuntimeError)
    assert "Reconnect" in failure.message
    assert queue.empty()
    stream.feed_eof()
    await reader


@pytest.mark.asyncio
async def test_disconnect_during_view_admission_releases_view_not_owner():
    admitted = asyncio.Event()
    reply = asyncio.Event()
    calls = []
    class AdmittedRuntime(CodingRuntime):
        async def command(self, method, params = None):
            calls.append((method, params))
            if method == "view":
                admitted.set()
                await reply.wait()
                self._subscriptions["view-race"] = asyncio.Queue(maxsize = 128)
                return {"subscription": "view-race"}
            assert method == "close_view", "browser cancellation must never close the owner"
            return {"closed": True}
    runtime = AdmittedRuntime()
    task = asyncio.create_task(runtime.subscribe("native-id"))
    await admitted.wait()
    task.cancel()
    reply.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert calls == [("view", {"conversation_id": "native-id"}), ("close_view", {"subscription": "view-race"})]
    assert not runtime._subscriptions


@pytest.mark.asyncio
async def test_disconnect_before_response_body_starts_closes_native_view():
    from routes.coding import NativeViewResponse
    closed = []
    started = False
    class ViewRuntime:
        async def unsubscribe(self, subscription):
            closed.append(subscription)
    async def body():
        nonlocal started
        started = True
        yield "unexpected"
    async def receive():
        return {"type": "http.disconnect"}
    async def send(message):
        # Headers are sent before iteration; an immediate disconnect must still
        # release the already-admitted view while this send is suspended.
        if message["type"] == "http.response.start":
            await asyncio.Event().wait()
    response = NativeViewResponse(body(), ViewRuntime(), "view-before-body")
    await response({"type": "http", "asgi": {"spec_version": "2.3"}}, receive, send)
    assert not started
    assert closed == ["view-before-body"]


@pytest.mark.asyncio
async def test_late_view_reply_reconciles_expired_admission(monkeypatch):
    import core.coding_runtime as module
    monkeypatch.setattr(module, "COMMAND_TIMEOUT", 0.01)
    stream = asyncio.StreamReader()
    closed = asyncio.Event()
    commands = []
    class Writer:
        def write(self, data):
            commands.append(json.loads(data[4:]))
        async def drain(self):
            pass
    class LateRuntime(CodingRuntime):
        async def unsubscribe(self, subscription):
            commands.append({"method": "close_view", "params": {"subscription": subscription}})
            closed.set()
    runtime = LateRuntime()
    runtime.process = SimpleNamespace(stdout = stream, stdin = Writer(), returncode = 0)
    with pytest.raises(CodingRuntimeError, match = "not confirmed"):
        await runtime.command("view", {"conversation_id": "saved"})
    assert runtime._abandoned_views == {1}
    payload = {"id": 1, "result": {"subscription": "late-view", "event": {"type": "start"}, "position": 1}}
    data = json.dumps(payload).encode()
    stream.feed_data(struct.pack(">I", len(data)) + data)
    reader = asyncio.create_task(runtime._read_responses())
    await asyncio.wait_for(closed.wait(), timeout = 2)
    assert commands == [{"id": 1, "method": "view", "params": {"conversation_id": "saved"}},
                        {"method": "close_view", "params": {"subscription": "late-view"}}]
    assert not runtime._abandoned_views
    stream.feed_eof()
    await reader
    if runtime._cleanup_tasks:
        await asyncio.gather(*tuple(runtime._cleanup_tasks))


@pytest.mark.asyncio
async def test_fatal_framing_closes_stdin_and_reaps_actual_child(tmp_path):
    import sys
    reaped = tmp_path / "eof-observed"
    code = "import sys,struct,pathlib; sys.stdout.buffer.write(struct.pack('>I',1048577)); sys.stdout.buffer.flush(); sys.stdin.buffer.read(); pathlib.Path(sys.argv[1]).write_text('EOF')"
    process = await asyncio.create_subprocess_exec(sys.executable, "-c", code, str(reaped),
        stdin = asyncio.subprocess.PIPE, stdout = asyncio.subprocess.PIPE, stderr = asyncio.subprocess.PIPE)
    runtime = CodingRuntime()
    runtime.process = process
    runtime._reader = asyncio.create_task(runtime._read_responses())
    runtime._stderr = asyncio.create_task(runtime._drain_stderr())
    await asyncio.wait_for(runtime._reader, timeout = 5)
    assert runtime._shutdown_task is not None
    await asyncio.wait_for(runtime._shutdown_task, timeout = 5)
    assert process.returncode == 0
    assert reaped.read_text() == "EOF"


@pytest.mark.asyncio
async def test_mcp_forwards_only_native_scoped_operations_and_actual_results(coding_app):
    app, headers = coding_app
    commands = []
    native_inventory = {"documents": [], "entries": [], "effective": [], "live": [], "diagnostics": []}
    draft = {"edit_id": "host-edit", "revision": "actual-r1", "source": "native-source", "name": "server", "json": "{}"}
    saved = {"draft": {**draft, "revision": "actual-r2"}, "inventory": native_inventory}
    class RecordingRuntime:
        async def command(self, method, params):
            commands.append((method, params))
            return {"mcp_inventory": native_inventory, "mcp_edit": draft, "mcp_save": saved}[method]
    app.state.coding_runtime = RecordingRuntime()
    async with httpx.AsyncClient(transport = httpx.ASGITransport(app = app), base_url = "http://test", headers = headers) as client:
        prefix = "/api/coding/conversations/native-session/mcp"
        inventory = await client.get(prefix + "/inventory")
        editor = await client.post(prefix + "/edit", json = {"source": "native-source", "name": "server"})
        result = await client.post(prefix + "/save", json = {"edit_id": "host-edit", "revision": "actual-r1", "json": "{}"})
        assert inventory.json() == native_inventory
        assert editor.json() == draft
        assert result.json() == saved
        assert all(response.headers["cache-control"] == "no-store" for response in (inventory, editor, result))
    assert commands == [
        ("mcp_inventory", {"conversation_id": "native-session"}),
        ("mcp_edit", {"conversation_id": "native-session", "source": "native-source", "name": "server"}),
        ("mcp_save", {"conversation_id": "native-session", "edit_id": "host-edit", "revision": "actual-r1", "json": "{}"}),
    ]


@pytest.mark.asyncio
async def test_model_configuration_is_native_and_never_part_of_queued_prompt(coding_app):
    app, headers = coding_app
    calls = []
    class RecordingRuntime:
        async def command(self, method, params):
            calls.append((method, params))
            if method == "configure":
                if params["configuration"].get("model") == "unavailable":
                    raise CodingRuntimeError("invalid", "Native model is unavailable; selection was not changed.")
                return {"provider": "native-id", "model": "local-id", "reasoning": "medium", "mode": "build"}
            return {"conversation_id": params["conversation_id"], "request_id": "queued", "submission_key": params["submission_key"]}
    app.state.coding_runtime = RecordingRuntime()
    async with httpx.AsyncClient(transport = httpx.ASGITransport(app = app), base_url = "http://test", headers = headers) as client:
        selected = await client.post("/api/coding/conversations/exact-id/configuration", json = {"provider": "native-id", "model": "local-id"})
        assert selected.status_code == 200
        assert selected.json()["reasoning"] == "medium", "the host returns Mimir's model-switch default"
        effort = await client.post("/api/coding/conversations/exact-id/configuration", json = {"reasoning": "high"})
        assert effort.status_code == 200
        bad = await client.post("/api/coding/conversations/exact-id/configuration", json = {"provider": "native-id", "model": "unavailable"})
        assert bad.status_code == 400
        assert "not changed" in bad.json()["detail"]
        for extra in ({"api_key": "forbidden"}, {"api_model": "not-an-identity"}, {"mode": "plan"}, {"fast": True}):
            response = await client.post("/api/coding/conversations/exact-id/configuration", json = extra)
            assert response.status_code == 422
        queued = await client.post("/api/coding/conversations/exact-id/prompts", json = {"submission_key": "same", "text": "Queued work"})
        assert queued.status_code == 202
        response = await client.post("/api/coding/conversations/exact-id/prompts", json = {"submission_key": "different", "text": "Work", "model": "local-id"})
        assert response.status_code == 422
    assert calls == [
        ("configure", {"conversation_id": "exact-id", "configuration": {"provider": "native-id", "model": "local-id"}}),
        ("configure", {"conversation_id": "exact-id", "configuration": {"reasoning": "high"}}),
        ("configure", {"conversation_id": "exact-id", "configuration": {"provider": "native-id", "model": "unavailable"}}),
        ("prompt", {"conversation_id": "exact-id", "submission_key": "same", "text": "Queued work", "overlap_confirmed": False}),
    ]


@pytest.mark.asyncio
async def test_extension_maintenance_forwards_only_target_and_operation(coding_app):
    app, headers = coding_app
    calls = []
    class RecordingRuntime:
        async def command(self, method, params):
            calls.append((method, params))
            if method == "extensions.inspect":
                return {"conversation_id": params["conversation_id"], "plugins": [], "skills": [], "reload": None}
            return {"operation_id": params["operation_id"], "status": "deferred"}
    app.state.coding_runtime = RecordingRuntime()
    async with httpx.AsyncClient(transport = httpx.ASGITransport(app = app), base_url = "http://test", headers = headers) as client:
        inspected = await client.get("/api/coding/conversations/exact-target/extensions")
        assert inspected.status_code == 200
        assert inspected.json()["conversation_id"] == "exact-target"
        reconciled = await client.get("/api/coding/conversations/exact-target/extensions", params = {"operation_id": "exact-operation"})
        assert reconciled.status_code == 200
        reload = await client.post("/api/coding/conversations/exact-target/plugins/reload", json = {"operation_id": "exact-operation"})
        assert reload.status_code == 200
        assert reload.json()["status"] == "deferred", "HTTP acceptance must not claim native completion"
        for body in ({"operation_id": "exact-operation", "all_sessions": True}, {"operation_id": "exact-operation", "api_key": "secret"}, {"operation_id": "contains spaces"}):
            assert (await client.post("/api/coding/conversations/exact-target/plugins/reload", json = body)).status_code == 422
    assert calls == [("extensions.inspect", {"conversation_id": "exact-target"}),
                     ("extensions.inspect", {"conversation_id": "exact-target", "operation_id": "exact-operation"}),
                     ("plugins.reload", {"conversation_id": "exact-target", "operation_id": "exact-operation"})]


@pytest.mark.asyncio
async def test_plugin_reload_uncertain_is_not_replayed(coding_app):
    app, headers = coding_app
    calls = []
    class RecordingRuntime:
        async def command(self, method, params):
            calls.append((method, params))
            raise CodingRuntimeError("uncertain", "Native outcome is uncertain; inspect before retrying.")
    app.state.coding_runtime = RecordingRuntime()
    async with httpx.AsyncClient(transport = httpx.ASGITransport(app = app), base_url = "http://test", headers = headers) as client:
        response = await client.post("/api/coding/conversations/exact-target/plugins/reload", json = {"operation_id": "lost-response"})
    assert response.status_code == 504
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_diagnostics_are_bounded_allowlisted_and_do_not_launch(coding_app):
    app, headers = coding_app
    runtime = CodingRuntime(executable = "/private/api-key-secret/executable")
    runtime.package = "/private/package-secret"
    app.state.coding_runtime = runtime
    async with httpx.AsyncClient(transport = httpx.ASGITransport(app = app), base_url = "http://test", headers = headers) as client:
        response = await client.get("/api/coding/diagnostics")
        assert response.status_code == 200
        assert response.json() == {"connection": "not_started", "frontend_plugin": "studio.frontend", "protocol": 1, "pending_commands": 0, "open_views": 0, "command_timeout_seconds": 60, "max_frame_bytes": 1048576}
        assert runtime.process is None
        runtime._failure = CodingRuntimeError("failed", "raw-provider-credential-secret")
        response = await client.get("/api/coding/diagnostics")
        assert response.json()["connection"] == "disconnected"
        assert "secret" not in response.text
        runtime._closing = True
        assert (await client.get("/api/coding/diagnostics")).json()["connection"] == "closing"


@pytest.mark.asyncio
async def test_overlap_preflight_and_refusal_carry_canonical_identity_without_opening(coding_app):
    app, headers = coding_app
    overlap = {"cwd": "/canonical/project", "conversations": [{"id": "other-native"}]}
    calls = []
    class RecordingRuntime:
        async def command(self, method, params):
            calls.append((method, params))
            if method == "overlap":
                return overlap
            if not params["overlap_confirmed"]:
                raise CodingRuntimeError("overlap_required", "Review overlapping work before submitting.", overlap)
            return {"conversation_id": params["conversation_id"], "submission_key": params["submission_key"], "request_id": "native-request"}
    app.state.coding_runtime = RecordingRuntime()
    async with httpx.AsyncClient(transport = httpx.ASGITransport(app = app), base_url = "http://test", headers = headers) as client:
        check = await client.get("/api/coding/conversations/exact-id/overlap")
        assert check.status_code == 200 and check.json() == overlap
        body = {"submission_key": "original-key", "text": "draft"}
        refused = await client.post("/api/coding/conversations/exact-id/prompts", json = body)
        assert refused.status_code == 409
        assert refused.json()["detail"]["code"] == "overlap_required"
        assert refused.json()["detail"]["overlap"] == overlap
        assert "request_id" not in refused.json()
        for invalid in ("true", 1, None):
            bad = await client.post("/api/coding/conversations/exact-id/prompts", json = {**body, "overlap_confirmed": invalid})
            assert bad.status_code == 422
        accepted = await client.post("/api/coding/conversations/exact-id/prompts", json = {**body, "overlap_confirmed": True})
        assert accepted.status_code == 202
        assert accepted.json()["request_id"] == "native-request"
    assert calls == [
        ("overlap", {"conversation_id": "exact-id"}),
        ("prompt", {"conversation_id": "exact-id", **body, "overlap_confirmed": False}),
        ("prompt", {"conversation_id": "exact-id", **body, "overlap_confirmed": True}),
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("code,status", [("conflict", 409), ("busy", 409), ("invalid", 400), ("denied", 403), ("not_found", 404), ("failed", 502), ("uncertain", 504)])
async def test_mcp_native_refusals_do_not_cancel_apply_reopen_or_retry(coding_app, code, status):
    app, headers = coding_app
    commands = []
    class RefusingRuntime:
        async def command(self, method, params):
            commands.append(method)
            raise CodingRuntimeError(code, "Native configuration refusal; retain draft and reconcile.")
    app.state.coding_runtime = RefusingRuntime()
    async with httpx.AsyncClient(transport = httpx.ASGITransport(app = app), base_url = "http://test", headers = headers) as client:
        response = await client.post("/api/coding/conversations/known/mcp/save", json = {"edit_id": "host-edit", "revision": "r1", "json": "{}"})
        assert response.status_code == status
        assert response.json()["detail"] == "Native configuration refusal; retain draft and reconcile."
        assert response.headers["cache-control"] == "no-store"
    assert commands == ["mcp_save"]


@pytest.mark.asyncio
@pytest.mark.parametrize("body", [
    {"edit_id": "host-edit", "json": "controlled-secret-250"},
    {"edit_id": [], "revision": "r1", "json": "controlled-secret-250"},
    {"edit_id": "host-edit", "revision": "r1", "json": "controlled-secret-250", "path": "/not-a-native-source"},
    {"edit_id": "host-edit", "revision": "r1", "json": "controlled-secret-250" + "x" * 524288},
])
async def test_mcp_request_validation_never_echoes_secret_drafts(coding_app, body):
    app, headers = coding_app
    async with httpx.AsyncClient(transport = httpx.ASGITransport(app = app), base_url = "http://test", headers = headers) as client:
        response = await client.post("/api/coding/conversations/known/mcp/save", json = body)
        assert response.status_code == 422
        assert "controlled-secret-250" not in response.text
        assert "input" not in response.json()
        assert "Invalid MCP Settings request" in response.json()["detail"]
        assert response.headers["cache-control"] == "no-store"
    assert not hasattr(app.state, "coding_runtime")


@pytest.mark.asyncio
async def test_uncertain_mcp_save_is_not_replayed_and_requires_saved_version_comparison(monkeypatch):
    import core.coding_runtime as module
    monkeypatch.setattr(module, "COMMAND_TIMEOUT", 0.01)
    commands = []
    class Writer:
        def write(self, data):
            commands.append(json.loads(data[4:]))
        async def drain(self):
            pass
    runtime = CodingRuntime()
    runtime.process = SimpleNamespace(stdin = Writer(), returncode = 0)
    with pytest.raises(CodingRuntimeError, match = "saved MCP version for comparison") as refused:
        await runtime.command("mcp_save", {"edit_id": "host-edit", "revision": "r1", "json": "{}"})
    assert refused.value.code == "uncertain"
    assert len(commands) == 1
    assert not runtime._pending


@pytest.mark.asyncio
async def test_private_overlap_error_retains_structured_warning_and_settles_exact_command():
    stream = asyncio.StreamReader()
    runtime = CodingRuntime()
    runtime.process = SimpleNamespace(stdout = stream, returncode = 0)
    future = asyncio.get_running_loop().create_future()
    runtime._pending[7] = future
    overlap = {"cwd": "/canonical/project", "conversations": [{"id": "native-owner"}]}
    data = json.dumps({"id": 7, "error": {"code": "overlap_required", "message": "Review overlap", "overlap": overlap}}).encode()
    stream.feed_data(struct.pack(">I", len(data)) + data)
    stream.feed_eof()
    await runtime._read_responses()
    with pytest.raises(CodingRuntimeError) as error:
        await future
    assert error.value.code == "overlap_required"
    assert error.value.overlap == overlap
    assert not runtime._pending


@pytest.mark.asyncio
@pytest.mark.parametrize("overlap", [None, {}, {"cwd": "/project", "conversations": []}, {"cwd": "/project", "conversations": [{"id": None}]}])
async def test_malformed_overlap_refusal_fails_transport_without_orphaning_command(overlap):
    stream = asyncio.StreamReader()
    runtime = CodingRuntime()
    runtime.process = SimpleNamespace(stdout = stream, returncode = 0)
    future = asyncio.get_running_loop().create_future()
    runtime._pending[1] = future
    data = json.dumps({"id": 1, "error": {"code": "overlap_required", "message": "Review", "overlap": overlap}}).encode()
    stream.feed_data(struct.pack(">I", len(data)) + data)
    stream.feed_eof()
    await runtime._read_responses()
    with pytest.raises(CodingRuntimeError, match = "disconnected"):
        await future
    assert not runtime._pending
