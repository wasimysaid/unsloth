# SPDX-License-Identifier: AGPL-3.0-only
from dataclasses import replace

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from auth import storage
from core import coding_runtime
from core.coding_connections import provider_snapshot
from core.inference import external_provider
from routes import coding_connections
from storage import credential_secrets, providers_db
from utils.account_context import as_api_caller, current_account, run_as


def _create(account, provider_id, provider_type = "custom", **options):
    run_as(account, providers_db.create_provider, provider_id, provider_type, provider_id,
           "https://8.8.8.8/v1", models = ["my-model"], **options)


def _login(account):
    record = storage.get_user_record(account.username)
    return replace(account, credential_gen = storage.credential_generation(record["jwt_secret"]))


def test_snapshot_uses_saved_connection_visibility_and_hides_credentials(accounts):
    owner, alice, bob = (accounts[name] for name in ("unsloth", "alice", "bob"))
    _create(owner, "owner-private")
    _create(owner, "team", shared = True)
    _create(alice, "my-gateway")
    _create(alice, "another-gateway")
    _create(alice, "codex", "openai_codex")
    _create(alice, "anthropic", "anthropic")
    _create(alice, "responses-only", api_type = "responses")
    _create(alice, "disabled")
    run_as(alice, providers_db.update_provider, "disabled", is_enabled = False)
    run_as(alice, credential_secrets.save_provider_api_key, "my-gateway", "provider-secret")

    def snapshot(account):
        return run_as(account, provider_snapshot, "http://127.0.0.1:8902", "session-bearer")

    rows = snapshot(alice)
    assert {row["name"] for row in rows} == {"team", "my-gateway", "another-gateway"}
    assert len({row["id"] for row in rows}) == 3
    assert all(row["models"][0]["id"] == "my-model" for row in rows)
    assert all(row["base_url"].startswith("http://127.0.0.1:8902/api/coding/connections/") for row in rows)
    assert "provider-secret" not in repr(rows) and "8.8.8.8" not in repr(rows)
    assert {row["name"] for row in snapshot(bob)} == {"team"}
    assert snapshot(as_api_caller(alice)) == []


def test_proxy_streams_with_current_saved_credential_and_rechecks_access(accounts, monkeypatch):
    owner, alice = (_login(accounts[name]) for name in ("unsloth", "alice"))
    _create(owner, "private")
    _create(owner, "team", shared = True, extra_headers = {"X-Project": "studio"})
    run_as(owner, credential_secrets.save_provider_api_key, "team", "old-key")
    identities = {"interactive": alice, "stale": replace(alice, credential_gen = "revoked"),
                  "api-key": as_api_caller(alice)}
    monkeypatch.setattr(coding_runtime, "connection_account_for",
                        lambda app, token: identities.get(token), raising = False)
    received = []
    body = {"model": "my-model", "messages": [{"role": "user", "content": "hello"}],
            "stream": True, "tools": [{"type": "function", "function": {"name": "read"}}]}
    wire = b'data: {"choices":[{"delta":{"tool_calls":[{"index":0}]}}]}\n\ndata: [DONE]\n\n'

    def upstream(request):
        import json
        received.append((current_account().account_id, request.headers["authorization"]))
        assert request.url == "https://8.8.8.8/v1/chat/completions"
        assert request.headers["x-project"] == "studio"
        assert json.loads(request.content) == body
        return httpx.Response(200, content = wire, headers = {"Content-Type": "text/event-stream"})

    http = httpx.AsyncClient(transport = httpx.MockTransport(upstream))
    monkeypatch.setattr(external_provider, "_client", lambda: http)
    app = FastAPI()
    app.include_router(coding_connections.router)
    with TestClient(app) as client:
        def send(connection = "team", token = "interactive", payload = body):
            return client.post(f"/{connection}/v1/chat/completions", json = payload,
                               headers = {"Authorization": f"Bearer {token}"})
        assert send("private").status_code == 404
        assert send(token = "unknown").status_code == 403
        assert send(token = "stale").status_code == 403
        assert send(token = "api-key").status_code == 403
        assert send(payload = {**body, "model": "disabled-model"}).status_code == 404
        assert send().content == wire
        run_as(owner, credential_secrets.save_provider_api_key, "team", "new-key")
        assert send().content == wire
        run_as(owner, providers_db.update_provider, "team", is_enabled = False)
        assert send().status_code == 404
        run_as(owner, providers_db.delete_provider, "team")
        assert send().status_code == 404
        assert received == [(alice.account_id, "Bearer old-key"), (alice.account_id, "Bearer new-key")]


