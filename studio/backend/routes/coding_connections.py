# SPDX-License-Identifier: AGPL-3.0-only
"""Private Chat Completions transport between a hosted Mimir process and Studio."""

from __future__ import annotations

import asyncio

import anyio
import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from auth import storage
from core.coding_connections import connection_request
from utils.account_context import AccountContext, bind_account, reset_account

router = APIRouter(include_in_schema = False)


def _current_login(account: AccountContext) -> bool:
    row = storage.get_user_record(account.username)
    return bool(
        row and row["is_active"] and not account.via_api_key
        and row["account_id"] == account.account_id and row["role"] == account.role
        and storage.credential_generation(row["jwt_secret"]) == account.credential_gen
    )


class ConnectionResponse(Response):
    def __init__(self, exchange, account: AccountContext):
        super().__init__()
        self.exchange = exchange
        self.account = account

    async def __call__(self, scope, receive, send):
        async def respond():
            started = False
            try:
                async with self.exchange as upstream:
                    if not upstream.is_success:
                        response = JSONResponse(
                            {"error": {"message": f"Provider returned HTTP {upstream.status_code}."}},
                            status_code = upstream.status_code if upstream.is_error else 502,
                        )
                        await response(scope, receive, send)
                        return
                    response = StreamingResponse(
                        upstream.aiter_bytes(),
                        media_type = upstream.headers.get("content-type", "text/event-stream"),
                        headers = {"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
                    )
                    started = True
                    await response.stream_response(send)
            except httpx.HTTPError:
                if started:
                    raise
                await JSONResponse(
                    {"error": {"message": "Studio could not reach this provider."}}, status_code = 502,
                )(scope, receive, send)
            finally:
                tasks.cancel_scope.cancel()

        binding = bind_account(self.account)
        try:
            # Also cancel a pending upstream connection if the caller leaves before headers.
            async with anyio.create_task_group() as tasks:
                tasks.start_soon(respond)
                while (await receive())["type"] != "http.disconnect":
                    pass
                tasks.cancel_scope.cancel()
        finally:
            reset_account(binding)


@router.post("/{connection_id}/v1/chat/completions")
async def chat_completions(connection_id: str, request: Request):
    from core.coding_runtime import connection_account_for

    scheme, _, bearer = request.headers.get("Authorization", "").partition(" ")
    account = connection_account_for(request.app, bearer) if scheme.lower() == "bearer" and bearer else None
    if account is None or not await asyncio.to_thread(_current_login, account):
        raise HTTPException(403, "A current Coding session is required.")
    try:
        payload = await request.json()
    except ValueError:
        raise HTTPException(400, "Invalid Chat Completions request.") from None
    if not isinstance(payload, dict) or not isinstance(payload.get("model"), str):
        raise HTTPException(400, "Supply a model for this connection.")
    binding = bind_account(account)
    try:
        exchange = await connection_request(connection_id, payload)
    finally:
        reset_account(binding)
    return ConnectionResponse(exchange, account)
