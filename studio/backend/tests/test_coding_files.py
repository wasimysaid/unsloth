# SPDX-License-Identifier: AGPL-3.0-only
"""Authenticated file-reference boundary checks; native resolves the actual files."""
from __future__ import annotations

import httpx
import pytest

from .test_coding_inputs import coding_app


@pytest.mark.asyncio
async def test_file_catalog_is_native_authenticated_scoped_and_bounded(coding_app):
    app, headers = coding_app
    calls = []
    catalog = {"files": [{"path": "src/naïve file.ts", "kind": "file"}, {"path": "src/lib", "kind": "directory"}], "truncated": False}
    class Runtime:
        async def command(self, method, params):
            calls.append((method, params))
            return catalog
    app.state.coding_runtime = Runtime()
    async with httpx.AsyncClient(transport = httpx.ASGITransport(app = app), base_url = "http://test") as client:
        denied = await client.get("/api/coding/conversations/exact/files")
        assert denied.status_code in (401, 403)
        assert calls == []
        response = await client.get("/api/coding/conversations/exact/files", params = {"query": "naïve", "max_results": 7}, headers = headers)
    assert response.status_code == 200
    assert response.json() == catalog
    assert calls == [("files", {"conversation_id": "exact", "query": "naïve", "max_results": 7})]


@pytest.mark.asyncio
@pytest.mark.parametrize("query", [{"max_results": 0}, {"max_results": 41}, {"query": "x" * 1025}, {"query": "😀" * 300}, {"query": "src\x00/private"}])
async def test_invalid_file_catalog_query_never_reaches_native(coding_app, query):
    app, headers = coding_app
    class Runtime:
        async def command(self, *_args, **_kwargs):
            pytest.fail("Invalid catalog query reached native")
    app.state.coding_runtime = Runtime()
    async with httpx.AsyncClient(transport = httpx.ASGITransport(app = app), base_url = "http://test", headers = headers) as client:
        response = await client.get("/api/coding/conversations/exact/files", params = query)
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_selected_file_paths_ranges_and_generation_cross_unchanged(coding_app):
    app, headers = coding_app
    calls = []
    class Runtime:
        async def command(self, method, params, *, expected_generation=None):
            calls.append((method, params, expected_generation))
            return {"request_id": "native-reference", "submission_key": params["submission_key"]}
    app.state.coding_runtime = Runtime()
    text = '😀 @"src/naïve file.ts" @src/lib/'
    encoded = text.encode("utf-8")
    first = '@"src/naïve file.ts"'.encode("utf-8")
    second = b"@src/lib/"
    payload = {"submission_key": "file-exact", "text": text, "file_mentions": [
        {"path": "src/naïve file.ts", "kind": "file", "start": encoded.index(first), "end": encoded.index(first) + len(first)},
        {"path": "src/lib", "kind": "directory", "start": encoded.index(second), "end": encoded.index(second) + len(second)},
    ]}
    async with httpx.AsyncClient(transport = httpx.ASGITransport(app = app), base_url = "http://test", headers = headers) as client:
        response = await client.post("/api/coding/conversations/exact/prompts", json = payload)
    assert response.status_code == 202, response.text
    assert calls == [("prompt", {"conversation_id": "exact", **payload, "overlap_confirmed": False}, 1)]


@pytest.mark.asyncio
@pytest.mark.parametrize("mentions", [
    [{"path": "a", "kind": "file", "start": 0, "end": 1}],
    [{"path": "wrong", "kind": "file", "start": 0, "end": 2}],
    [{"path": "a", "kind": "file", "start": False, "end": 2}],
    [{"path": "a", "kind": "unknown", "start": 0, "end": 2}],
    [{"path": "a", "kind": "file", "start": 0, "end": 2, "content": "injected"}],
    [{"path": "a\x00", "kind": "file", "start": 0, "end": 2}],
    [{"path": "a", "kind": "file", "start": 0, "end": 2}] * 2,
])
async def test_invalid_selected_files_never_reach_native(coding_app, mentions):
    app, headers = coding_app
    class Runtime:
        async def command(self, *_args, **_kwargs):
            pytest.fail("Invalid file reference reached native")
    app.state.coding_runtime = Runtime()
    async with httpx.AsyncClient(transport = httpx.ASGITransport(app = app), base_url = "http://test", headers = headers) as client:
        response = await client.post("/api/coding/conversations/exact/prompts", json = {"submission_key": "invalid", "text": "@a", "file_mentions": mentions})
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_file_and_skill_ranges_cannot_overlap(coding_app):
    app, headers = coding_app
    class Runtime:
        async def command(self, *_args, **_kwargs):
            pytest.fail("Overlapping input reached native")
    app.state.coding_runtime = Runtime()
    payload = {"submission_key": "overlap", "text": "@a", "file_mentions": [{"path": "a", "kind": "file", "start": 0, "end": 2}], "skill_mentions": [{"name": "a", "start": 0, "end": 2}]}
    async with httpx.AsyncClient(transport = httpx.ASGITransport(app = app), base_url = "http://test", headers = headers) as client:
        response = await client.post("/api/coding/conversations/exact/prompts", json = payload)
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_file_mentions_share_the_combined_selection_budget(coding_app):
    app, headers = coding_app
    class Runtime:
        async def command(self, *_args, **_kwargs):
            pytest.fail("Over-budget input reached native")
    app.state.coding_runtime = Runtime()
    payload = {"submission_key": "budget", "text": "@s " + " ".join(["@a"] * 64), "skill_mentions": [{"name": "s", "start": 0, "end": 2}], "file_mentions": [{"path": "a", "kind": "file", "start": 3 + index * 3, "end": 5 + index * 3} for index in range(64)]}
    async with httpx.AsyncClient(transport = httpx.ASGITransport(app = app), base_url = "http://test", headers = headers) as client:
        response = await client.post("/api/coding/conversations/exact/prompts", json = payload)
    assert response.status_code == 422
