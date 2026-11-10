# SPDX-License-Identifier: AGPL-3.0-only
"""Host projection of Studio's existing downloaded inventory into the native catalog.

No saved inventory, download workflow, or compatibility/certification policy lives
here. Identity and load resolution use the same current Studio inventory rows.
The native execution owner, not the picker or browser, admits request protections.
"""
from __future__ import annotations

import asyncio
import functools
import hashlib
import os
from dataclasses import dataclass
from types import SimpleNamespace

from core.coding_runtime import CodingRuntimeError

PROVIDER_ID = "studio-local"
PROVIDER_NAME = "Studio local"
_CHAT = SimpleNamespace(can_chat = True)
_NO_REASONING = (False, False, ())


def reasoning_controls(path: str | None, model_id: str) -> dict:
    """The thinking controls Studio's own chat offers for this GGUF, from its chat template."""
    try:
        stamp = os.stat(path).st_mtime_ns
    except (OSError, TypeError, ValueError):
        thinking, toggle, levels = _NO_REASONING
    else:
        thinking, toggle, levels = _template_reasoning(path, stamp, model_id)
    return {"thinking": thinking, "toggle": toggle, "levels": list(levels)}


@functools.lru_cache(maxsize = 256)
def _template_reasoning(path: str, _stamp: int, model_id: str) -> tuple[bool, bool, tuple[str, ...]]:
    from core.inference.llama_cpp import detect_reasoning_flags
    from utils.models.gguf_metadata import read_gguf_chat_template

    flags = detect_reasoning_flags(read_gguf_chat_template(path), model_id, log_level = "debug")
    if not flags["supports_reasoning"]:
        return _NO_REASONING
    if flags["reasoning_always_on"]:
        return True, False, ()
    levels = tuple(flags.get("reasoning_effort_levels") or ())
    style = flags["reasoning_style"]
    if style == "reasoning_effort":
        # Same levels Studio's request mapping accepts when the template lists none.
        return True, False, levels or ("low", "medium", "high")
    return True, True, levels if style == "enable_thinking_effort" else ()


def local_choice(row) -> dict:
    # Use the existing semantic inventory identity; the fallback covers old rows.
    identity = row.inventory_id or row.load_id or row.id
    identifier = "local-" + hashlib.sha256(identity.encode("utf-8")).hexdigest()
    load_id = row.load_id or row.id
    variant = getattr(row, "format_variant", None)
    # Loose GGUF file paths already identify an exact quant. Folder/repository
    # choices must keep the explicit variant in their native API-model mapping.
    api_model = f"{load_id}:{variant}" if variant and not load_id.lower().endswith(".gguf") else load_id
    reasoning = getattr(row, "reasoning", None) or reasoning_controls(
        load_id if load_id.lower().endswith(".gguf") else None, load_id,
    )
    return {"id": identifier, "name": row.display_name, "api_model": api_model, "reasoning": reasoning}


async def _cached_gguf_rows() -> tuple[list, set[str]]:
    """One row per fully downloaded quant, as Chat's On Device list shows them."""
    from hub.services.models.cache_inventory import list_cached_gguf_response
    from hub.services.models.gguf_variants import get_gguf_variants_answer

    repos = [repo for repo in (await list_cached_gguf_response())["cached"]
             if (repo.get("capabilities") or {}).get("can_chat")]
    answers = await asyncio.gather(
        *(get_gguf_variants_answer(repo["repo_id"], prefer_local_cache = True, offline = True,
                                   include_cache_locations = True)
          for repo in repos),
        return_exceptions = True,
    )
    rows, files = [], []
    for repo, answer in zip(repos, answers):
        if isinstance(answer, BaseException):
            continue
        repo_id = repo["repo_id"]
        sources = answer.variant_context_sources or {}
        for variant in answer.response.variants:
            if not variant.downloaded or variant.partial:
                continue
            # The first file of the quant (shard 1 for splits) carries its chat template.
            files.append((sources.get(variant.quant.lower()) or (
                os.path.join(answer.context_source, variant.filename) if answer.context_source else None
            ), repo_id))
            rows.append(SimpleNamespace(
                inventory_id = f"{repo.get('inventory_id') or repo_id}:{variant.quant}",
                id = repo_id, load_id = repo.get("load_id") or repo_id, model_format = "gguf",
                display_name = f"{repo_id.split('/')[-1]} · {variant.display_label or variant.quant}",
                format_variant = variant.quant, partial = False, capabilities = _CHAT,
            ))
    controls = await asyncio.to_thread(lambda: [reasoning_controls(path, model) for path, model in files])
    for row, reasoning in zip(rows, controls):
        row.reasoning = reasoning
    return rows, {repo["repo_id"] for repo in repos}


async def downloaded_rows():
    from hub.services.models.local_inventory import list_local_models_response

    gguf_rows, gguf_repos = await _cached_gguf_rows()
    response = await list_local_models_response()
    # Studio's inventory chat classification covers everything outside the GGUF cache
    # (custom folders, loose files, safetensors). Partial downloads stay in model management.
    others = [row for row in response.models
              if row.capabilities.can_chat and not row.partial and row.id not in gguf_repos
              and not (row.source == "hf_cache" and row.model_format in ("gguf", "unknown"))]
    return gguf_rows + others


async def local_catalog() -> dict:
    return {"id": PROVIDER_ID, "name": PROVIDER_NAME,
            "models": [local_choice(row) for row in await downloaded_rows()]}


async def resolve_local_choice(identifier: str):
    for row in await downloaded_rows():
        if local_choice(row)["id"] == identifier:
            return row
    raise CodingRuntimeError("unavailable", "This model is no longer downloaded. Pick another model.")


