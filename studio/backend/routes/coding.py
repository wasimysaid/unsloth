# SPDX-License-Identifier: AGPL-3.0-only
"""Authenticated coding entry boundary, independent of ordinary chat execution."""
from __future__ import annotations

import asyncio
import anyio
import base64
import binascii
import json
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Path as ApiPath, Query, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, model_validator

from auth.authentication import get_current_credential
from core.coding_runtime import CodingRuntimeError, active_runtimes, runtime_for
from models.model_load_config import ModelLoadConfig
from utils.paths import studio_root


async def _coding_credential(request: Request, credential = Depends(get_current_credential)):
    request.state.coding_subject, request.state.coding_credential_generation = credential


router = APIRouter(dependencies = [Depends(_coding_credential)])
Generation = Annotated[int, Header(alias = "X-Mimir-Runtime-Generation", ge = 1, le = 9007199254740991)]


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


class NativeContentResponse(Response):
    """Own production and its temporary file, including disconnect before headers."""
    media_type = "application/json"

    def __init__(self, runtime, conversation_id, selection, generation):
        super().__init__(media_type = self.media_type)
        self.runtime = runtime
        self.conversation_id = conversation_id
        self.selection = selection
        self.generation = generation

    async def __call__(self, scope, receive, send):
        content = None
        async def respond():
            nonlocal content
            try:
                content = await self.runtime.public_entry(self.conversation_id, **self.selection,
                                                         expected_generation = self.generation)
            except CodingRuntimeError as exc:
                error = _http_error(exc)
                await JSONResponse({"detail": error.detail}, status_code = error.status_code,
                                   headers = error.headers)(scope, receive, send)
                return
            await send({"type": "http.response.start", "status": 200,
                        "headers": [(b"content-type", b"application/json"), (b"cache-control", b"no-store")]})
            while data := await anyio.to_thread.run_sync(content.read, 65536):
                await send({"type": "http.response.body", "body": data, "more_body": True})
            await send({"type": "http.response.body", "body": b"", "more_body": False})

        try:
            async with anyio.create_task_group() as tasks:
                async def serve():
                    try:
                        await respond()
                    finally:
                        tasks.cancel_scope.cancel()
                tasks.start_soon(serve)
                while True:
                    message = await receive()
                    if message["type"] == "http.disconnect":
                        tasks.cancel_scope.cancel()
                        break
        finally:
            if content is not None:
                self.runtime.release_content(content)


class ModelConfiguration(BaseModel):
    model_config = ConfigDict(extra = "forbid")
    provider: str | None = Field(default = None, min_length = 1, max_length = 1024)
    model: str | None = Field(default = None, min_length = 1, max_length = 1024)
    reasoning: str | None = Field(default = None, min_length = 1, max_length = 1024)
    preserve_thinking: bool | None = Field(default = None, strict = True)


class ProjectSelection(BaseModel):
    model_config = ConfigDict(extra = "forbid")
    cwd: str | None = Field(default = None, min_length = 1, max_length = 32768)
    # The first request's selection, chosen before the conversation existed.
    configuration: ModelConfiguration | None = None


class RuntimeRestart(BaseModel):
    model_config = ConfigDict(extra = "forbid")
    scope: Literal["all_hosted_conversations"]


MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024


class SkillMention(BaseModel):
    model_config = ConfigDict(extra = "forbid")
    name: str = Field(min_length = 1, max_length = 512)
    path: str | None = Field(default = None, min_length = 1, max_length = 32768)
    start: int = Field(ge = 0, strict = True)
    end: int = Field(gt = 0, strict = True)


class SubagentMention(BaseModel):
    model_config = ConfigDict(extra = "forbid")
    name: str = Field(min_length = 1, max_length = 512)
    start: int = Field(ge = 0, strict = True)
    end: int = Field(gt = 0, strict = True)


