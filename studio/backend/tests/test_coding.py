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
    ("GET", "/conversations", None),
    ("POST", "/conversations", {"cwd": "/"}),
    ("POST", "/conversations/known-id/open", None),
    ("GET", "/conversations/known-id/events", None),
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
