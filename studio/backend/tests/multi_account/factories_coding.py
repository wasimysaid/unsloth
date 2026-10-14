# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

"""Coding authenticates Studio subjects but delegates one host's history to Mimir.

The native protocol double below is only for HTTP authorization tests; native
ownership, persistence and framing are verified by the coding integration tests.
"""

import asyncio
import json
import uuid

from utils.account_context import current_account

from .factory_base import Factory, seeder
from .seed import SENTINEL

CONVERSATION_ID = "shared-native-matrix-conversation"
_SHARED_HISTORY_REASON = (
    "Coding uses authenticated shared-host Mimir history, not Studio account-owned "
    "resources. Owner and other active subjects intentionally access the same native "
    "conversation; unauthenticated and deactivated subjects remain rejected."
)


@seeder("coding-conversation")
def seed_conversation(account) -> dict[str, str]:
    from storage import studio_db
    from utils.account_context import run_as

    # Finish the existing account's ordinary schema setup before taking the matrix
    # snapshot; authentication may initialize it on first access. No Studio coding
    # record/profile is created: the conversation ID belongs to the shared host.
    assert run_as(account, studio_db.list_chat_threads) == []
    return {"conversation_id": CONVERSATION_ID}


class NativeCodingBoundary:
    def __init__(self):
        self.observation_epoch = uuid.uuid4().hex
        self.subjects = []
        self.operations = []
        self.released = []

    async def command(self, method, params, *, expected_generation=None):
        assert params["conversation_id"] == CONVERSATION_ID
        assert expected_generation == (1 if method in GENERATION_METHODS else None)
        self.subjects.append(current_account().username)
        self.operations.append(method)
        if method == "open":
            assert params == {"conversation_id": CONVERSATION_ID}
            return {"info": {"conversation_id": CONVERSATION_ID, "title": SENTINEL}}
        assert method in NATIVE_OPERATIONS.values()
        if not method.startswith("mcp_"):
            # Authorization-only response, not a claim about native execution.
            # Full native result shapes are asserted in the focused coding tests.
            return {"title": SENTINEL}
        if method in ("mcp_apply", "mcp_reconnect", "mcp_inspect_operation"):
            assert params["operation_id"] == "matrix-operation"
            return {"operation_id": "matrix-operation", "title": SENTINEL}
        if method == "mcp_release_edit":
            return {"released": True}
        if method == "mcp_inventory":
            return {"documents": [{"label": SENTINEL}], "entries": [], "effective": [], "live": [], "diagnostics": []}
        draft = {"edit_id": "matrix-edit", "source": "matrix-source", "name": SENTINEL,
                 "revision": "matrix-revision", "json": "{}"}
        return draft if method == "mcp_edit" else {"draft": draft, "inventory": {"documents": []}}

    async def subscribe(self, conversation_id, *, expected_generation):
        assert expected_generation == 1
        assert conversation_id == CONVERSATION_ID
        self.subjects.append(current_account().username)
        self.operations.append("view")
        subscription = f"matrix-view-{len(self.subjects)}"
        queue = asyncio.Queue()
        queue.put_nowait({"position": 1, "event": {"type": "closed", "title": SENTINEL}})
        return subscription, queue

    async def unsubscribe(self, subscription):
        self.released.append(subscription)


FACTORIES = {
    "routes.coding:POST:/conversations/{conversation_id}/open": Factory(
        "coding-conversation", fragment = SENTINEL,
        owner = (200,), wrong = (200,), reason = _SHARED_HISTORY_REASON,
    ),
    "routes.coding:GET:/conversations/{conversation_id}/events": Factory(
        # SSE carries raw JSON text, unlike FastAPI's decoded Unicode JSON body.
        "coding-conversation", fragment = json.dumps(SENTINEL)[1:-1],
        owner = (200,), wrong = (200,), reason = _SHARED_HISTORY_REASON,
    ),
    "routes.coding:GET:/conversations/{conversation_id}/mcp/inventory": Factory(
        "coding-conversation", fragment = SENTINEL,
        owner = (200,), wrong = (200,), reason = _SHARED_HISTORY_REASON,
    ),
    "routes.coding:POST:/conversations/{conversation_id}/mcp/edit": Factory(
        "coding-conversation", {"source": "matrix-source", "name": "server"}, fragment = SENTINEL,
        owner = (200,), wrong = (200,), reason = _SHARED_HISTORY_REASON,
    ),
    "routes.coding:POST:/conversations/{conversation_id}/mcp/save": Factory(
        "coding-conversation", {"edit_id": "matrix-edit", "revision": "matrix-revision", "json": "{}"}, fragment = SENTINEL,
        owner = (200,), wrong = (200,), reason = _SHARED_HISTORY_REASON,
    ),
    "routes.coding:POST:/conversations/{conversation_id}/mcp/release": Factory(
        "coding-conversation", {"edit_id": "matrix-edit"},
        owner = (200,), wrong = (200,), reason = _SHARED_HISTORY_REASON,
    ),
}