class FileMention(BaseModel):
    model_config = ConfigDict(extra = "forbid")
    path: str = Field(min_length = 1, max_length = 32768)
    kind: Literal["file", "directory"]
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
    subagent_mentions: list[SubagentMention] = Field(default_factory = list, max_length = 64)
    file_mentions: list[FileMention] = Field(default_factory = list, max_length = 64)
    images: list[PromptImage] = Field(default_factory = list, max_length = 4)

    @model_validator(mode = "after")
    def validate_input(self):
        if not self.text.strip():
            raise ValueError("Include a nonempty coding text prompt.")
        encoded = self.text.encode("utf-8")
        if len(encoded) > 65536:
            raise ValueError("Coding prompt text must be at most 65536 UTF-8 bytes.")
        for mentions in (self.skill_mentions, self.subagent_mentions, self.file_mentions):
            previous_end = 0
            for mention in mentions:
                if isinstance(mention, FileMention):
                    if any(ord(char) < 32 or ord(char) == 127 for char in mention.path) or len(mention.path.encode("utf-8")) > 32768:
                        raise ValueError("File references require a bounded path without control characters.")
                    path = mention.path if mention.kind == "file" else mention.path.rstrip("/") + "/"
                    expected = (("@" + path).encode("utf-8"), ('@"' + path + '"').encode("utf-8"))
                else:
                    expected = (("@" + mention.name).encode("utf-8"),)
                if mention.start < previous_end or mention.end <= mention.start or mention.end > len(encoded):
                    raise ValueError("Mention ranges must be ordered, non-overlapping UTF-8 byte ranges in the exact text.")
                if encoded[mention.start:mention.end] not in expected:
                    raise ValueError("A mention range must match its exact @name or @path.")
                previous_end = mention.end
        mentions = sorted([*self.skill_mentions, *self.subagent_mentions, *self.file_mentions], key = lambda mention: mention.start)
        if len(mentions) > 64:
            raise ValueError("A coding prompt accepts at most 64 selected mentions.")
        if any(left.end > right.start for left, right in zip(mentions, mentions[1:])):
            raise ValueError("Selected mention ranges must not overlap.")
        total = 0
        for image in self.images:
            try:
                raw = base64.b64decode(image.data, validate = True)
            except (ValueError, binascii.Error) as exc:
                raise ValueError("Image data must be valid base64, not a URL or host file path.") from exc
            total += len(raw)
            if not raw or len(raw) > MAX_IMAGE_BYTES or total > MAX_TOTAL_IMAGE_BYTES:
                raise ValueError("Coding images must be nonempty, at most 10 MiB each and 20 MiB total.")
            signatures = {
                "image/png": raw.startswith(b"\x89PNG\r\n\x1a\n"),
                "image/jpeg": raw.startswith(b"\xff\xd8\xff"),
                "image/gif": raw.startswith((b"GIF87a", b"GIF89a")),
                "image/webp": raw.startswith(b"RIFF") and raw[8:12] == b"WEBP",
            }
            if not signatures[image.mime_type]:
                raise ValueError("Image bytes do not match the declared supported MIME type.")
        return self


class ModeSelection(BaseModel):
    model_config = ConfigDict(extra = "forbid")
    mode: Literal["build", "plan"]


class TerminalPermissionSelection(BaseModel):
    model_config = ConfigDict(extra = "forbid")
    mode: Literal["ask", "auto", "off", "full"]


class PlanSelection(BaseModel):
    model_config = ConfigDict(extra = "forbid")
    plan_id: str = Field(min_length = 1, max_length = 128)
    revision: str = Field(min_length = 1, max_length = 256)
    decision: Literal["implement", "implement_fresh", "save_and_stop"]


class GoalChange(BaseModel):
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
    # Unbounded here: the whole command frame bounds it, and Mimir validates the question.
    question_id: str = Field(min_length = 1)
    selected_options: list[str] = Field(max_length = 4)
    freeform_text: str | None = None


class AnswerSubmission(BaseModel):
    model_config = ConfigDict(extra = "forbid")
    subscription: str = Field(min_length = 1, max_length = 128)
    answers: list[QuestionAnswer] = Field(min_length = 1, max_length = 3)


class CommandInvocation(BaseModel):
    model_config = ConfigDict(extra = "forbid")
    operation_id: str = Field(min_length = 1, max_length = 128)
    name: str = Field(min_length = 1, max_length = 256, pattern = r"^[^\s/]+$")
    tail: str = Field(default = "", max_length = 16384)


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
    model_config = ConfigDict(extra = "forbid")
    cut: JournalCut
    anchor: Literal["latest"] | BeforeEntry | AfterEntry = "latest"
    max_entries: int = Field(default = 100, ge = 1, le = 128)
    max_bytes: int = Field(default = 262144, ge = 1024, le = 262144)


