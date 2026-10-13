# SPDX-License-Identifier: AGPL-3.0-only
"""Authenticated coding entry boundary, independent of ordinary chat execution."""
from __future__ import annotations

import asyncio
import anyio
import base64
import binascii
import json
import os
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Path as ApiPath, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, model_validator

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


MAX_IMAGE_BYTES = 512 * 1024


class SkillMention(BaseModel):
    model_config = ConfigDict(extra = "forbid")
    name: str = Field(min_length = 1, max_length = 512)
    path: str | None = Field(default = None, min_length = 1, max_length = 32768)
    start: int = Field(ge = 0, strict = True)
    end: int = Field(gt = 0, strict = True)


class PromptImage(BaseModel):
    model_config = ConfigDict(extra = "forbid")
    mime_type: Literal["image/png", "image/jpeg", "image/webp", "image/gif"]
    data: str = Field(min_length = 1, max_length = ((MAX_IMAGE_BYTES + 2) // 3) * 4)


class PromptSubmission(BaseModel):
    model_config = ConfigDict(extra = "forbid")
    submission_key: str = Field(min_length = 1, max_length = 128)
    text: str = Field(min_length = 1, max_length = 65536)
    skill_mentions: list[SkillMention] = Field(default_factory = list, max_length = 64)
    images: list[PromptImage] = Field(default_factory = list, max_length = 4)

    @model_validator(mode = "after")
    def validate_input(self):
        if not self.text.strip():
            raise ValueError("Include a nonempty coding text prompt.")
        encoded = self.text.encode("utf-8")
        if len(encoded) > 65536:
            raise ValueError("Coding prompt text must be at most 65536 UTF-8 bytes.")
        previous_end = 0
        for mention in self.skill_mentions:
            if mention.start < previous_end or mention.end <= mention.start or mention.end > len(encoded):
                raise ValueError("Skill mention ranges must be ordered, non-overlapping UTF-8 byte ranges in the exact text.")
            if encoded[mention.start:mention.end] != ("@" + mention.name).encode("utf-8"):
                raise ValueError("A skill mention range must match its exact qualified @name.")
            previous_end = mention.end
        total = 0
        for image in self.images:
            try:
                raw = base64.b64decode(image.data, validate = True)
            except (ValueError, binascii.Error) as exc:
                raise ValueError("Image data must be valid base64, not a URL or host file path.") from exc
            total += len(raw)
            if not raw or total > MAX_IMAGE_BYTES:
                raise ValueError("Coding images must be nonempty and total at most 512 KiB.")
            signatures = {
                "image/png": raw.startswith(b"\x89PNG\r\n\x1a\n"),
                "image/jpeg": raw.startswith(b"\xff\xd8\xff"),
                "image/gif": raw.startswith((b"GIF87a", b"GIF89a")),
                "image/webp": raw.startswith(b"RIFF") and raw[8:12] == b"WEBP",
            }
            if not signatures[image.mime_type]:
                raise ValueError("Image bytes do not match the declared supported MIME type.")
        # Decode/content/provider validation is authoritative in native Mimir.
        return self


class ChildJournal(BaseModel):
    model_config = ConfigDict(extra = "forbid")
    child: str = Field(min_length = 1, max_length = 128, pattern = r"^[^\x00]+$")


class JournalCut(BaseModel):
    model_config = ConfigDict(extra = "forbid")
    journal: Literal["root"] | ChildJournal
    leaf: str | None = Field(max_length = 128)


class BeforeEntry(BaseModel):
    model_config = ConfigDict(extra = "forbid")
    before: str = Field(min_length = 1, max_length = 128)


class AfterEntry(BaseModel):
    model_config = ConfigDict(extra = "forbid")
    after: str = Field(min_length = 1, max_length = 128)


class HistorySelection(BaseModel):
    """An immutable native view cut, never an independently moving snapshot."""
    model_config = ConfigDict(extra = "forbid")
    cut: JournalCut
    anchor: Literal["latest"] | BeforeEntry | AfterEntry = "latest"
    max_entries: int = Field(default = 100, ge = 1, le = 128)
    max_bytes: int = Field(default = 262144, ge = 1024, le = 262144)


def _http_error(exc: CodingRuntimeError) -> HTTPException:
    status = {"invalid": 400, "not_found": 404, "denied": 403,
              "busy": 409, "conflict": 409, "trust_conflict": 409,
              "unavailable": 503, "disconnected": 503, "uncertain": 504,
              "limit": 429, "failed": 502}.get(exc.code, 400)
    return HTTPException(status_code = status, detail = exc.message)


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


@router.get("/diagnostics")
async def diagnostics(request: Request):
    # Does not launch Mimir. This is transport state, not a second execution owner.
    return runtime_for(request.app).diagnostics()


@router.get("/conversations/{conversation_id}/extensions")
async def extensions(conversation_id: str, request: Request,
                     operation_id: str | None = Query(default = None, min_length = 1, max_length = 128, pattern = r"^[A-Za-z0-9_-]+$")):
    params = {"conversation_id": conversation_id}
    if operation_id is not None:
        params["operation_id"] = operation_id
    return await _command(request, "extensions.inspect", params)


class PluginReload(BaseModel):
    model_config = ConfigDict(extra = "forbid")
    operation_id: str = Field(min_length = 1, max_length = 128, pattern = r"^[A-Za-z0-9_-]+$")


@router.post("/conversations/{conversation_id}/plugins/reload")
async def reload_plugins(conversation_id: str, body: PluginReload, request: Request):
    # No retry, cancellation, MCP apply, catalog refresh or frontend replacement.
    return await _command(request, "plugins.reload", {"conversation_id": conversation_id, **body.model_dump()})


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


@router.get("/conversations/{conversation_id}/skills")
async def conversation_skills(conversation_id: str, request: Request):
    # Discover the retained native controller's effective project metadata only.
    # This does not load skill bodies or implicitly open/grant another owner.
    return await _command(request, "skills", {"conversation_id": conversation_id})


@router.post("/conversations/{conversation_id}/prompts", status_code = 202)
async def submit_prompt(conversation_id: str, body: PromptSubmission, request: Request):
    # Mimir admits/deduplicates the submission and owns scheduling and saved input.
    return await _command(request, "prompt", {"conversation_id": conversation_id, **body.model_dump(exclude_unset = True)})


@router.post("/conversations/{conversation_id}/requests/{request_id}/cancel")
async def cancel_request(conversation_id: str, request_id: str, request: Request):
    # Acceptance is not settlement. The ordered native view confirms completion.
    return await _command(request, "cancel", {"conversation_id": conversation_id, "request_id": request_id})


@router.post("/conversations/{conversation_id}/entries")
async def read_entries(conversation_id: str, body: HistorySelection, request: Request):
    return await _command(request, "read_entries", {"conversation_id": conversation_id, **body.model_dump()})


@router.get("/conversations/{conversation_id}/children/{handle}/attempts/{attempt}")
async def child_detail(conversation_id: str, request: Request,
                       handle: str = ApiPath(min_length = 1, max_length = 128, pattern = r"^[^\x00]+$"),
                       attempt: int = ApiPath(ge = 1, le = 4294967295)):
    # SDK inspection never claims the terminal completion owed to Mimir's parent.
    # A current child's newer attempt is not relabeled as the selected old one.
    return await _command(request, "child_detail", {
        "conversation_id": conversation_id, "handle": handle, "attempt": attempt,
    })


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
