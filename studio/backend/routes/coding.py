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

from fastapi import APIRouter, Depends, Header, HTTPException, Path as ApiPath, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.routing import APIRoute
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


class RuntimeRestart(BaseModel):
    model_config = ConfigDict(extra = "forbid")
    scope: Literal["all_hosted_conversations"]


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
    overlap_confirmed: bool = Field(default = False, strict = True)
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


class ModeSelection(BaseModel):
    model_config = ConfigDict(extra = "forbid")
    mode: Literal["build", "plan"]


class PlanSelection(BaseModel):
    model_config = ConfigDict(extra = "forbid")
    plan_id: str = Field(min_length = 1, max_length = 128)
    revision: str = Field(min_length = 1, max_length = 256)
    decision: Literal["implement", "implement_fresh", "save_and_stop"]


class GoalChange(BaseModel):
    """Native admission identity, not a Studio lifecycle or completion claim."""
    model_config = ConfigDict(extra = "forbid")
    revision: str = Field(min_length = 1, max_length = 1024)
    action: Literal["start", "edit", "pause", "resume", "clear"]
    objective: str | None = Field(default = None, min_length = 1, max_length = 65536)
    duration_seconds: int | None = Field(default = None, ge = 1800, le = 9007199254740991, strict = True)

    @model_validator(mode = "after")
    def valid_action_fields(self):
        if self.action in ("start", "edit"):
            if not self.objective or not self.objective.strip():
                raise ValueError("Start and edit require a non-empty goal objective.")
        elif "objective" in self.model_fields_set:
            raise ValueError("Only start and edit accept an objective.")
        if self.action not in ("start", "resume") and "duration_seconds" in self.model_fields_set:
            raise ValueError("Only start and resume accept a duration.")
        return self


class QuestionAnswer(BaseModel):
    model_config = ConfigDict(extra = "forbid")
    question_id: str = Field(min_length = 1, max_length = 128)
    selected_options: list[str] = Field(max_length = 4)
    freeform_text: str | None = Field(default = None, max_length = 65536)


class AnswerSubmission(BaseModel):
    model_config = ConfigDict(extra = "forbid")
    subscription: str = Field(min_length = 1, max_length = 128)
    answers: list[QuestionAnswer] = Field(min_length = 1, max_length = 3)


class CommandInvocation(BaseModel):
    model_config = ConfigDict(extra = "forbid")
    operation_id: str = Field(min_length = 1, max_length = 128)
    name: str = Field(min_length = 1, max_length = 256, pattern = r"^[^\s/]+$")
    tail: str = Field(default = "", max_length = 16384)


class ModelConfiguration(BaseModel):
    """Exact native identity/effort only; credential and provider setup stay external."""
    model_config = ConfigDict(extra = "forbid")
    provider: str | None = Field(default = None, min_length = 1, max_length = 1024)
    model: str | None = Field(default = None, min_length = 1, max_length = 1024)
    reasoning: str | None = Field(default = None, min_length = 1, max_length = 1024)


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
    if exc.code == "overlap_required":
        return HTTPException(status_code = 409, detail = {
            "code": exc.code, "message": exc.message, "overlap": exc.overlap,
        })
    status = {"invalid": 400, "not_found": 404, "denied": 403,
              "busy": 409, "conflict": 409, "trust_conflict": 409,
              "runtime_changed": 409, "stale_plan": 409, "stale_goal": 409,
              "unavailable": 503, "disconnected": 503, "uncertain": 504,
              "limit": 429, "failed": 502, "cleanup_failed": 502}.get(exc.code, 400)
    headers = {"Cache-Control": "no-store"}
    if exc.requires_reopen:
        headers["X-Mimir-Requires-Reopen"] = "true"
    return HTTPException(status_code = status, detail = exc.message, headers = headers)


async def _command(request: Request, method: str, params: dict | None = None, *, generation: int | None = None):
    try:
        runtime = runtime_for(request.app)
        if generation is None:
            return await runtime.command(method, params)
        return await runtime.command(method, params, expected_generation = generation)
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


@router.get("/runtime")
async def runtime_status(request: Request):
    return await runtime_for(request.app).inspect_status()


@router.post("/runtime/restart")
async def restart_whole_runtime(body: RuntimeRestart, request: Request):
    # Explicit all-conversation scope, not plugin hot reload. Native admission
    # refuses any busy hosted owner; HTTP disconnect never cancels maintenance.
    try:
        return await runtime_for(request.app).restart()
    except CodingRuntimeError as exc:
        raise _http_error(exc) from exc


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


@router.post("/conversations/{conversation_id}/configuration")
async def configure_model(conversation_id: str, body: ModelConfiguration, request: Request):
    # No Studio scheduler/config store. Mimir orders selection against dequeue and
    # keeps running work frozen; prompts deliberately carry no model configuration.
    return await _command(request, "configure", {
        "conversation_id": conversation_id,
        "configuration": body.model_dump(exclude_unset = True),
    })


@router.get("/conversations/{conversation_id}/overlap")
async def project_overlap(conversation_id: str, request: Request):
    # A read-only native preflight; never implicitly opens or retargets an owner.
    return await _command(request, "overlap", {"conversation_id": conversation_id})


@router.get("/conversations/{conversation_id}/skills")
async def conversation_skills(conversation_id: str, request: Request):
    # Discover the retained native controller's effective project metadata only.
    # This does not load skill bodies or implicitly open/grant another owner.
    return await _command(request, "skills", {"conversation_id": conversation_id})