class PublicEntrySelection(BaseModel):
    model_config = ConfigDict(extra = "forbid")
    cut: JournalCut
    entry_id: str = Field(min_length = 1, max_length = 128)


def _http_error(exc: CodingRuntimeError) -> HTTPException:
    if exc.code == "overlap_required":
        return HTTPException(status_code = 409, detail = {
            "code": exc.code, "message": exc.message, "overlap": exc.overlap,
        })
    status = {"invalid": 400, "invalid_answer": 400, "unsupported_command": 400, "not_found": 404, "denied": 403,
              "busy": 409, "conflict": 409, "stale_answer": 409, "trust_conflict": 409,
              "runtime_changed": 409, "stale_plan": 409, "stale_goal": 409,
              "unavailable": 503, "disconnected": 503, "uncertain": 504,
              "limit": 429, "failed": 502, "cleanup_failed": 502, "protocol": 502}.get(exc.code, 502)
    headers = {"Cache-Control": "no-store"}
    if exc.requires_reopen:
        headers["X-Mimir-Requires-Reopen"] = "true"
    return HTTPException(status_code = status, detail = exc.message, headers = headers)


async def _runtime(request: Request):
    runtime = runtime_for(request.app)
    await runtime.configure_local_serving(request)
    return runtime


async def _command(request: Request, method: str, params: dict | None = None, *, generation: int | None = None):
    try:
        runtime = await _runtime(request)
        if generation is None:
            return await runtime.command(method, params)
        return await runtime.command(method, params, expected_generation = generation)
    except CodingRuntimeError as exc:
        raise _http_error(exc) from exc


class LocalOperationIdentity(BaseModel):
    model_config = ConfigDict(extra = "forbid")
    incarnation: str = Field(min_length = 1, max_length = 128)
    operation_id: str = Field(min_length = 1, max_length = 128)


class LocalPreparation(LocalOperationIdentity):
    conversation_id: str = Field(min_length = 1, max_length = 128)
    request_id: str = Field(min_length = 1, max_length = 128)
    model_id: str = Field(min_length = 1, max_length = 1024)
    api_model: str = Field(min_length = 1, max_length = 32768)


def _local_serving(request: Request, incarnation: str | None = None):
    import secrets

    header = request.headers.get("authorization", "")
    token = header[7:] if header.lower().startswith("bearer ") else ""
    for runtime in active_runtimes(request.app):
        serving = runtime.local_serving
        if (serving is not None and not serving.closing and secrets.compare_digest(token.encode(), serving.key.encode())
                and (incarnation is None or incarnation == serving.incarnation)):
            return serving
    raise HTTPException(403, "This operation requires the current native serving incarnation.")


class LocalModelLoad(BaseModel):
    model_config = ConfigDict(extra = "forbid")
    config: ModelLoadConfig | None = None
    force_reload: bool = False
    load_request_id: str = Field(min_length = 1, max_length = 128, pattern = r"^[A-Za-z0-9][A-Za-z0-9._:-]*$")


@router.get("/model-inventory")
async def browser_model_inventory():
    from core.coding_local_models import model_inventory
    return JSONResponse(await model_inventory(), headers = {"Cache-Control": "no-store"})


@router.get("/models/{model_id}/state")
async def browser_model_state(model_id: str, request: Request):
    from core.coding_local_models import local_model_state
    try:
        return await local_model_state(model_id, request.state.coding_subject)
    except CodingRuntimeError as exc:
        raise _http_error(exc) from exc


@router.post("/models/{model_id}/load")
async def browser_load_model(model_id: str, body: LocalModelLoad, request: Request):
    from core.coding_local_models import local_load_request
    from routes.inference import load_model
    try:
        load = await local_load_request(
            model_id, body.load_request_id, config = body.config, force_reload = body.force_reload,
        )
        # The shared loader consults Keep models loaded and owns slot placement.
        return await load_model(load.model_copy(update = {"alongside": True}),
                                request, request.state.coding_subject)
    except CodingRuntimeError as exc:
        raise _http_error(exc) from exc


@router.post("/models/{model_id}/unload")
async def browser_unload_model(model_id: str, request: Request, load_request_id: str | None = None):
    from core.coding_local_models import local_load_request
    from models.inference import UnloadRequest
    from routes.inference import _model_key, unload_model
    try:
        load = await local_load_request(model_id)
        target = load.model_path if load_request_id else _model_key(load)
        return await unload_model(UnloadRequest(model_path = target, cancel_load_request_id = load_request_id),
                                  request.state.coding_subject)
    except CodingRuntimeError as exc:
        raise _http_error(exc) from exc


