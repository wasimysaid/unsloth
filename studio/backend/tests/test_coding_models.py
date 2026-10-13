# SPDX-License-Identifier: AGPL-3.0-only
"""Authenticated model refresh delegates to the retained native owner."""
from __future__ import annotations

import httpx
import pytest

from core.coding_runtime import CodingRuntimeError
from .test_coding import coding_app


@pytest.mark.asyncio
async def test_model_inventory_and_refresh_keep_native_identity_and_never_reopen(coding_app):
    app, headers = coding_app
    calls = []
    catalog = [{"id": "external", "name": "External", "models": [
        {"id": "local/alias", "api_model": "wire-id", "name": "Label",
         "reasoning": "unsupported", "default_reasoning": None}]}]

    class Runtime:
        async def command(self, method, params):
            calls.append((method, params))
            assert method in ("models", "models.refresh")
            return catalog

    app.state.coding_runtime = Runtime()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test", headers=headers) as client:
        for method, suffix in (("GET", ""), ("POST", "/refresh")):
            response = await client.request(method, "/api/coding/conversations/exact-id/models" + suffix)
            assert response.status_code == 200
            assert response.json() == catalog
            assert response.headers["cache-control"] == "no-store"
    assert calls == [("models", {"conversation_id": "exact-id"}),
                     ("models.refresh", {"conversation_id": "exact-id"})]


@pytest.mark.asyncio
@pytest.mark.parametrize("code,status", [("not_found", 404), ("failed", 502), ("busy", 409)])
async def test_refresh_failure_is_explicit_and_not_replayed(coding_app, code, status):
    app, headers = coding_app
    calls = []

    class Runtime:
        async def command(self, method, params):
            calls.append((method, params))
            raise CodingRuntimeError(code, "Refresh failed; selection and history retained.")

    app.state.coding_runtime = Runtime()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test", headers=headers) as client:
        response = await client.post("/api/coding/conversations/exact-id/models/refresh")
        assert response.status_code == status
        assert "selection and history retained" in response.json()["detail"]
    assert calls == [("models.refresh", {"conversation_id": "exact-id"})]
