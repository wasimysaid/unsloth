# SPDX-License-Identifier: AGPL-3.0-only
"""Command route validation/access; real native outcomes are covered by browser scenarios."""
from __future__ import annotations

import httpx
import pytest

from core.coding_runtime import CodingRuntimeError
from .test_coding import coding_app  # Reuse the isolated authenticated app fixture.


@pytest.mark.asyncio
async def test_commands_and_bounded_diagnostics_preserve_native_shapes(coding_app):
    app, headers = coding_app
    calls = []

    class Runtime:
        async def command(self, method, params, *, expected_generation=None):
            assert expected_generation == (1 if method == "command" else None)
            calls.append((method, params))
            if method == "commands":
                return {"conversation_id": params["conversation_id"], "commands": [{"name": "project:inspect", "aliases": ["inspect"], "description": "Contributed command", "argument": "path", "availability": "any"}]}
            if method == "command":
                if params["name"] == "compress":
                    raise CodingRuntimeError("busy", "Native session is busy")
                return {"conversation_id": params["conversation_id"], "outcome": "display", "text": "Native transient output"}
            return {"conversation_id": params["conversation_id"], "kind": params["kind"], "data": {"supported": True}}

    app.state.coding_runtime = Runtime()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test", headers=headers) as client:
        catalog = await client.get("/api/coding/conversations/exact-id/commands")
        assert catalog.status_code == 200
        assert catalog.json()["commands"][0]["aliases"] == ["inspect"]
        result = await client.post("/api/coding/conversations/exact-id/commands", json={"operation_id": "inspect-op", "name": "inspect", "tail": "a path"})
        assert result.json() == {"conversation_id": "exact-id", "outcome": "display", "text": "Native transient output"}
        busy = await client.post("/api/coding/conversations/exact-id/commands", json={"operation_id": "busy-op", "name": "compress"})
        assert busy.status_code == 409 and busy.json()["detail"] == "Native session is busy"
        for kind in ("context", "tokens", "retry", "execution"):
            result = await client.get(f"/api/coding/conversations/exact-id/diagnostics/{kind}")
            assert result.status_code == 200 and result.json()["kind"] == kind
    assert calls[:3] == [("commands", {"conversation_id": "exact-id"}), ("command", {"conversation_id": "exact-id", "operation_id": "inspect-op", "name": "inspect", "tail": "a path"}), ("command", {"conversation_id": "exact-id", "operation_id": "busy-op", "name": "compress", "tail": ""})]
    assert [params["kind"] for method, params in calls if method == "diagnostics"] == ["context", "tokens", "retry", "execution"]


@pytest.mark.asyncio
async def test_slash_prompt_bypass_and_invalid_diagnostics_never_reach_native_execution(coding_app):
    app, headers = coding_app

    class Runtime:
        async def command(self, *_):
            raise AssertionError("Invalid browser data must not reach the native owner")

    app.state.coding_runtime = Runtime()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test", headers=headers) as client:
        for text in ("/unknown", "  /terminal-only", "/compress"):
            response = await client.post("/api/coding/conversations/exact-id/prompts", json={"submission_key": "key", "text": text})
            assert response.status_code == 400 and "no model prompt" in response.json()["detail"]
        for body in ({"name": ""}, {"name": "/compress"}, {"name": "two names"}, {"name": "inspect", "tail": "x" * 16385}, {"name": "inspect", "api_key": "must-not-pass"}):
            assert (await client.post("/api/coding/conversations/exact-id/commands", json={"operation_id": "validation-op", **body})).status_code == 422
        assert (await client.get("/api/coding/conversations/exact-id/diagnostics/config" )).status_code == 422
