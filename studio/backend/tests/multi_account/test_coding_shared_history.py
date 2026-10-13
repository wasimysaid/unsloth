# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

"""Studio subjects authenticate independently; Mimir owns one host's history."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from routes import coding

from .factories import initialize_workspaces, snapshot_resource
from .factories_coding import CONVERSATION_ID, seed_conversation
from .support import bearer


@pytest.mark.parametrize("method,suffix,body", [
    ("POST", "open", None), ("GET", "events", None),
    ("GET", "mcp/inventory", None),
    ("POST", "mcp/edit", {"source": "matrix-source", "name": "server"}),
    ("POST", "mcp/save", {"edit_id": "matrix-edit", "revision": "matrix-revision", "json": "{}"}),
])
def test_active_subjects_share_native_history_without_studio_profiles(
    accounts, coding_native_boundary, method, suffix, body
):
    initialize_workspaces(accounts)
    for account in accounts.values():
        seed_conversation(account)
    before = {name: snapshot_resource(account) for name, account in accounts.items()}
    app = FastAPI()
    app.include_router(coding.router, prefix = "/coding")
    subjects = ("alice", "bob", "unsloth")
    bodies = []
    with TestClient(app) as client:
        for username in subjects:
            response = client.request(
                method, f"/coding/conversations/{CONVERSATION_ID}/{suffix}",
                headers = {**bearer(username), "X-Mimir-Runtime-Generation": "1"}, json = body,
            )
            assert response.status_code == 200, response.text
            bodies.append(response.text)

    assert bodies[0] == bodies[1] == bodies[2]
    assert coding_native_boundary.subjects == list(subjects)
    operation = "mcp_" + suffix.split("/", 1)[1] if suffix.startswith("mcp/") else "open" if suffix == "open" else "view"
    assert coding_native_boundary.operations == [operation] * 3
    assert coding_native_boundary.released == (
        ["matrix-view-1", "matrix-view-2", "matrix-view-3"] if suffix == "events" else []
    )
    assert {name: snapshot_resource(account) for name, account in accounts.items()} == before