@router.get("/local-models/catalog")
async def local_models_catalog(request: Request):
    serving = _local_serving(request)
    from core.coding_local_models import local_catalog
    try:
        return JSONResponse(await local_catalog(serving.subject), headers = {"Cache-Control": "no-store"})
    except Exception:
        raise HTTPException(503, "Studio downloaded model inventory is unavailable. Retry explicitly.") from None


@router.post("/local-models/acquire")
async def acquire_local_model(body: LocalPreparation, request: Request):
    serving = _local_serving(request, body.incarnation)
    try:
        return await serving.acquire(body.model_dump(), request)
    except CodingRuntimeError as exc:
        raise _http_error(exc) from exc


@router.post("/local-models/inspect")
async def inspect_local_model(body: LocalOperationIdentity, request: Request):
    return _local_serving(request, body.incarnation).inspect(body.operation_id)


@router.post("/local-models/release")
async def release_local_model(body: LocalOperationIdentity, request: Request):
    serving = _local_serving(request, body.incarnation)
    try:
        return await serving.release(body.operation_id)
    except CodingRuntimeError as exc:
        raise _http_error(exc) from exc


def _is_git_folder(path: Path) -> bool:
    try:
        marker = path / ".git"
        return marker.is_dir() or marker.is_file()
    except OSError:
        return False


def _browse(path: str | None, complete: bool = False, hidden: bool = False) -> dict:
    """Read host folders only. Completion never grants project execution authority."""
    try:
        query = (path or "").strip()
        if len(query) >= 2 and query[0] == query[-1] and query[0] in ("'", '"'):
            query = query[1:-1]
        target = Path(query).expanduser() if query else Path.home()
        leaf = ""
        try:
            target = target.resolve(strict = True)
        except FileNotFoundError:
            # Only the final component is a completion. A missing ancestor is an error.
            if not complete:
                raise
            leaf = target.name
            target = target.parent.resolve(strict = True)
        if not target.is_dir():
            raise HTTPException(400, "Choose a host directory, not a file.")
        if not os.access(target, os.R_OK | os.X_OK):
            raise PermissionError()
        entries = []
        truncated = False
        with os.scandir(target) as children:
            for child in children:
                if child.name.startswith(".") and not (hidden or leaf.startswith(".")):
                    continue
                if not child.name.casefold().startswith(leaf.casefold()):
                    continue
                try:
                    if not child.is_dir():
                        continue
                except OSError:
                    continue
                if len(entries) == 200:
                    truncated = True
                    break
                entries.append({"name": child.name, "path": child.path,
                                "is_git": _is_git_folder(Path(child.path))})
        entries.sort(key = lambda entry: entry["name"].casefold())
        return {"path": str(target),
                "parent": str(target.parent) if target.parent != target else None,
                "entries": entries, "truncated": truncated, "filter": leaf,
                "is_git": _is_git_folder(target)}
    except FileNotFoundError as exc:
        raise HTTPException(404, "That host folder does not exist. Check the path or choose its parent.") from exc
    except PermissionError as exc:
        raise HTTPException(403, "The host OS denies access to that folder. Choose another folder or ask its owner for access.") from exc
    except (OSError, ValueError, RuntimeError) as exc:
        raise HTTPException(400, "That host folder cannot be read. Check the path and host permissions.") from exc


@router.get("/runtime")
async def runtime_status(request: Request):
    try:
        return await runtime_for(request.app).inspect_status()
    except CodingRuntimeError as exc:
        raise _http_error(exc) from exc


@router.post("/runtime/restart")
async def restart_whole_runtime(body: RuntimeRestart, request: Request):
    try:
        return await (await _runtime(request)).restart()
    except CodingRuntimeError as exc:
        raise _http_error(exc) from exc


@router.get("/projects/browse")
async def browse_projects(
    path: str | None = Query(default = None, max_length = 32768),
    complete: bool = False,
    hidden: bool = False,
):
    return await asyncio.to_thread(_browse, path, complete, hidden)