def test_new_chat_saved_gateway_is_immediately_selectable_and_respects_output_limit(accounts, monkeypatch):
    from routes import providers
    from .factories_providers import _encrypt_api_key
    from .support import bearer

    owner = _login(accounts["unsloth"])
    app = FastAPI()
    app.include_router(providers.router, prefix = "/api/providers")
    app.include_router(coding_connections.router, prefix = "/api/coding/connections")
    monkeypatch.setattr(coding_runtime, "connection_account_for",
                        lambda app, token: owner if token == "runtime-only" else None, raising = False)
    def upstream(request):
        import json
        assert request.headers["Authorization"] == "Bearer from-new-chat"
        assert json.loads(request.content)["max_tokens"] == 128
        return httpx.Response(200, text = "data: [DONE]\n\n")

    http = httpx.AsyncClient(transport = httpx.MockTransport(upstream))
    monkeypatch.setattr(external_provider, "_client", lambda: http)
    with TestClient(app) as client:
        for kind in ("custom", "openai"):
            response = client.post("/api/providers/", headers = bearer("unsloth"), json = {
                "provider_type": kind, "display_name": "Gateway " + kind,
                "api_type": "chat_completions", "base_url": "http://127.0.0.1:9999/v1",
                "models": ["my-model"], "max_output_tokens": 128,
                "encrypted_api_key": _encrypt_api_key("from-new-chat"),
            })
            assert response.status_code == 201, response.text
            saved_id = response.json()["id"]
            rows = run_as(owner, provider_snapshot, "http://127.0.0.1:8902", "runtime-only")
            selected = next(row for row in rows if row["id"] == f"studio-connection-{saved_id}")
            assert selected["models"][0]["max_output_tokens"] == 128
            assert selected["name"] == "Gateway " + kind
            reply = client.post(f"/api/coding/connections/{saved_id}/v1/chat/completions",
                                headers = {"Authorization": "Bearer runtime-only"},
                                json = {"model": "my-model", "messages": [], "stream": True, "max_tokens": 256})
            assert reply.status_code == 200, reply.text
            assert reply.text == "data: [DONE]\n\n"


def test_disconnect_stops_a_waiting_upstream_before_any_headers(accounts):
    import asyncio
    from contextlib import asynccontextmanager

    async def check():
        connected = asyncio.Event()
        closed = asyncio.Event()

        @asynccontextmanager
        async def exchange():
            try:
                connected.set()
                await asyncio.Event().wait()
                yield
            finally:
                closed.set()

        async def disconnect():
            await connected.wait()
            return {"type": "http.disconnect"}

        async def unused(_):
            raise AssertionError("Upstream never sent headers")

        response = coding_connections.ConnectionResponse(exchange(), accounts["alice"])
        await asyncio.wait_for(response({}, disconnect, unused), timeout = 2)
        assert closed.is_set()

    asyncio.run(check())


def test_account_deactivation_and_deletion_close_only_its_hosted_runtimes(accounts):
    from routes import accounts as account_routes
    from state import active_generations
    from .support import bearer

    alice, bob = accounts["alice"], accounts["bob"]
    app = FastAPI()
    app.include_router(account_routes.router, prefix = "/accounts")
    alice_ui = run_as(alice, coding_runtime.runtime_for, app)
    alice_api = run_as(as_api_caller(alice), coding_runtime.runtime_for, app)
    bob_ui = run_as(bob, coding_runtime.runtime_for, app)
    with TestClient(app) as client:
        headers = bearer("unsloth")
        response = client.patch(f"/accounts/{alice.account_id}", headers = headers, json = {"is_active": False})
        assert response.status_code == 200, response.text
        assert alice_ui.status()["state"] == alice_api.status()["state"] == "stopped"
        assert list(coding_runtime.active_runtimes(app)) == [bob_ui]
        assert active_generations.fenced(alice.account_id)

        response = client.patch(f"/accounts/{alice.account_id}", headers = headers, json = {"is_active": True})
        assert response.status_code == 200, response.text
        reopened = run_as(alice, coding_runtime.runtime_for, app)
        assert reopened is not alice_ui
        response = client.delete(f"/accounts/{alice.account_id}", headers = headers)
        assert response.status_code == 204, response.text
        assert reopened.status()["state"] == "stopped"
        assert list(coding_runtime.active_runtimes(app)) == [bob_ui]


def test_unconfirmed_coding_drain_preserves_disabled_account_for_retry(accounts, monkeypatch):
    from routes import accounts as account_routes
    from state import active_generations
    from .support import bearer

    alice = accounts["alice"]
    app = FastAPI()
    app.include_router(account_routes.router, prefix = "/accounts")
    runtime = run_as(alice, coding_runtime.runtime_for, app)
    attempts = []

    async def close():
        assert storage.get_user_record("alice")["is_active"] == 0
        assert active_generations.fenced(alice.account_id)
        attempts.append(None)
        runtime._cleanup_failed = len(attempts) < 3

    monkeypatch.setattr(runtime, "close", close)
    with TestClient(app) as client:
        headers = bearer("unsloth")
        url = f"/accounts/{alice.account_id}"
        assert client.delete(url, headers = headers).status_code == 409
        assert storage.get_user_record("alice")["account_id"] == alice.account_id
        assert client.patch(url, headers = headers, json = {"is_active": True}).status_code == 409
        assert client.delete(url, headers = headers).status_code == 204
        assert storage.get_user_record("alice") is None
        assert not list(coding_runtime.active_runtimes(app))
