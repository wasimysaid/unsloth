# SPDX-License-Identifier: AGPL-3.0-only
"""Lossless Studio transfer boundaries. No native execution or hosted model calls."""
from __future__ import annotations

import asyncio
import json
import struct
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from fastapi import FastAPI
from auth import storage
from auth.authentication import create_access_token
from core.coding_runtime import CodingRuntime, ViewQueue
from routes.coding import router


@pytest.fixture
def coding_app(monkeypatch, tmp_path):
    monkeypatch.setattr(storage, "DB_PATH", tmp_path / "auth" / "auth.db")
    storage.create_initial_user("unsloth", "isolated-test-password", "isolated-signing-secret-234-long-enough")
    app = FastAPI()
    app.include_router(router, prefix = "/api/coding")
    return app, {"Authorization": "Bearer " + create_access_token("unsloth"), "X-Mimir-Runtime-Generation": "1"}


@pytest.mark.asyncio
async def test_unsubscribe_drains_payloads_held_by_the_response_before_forgetting_accounting():
    runtime = CodingRuntime()
    queue = ViewQueue()
    queue.offer({"event": {"type": "fragment", "data": "漢🙂" * 10000}}, 70000)
    runtime._subscriptions["retained"] = queue
    runtime.command = AsyncMock(return_value = {})
    await runtime.unsubscribe("retained")
    assert queue.bytes == 0
    assert queue.empty()
    assert not runtime._subscriptions
    runtime.command.assert_awaited_once_with("close_view", {"subscription": "retained"})


@pytest.mark.asyncio
async def test_public_entry_forwards_exact_cut_and_generation(coding_app):
    app, headers = coding_app
    cut = {"journal": {"child": "agent-exact"}, "leaf": "entry-9"}
    result = {"conversation_id": "saved", "cut": cut, "entry_id": "entry-4", "offset": 0,
              "total_bytes": 7, "data": "漢🙂", "next_offset": None}
    command = AsyncMock(return_value = result)
    app.state.coding_runtime = SimpleNamespace(command = command)
    async with httpx.AsyncClient(transport = httpx.ASGITransport(app = app), base_url = "http://test", headers = headers) as client:
        response = await client.post("/api/coding/conversations/saved/public-entry", json = {
            "cut": cut, "entry_id": "entry-4", "offset": 0, "max_bytes": 1024,
        })
    assert response.status_code == 200
    assert response.json() == result
    command.assert_awaited_once_with("read_public_entry", {
        "conversation_id": "saved", "cut": cut, "entry_id": "entry-4", "offset": 0, "max_bytes": 1024,
    }, expected_generation = 1)


@pytest.mark.asyncio
async def test_public_entry_auth_and_strict_validation_precede_runtime_start(coding_app):
    app, headers = coding_app
    body = {"cut": {"journal": "root", "leaf": "saved"}, "entry_id": "saved", "offset": 0}
    async with httpx.AsyncClient(transport = httpx.ASGITransport(app = app), base_url = "http://test") as client:
        response = await client.post("/api/coding/conversations/saved/public-entry", json = body)
        assert response.status_code in (401, 403)
        for patch in [{"offset": -1}, {"offset": True}, {"offset": 1.5}, {"offset": 9007199254740992},
                      {"entry_id": ""}, {"max_bytes": 1023}, {"max_bytes": 262145}, {"max_bytes": True},
                      {"path": "/not-an-entry"}, {"cut": {"journal": "root", "leaf": "saved", "extra": 1}}]:
            response = await client.post("/api/coding/conversations/saved/public-entry", headers = headers, json = {**body, **patch})
            assert response.status_code == 422
        response = await client.post("/api/coding/conversations/saved/public-entry", headers = {"Authorization": headers["Authorization"]}, json = body)
        assert response.status_code == 422
    assert not hasattr(app.state, "coding_runtime")


@pytest.mark.asyncio
async def test_public_entry_generation_refusal_preserves_reopen_header(coding_app):
    from core.coding_runtime import CodingRuntimeError
    app, headers = coding_app
    app.state.coding_runtime = SimpleNamespace(command = AsyncMock(side_effect = CodingRuntimeError(
        "runtime_changed", "Deliberately reopen", requires_reopen = True)))
    async with httpx.AsyncClient(transport = httpx.ASGITransport(app = app), base_url = "http://test", headers = headers) as client:
        response = await client.post("/api/coding/conversations/saved/public-entry", json = {
            "cut": {"journal": "root", "leaf": "saved"}, "entry_id": "saved", "offset": 0,
        })
    assert response.status_code == 409
    assert response.headers["X-Mimir-Requires-Reopen"] == "true"


@pytest.mark.asyncio
async def test_four_thousand_deltas_and_cancel_reply_share_reader_without_loss(coding_app, monkeypatch):
    app, headers = coding_app
    source = asyncio.StreamReader()
    writes = []
    frames = [{"subscription": "burst", "position": n + 2, "event": {
        "type": "text_delta", "row": {"id": "text", "entry_id": None, "request_id": "r", "kind": "assistant"},
        "offset": n * 7, "delta": "漢🙂",
    }} for n in range(4000)]
    fragments = [{"subscription": "burst", "position": 4002, "event": {
        "type": "fragment", "part": part, "last": part == 1, "data": data,
    }} for part, data in enumerate(['{"type":"activity",', '"rows":[]}'])]
    terminal = {"subscription": "burst", "event": {"type": "closed"}}
    def feed(value):
        data = json.dumps(value, ensure_ascii = False).encode()
        source.feed_data(struct.pack(">I", len(data)) + data)
    class Writer:
        def write(self, data):
            value = json.loads(data[4:])
            writes.append(value)
            if value["method"] == "view":
                feed({"id": value["id"], "result": {"subscription": "burst", "position": 1, "event": {"type": "start"}}})
                for frame in frames + fragments:
                    feed(frame)
            else:
                feed({"id": value["id"], "result": {"cancel_requested": True}})
        async def drain(self):
            pass
    runtime = CodingRuntime()
    runtime._generation = 1
    runtime.process = SimpleNamespace(stdin = Writer(), stdout = source, returncode = 0)
    runtime._reader = asyncio.create_task(runtime._read_responses())
    app.state.coding_runtime = runtime
    try:
        subscription, queue = await asyncio.wait_for(runtime.subscribe("saved", expected_generation = 1), 5)
        cancel = await asyncio.wait_for(runtime.command("cancel", {"conversation_id": "saved", "request_id": "r"}, expected_generation = 1), 5)
        assert cancel == {"cancel_requested": True}
        assert queue.qsize() == 4003
        assert [queue.get_nowait() for _ in range(queue.qsize())] == [
            {"subscription": "burst", "position": 1, "event": {"type": "start"}}, *frames, *fragments,
        ]
        assert queue.bytes == 0
        for frame in fragments + [terminal]:
            queue.offer(frame, len(json.dumps(frame).encode()))
        monkeypatch.setattr(runtime, "subscribe", AsyncMock(return_value = (subscription, queue)))
        async with httpx.AsyncClient(transport = httpx.ASGITransport(app = app), base_url = "http://test", headers = headers) as client:
            response = await client.get("/api/coding/conversations/saved/events")
        values = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]
        assert values == [{**frame, "observation_epoch": runtime.observation_epoch} for frame in fragments + [terminal]]
        assert queue.bytes == 0 and queue.empty()
        assert [value["method"] for value in writes] == ["view", "cancel", "close_view"]
    finally:
        runtime._reader.cancel()
        await asyncio.gather(runtime._reader, return_exceptions = True)