def _local_checkouts(path: str):
    project = Path(path).expanduser().resolve()
    try:
        listing = subprocess.run(
            ["git", "-C", str(project), "worktree", "list", "--porcelain", "-z"],
            capture_output = True, timeout = 3, check = False,
        )
    except FileNotFoundError:
        return []
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(503, "Git took too long to list the local checkouts.") from exc
    if listing.returncode:
        return []
    checkouts = []
    for record in listing.stdout.split(b"\0\0"):
        fields = {}
        for field in record.split(b"\0"):
            name, _, value = field.partition(b" ")
            fields[name] = value
        if b"worktree" not in fields or b"bare" in fields or b"prunable" in fields:
            continue
        cwd = Path(os.fsdecode(fields[b"worktree"]))
        if not cwd.is_dir():
            continue
        branch = fields.get(b"branch", b"").removeprefix(b"refs/heads/")
        checkouts.append({"cwd": str(cwd), "branch": os.fsdecode(branch) or None,
                          "head": fields.get(b"HEAD", b"")[:8].decode("ascii"), "current": False})
    # A selected subdirectory belongs to its innermost checkout.
    current = max((item for item in checkouts if project.is_relative_to(item["cwd"])),
                  key = lambda item: len(item["cwd"]), default = None)
    if current:
        current["current"] = True
    return sorted(checkouts, key = lambda item: (not item["current"], item["branch"] or item["cwd"]))


@router.get("/projects/checkouts")
async def local_checkouts(path: str = Query(min_length = 1, max_length = 32768)):
    _project_text(path, 32768)
    return await asyncio.to_thread(_local_checkouts, path)


@router.get("/projects/branches")
async def local_branches(path: str = Query(min_length = 1, max_length = 32768)):
    _project_text(path, 32768)
    try:
        result = await asyncio.to_thread(
            subprocess.run,
            ["git", "-C", path, "for-each-ref", "--format=%(refname:lstrip=2)", "refs/heads/"],
            capture_output = True, timeout = 5, check = True,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise HTTPException(503, "Could not read local branches.") from exc
    return os.fsdecode(result.stdout).splitlines()


@router.get("/catalog")
async def catalog(request: Request, cwd: str | None = Query(default = None, min_length = 1, max_length = 32768)):
    # Model choices before any folder is chosen are the host home's effective settings.
    return await _command(request, "catalog", {"cwd": cwd or str(Path.home())})


@router.get("/conversations/{conversation_id}/models")
async def conversation_models(conversation_id: str, request: Request):
    result = await _command(request, "models", {"conversation_id": conversation_id})
    return JSONResponse(result, headers = {"Cache-Control": "no-store"})


@router.post("/conversations/{conversation_id}/models/refresh")
async def refresh_models(conversation_id: str, request: Request):
    result = await _command(request, "models.refresh", {"conversation_id": conversation_id})
    return JSONResponse(result, headers = {"Cache-Control": "no-store"})


def _project_text(value: str, limit: int, *, relative: bool = False, empty: bool = False):
    if ((not empty and not value.strip()) or len(value.encode("utf-8")) > limit
            or any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in value)
            or (relative and ("\\" in value or ":" in value
                              or (value and any(part in ("", ".", "..") for part in value.split("/")))))):
        raise HTTPException(422, "Choose a valid path or search within the selected project.")


@router.get("/project/directory")
async def project_directory(request: Request,
                            project_path: str = Query(min_length = 1, max_length = 16384),
                            path: str = Query(default = "", max_length = 16384),
                            show_hidden: bool = False):
    _project_text(project_path, 16384)
    _project_text(path, 16384, relative = True, empty = True)
    return await _command(request, "project_directory", {
        "project_path": project_path, "path": path, "show_hidden": show_hidden,
    })


@router.get("/project/search")
async def project_search(request: Request,
                         project_path: str = Query(min_length = 1, max_length = 16384),
                         query: str = Query(min_length = 1, max_length = 1024),
                         show_hidden: bool = False):
    _project_text(project_path, 16384)
    _project_text(query, 1024)
    return await _command(request, "project_search", {
        "project_path": project_path, "query": query, "show_hidden": show_hidden,
    })


