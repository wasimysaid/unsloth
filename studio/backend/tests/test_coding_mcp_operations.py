# SPDX-License-Identifier: AGPL-3.0-only
"""Transport/admission checks; native and rendered route drivers verify live owners."""
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


@pytest.fixture
def app_and_headers(monkeypatch, tmp_path):
    monkeypatch.setattr(storage, "DB_PATH", tmp_path / "auth" / "auth.db")
    storage.create_initial_user("unsloth", "isolated-password", "isolated-mcp-signing-secret-long-enough")
    app = FastAPI()
    app.include_router(router, prefix = "/api/coding")
    return app, {"Authorization": "Bearer " + create_access_token("unsloth")}


@pytest.mark.asyncio
async def test_mcp_apply_reconnect_and_exact_inspection_are_distinct_native_commands(app_and_headers):
    app, headers = app_and_headers
    commands = []
    result = {"operation_id": "exact", "session_id": "native", "status": "running"}

    class Runtime:
        async def command(self, method, params):
            commands.append((method, params))
            return result

    app.state.coding_runtime = Runtime()
    async with httpx.AsyncClient(transport = httpx.ASGITransport(app = app), base_url = "http://test", headers = headers) as client:
        prefix = "/api/coding/conversations/native/mcp"
        for endpoint, body in (("apply", {"operation_id": "exact"}),
                               ("reconnect", {"operation_id": "exact", "name": "configured"})):
            response = await client.post(prefix + "/" + endpoint, json = body)
            assert response.status_code == 200
            assert response.json() == result  # Acceptance is not synthesized completion.
            assert response.headers["cache-control"] == "no-store"
        response = await client.get(prefix + "/operations/exact")
        assert response.json() == result
    assert commands == [
        ("mcp_apply", {"conversation_id": "native", "operation_id": "exact"}),
        ("mcp_reconnect", {"conversation_id": "native", "operation_id": "exact", "name": "configured"}),
        ("mcp_inspect_operation", {"conversation_id": "native", "operation_id": "exact"}),
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("endpoint", ["apply", "reconnect"])
@pytest.mark.parametrize("code,status", [("busy", 409), ("conflict", 409), ("invalid", 400), ("denied", 403), ("failed", 502), ("protocol", 502), ("unknown-runtime-failure", 502), ("uncertain", 504)])
async def test_native_refusal_or_lost_reply_cannot_trigger_cancellation_or_retry(app_and_headers, endpoint, code, status):
    app, headers = app_and_headers
    commands = []

    class Runtime:
        async def command(self, method, params):
            commands.append((method, params))
            raise CodingRuntimeError(code, "Native work remains owned; inspect before retry.")

    app.state.coding_runtime = Runtime()
    async with httpx.AsyncClient(transport = httpx.ASGITransport(app = app), base_url = "http://test", headers = headers) as client:
        response = await client.post("/api/coding/conversations/native/mcp/" + endpoint, json = {"operation_id": "exact"})
        assert response.status_code == status
        assert response.headers["cache-control"] == "no-store"
    expected = {"conversation_id": "native", "operation_id": "exact"}
    if endpoint == "reconnect":
        expected["name"] = None
    assert commands == [("mcp_" + endpoint, expected)]


@pytest.mark.asyncio
@pytest.mark.parametrize("endpoint,body", [
    ("apply", {"operation_id": "", "json": "private-definition"}),
    ("apply", {"operation_id": 123}),
    ("reconnect", {"operation_id": "id", "name": "", "headers": "private-definition"}),
    ("reconnect", {"operation_id": "id", "name": 123}),
])
async def test_mcp_operation_validation_does_not_echo_definitions_or_start_runtime(app_and_headers, endpoint, body):
    app, headers = app_and_headers
    async with httpx.AsyncClient(transport = httpx.ASGITransport(app = app), base_url = "http://test", headers = headers) as client:
        response = await client.post("/api/coding/conversations/native/mcp/" + endpoint, json = body)
        assert response.status_code == 422
        assert "private-definition" not in response.text
    assert not hasattr(app.state, "coding_runtime")


@pytest.mark.asyncio
@pytest.mark.parametrize("method", ["mcp_apply", "mcp_reconnect"])
async def test_timed_out_operation_preserves_delivery_and_names_exact_reconciliation(monkeypatch, method):
    import core.coding_runtime as module
    monkeypatch.setattr(module, "COMMAND_TIMEOUT", 0.001)
    runtime = CodingRuntime()
    frames = []

    class Writer:
        def write(self, data):
            frames.append(data)

        async def drain(self):
            pass

    async def started():
        pass

    runtime.start = started
    runtime.process = SimpleNamespace(stdin = Writer(), returncode = 0)
    with pytest.raises(CodingRuntimeError, match = "exact native MCP operation") as error:
        await runtime.command(method, {"conversation_id": "native", "operation_id": "exact"})
    assert error.value.code == "uncertain"
    assert len(frames) == 1
    assert not runtime._pending


@pytest.mark.asyncio
async def test_missing_result_after_delivery_is_502_not_unadmitted_400(app_and_headers):
    app, headers = app_and_headers
    runtime = CodingRuntime()
    stream = asyncio.StreamReader()
    delivered = []

    class Writer:
        def write(self, data):
            command = json.loads(data[4:])
            delivered.append(command)
            malformed = json.dumps({"id": command["id"]}).encode()
            stream.feed_data(struct.pack(">I", len(malformed)) + malformed)

        async def drain(self):
            pass

    async def started():
        pass

    runtime.start = started
    runtime.process = SimpleNamespace(stdin = Writer(), stdout = stream, returncode = 0)
    app.state.coding_runtime = runtime
    reader = asyncio.create_task(runtime._read_responses())
    try:
        async with httpx.AsyncClient(transport = httpx.ASGITransport(app = app), base_url = "http://test", headers = headers) as client:
            response = await client.post("/api/coding/conversations/native/mcp/apply", json = {"operation_id": "exact"})
            assert response.status_code == 502
            assert response.json()["detail"] == "Invalid Mimir response."
        assert len(delivered) == 1
        assert delivered[0]["method"] == "mcp_apply"
        assert not runtime._pending
    finally:
        stream.feed_eof()
        await reader
