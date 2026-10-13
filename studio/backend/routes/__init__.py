# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

"""API route exports, loaded only when requested.

Importing the independent coding/auth boundary must not initialize ordinary-chat
inference or training. The full application still requests the same routers.
"""
from importlib import import_module

_EXPORTS = {
    "training_router": ("training", "router"),
    "models_router": ("models", "router"),
    "inference_router": ("inference", "router"),
    "inference_studio_router": ("inference", "studio_router"),
    "video_router": ("video", "router"),
    "video_openai_router": ("video", "openai_router"),
    "datasets_router": ("datasets", "router"),
    "auth_router": ("auth", "router"),
    "data_recipe_router": ("data_recipe", "router"),
    "export_router": ("export", "router"),
    "training_history_router": ("training_history", "router"),
    "chat_history_router": ("chat_history", "router"),
    "external_import_router": ("external_import", "router"),
    "providers_router": ("providers", "router"),
    "openai_codex_auth_router": ("openai_codex_auth", "router"),
    "mcp_servers_router": ("mcp_servers", "router"),
    "skills_router": ("skills", "router"),
    "rag_router": ("rag", "router"),
    "research_runs_router": ("research_runs", "router"),
    "chat_generation_runs_router": ("chat_generation_runs", "router"),
    "youtube_router": ("youtube", "router"),
}
__all__ = list(_EXPORTS)


def __getattr__(name):
    if name not in _EXPORTS:
        raise AttributeError(name)
    module, attribute = _EXPORTS[name]
    value = getattr(import_module(f"routes.{module}"), attribute)
    globals()[name] = value
    return value
