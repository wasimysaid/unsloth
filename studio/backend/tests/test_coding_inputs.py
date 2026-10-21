# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
"""Deterministic authenticated input-contract checks, not native workload evidence."""
from __future__ import annotations

import base64
import struct
import zlib

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
    return app, {"Authorization": "Bearer " + create_access_token("unsloth"), "X-Mimir-Runtime-Generation": "1"}

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
@pytest.mark.parametrize("overlap_confirmed", [None, False, True])
async def test_rich_input_crosses_transport_without_rewriting_exact_key_ranges_or_bytes(coding_app, overlap_confirmed):
    app, headers = coding_app
    calls = []
    class Runtime:
        async def command(self, method, params, *, expected_generation=None):
            assert expected_generation == 1
            calls.append((method, params))
            return {"conversation_id": params["conversation_id"], "submission_key": params["submission_key"], "request_id": "native"}
    app.state.coding_runtime = Runtime()
    payload = {"submission_key": "same-key", "text": "😀 @plugin:alpha:review inspect", "skill_mentions": [{"name": "plugin:alpha:review", "path": "/effective/project/review/SKILL.md", "start": 5, "end": 25}], "images": [{"mime_type": "image/png", "data": PNG}]}
    if overlap_confirmed is not None:
        payload["overlap_confirmed"] = overlap_confirmed
    async with httpx.AsyncClient(transport = httpx.ASGITransport(app = app), base_url = "http://test", headers = headers) as client:
        for _ in range(2):
            response = await client.post("/api/coding/conversations/exact/prompts", json = payload)
            assert response.status_code == 202
            assert response.json()["submission_key"] == "same-key"
    assert calls == [("prompt", {"conversation_id": "exact", **payload, "overlap_confirmed": overlap_confirmed or False})] * 2


@pytest.mark.asyncio
@pytest.mark.parametrize("extra", [
    {"images": [{"mime_type": "image/svg+xml", "data": PNG}]},
    {"images": [{"mime_type": "image/png", "data": "https://host/image.png"}]},
    {"images": [{"mime_type": "image/png", "data": base64.b64encode(b"not an image").decode()}]},
    {"images": [{"mime_type": "image/jpeg", "data": PNG}]},
    {"images": [{"mime_type": "image/png", "data": PNG}] * 5},
    {"images": [{"mime_type": "image/png", "data": base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"x" * (10 * 1024 * 1024)).decode()}]},
    {"images": [{"mime_type": "image/png", "data": base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"x" * (7 * 1024 * 1024)).decode()}] * 3},
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
        async def command(self, method, params, *, expected_generation=None):
            assert expected_generation == 1
            assert method == "prompt" and params["images"][0]["data"] == PNG
            raise CodingRuntimeError("invalid", "Selected provider does not support image input.")
    app.state.coding_runtime = Runtime()
    async with httpx.AsyncClient(transport = httpx.ASGITransport(app = app), base_url = "http://test", headers = headers) as client:
        response = await client.post("/api/coding/conversations/exact/prompts", json = {"submission_key": "key", "text": "Inspect this image", "images": [{"mime_type": "image/png", "data": PNG}]})
    assert response.status_code == 400
    assert "does not support image" in response.json()["detail"]


def large_valid_png():
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    header = struct.pack(">IIBBBBB", 512, 512, 8, 2, 0, 0, 0)
    scanlines = (b"\x00" + bytes(range(256)) * 6) * 512
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(scanlines, 0)) + chunk(b"IEND", b"")


@pytest.mark.asyncio
async def test_large_image_and_typed_subagent_reach_exact_generation(coding_app):
    app, headers = coding_app
    calls = []
    class Runtime:
        async def command(self, method, params, *, expected_generation=None):
            calls.append((method, params, expected_generation))
            return {"request_id": "accepted-native", "submission_key": params["submission_key"]}
    app.state.coding_runtime = Runtime()
    image = large_valid_png()
    assert len(image) > 512 * 1024
    payload = {"submission_key": "large-typed", "text": "😀 @explore inspect", "subagent_mentions": [{"name": "explore", "start": 5, "end": 13}], "images": [{"mime_type": "image/png", "data": base64.b64encode(image).decode()}]}
    async with httpx.AsyncClient(transport = httpx.ASGITransport(app = app), base_url = "http://test", headers = headers) as client:
        response = await client.post("/api/coding/conversations/exact/prompts", json = payload)
    assert response.status_code == 202, response.text
    assert calls == [("prompt", {"conversation_id": "exact", **payload, "overlap_confirmed": False}, 1)]


@pytest.mark.asyncio
async def test_subagent_catalog_is_authenticated_and_scoped(coding_app):
    app, headers = coding_app
    calls = []
    catalog = {"subagents": [{"name": "explore", "description": "Read project files", "plan_eligible": True}]}
    class Runtime:
        async def command(self, method, params):
            calls.append((method, params))
            return catalog
    app.state.coding_runtime = Runtime()
    async with httpx.AsyncClient(transport = httpx.ASGITransport(app = app), base_url = "http://test") as client:
        denied = await client.get("/api/coding/conversations/exact/subagents")
        assert denied.status_code in (401, 403)
        assert calls == []
        response = await client.get("/api/coding/conversations/exact/subagents", headers = headers)
    assert response.status_code == 200
    assert response.json() == catalog
    assert calls == [("subagents", {"conversation_id": "exact"})]


@pytest.mark.asyncio
@pytest.mark.parametrize("mentions", [
    [{"name": "explore", "start": 1, "end": 8}],
    [{"name": "wrong", "start": 0, "end": 8}],
    [{"name": "explore", "start": False, "end": 8}],
    [{"name": "explore", "start": 0, "end": 8, "allowed_tools": ["shell"]}],
    [{"name": "explore", "start": 0, "end": 8}] * 2,
])
async def test_invalid_subagent_mentions_never_reach_native(coding_app, mentions):
    app, headers = coding_app
    class Runtime:
        async def command(self, *_args, **_kwargs):
            pytest.fail("Invalid mention reached native")
    app.state.coding_runtime = Runtime()
    async with httpx.AsyncClient(transport = httpx.ASGITransport(app = app), base_url = "http://test", headers = headers) as client:
        response = await client.post("/api/coding/conversations/exact/prompts", json = {"submission_key": "invalid", "text": "@explore", "subagent_mentions": mentions})
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_skill_and_subagent_cannot_claim_same_text_range(coding_app):
    app, headers = coding_app
    class Runtime:
        async def command(self, *_args, **_kwargs):
            pytest.fail("Overlapping mention reached native")
    app.state.coding_runtime = Runtime()
    mention = {"name": "explore", "start": 0, "end": 8}
    async with httpx.AsyncClient(transport = httpx.ASGITransport(app = app), base_url = "http://test", headers = headers) as client:
        response = await client.post("/api/coding/conversations/exact/prompts", json = {"submission_key": "overlap", "text": "@explore", "skill_mentions": [mention], "subagent_mentions": [mention]})
    assert response.status_code == 422
