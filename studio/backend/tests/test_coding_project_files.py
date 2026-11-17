# SPDX-License-Identifier: AGPL-3.0-only
"""Project preview uses authenticated, bounded native commands without sessions."""
import asyncio

import httpx
import pytest

from core.coding_runtime import CodingRuntimeError
from .test_coding import RuntimeDouble
from .test_coding_inputs import coding_app


@pytest.mark.parametrize("endpoint,params,expected", [
    ("directory", {}, {"path": "", "show_hidden": False}),
    ("directory", {"path": "src", "show_hidden": True}, {"path": "src", "show_hidden": True}),
    ("search", {"query": "naïve"}, {"query": "naïve", "show_hidden": False}),
    ("file", {"path": "src/naïve.rs"}, {"path": "src/naïve.rs", "offset": 0, "limit": 131072, "revision": None}),
    ("file", {"path": "large.rs", "offset": 128, "limit": 4096, "revision": "exact"},
     {"path": "large.rs", "offset": 128, "limit": 4096, "revision": "exact"}),
])
def test_project_preview_is_authenticated_and_forwards_without_session(coding_app, endpoint, params, expected):
    async def exercise():
        app, headers = coding_app
        calls = []
        result = {"path": "src/naïve.rs", "text": "project fixture"}
        class Runtime(RuntimeDouble):
            async def command(self, method, params):
                calls.append((method, params))
                return result
        app.state.coding_runtime = Runtime()
        query_params = {"project_path": "/selected project", **params}
        async with httpx.AsyncClient(transport = httpx.ASGITransport(app = app), base_url = "http://test") as client:
            denied = await client.get(f"/api/coding/project/{endpoint}", params = query_params)
            assert denied.status_code in (401, 403)
            assert calls == []
            response = await client.get(f"/api/coding/project/{endpoint}", params = query_params, headers = headers)
        assert response.status_code == 200, response.text
        assert response.json() == result
        assert calls == [(f"project_{endpoint}", {"project_path": "/selected project", **expected})]
    asyncio.run(exercise())


@pytest.mark.parametrize("endpoint,params", [
    ("directory", {"path": "../private"}), ("directory", {"path": "/etc"}),
    ("directory", {"project_path": "😀" * 5000}), ("directory", {"path": "a\\b"}),
    ("directory", {"path": "src//a"}), ("directory", {"path": "src\x00"}),
    ("search", {"query": " "}), ("search", {"query": "😀" * 300}),
    ("file", {"path": "a", "offset": 1}), ("file", {"path": "a", "limit": 262145}),
    ("file", {"path": "a", "limit": 3}), ("file", {"path": "a", "offset": -1}),
    ("file", {"path": "C:/private"}), ("file", {"path": "a", "revision": "\x7f"}),
])
def test_invalid_project_requests_never_reach_native(coding_app, endpoint, params):
    async def exercise():
        app, headers = coding_app
        class Runtime(RuntimeDouble):
            async def command(self, *_args, **_kwargs):
                pytest.fail("Invalid project read reached native")
        app.state.coding_runtime = Runtime()
        async with httpx.AsyncClient(transport = httpx.ASGITransport(app = app), base_url = "http://test", headers = headers) as client:
            response = await client.get(f"/api/coding/project/{endpoint}", params = {"project_path": "/project", **params})
        assert response.status_code == 422, response.text
    asyncio.run(exercise())


def test_changed_file_maps_to_conflict(coding_app):
    async def exercise():
        app, headers = coding_app
        class Runtime(RuntimeDouble):
            async def command(self, *_args, **_kwargs):
                raise CodingRuntimeError("conflict", "The file changed. Reload it.")
        app.state.coding_runtime = Runtime()
        async with httpx.AsyncClient(transport = httpx.ASGITransport(app = app), base_url = "http://test", headers = headers) as client:
            response = await client.get("/api/coding/project/file", params = {"project_path": "/project", "path": "a"})
        assert response.status_code == 409
        assert response.json()["detail"] == "The file changed. Reload it."
    asyncio.run(exercise())