@router.post("/conversations/{conversation_id}/prompts", status_code = 202)
async def submit_prompt(conversation_id: str, body: PromptSubmission, request: Request,
                        generation: int = Header(alias = "X-Mimir-Runtime-Generation", ge = 1, le = 9007199254740991)):
    # Slash attempts never bypass native command handling, including recovered drafts.
    if body.text.lstrip().startswith("/"):
        raise HTTPException(400, "Slash commands must use native command dispatch; no model prompt was submitted.")
    # Native deduplication and the opening's exact supervisor incarnation both apply.
    return await _command(request, "prompt", {"conversation_id": conversation_id, **body.model_dump(exclude_unset = True), "overlap_confirmed": body.overlap_confirmed}, generation = generation)


@router.post("/conversations/{conversation_id}/requests/{request_id}/cancel")
async def cancel_request(conversation_id: str, request_id: str, request: Request,
                         generation: int = Header(alias = "X-Mimir-Runtime-Generation", ge = 1, le = 9007199254740991)):
    # Acceptance is not settlement. The ordered native view confirms completion.
    return await _command(request, "cancel", {"conversation_id": conversation_id, "request_id": request_id}, generation = generation)


@router.post("/conversations/{conversation_id}/mode")
async def select_mode(conversation_id: str, body: ModeSelection, request: Request,
                      generation: int = Header(alias = "X-Mimir-Runtime-Generation", ge = 1, le = 9007199254740991)):
    # Configuration selection is not plan acceptance; native execution owns admission.
    return await _command(request, "set_mode", {"conversation_id": conversation_id, **body.model_dump()}, generation = generation)


@router.post("/conversations/{conversation_id}/plan-actions")
async def decide_plan(conversation_id: str, body: PlanSelection, request: Request,
                      generation: int = Header(alias = "X-Mimir-Runtime-Generation", ge = 1, le = 9007199254740991)):
    # Validate both the opening's owner generation and exact native plan revision.
    return await _command(request, "decide_plan", {"conversation_id": conversation_id, **body.model_dump()}, generation = generation)


@router.post("/conversations/{conversation_id}/goal")
async def change_goal(conversation_id: str, body: GoalChange, request: Request,
                      generation: int = Header(alias = "X-Mimir-Runtime-Generation", ge = 1, le = 9007199254740991)):
    # Native owner validates revision and admission atomically; the opening's
    # generation prevents delivery to a replacement owner. Never infer completion.
    return await _command(request, "change_goal", {"conversation_id": conversation_id,
                                                  **body.model_dump(exclude_unset = True)}, generation = generation)


@router.post("/conversations/{conversation_id}/requests/{request_id}/questions/{user_request_id}/answers")
async def answer_questions(conversation_id: str, request_id: str, user_request_id: str,
                           body: AnswerSubmission, request: Request,
                           generation: int = Header(alias = "X-Mimir-Runtime-Generation", ge = 1, le = 9007199254740991)):
    # Native admission validates the current request/question/view before accepting
    # the waiter. Public answer history and terminal cleanup are separate evidence;
    # uncertain delivery must be reconciled through the native view, never replayed.
    return await _command(request, "answer", {"conversation_id": conversation_id,
                          "request_id": request_id, "user_request_id": user_request_id,
                          **body.model_dump()}, generation = generation)


@router.get("/conversations/{conversation_id}/commands")
async def discover_commands(conversation_id: str, request: Request):
    return await _command(request, "commands", {"conversation_id": conversation_id})


@router.post("/conversations/{conversation_id}/commands")
async def invoke_command(conversation_id: str, body: CommandInvocation, request: Request,
                         generation: int = Header(alias = "X-Mimir-Runtime-Generation", ge = 1, le = 9007199254740991)):
    # A command may submit native work too; never dispatch it into a replacement owner.
    return await _command(request, "command", {"conversation_id": conversation_id, **body.model_dump()}, generation = generation)


@router.get("/conversations/{conversation_id}/commands/{operation_id}")
async def inspect_command_receipt(conversation_id: str, operation_id: str, request: Request):
    # Read an already-delivered operation. This never invokes/replays a command.
    return await _command(request, "command_receipt", {"conversation_id": conversation_id, "operation_id": operation_id})


@router.get("/conversations/{conversation_id}/diagnostics/{kind}")
async def inspect_diagnostics(conversation_id: str, kind: Literal["context", "tokens", "retry", "execution"], request: Request):
    # Native plugin returns an allowlisted bounded projection, never raw logs/config.
    return await _command(request, "diagnostics", {"conversation_id": conversation_id, "kind": kind})


@router.post("/conversations/{conversation_id}/entries")
async def read_entries(conversation_id: str, body: HistorySelection, request: Request,
                       generation: int = Header(alias = "X-Mimir-Runtime-Generation", ge = 1, le = 9007199254740991)):
    return await _command(request, "read_entries", {"conversation_id": conversation_id, **body.model_dump()}, generation = generation)


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
async def conversation_events(conversation_id: str, request: Request,
                              generation: int = Header(alias = "X-Mimir-Runtime-Generation", ge = 1, le = 9007199254740991)):
    # A GET never implicitly opens an owner or grants project trust. The plugin
    # captures its native ordered view; no snapshot-then-subscribe race exists.
    runtime = runtime_for(request.app)
    try:
        subscription, queue = await runtime.subscribe(conversation_id, expected_generation = generation)
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
                yield "event: disconnected\ndata: " + json.dumps({"message": item.message, "code": item.code, "requires_reopen": item.requires_reopen}) + "\n\n"
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
