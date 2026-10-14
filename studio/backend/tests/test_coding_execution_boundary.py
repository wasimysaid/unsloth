# SPDX-License-Identifier: AGPL-3.0-only
"""Both authenticated HTTP routes preserve their distinct execution contracts."""
import httpx
import pytest
from fastapi.responses import JSONResponse

from core.coding_runtime import CodingRuntimeError
from routes import inference

from .test_coding import coding_app


@pytest.mark.asyncio
async def test_coding_refusal_cannot_fallback_to_general_chat_and_chat_does_not_enter_native(
    coding_app, monkeypatch,
):
    app, headers = coding_app
    app.include_router(inference.router, prefix="/v1")
    general_requests = []

    async def general(payload, request, subject, *, cancel_on_disconnect):
        general_requests.append(payload.messages[0].content)
        assert subject == "unsloth" and cancel_on_disconnect
        return JSONResponse({"choices": [{"message": {"content": "ordinary-chat-result"}}]})

    monkeypatch.setattr(inference, "produce_openai_chat_completions", general)

    class Native:
        async def command(self, method, params, *, expected_generation):
            assert method == "prompt" and expected_generation == 1
            assert params["conversation_id"] == "native-conversation"
            if params["text"] == "refuse":
                raise CodingRuntimeError("unavailable", "Explicit native refusal; no fallback.")
            return {"conversation_id": "native-conversation", "request_id": "native-request", "submission_key": params["submission_key"]}

    app.state.coding_runtime = Native()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test", headers=headers) as client:
        accepted = await client.post("/api/coding/conversations/native-conversation/prompts", json={"submission_key": "exact-submission", "text": "coding"})
        assert accepted.status_code == 202
        assert accepted.json() == {"conversation_id": "native-conversation", "request_id": "native-request", "submission_key": "exact-submission"}
        refused = await client.post("/api/coding/conversations/native-conversation/prompts", json={"submission_key": "refused-submission", "text": "refuse"})
        assert refused.status_code == 503
        assert "no fallback" in refused.json()["detail"]
        assert general_requests == []
        # Any routing through native now fails before producing an HTTP result.
        app.state.coding_runtime = object()
        ordinary = await client.post("/v1/chat/completions", json={"model": "ordinary-local", "messages": [{"role": "user", "content": "general chat"}]})
        assert ordinary.status_code == 200
        assert ordinary.json()["choices"][0]["message"]["content"] == "ordinary-chat-result"
        assert general_requests == ["general chat"]
