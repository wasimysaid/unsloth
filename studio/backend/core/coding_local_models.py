# SPDX-License-Identifier: AGPL-3.0-only
"""Host projection of Studio's existing downloaded inventory into the native catalog.

No saved inventory, download workflow, or compatibility/certification policy lives
here. Identity and load resolution use the same current Studio inventory rows.
The native execution owner, not the picker or browser, admits request protections.
"""
from __future__ import annotations

import asyncio
import hashlib
from dataclasses import dataclass

from core.coding_runtime import CodingRuntimeError

PROVIDER_ID = "studio-local"
PROVIDER_NAME = "Studio local"


def local_choice(row) -> dict:
    # Use the existing semantic inventory identity; the fallback covers old rows.
    identity = row.inventory_id or row.load_id or row.id
    identifier = "local-" + hashlib.sha256(identity.encode("utf-8")).hexdigest()
    load_id = row.load_id or row.id
    variant = getattr(row, "format_variant", None)
    # Loose GGUF file paths already identify an exact quant. Folder/repository
    # choices must keep the explicit variant in their native API-model mapping.
    api_model = f"{load_id}:{variant}" if variant and not load_id.lower().endswith(".gguf") else load_id
    return {
        "id": identifier,
        "name": row.display_name,
        "api_model": api_model,
        "reasoning": "unsupported",
        "default_reasoning": None,
    }


async def downloaded_rows():
    from hub.services.models.local_inventory import list_local_models_response

    response = await list_local_models_response()
    # This is the existing Studio inventory's chat/load classification, not a
    # Mimir capability filter. Partial downloads stay in Studio model management.
    return [row for row in response.models
            if row.capabilities.can_chat and not row.partial]


async def local_catalog() -> dict:
    return {"id": PROVIDER_ID, "name": PROVIDER_NAME,
            "models": [local_choice(row) for row in await downloaded_rows()]}


async def resolve_local_choice(identifier: str):
    for row in await downloaded_rows():
        if local_choice(row)["id"] == identifier:
            return row
    raise CodingRuntimeError(
        "unavailable", "The selected Studio local model is no longer downloaded or accessible. "
        "Refresh the native catalog, retry, or choose a replacement; no model was substituted.",
    )


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
                raise CodingRuntimeError("conflict", "The downloaded model identity changed. Refresh and retry; nothing was substituted.")
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
            # Do not include raw backend exceptions/HTTP detail (which may contain
            # paths, credentials or URLs) in native/browser diagnostics.
            from fastapi import HTTPException
            code = (exc.code if isinstance(exc, CodingRuntimeError) else
                    "busy" if isinstance(exc, HTTPException) and exc.status_code == 409 else
                    "unavailable")
            operation.state = "failed"
            operation.error = CodingRuntimeError(
                code, "Studio local model preparation is busy. Wait for the existing workload, then retry."
                if code == "busy" else
                "Studio local model preparation failed. Check the Studio model runtime and downloaded choice, then explicitly retry. No fallback was used.",
            )
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
        assert operation.task is not None
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
