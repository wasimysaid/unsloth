# SPDX-License-Identifier: AGPL-3.0-only
"""Authenticated coding entry boundary, independent of ordinary chat execution."""
from __future__ import annotations

import asyncio
import anyio
import json
import os
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field

from auth.authentication import get_current_subject
from core.coding_runtime import CodingRuntimeError, runtime_for

router = APIRouter(dependencies = [Depends(get_current_subject)])


class NativeViewResponse(StreamingResponse):
    """Own the admitted view even if disconnect precedes body iteration."""
    def __init__(self, content, runtime, subscription):
        super().__init__(content, media_type = "text/event-stream",
                         headers = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
        self.runtime = runtime
        self.subscription = subscription

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            with anyio.CancelScope(shield = True):
                await self.runtime.unsubscribe(self.subscription)


class ProjectSelection(BaseModel):
    model_config = ConfigDict(extra = "forbid")
    cwd: str = Field(min_length = 1, max_length = 32768)


def _http_error(exc: CodingRuntimeError) -> HTTPException:
    status = {"invalid": 400, "not_found": 404, "denied": 403,
              "busy": 409, "conflict": 409, "trust_conflict": 409,
              "unavailable": 503, "disconnected": 503, "uncertain": 504,
              "limit": 429, "failed": 502}.get(exc.code, 400)
    return HTTPException(status_code = status, detail = exc.message,
                         headers = {"Cache-Control": "no-store"})


async def _command(request: Request, method: str, params: dict | None = None):
    try:
        return await runtime_for(request.app).command(method, params)
    except CodingRuntimeError as exc:
        raise _http_error(exc) from exc


def _browse(path: str | None) -> dict:
    """Directory names only. This is not model browsing and has no coding allowlist.

    This discovery does not grant trust or enable Send: Session Control validates
    the selected directory natively at catalog/create/open admission.
    """
    try:
        target = Path(path).expanduser() if path else Path.home()
        target = target.resolve(strict = True)
        if not target.is_dir():
            raise HTTPException(400, "Choose a host directory, not a file.")
        if not os.access(target, os.R_OK | os.X_OK):
            raise PermissionError()
        entries = []
        truncated = False
        with os.scandir(target) as children:
            for index, child in enumerate(children):
                if index >= 2000:
                    truncated = True
                    break
                try:
                    if child.is_dir():
                        entries.append({"name": child.name, "path": child.path})
                except OSError:
                    continue
        entries.sort(key = lambda entry: entry["name"].casefold())
        return {"path": str(target), "parent": str(target.parent),
                "entries": entries, "truncated": truncated}
    except FileNotFoundError as exc:
        raise HTTPException(404, "That host folder does not exist. Check the path or choose its parent.") from exc
    except PermissionError as exc:
        raise HTTPException(403, "The host OS denies access to that folder. Choose another folder or ask its owner for access.") from exc
    except (OSError, ValueError, RuntimeError) as exc:
        # Python 3.12 reports symlink loops/unknown ~users as RuntimeError;
        # they are invalid host paths, not an internal-server failure.
        raise HTTPException(400, "That host folder cannot be read. Check the path and host permissions.") from exc


@router.get("/projects/browse")
async def browse_projects(path: str | None = Query(default = None, max_length = 32768)):
    return await asyncio.to_thread(_browse, path)


@router.get("/catalog")
async def catalog(request: Request, cwd: str = Query(min_length = 1, max_length = 32768)):
    return await _command(request, "catalog", {"cwd": cwd})


@router.get("/conversations")
async def conversations(request: Request, cursor: str | None = Query(default = None, max_length = 16384)):
    page = await _command(request, "list", {"cursor": cursor})
    return {"conversations": page["sessions"], "next_cursor": page.get("next_cursor")}


@router.post("/conversations", status_code = 201)
async def create_conversation(body: ProjectSelection, request: Request):
    state = await _command(request, "create", {"cwd": body.cwd})
    return state["info"]


@router.post("/conversations/{conversation_id}/open")
async def open_conversation(conversation_id: str, request: Request):
    state = await _command(request, "open", {"conversation_id": conversation_id})
    return state["info"]


@router.get("/conversations/{conversation_id}/events")
async def conversation_events(conversation_id: str, request: Request):
    # A GET never implicitly opens an owner or grants project trust. The plugin
    # captures its native ordered view; no snapshot-then-subscribe race exists.
    runtime = runtime_for(request.app)
    try:
        subscription, queue = await runtime.subscribe(conversation_id)
    except CodingRuntimeError as exc:
        raise _http_error(exc) from exc

    async def events():
        while not await request.is_disconnected():
            try:
                item = await asyncio.wait_for(queue.get(), timeout = 10)
            except TimeoutError:
                yield ": keepalive\n\n"
                continue
            if isinstance(item, CodingRuntimeError):
                yield "event: disconnected\ndata: " + json.dumps({"message": item.message}) + "\n\n"
                return
            yield "event: view\ndata: " + json.dumps(item, separators = (",", ":")) + "\n\n"
            if item.get("event", {}).get("type") == "closed":
                return

    # Only this view is released on disconnect; native conversation owners survive.
    return NativeViewResponse(events(), runtime, subscription)


class McpSettingsRoute(APIRoute):
    """Do not echo raw MCP definitions in FastAPI's validation diagnostics."""
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def sanitized(request: Request):
            try:
                response = await handler(request)
            except RequestValidationError:
                response = JSONResponse(
                    status_code = 422,
                    content = {"detail": "Invalid MCP Settings request. Check the source, server name, edit identity, revision and definition size. Your draft was not saved."},
                )
            response.headers["Cache-Control"] = "no-store"
            return response

        return sanitized


class McpEditRequest(BaseModel):
    model_config = ConfigDict(extra = "forbid", strict = True)
    source: str = Field(min_length = 1, max_length = 256)
    name: str = Field(min_length = 1, max_length = 256)


class McpEditIdentity(BaseModel):
    model_config = ConfigDict(extra = "forbid", strict = True)
    edit_id: str = Field(min_length = 1, max_length = 256)


class McpSaveRequest(McpEditIdentity):
    revision: str = Field(min_length = 1, max_length = 256)
    definition_json: str = Field(alias = "json", max_length = 524288)


mcp_router = APIRouter(route_class = McpSettingsRoute)


@mcp_router.get("/conversations/{conversation_id}/mcp/inventory")
async def mcp_inventory(conversation_id: str, request: Request):
    # Neither a read nor save opens/closes a session, grants trust, or applies changes.
    return await _command(request, "mcp_inventory", {"conversation_id": conversation_id})


@mcp_router.post("/conversations/{conversation_id}/mcp/edit")
async def mcp_edit(conversation_id: str, body: McpEditRequest, request: Request):
    # Source is an opaque native identifier, never a Studio-resolved file path.
    return await _command(request, "mcp_edit", {"conversation_id": conversation_id, **body.model_dump()})


@mcp_router.post("/conversations/{conversation_id}/mcp/save")
async def mcp_save(conversation_id: str, body: McpSaveRequest, request: Request):
    return await _command(request, "mcp_save", {"conversation_id": conversation_id, **body.model_dump(by_alias = True)})


@mcp_router.post("/conversations/{conversation_id}/mcp/release")
async def mcp_release_edit(conversation_id: str, body: McpEditIdentity, request: Request):
    # Drop only an obsolete editor handle, never a conversation or MCP attachment.
    return await _command(request, "mcp_release_edit", {"conversation_id": conversation_id, **body.model_dump()})


router.include_router(mcp_router)
