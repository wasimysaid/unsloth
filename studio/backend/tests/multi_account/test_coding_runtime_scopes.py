# SPDX-License-Identifier: AGPL-3.0-only
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI

from core import coding_connections
from core.coding_runtime import CodingRuntimeError, connection_account_for, runtime_for
from utils.account_context import arun_as, as_api_caller, current_account_id, run_as


@pytest.mark.asyncio
async def test_live_connections_follow_the_account_and_auth_method(accounts, monkeypatch):
    app = FastAPI()
    alice = replace(accounts["alice"], credential_gen = "first")
    bob = replace(accounts["bob"], credential_gen = "second")
    runtime = run_as(alice, runtime_for, app)
    assert runtime is not run_as(as_api_caller(alice), runtime_for, app)
    assert runtime is not run_as(bob, runtime_for, app)
    assert runtime is run_as(alice, runtime_for, app)
    runtime.process = SimpleNamespace(returncode = None)
    runtime._request = AsyncMock(return_value = {})
    runtime._connection_origin = "http://127.0.0.1:8902"
    monkeypatch.setattr(coding_connections, "provider_snapshot", lambda origin, token: [
        {"name": current_account_id(), "token": token},
    ])
    await arun_as(alice, runtime._sync_connections(0))
    first = runtime._request.call_args.args[1]["providers"][0]
    assert first["name"] == alice.account_id
    assert connection_account_for(app, first["token"]) is alice
    await arun_as(alice, runtime._sync_connections(0))
    assert runtime._request.await_count == 1

    renewed = replace(alice, credential_gen = "reset")
    await arun_as(renewed, runtime._sync_connections(0))
    second = runtime._request.call_args.args[1]["providers"][0]
    assert connection_account_for(app, first["token"]) is None
    assert connection_account_for(app, second["token"]) is renewed
    runtime.process.returncode = 0
    assert connection_account_for(app, second["token"]) is None


@pytest.mark.asyncio
async def test_unconfirmed_sync_is_retried_even_if_connection_was_removed(accounts, monkeypatch):
    account = replace(accounts["alice"], credential_gen = "generation")
    runtime = run_as(account, runtime_for, FastAPI())
    snapshots = iter(([{"name": "ephemeral"}], []))
    monkeypatch.setattr(coding_connections, "provider_snapshot", lambda *_: next(snapshots))
    runtime._request = AsyncMock(side_effect = [CodingRuntimeError("uncertain", "Lost ACK"), {}])
    with pytest.raises(CodingRuntimeError, match = "Lost ACK"):
        await arun_as(account, runtime._sync_connections(0))
    await arun_as(account, runtime._sync_connections(0))
    assert runtime._request.call_args.args == ("sync_providers", {"providers": []})
