# SPDX-License-Identifier: AGPL-3.0-only
"""Studio connections exposed to a signed-in account's Coding runtime."""

from __future__ import annotations

import asyncio
from urllib.parse import quote

from fastapi import HTTPException

from core.inference.external_provider import _is_openai_family_cloud
from core.inference.providers import (
    answers_decisions_only,
    external_model_accepts_images,
    get_connectable_provider_info,
    provider_default_models,
    speaks_native_gemini,
)
from hub.services.models import account_access
from routes.provider_credentials import provider_config_guard, resolve_provider_api_key_or_400
from storage import providers_db


def _connection_models(row: dict | None) -> list[str]:
    if not row or not row["is_enabled"]:
        return []
    kind = row["provider_type"]
    info = get_connectable_provider_info(kind)
    api_type = row.get("api_type") or "chat_completions"
    if (
        not info
        or kind == "openai_codex"
        or (kind == "openai" and _is_openai_family_cloud(row["base_url"] or info["base_url"]))
        or api_type != "chat_completions"
        or answers_decisions_only(kind, api_type)
        or not info.get("supports_streaming")
        or not (
            info.get("openai_compatible", True)
            or (kind == "gemini" and not speaks_native_gemini(row["base_url"]))
        )
    ):
        return []
    if row["models"]:
        return row["models"]
    from routes.providers import cached_catalog_models

    return provider_default_models(kind, cached_catalog_models())


def provider_snapshot(origin: str, token: str) -> list[dict]:
    from routes.providers import cached_catalog_model_context
    from utils.account_context import via_api_key_context

    if via_api_key_context():
        return []
    providers = []
    for row in providers_db.list_providers():
        selected = _connection_models(row)
        if not selected:
            continue
        kind = row["provider_type"]
        info = get_connectable_provider_info(kind)
        output_cap = row.get("max_output_tokens")
        models = [{
            "id": model,
            "name": model,
            "supports_vision": external_model_accepts_images(kind, info.get("supports_vision", False), model, info),
            "context_length": cached_catalog_model_context(kind, model),
            "max_output_tokens": min(output_cap, 2**32 - 1) if output_cap else None,
        } for model in dict.fromkeys(selected)]
        providers.append({
            "id": "studio-connection-" + row["id"], "name": row["display_name"],
            "base_url": f"{origin}/api/coding/connections/{quote(row['id'], safe = '')}/v1",
            "token": token, "models": models,
        })
    return providers


async def connection_request(connection_id: str, payload: dict):
    from core.inference.external_provider import ExternalProviderClient

    model = payload["model"]
    initial = await asyncio.to_thread(providers_db.get_provider, connection_id)
    shared = bool(initial and initial.get("shared_by_owner"))

    def resolve():
        row = providers_db.get_provider(connection_id)
        if not row or shared != bool(row.get("shared_by_owner")) or model not in _connection_models(row):
            raise HTTPException(404, "This model is no longer available from this connection.")
        account_access.require_connection_model_allowed(row, model)
        api_key = resolve_provider_api_key_or_400(connection_id, None)
        info = get_connectable_provider_info(row["provider_type"])
        try:
            client = ExternalProviderClient(
                provider_type = row["provider_type"],
                base_url = row["base_url"] or info["base_url"],
                api_key = api_key, extra_headers = row.get("extra_headers"),
            )
        except ValueError:
            raise HTTPException(400, "This connection has an invalid provider configuration.") from None
        client.set_header_context(None, model)
        cap = row.get("max_output_tokens")
        body = payload
        if cap:
            field = "max_completion_tokens" if "max_completion_tokens" in payload else "max_tokens"
            requested = payload.get(field)
            if requested is not None and (type(requested) is not int or requested <= 0):
                raise HTTPException(400, "The output token limit must be a positive integer.")
            body = {**payload, field: min(requested or cap, cap)}
        return client, body

    async with provider_config_guard(connection_id, shared_by_owner = shared):
        client, body = await asyncio.to_thread(resolve)
    return client.open_chat_completions(body)