def _load_error(exc: BaseException) -> CodingRuntimeError:
    """Say why the load was refused or failed, with host paths and secrets scrubbed."""
    from fastapi import HTTPException

    if not isinstance(exc, HTTPException):
        return CodingRuntimeError("failed", "Studio couldn't load the model. Studio's server log has the details.")
    detail = exc.detail.get("message") if isinstance(exc.detail, dict) else exc.detail
    if isinstance(detail, str) and detail.strip():
        from hub.utils.download_registry import scrub_secrets
        from hub.utils.host_paths import redact_paths_in_text

        reason = redact_paths_in_text(scrub_secrets(detail.strip()))[:400]
    else:
        reason = "Studio refused the load without a reason."
    if exc.status_code == 409:
        return CodingRuntimeError("busy", reason)
    return CodingRuntimeError("failed", f"Studio couldn't load the model: {reason}")


@dataclass
class LocalOperation:
    identity: tuple
    state: str = "pending"
    task: asyncio.Task | None = None
    result: dict | None = None
    error: CodingRuntimeError | None = None


class CodingLocalServing:
    """Incarnation-owned admission receipts; the lifecycle owner holds the models.

    HTTP timeout/disconnect cannot discard an acquisition still loading. Release
    waits for that exact acquisition, and a release-before-acquire tombstone makes
    delayed delivery harmless. There is no clock-based request protection expiry.
    """
    def __init__(self, incarnation: str, key: str, subject: str):
        self.incarnation = incarnation
        self.key = key
        self.subject = subject
        self.operations: dict[str, LocalOperation] = {}
        self.closing = False

    async def _load(self, body: dict, request, operation: LocalOperation) -> dict:
        try:
            row = await resolve_local_choice(body["model_id"])
            choice = local_choice(row)
            if body["api_model"] != choice["api_model"]:
                raise CodingRuntimeError("conflict", "This model changed on disk. Pick it again from the model list.")
            from models.inference import LoadRequest
            from routes.inference import load_model_for_coding
            from utils.openai_auto_switch_settings import model_override_load_kwargs, resolve_override_for_load

            # Reuse the existing Studio model-management launch preferences, not
            # a second coding settings store. Borrowing an existing resident still
            # leaves its actual settings untouched inside lifecycle admission.
            load_id = row.load_id or row.id
            variant = row.format_variant if not load_id.lower().endswith(".gguf") else None
            _override_key, override = await asyncio.to_thread(
                resolve_override_for_load, load_id, row.id, variant,
            )
            launch = model_override_load_kwargs(override, is_gguf=row.model_format == "gguf")
            launch.update(model_path=load_id, gguf_variant=variant, force_reload=False,
                          force_cancel_active=False, alongside=False, force_alongside=False)
            await load_model_for_coding(
                LoadRequest(**launch), request, self.subject, body["operation_id"],
            )
            operation.state = "protected"
            operation.result = {"token": body["operation_id"], "model_id": choice["id"],
                                "api_model": choice["api_model"]}
            return operation.result
        except BaseException as exc:
            operation.state = "failed"
            operation.error = exc if isinstance(exc, CodingRuntimeError) else _load_error(exc)
            raise operation.error from None

    async def acquire(self, body: dict, request) -> dict:
        if self.closing:
            raise CodingRuntimeError("unavailable", "The local serving incarnation is shutting down.")
        identifier = body["operation_id"]
        identity = tuple(body[key] for key in ("conversation_id", "request_id", "model_id", "api_model"))
        operation = self.operations.get(identifier)
        if operation is not None:
            if operation.state == "released":
                raise CodingRuntimeError("conflict", "This exact preparation was already released; submit new work explicitly.")
            if operation.identity != identity:
                raise CodingRuntimeError("conflict", "The preparation identity does not match its original request.")
        else:
            if len(self.operations) >= 4096:
                raise CodingRuntimeError("limit", "The serving incarnation has reached its receipt limit. Drain work before restarting the runtime.")
            operation = LocalOperation(identity)
            self.operations[identifier] = operation
            operation.task = asyncio.create_task(self._load(body, request, operation))
            # Consume failures if a disconnected caller never resumes; the receipt
            # remains inspectable and the original exception is returned on retry.
            operation.task.add_done_callback(lambda task: task.exception() if not task.cancelled() else None)
        if operation.error:
            raise operation.error
        return await asyncio.shield(operation.task)

    def inspect(self, identifier: str) -> dict:
        operation = self.operations.get(identifier)
        return {"state": operation.state, **(operation.result or {})} if operation else {"state": "missing"}

    async def release(self, identifier: str) -> dict:
        operation = self.operations.get(identifier)
        if operation is None:
            if len(self.operations) >= 4096:
                raise CodingRuntimeError("limit", "The serving receipt limit prevents release reconciliation. Keep cleanup pending.")
            self.operations[identifier] = LocalOperation((), state="released")
            return {"state": "released"}
        if operation.state == "released":
            return {"state": "released"}
        if operation.task:
            try:
                await asyncio.shield(operation.task)
            except CodingRuntimeError:
                pass  # failed admission acquired no hold
        from core.inference.llama_keepwarm import release_coding_model

        # Mark released only AFTER the authoritative lifecycle owner confirms.
        release_coding_model(identifier)
        operation.state = "released"
        return {"state": "released"}

    async def close(self, *, clean: bool) -> None:
        self.closing = True
        if not clean:
            # Native process exit alone does not confirm tool/child cleanup. Never
            # turn forced termination into a successful protection release.
            return
        for identifier in tuple(self.operations):
            await self.release(identifier)
