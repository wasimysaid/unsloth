# SPDX-License-Identifier: AGPL-3.0-only
"""Authenticated question boundary contracts; native/browser suites prove admission."""
from __future__ import annotations

import httpx
import pytest

from core.coding_runtime import CodingRuntimeError
from .test_coding import coding_app


ANSWER_PATH = "/api/coding/conversations/exact-conversation/requests/exact-request/questions/exact-user-request/answers"
ANSWER_BODY = {"subscription": "exact-live-view", "answers": [
    {"question_id": "single", "selected_options": ["First"], "freeform_text": None},
    {"question_id": "multiple", "selected_options": ["One", "Two"], "freeform_text": "Keep this verbatim.\n"},
    {"question_id": "freeform", "selected_options": [], "freeform_text": "User's actual answer"},
]}


@pytest.mark.asyncio
async def test_answer_preserves_exact_identities_payload_and_native_ack(coding_app):
    app, headers = coding_app
    calls = []
    ack = {"conversation_id": "exact-conversation", "request_id": "exact-request",
           "user_request_id": "exact-user-request", "subscription": "exact-live-view", "accepted": True}

    class RecordingRuntime:
        async def command(self, method, params, *, expected_generation=None):
            assert expected_generation == 1
            calls.append((method, params))
            return ack

    app.state.coding_runtime = RecordingRuntime()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test", headers=headers) as client:
        response = await client.post(ANSWER_PATH, json=ANSWER_BODY)
    assert response.status_code == 200
    assert response.json() == ack, "The HTTP layer must not invent acceptance or terminal settlement"
    assert calls == [("answer", {"conversation_id": "exact-conversation", "request_id": "exact-request",
                                "user_request_id": "exact-user-request", **ANSWER_BODY})]


@pytest.mark.asyncio
@pytest.mark.parametrize("body", [
    {}, {"answers": ANSWER_BODY["answers"]},
    {**ANSWER_BODY, "subscription": ""},
    {**ANSWER_BODY, "answers": []},
    {**ANSWER_BODY, "answers": [{"question_id": "single", "selected_options": "First", "freeform_text": None}]},
    {**ANSWER_BODY, "answers": [{"question_id": "", "selected_options": [], "freeform_text": None}]},
    {**ANSWER_BODY, "answers": [{"question_id": "single", "selected_options": [], "freeform_text": None, "accepted": True}]},
    {**ANSWER_BODY, "conversation_id": "body-cannot-override-path"},
    {**ANSWER_BODY, "request_id": "body-cannot-override-path"},
    {**ANSWER_BODY, "user_request_id": "body-cannot-override-path"},
    {**ANSWER_BODY, "accepted": True},
])
async def test_invalid_answer_envelope_never_reaches_native(coding_app, body):
    app, headers = coding_app
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test", headers=headers) as client:
        response = await client.post(ANSWER_PATH, json=body)
    assert response.status_code == 422
    assert not hasattr(app.state, "coding_runtime")


@pytest.mark.asyncio
@pytest.mark.parametrize("code,status", [("invalid", 400), ("invalid_answer", 400),
                                         ("stale_answer", 409), ("not_found", 404), ("conflict", 409),
                                         ("disconnected", 503), ("uncertain", 504)])
async def test_native_invalid_stale_or_uncertain_answer_is_not_retried(coding_app, code, status):
    app, headers = coding_app
    calls = []

    class RejectingRuntime:
        async def command(self, method, params, *, expected_generation=None):
            assert expected_generation == 1
            calls.append((method, params))
            raise CodingRuntimeError(code, "The exact question was not confirmed; reconstruct its native view.")

    app.state.coding_runtime = RejectingRuntime()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test", headers=headers) as client:
        response = await client.post(ANSWER_PATH, json=ANSWER_BODY)
    assert response.status_code == status
    assert "reconstruct" in response.json()["detail"]
    assert len(calls) == 1 and calls[0][0] == "answer", "No blind replay or polling may imply acceptance"


@pytest.mark.asyncio
@pytest.mark.parametrize("view_open", [True, False])
async def test_answer_ack_never_acquires_or_replaces_a_view_queue(view_open):
    import asyncio
    import json
    import struct
    from types import SimpleNamespace
    from core.coding_runtime import CodingRuntime

    stream = asyncio.StreamReader()
    subscription = "exact-live-view"
    state = {"subscription": subscription, "position": 25,
             "event": {"type": "state", "state": {"pending_user_request": False}}}
    ack = {"subscription": subscription, "conversation_id": "exact-conversation",
           "request_id": "exact-request", "user_request_id": "exact-user-request", "accepted": True}

    class Writer:
        def write(self, data):
            request = json.loads(data[4:])
            result = {"subscription": subscription} if request["method"] == "view" else ack
            frames = [{"id": request["id"], "result": result}]
            if request["method"] == "answer":
                frames.append(state)
            for payload in frames:
                body = json.dumps(payload).encode()
                stream.feed_data(struct.pack(">I", len(body)) + body)

        async def drain(self):
            pass

    runtime = CodingRuntime()
    runtime.process = SimpleNamespace(stdout=stream, stdin=Writer(), returncode=0)
    reader = asyncio.create_task(runtime._read_responses())
    try:
        queue = None
        if view_open:
            key, queue = await runtime.subscribe("exact-conversation")
            assert key == subscription
        assert await runtime.command("answer", ANSWER_BODY) == ack
        if view_open:
            assert runtime._subscriptions[subscription] is queue, "ACK replaced the live SSE queue"
            assert await asyncio.wait_for(queue.get(), timeout=1) == state
        else:
            assert not runtime._subscriptions, "ACK manufactured a view after teardown"
    finally:
        stream.feed_eof()
        await reader