@router.get("/project/file")
async def project_file(request: Request,
                       project_path: str = Query(min_length = 1, max_length = 16384),
                       path: str = Query(min_length = 1, max_length = 16384),
                       offset: int = Query(default = 0, ge = 0, le = 9007199254740991),
                       limit: int = Query(default = 131072, ge = 4, le = 262144),
                       revision: str | None = Query(default = None, min_length = 1, max_length = 128)):
    _project_text(project_path, 16384)
    _project_text(path, 16384, relative = True)
    if offset and revision is None:
        raise HTTPException(422, "The next file section requires its previous revision.")
    if revision is not None:
        _project_text(revision, 128)
    return await _command(request, "project_file", {
        "project_path": project_path, "path": path, "offset": offset,
        "limit": limit, "revision": revision,
    })


@router.get("/conversations")
async def conversations(request: Request, cursor: str | None = Query(default = None, max_length = 16384)):
    page = await _command(request, "list", {"cursor": cursor})
    return {"conversations": [_conversation_info(info) for info in page["sessions"]],
            "next_cursor": page.get("next_cursor")}


def _chat_workspaces() -> Path:
    return studio_root() / "coding" / "chats"


def _conversation_info(info: dict) -> dict:
    # Managed chat directories are durable native working directories, not user projects.
    if Path(info["cwd"]).parent.resolve() == _chat_workspaces().resolve():
        return {**info, "cwd": None}
    return info


@router.post("/conversations", status_code = 201)
async def create_conversation(body: ProjectSelection, request: Request):
    cwd = body.cwd
    if cwd is None:
        root = _chat_workspaces()
        root.mkdir(parents = True, exist_ok = True)
        cwd = tempfile.mkdtemp(prefix = "chat-", dir = root)
    params = {"cwd": cwd}
    if body.configuration is not None:
        params["configuration"] = body.configuration.model_dump(exclude_none = True)
    state = await _command(request, "create", params)
    return _conversation_info(state["info"])


@router.post("/conversations/{conversation_id}/open")
async def open_conversation(conversation_id: str, request: Request):
    state = await _command(request, "open", {"conversation_id": conversation_id})
    return _conversation_info(state["info"])


@router.post("/conversations/{conversation_id}/configuration")
async def configure_model(conversation_id: str, body: ModelConfiguration, request: Request,
                          generation: Generation):
    return await _command(request, "configure", {
        "conversation_id": conversation_id,
        "configuration": body.model_dump(exclude_unset = True),
    }, generation = generation)


@router.get("/conversations/{conversation_id}/overlap")
async def project_overlap(conversation_id: str, request: Request):
    return await _command(request, "overlap", {"conversation_id": conversation_id})


@router.get("/conversations/{conversation_id}/skills")
async def conversation_skills(conversation_id: str, request: Request):
    return await _command(request, "skills", {"conversation_id": conversation_id})


@router.get("/conversations/{conversation_id}/subagents")
async def conversation_subagents(conversation_id: str, request: Request):
    return await _command(request, "subagents", {"conversation_id": conversation_id})


@router.get("/conversations/{conversation_id}/files")
async def conversation_files(conversation_id: str, request: Request,
                             query: str = Query(default = "", max_length = 1024),
                             max_results: int = Query(default = 40, ge = 1, le = 40)):
    if len(query.encode("utf-8")) > 1024 or any(ord(char) < 32 or ord(char) == 127 for char in query):
        raise HTTPException(422, "File search text is too long or contains invalid characters.")
    return await _command(request, "files", {"conversation_id": conversation_id, "query": query, "max_results": max_results})


@router.post("/conversations/{conversation_id}/prompts", status_code = 202)
async def submit_prompt(conversation_id: str, body: PromptSubmission, request: Request,
                        generation: Generation):
    if body.text.lstrip().startswith("/"):
        raise HTTPException(400, "Run slash commands from the command menu.")
    return await _command(request, "prompt", {"conversation_id": conversation_id, **body.model_dump(exclude_unset = True), "overlap_confirmed": body.overlap_confirmed}, generation = generation)


@router.post("/conversations/{conversation_id}/requests/{request_id}/cancel")
async def cancel_request(conversation_id: str, request_id: str, request: Request,
                         generation: Generation):
    return await _command(request, "cancel", {"conversation_id": conversation_id, "request_id": request_id}, generation = generation)


@router.post("/conversations/{conversation_id}/mode")
async def select_mode(conversation_id: str, body: ModeSelection, request: Request,
                      generation: Generation):
    return await _command(request, "set_mode", {"conversation_id": conversation_id, **body.model_dump()}, generation = generation)


