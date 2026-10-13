# SPDX-License-Identifier: AGPL-3.0-only
"""Bridge delivery/reconstruction tests; these are not live-native acceptance."""
from __future__ import annotations

import asyncio
import json
import struct
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from auth import storage
from auth.authentication import create_access_token
from core.coding_runtime import CodingRuntime, CodingRuntimeError
from routes.coding import router
from .coding_transport_faults import CodingTransportFaults


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["prompt", "cancel", "change_goal", "answer"])
async def test_uncertain_command_is_not_replayed_and_late_ack_does_not_poison_reconciliation(monkeypatch, operation):
    import core.coding_runtime as module
    monkeypatch.setattr(module, "COMMAND_TIMEOUT", 0.01)
    stream = asyncio.StreamReader()
    commands = []

    class Writer:
        def write(self, data):
            value = json.loads(data[4:])
            commands.append(value)
            if value["method"] == "state":
                # Native late acceptance precedes the requested reconciliation.
                for payload in (
                    {"id": 1, "result": {"request_id": "accepted-original"}},
                    {"id": value["id"], "result": {"active_request": "accepted-original"}},
                ):
                    body = json.dumps(payload).encode()
                    stream.feed_data(struct.pack(">I", len(body)) + body)

        async def drain(self):
            pass

    runtime = CodingRuntime()
    runtime.process = SimpleNamespace(stdout=stream, stdin=Writer(), returncode=0)
    reader = asyncio.create_task(runtime._read_responses())
    with pytest.raises(CodingRuntimeError, match="not confirmed") as failure:
        await runtime.command(operation, {"conversation_id": "saved", "submission_key": "original"})
    assert failure.value.code == "uncertain"
    state = await runtime.command("state", {"conversation_id": "saved"})
    assert state == {"active_request": "accepted-original"}
    assert [command["method"] for command in commands] == [operation, "state"]
    assert not runtime._pending
    stream.feed_eof()
    await reader


@pytest.mark.asyncio
async def test_last_event_id_does_not_turn_new_view_into_arbitrary_replay(monkeypatch, tmp_path):
    monkeypatch.setattr(storage, "DB_PATH", tmp_path / "auth.db")
    storage.create_initial_user("unsloth", "isolated-test-password", "isolated-signing-secret-236-long-enough")
    app = FastAPI()
    app.include_router(router, prefix="/api/coding")
    opened = []
    released = []

    class NativeViews:
        async def subscribe(self, conversation):
            opened.append(conversation)
            queue = asyncio.Queue()
            queue.put_nowait({"subscription": "fresh-view", "position": 100,
                              "event": {"type": "start", "root": {"cut": {"journal": "root", "leaf": "captured"}}}})
            queue.put_nowait({"subscription": "fresh-view", "event": {"type": "closed"}})
            return "fresh-view", queue

        async def unsubscribe(self, subscription):
            released.append(subscription)

    app.state.coding_runtime = NativeViews()
    headers = {"Authorization": "Bearer " + create_access_token("unsloth"), "Last-Event-ID": "arbitrary-obsolete-position"}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/coding/conversations/exact-saved-id/events", headers=headers)
    assert response.status_code == 200
    assert '"type":"start"' in response.text
    assert '"leaf":"captured"' in response.text
    assert opened == ["exact-saved-id"]
    assert released == ["fresh-view"]


@pytest.mark.asyncio
async def test_acceptance_reset_uses_actual_capture_and_monotonic_transport_positions():
    captured = {"subscription": "native", "position": 3, "event": {
        "type": "start", "state": {"info": {"id": "saved", "cwd": "/canonical"}},
        "root": {"cut": {"journal": "root", "leaf": "immutable-native-cut"}}, "recovering": False,
    }}
    checkpoint = {"subscription": "native", "position": 7, "event": {
        "type": "checkpoint", "cut": {"journal": "root", "leaf": "next-native-cut"},
    }}
    messages = []

    async def native_transport(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})
        for item in (captured, checkpoint):
            body = b"event: view\ndata: " + json.dumps(item).encode() + b"\n\n"
            await send({"type": "http.response.body", "body": body, "more_body": True})
        await send({"type": "http.response.body", "body": b"", "more_body": False})

    async def receive():
        return {"type": "http.disconnect"}

    async def send(message):
        messages.append(message)

    faults = {"reset_conversation": "saved"}
    middleware = CodingTransportFaults(native_transport, faults)
    await middleware({"type": "http", "method": "GET", "path": "/api/coding/conversations/saved/events"}, receive, send)
    body = b"".join(message.get("body", b"") for message in messages)
    items = [json.loads(frame.split(b"data: ", 1)[1]) for frame in body.split(b"\n\n") if frame]
    assert [item["position"] for item in items] == [6, 7, 14]
    assert [item["event"]["type"] for item in items] == ["start", "reset", "checkpoint"]
    assert items[1]["event"]["state"] == captured["event"]["state"]
    assert items[1]["event"]["root"] == captured["event"]["root"]
    assert items[1]["event"]["recovering"] is True
    assert faults == {}