# The route table stays explicit: adding a new coding endpoint must still fail
# the matrix completeness assertion until its authenticated actor cases exist.
NATIVE_OPERATIONS = {
    "routes.coding:POST:/conversations/{conversation_id}/open": "open",
    "routes.coding:GET:/conversations/{conversation_id}/events": "view",
    "routes.coding:GET:/conversations/{conversation_id}/mcp/inventory": "mcp_inventory",
    "routes.coding:POST:/conversations/{conversation_id}/mcp/edit": "mcp_edit",
    "routes.coding:POST:/conversations/{conversation_id}/mcp/save": "mcp_save",
    "routes.coding:POST:/conversations/{conversation_id}/mcp/release": "mcp_release_edit",
}
GENERATION_METHODS = {
    "prompt", "cancel", "answer", "set_mode", "decide_plan", "change_goal", "command", "read_entries",
}

for method, suffix, operation, body, params, success in (
    ("GET", "children/{handle}/attempts/{attempt}", "child_detail", None, {"handle": "matrix-child", "attempt": "1"}, 200),
    ("GET", "commands", "commands", None, {}, 200),
    ("GET", "commands/{operation_id}", "command_receipt", None, {"operation_id": "matrix-operation"}, 200),
    ("GET", "diagnostics/{kind}", "diagnostics", None, {"kind": "context"}, 200),
    ("GET", "extensions", "extensions.inspect", None, {}, 200),
    ("GET", "mcp/operations/{operation_id}", "mcp_inspect_operation", None, {"operation_id": "matrix-operation"}, 200),
    ("GET", "models", "models", None, {}, 200),
    ("GET", "overlap", "overlap", None, {}, 200),
    ("GET", "skills", "skills", None, {}, 200),
    ("POST", "commands", "command", {"operation_id": "matrix-operation", "name": "compress", "tail": ""}, {}, 200),
    ("POST", "configuration", "configure", {"provider": "matrix-provider", "model": "matrix-model"}, {}, 200),
    ("POST", "entries", "read_entries", {"cut": {"journal": "root", "leaf": None}}, {}, 200),
    ("POST", "goal", "change_goal", {"revision": "matrix-goal-revision", "action": "pause"}, {}, 200),
    ("POST", "mcp/apply", "mcp_apply", {"operation_id": "matrix-operation"}, {}, 200),
    ("POST", "mcp/reconnect", "mcp_reconnect", {"operation_id": "matrix-operation", "name": "matrix-server"}, {}, 200),
    ("POST", "mode", "set_mode", {"mode": "plan"}, {}, 200),
    ("POST", "models/refresh", "models.refresh", None, {}, 200),
    ("POST", "plan-actions", "decide_plan", {"plan_id": "matrix-plan", "revision": "matrix-plan-revision", "decision": "implement"}, {}, 200),
    ("POST", "plugins/reload", "plugins.reload", {"operation_id": "matrix-operation"}, {}, 200),
    ("POST", "prompts", "prompt", {"submission_key": "matrix-submission", "text": "matrix prompt"}, {}, 202),
    ("POST", "requests/{request_id}/cancel", "cancel", None, {"request_id": "matrix-request"}, 200),
    ("POST", "requests/{request_id}/questions/{user_request_id}/answers", "answer", {
        "subscription": "matrix-view", "answers": [{"question_id": "matrix-question", "selected_options": ["One"]}],
    }, {"request_id": "matrix-request", "user_request_id": "matrix-user-request"}, 200),
):
    key = f"routes.coding:{method}:/conversations/{{conversation_id}}/{suffix}"
    assert key not in FACTORIES and key not in NATIVE_OPERATIONS
    FACTORIES[key] = Factory(
        "coding-conversation", body, success=success, fragment=SENTINEL,
        owner=(success,), wrong=(success,), reason=_SHARED_HISTORY_REASON, extra_params=params,
    )
    NATIVE_OPERATIONS[key] = operation

SKIPPED: dict[str, str] = {}