@router.get("/conversations/{conversation_id}/terminal-permissions")
async def terminal_permissions(conversation_id: str, request: Request, response: Response,
                               generation: Generation):
    response.headers["Cache-Control"] = "no-store"
    return await _command(request, "terminal_permissions", {"conversation_id": conversation_id},
                          generation = generation)


@router.put("/conversations/{conversation_id}/terminal-permissions")
async def set_terminal_permissions(conversation_id: str, body: TerminalPermissionSelection,
                                   request: Request, generation: Generation):
    from state.tool_policy import require_tool_access

    require_tool_access(body.mode)
    return await _command(request, "terminal_permissions",
                          {"conversation_id": conversation_id, "mode": body.mode}, generation = generation)


@router.post("/conversations/{conversation_id}/plan-actions")
async def decide_plan(conversation_id: str, body: PlanSelection, request: Request,
                      generation: Generation):
    return await _command(request, "decide_plan", {"conversation_id": conversation_id, **body.model_dump()}, generation = generation)


@router.post("/conversations/{conversation_id}/goal")
async def change_goal(conversation_id: str, body: GoalChange, request: Request,
                      generation: Generation):
    return await _command(request, "change_goal", {"conversation_id": conversation_id,
                                                  **body.model_dump(exclude_unset = True)}, generation = generation)


@router.post("/conversations/{conversation_id}/requests/{request_id}/questions/{user_request_id}/answers")
async def answer_questions(conversation_id: str, request_id: str, user_request_id: str,
                           body: AnswerSubmission, request: Request,
                           generation: Generation):
    return await _command(request, "answer", {"conversation_id": conversation_id,
                          "request_id": request_id, "user_request_id": user_request_id,
                          **body.model_dump()}, generation = generation)


@router.get("/conversations/{conversation_id}/commands")
async def discover_commands(conversation_id: str, request: Request):
    return await _command(request, "commands", {"conversation_id": conversation_id})


@router.post("/conversations/{conversation_id}/commands")
async def invoke_command(conversation_id: str, body: CommandInvocation, request: Request,
                         generation: Generation):
    return await _command(request, "command", {"conversation_id": conversation_id, **body.model_dump()}, generation = generation)


@router.get("/conversations/{conversation_id}/commands/{operation_id}")
async def inspect_command_receipt(conversation_id: str, operation_id: str, request: Request):
    return await _command(request, "command_receipt", {"conversation_id": conversation_id, "operation_id": operation_id})


@router.post("/conversations/{conversation_id}/entries")
async def read_entries(conversation_id: str, body: HistorySelection, request: Request,
                       generation: Generation):
    return await _command(request, "read_entries", {"conversation_id": conversation_id, **body.model_dump()}, generation = generation)


@router.post("/conversations/{conversation_id}/public-entry")
async def read_public_entry(conversation_id: str, body: PublicEntrySelection, request: Request,
                            generation: Generation):
    try:
        runtime = await _runtime(request)
    except CodingRuntimeError as exc:
        raise _http_error(exc) from exc
    return NativeContentResponse(runtime, conversation_id, body.model_dump(), generation)


@router.get("/conversations/{conversation_id}/children/{handle}/attempts/{attempt}")
async def child_detail(conversation_id: str, request: Request,
                       handle: str = ApiPath(min_length = 1, max_length = 128, pattern = r"^[^\x00]+$"),
                       attempt: int = ApiPath(ge = 1, le = 4294967295)):
    return await _command(request, "child_detail", {
        "conversation_id": conversation_id, "handle": handle, "attempt": attempt,
    })


@router.get("/conversations/{conversation_id}/events")
async def conversation_events(conversation_id: str, request: Request,
                              generation: Generation):
    try:
        runtime = await _runtime(request)
        subscription, queue = await runtime.subscribe(conversation_id, expected_generation = generation)
        observation_epoch = runtime.observation_epoch
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
            # Positions are only comparable within the epoch this view was opened in.
            envelope = {**item, "observation_epoch": observation_epoch}
            yield "event: view\ndata: " + json.dumps(envelope, separators = (",", ":")) + "\n\n"
            if item.get("event", {}).get("type") in ("closed", "invalidated"):
                return

    # Disconnect releases only this view; the conversation keeps running.
    return NativeViewResponse(events(), runtime, subscription)
