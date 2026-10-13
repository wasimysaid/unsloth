# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
"""Deterministic authenticated input-contract checks, not native workload evidence."""
from __future__ import annotations

import base64

import httpx
import pytest

from fastapi import FastAPI
from auth import storage
from auth.authentication import create_access_token
from core.coding_runtime import CodingRuntimeError
from routes.coding import router


@pytest.fixture
def coding_app(monkeypatch, tmp_path):
    monkeypatch.setattr(storage, "DB_PATH", tmp_path / "auth" / "auth.db")
    storage.create_initial_user("unsloth", "isolated-input-password", "isolated-signing-secret-242-long-enough")
    app = FastAPI()
    app.include_router(router, prefix = "/api/coding")
    return app, {"Authorization": "Bearer " + create_access_token("unsloth")}

PNG = base64.b64encode(bytes.fromhex("89504e470d0a1a0a") + b"transport fixture").decode()


@pytest.mark.asyncio
async def test_effective_skill_discovery_is_authenticated_and_exact_conversation_scoped(coding_app):
    app, headers = coding_app
    calls = []
    class Runtime:
        async def command(self, method, params):
            calls.append((method, params))
            return {"skills": [
                {"name": "review", "qualified_name": "plugin:alpha:review", "description": "Alpha"},
                {"name": "review", "qualified_name": "plugin:beta:review", "description": "Beta"},
            ]}
    app.state.coding_runtime = Runtime()
    async with httpx.AsyncClient(transport = httpx.ASGITransport(app = app), base_url = "http://test") as client:
        denied = await client.get("/api/coding/conversations/exact/skills")
        assert denied.status_code in (401, 403)
        assert calls == []
        response = await client.get("/api/coding/conversations/exact/skills", headers = headers)
        assert response.status_code == 200
        assert [item["qualified_name"] for item in response.json()["skills"]] == ["plugin:alpha:review", "plugin:beta:review"]
    assert calls == [("skills", {"conversation_id": "exact"})]


@pytest.mark.asyncio
async def test_rich_input_crosses_transport_without_rewriting_exact_key_ranges_or_bytes(coding_app):
    app, headers = coding_app
    calls = []
    class Runtime:
        async def command(self, method, params):
            calls.append((method, params))
            return {"conversation_id": params["conversation_id"], "submission_key": params["submission_key"], "request_id": "native"}
    app.state.coding_runtime = Runtime()
    payload = {"submission_key": "same-key", "text": "😀 @plugin:alpha:review inspect", "skill_mentions": [{"name": "plugin:alpha:review", "path": "/effective/project/review/SKILL.md", "start": 5, "end": 25}], "images": [{"mime_type": "image/png", "data": PNG}]}
    async with httpx.AsyncClient(transport = httpx.ASGITransport(app = app), base_url = "http://test", headers = headers) as client:
        for _ in range(2):
            response = await client.post("/api/coding/conversations/exact/prompts", json = payload)
            assert response.status_code == 202
            assert response.json()["submission_key"] == "same-key"
    assert calls == [("prompt", {"conversation_id": "exact", **payload})] * 2


@pytest.mark.asyncio
@pytest.mark.parametrize("extra", [
    {"images": [{"mime_type": "image/svg+xml", "data": PNG}]},
    {"images": [{"mime_type": "image/png", "data": "https://host/image.png"}]},
    {"images": [{"mime_type": "image/png", "data": base64.b64encode(b"not an image").decode()}]},
    {"images": [{"mime_type": "image/jpeg", "data": PNG}]},
    {"images": [{"mime_type": "image/png", "data": PNG}] * 5},
    {"images": [{"mime_type": "image/png", "data": base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"x" * (512 * 1024)).decode()}]},
    {"images": [{"mime_type": "image/png", "data": base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"x" * (300 * 1024)).decode()}] * 2},
    {"skill_mentions": [{"name": "plugin:alpha:review", "start": 1, "end": 21}]},
    {"skill_mentions": [{"name": "plugin:beta:review", "start": 0, "end": 20}]},
    {"skill_mentions": [{"name": "plugin:alpha:review", "start": 0, "end": 20}] * 2},
    {"skill_mentions": [{"name": "plugin:alpha:review", "start": False, "end": 20}]},
    {"images": [{"mime_type": "image/png", "data": PNG, "path": "/host/file"}]},
])
async def test_invalid_inputs_rejected_before_native_transport(coding_app, extra):
    app, headers = coding_app
    class Runtime:
        async def command(self, *_):
            pytest.fail("Rejected input must not reach native transport")
    app.state.coding_runtime = Runtime()
    async with httpx.AsyncClient(transport = httpx.ASGITransport(app = app), base_url = "http://test", headers = headers) as client:
        response = await client.post("/api/coding/conversations/exact/prompts", json = {"submission_key": "key", "text": "@plugin:alpha:review", **extra})
    assert response.status_code == 422
    assert response.json()["detail"]


@pytest.mark.asyncio
async def test_native_supported_input_failure_is_explicit_not_silent_drop(coding_app):
    app, headers = coding_app
    class Runtime:
        async def command(self, method, params):
            assert method == "prompt" and params["images"][0]["data"] == PNG
            raise CodingRuntimeError("invalid", "Selected provider does not support image input.")
    app.state.coding_runtime = Runtime()
    async with httpx.AsyncClient(transport = httpx.ASGITransport(app = app), base_url = "http://test", headers = headers) as client:
        response = await client.post("/api/coding/conversations/exact/prompts", json = {"submission_key": "key", "text": "Inspect this image", "images": [{"mime_type": "image/png", "data": PNG}]})
    assert response.status_code == 400
    assert "does not support image" in response.json()["detail"]
