# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

"""Coding authenticates Studio subjects but delegates one host's history to Mimir.

The native protocol double below is only for HTTP authorization tests; native
ownership, persistence and framing are verified by the coding integration tests.
"""

import asyncio
import json

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
        self.subjects = []
        self.operations = []
        self.released = []

    async def command(self, method, params):
        assert method == "open"
        assert params == {"conversation_id": CONVERSATION_ID}
        self.subjects.append(current_account().username)
        self.operations.append("open")
        return {"info": {"conversation_id": CONVERSATION_ID, "title": SENTINEL}}

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
}

SKIPPED: dict[str, str] = {}
