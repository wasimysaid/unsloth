# SPDX-License-Identifier: AGPL-3.0-only
"""Deterministic incarnation authentication and uncertain-acquire reconciliation."""
import asyncio
from types import SimpleNamespace

import httpx
import pytest
from fastapi import Request

from auth import storage
from core.coding_local_models import CodingLocalServing
from core.coding_runtime import CodingRuntime, CodingRuntimeError
from .test_coding import coding_app


def body(operation="op-1"):
    return dict(incarnation="incarnation", operation_id=operation, conversation_id="session",
                request_id=operation, model_id="local-model", api_model="wire")


@pytest.mark.asyncio
async def test_browser_and_other_incarnation_cannot_control_protections(coding_app, monkeypatch):
    app, headers = coding_app
    key, _ = storage.create_api_key("unsloth", "mimir coding incarnation", internal=True)
    other, _ = storage.create_api_key("unsloth", "unrelated workflow", internal=True)
    serving = CodingLocalServing("incarnation", key, "unsloth")
    app.state.coding_runtime = SimpleNamespace(local_serving=serving)
    monkeypatch.setattr("core.coding_local_models.local_catalog", _empty_catalog)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        for credential in (headers, {"Authorization": "Bearer " + other}):
            for method, path, payload in (("GET", "/catalog", None), ("POST", "/acquire", body()),
                                          ("POST", "/inspect", dict(incarnation="incarnation", operation_id="op-1")),
                                          ("POST", "/release", dict(incarnation="incarnation", operation_id="op-1"))):
                response = await client.request(method, "/api/coding/local-models" + path, json=payload, headers=credential)
                assert response.status_code == 403
                assert key not in response.text
        native = {"Authorization": "Bearer " + key}
        response = await client.get("/api/coding/local-models/catalog", headers=native)
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        assert key not in response.text
        assert (await client.post("/api/coding/local-models/inspect", headers=native,
                                  json=dict(incarnation="other", operation_id="op-1"))).status_code == 403
    assert not serving.operations


async def _empty_catalog():
    return dict(id="studio-local", name="Studio local", models=[])


@pytest.mark.asyncio
async def test_disconnected_acquire_and_early_release_reconcile_exact_operation(monkeypatch):
    from core.inference import llama_keepwarm
    released = []
    monkeypatch.setattr(llama_keepwarm, "release_coding_model", released.append)
    started, finish = asyncio.Event(), asyncio.Event()
    serving = CodingLocalServing("incarnation", "private-key", "unsloth")

    async def load(data, request, operation):
        started.set()
        await finish.wait()
        operation.state = "protected"
        operation.result = dict(token=data["operation_id"], model_id=data["model_id"], api_model=data["api_model"])
        return operation.result

    monkeypatch.setattr(serving, "_load", load)
    acquisition = asyncio.create_task(serving.acquire(body(), None))
    await started.wait()
    acquisition.cancel()
    with pytest.raises(asyncio.CancelledError):
        await acquisition
    assert serving.inspect("op-1")["state"] == "pending"
    release = asyncio.create_task(serving.release("op-1"))
    await asyncio.sleep(0)
    assert not release.done()
    assert released == []
    finish.set()
    assert await release == {"state": "released"}
    assert released == ["op-1"]
    assert await serving.release("op-1") == {"state": "released"}
    assert released == ["op-1"]
    with pytest.raises(CodingRuntimeError, match="already released"):
        await serving.acquire(body(), None)
    await serving.release("not-delivered")
    with pytest.raises(CodingRuntimeError, match="already released"):
        await serving.acquire(body("not-delivered"), None)


@pytest.mark.asyncio
async def test_failed_cleanup_never_marks_released_or_drops_another_request(monkeypatch):
    from core.inference import llama_keepwarm
    serving = CodingLocalServing("incarnation", "private-key", "unsloth")

    async def load(data, request, operation):
        operation.state = "protected"
        operation.result = dict(token=data["operation_id"], model_id="local-model", api_model="wire")
        return operation.result

    monkeypatch.setattr(serving, "_load", load)
    await serving.acquire(body(), None)
    await serving.acquire(body("op-2"), None)

    def fail(identifier):
        raise RuntimeError("failed cleanup fixture")

    monkeypatch.setattr(llama_keepwarm, "release_coding_model", fail)
    with pytest.raises(RuntimeError, match="cleanup"):
        await serving.release("op-1")
    assert serving.inspect("op-1")["state"] == "protected"
    assert serving.inspect("op-2")["state"] == "protected"
    await serving.close(clean=False)
    assert serving.inspect("op-1")["state"] == "protected"
    assert serving.inspect("op-2")["state"] == "protected"


@pytest.mark.asyncio
async def test_host_origin_is_socket_not_browser_host_and_key_is_revoked(coding_app, monkeypatch):
    app, _ = coding_app
    runtime = CodingRuntime()
    scope = dict(type="http", app=app, server=("0.0.0.0", 8800), headers=[(b"host", b"credential-exfil.invalid")])
    request = Request(scope)
    request.state.coding_subject = "unsloth"
    request.state.coding_credential_generation = storage.credential_generation(storage.get_jwt_secret("unsloth"))
    monkeypatch.delenv("UNSLOTH_MIMIR_STUDIO_URL", raising=False)
    await runtime.configure_local_serving(request)
    assert runtime._local_origin == "http://127.0.0.1:8800"
    key = runtime.local_serving.key
    assert storage.validate_api_key(key) == "unsloth"
    assert key not in str(runtime.diagnostics())
    await runtime.close()
    assert storage.validate_api_key(key) is None


@pytest.mark.asyncio
async def test_cold_events_configure_local_serving_before_native_start(coding_app, monkeypatch):
    app, headers = coding_app
    runtime = CodingRuntime()
    app.state.coding_runtime = runtime
    monkeypatch.setenv("UNSLOTH_MIMIR_STUDIO_URL", "http://127.0.0.1:8800")

    async def subscribe(identifier):
        assert runtime.local_serving is not None, "SSE must configure serving before starting native execution"
        raise CodingRuntimeError("not_found", "Unknown saved conversation")

    monkeypatch.setattr(runtime, "subscribe", subscribe)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test", headers=headers) as client:
        response = await client.get("/api/coding/conversations/unknown/events")
        assert response.status_code == 404
    await runtime.close()


def setup_request(app):
    request = Request(dict(type="http", app=app, server=("127.0.0.1", 8800), headers=[]))
    request.state.coding_subject = "unsloth"
    request.state.coding_credential_generation = storage.credential_generation(storage.get_jwt_secret("unsloth"))
    return request


@pytest.mark.asyncio
@pytest.mark.parametrize("cancel", [False, True, "twice"])
async def test_inflight_credential_mint_is_reconciled_on_shutdown_or_cancellation(coding_app, monkeypatch, cancel):
    import threading

    app, _ = coding_app
    runtime = CodingRuntime()
    entered, proceed, minted = threading.Event(), threading.Event(), threading.Event()
    original = storage.create_api_key
    keys = []

    def create(*args, **kwargs):
        entered.set()
        assert proceed.wait(5)
        result = original(*args, **kwargs)
        keys.append(result[0])
        minted.set()
        return result

    monkeypatch.setattr(storage, "create_api_key", create)
    monkeypatch.delenv("UNSLOTH_MIMIR_STUDIO_URL", raising=False)
    setup = asyncio.create_task(runtime.configure_local_serving(setup_request(app)))
    assert await asyncio.to_thread(entered.wait, 5)
    if cancel:
        setup.cancel()
        if cancel == "twice":
            await asyncio.sleep(0)  # first cancellation enters mint reconciliation
            setup.cancel()
        closing = None
    else:
        closing = asyncio.create_task(runtime.close())
        await asyncio.sleep(0)
    proceed.set()
    await asyncio.gather(setup, *([closing] if closing else []), return_exceptions=True)
    assert await asyncio.to_thread(minted.wait, 5)
    assert len(keys) > 0
    active_credentials = sum(storage.validate_api_key(key) is not None for key in keys)
    assert active_credentials == 0
    assert runtime._local_key_id is None


@pytest.mark.asyncio
async def test_already_reaped_process_retires_key_but_retains_failed_cleanup_holds(coding_app):
    from core.coding_local_models import LocalOperation

    app, _ = coding_app
    runtime = CodingRuntime()
    await runtime.configure_local_serving(setup_request(app))
    serving = runtime.local_serving
    key = serving.key
    serving.operations["unconfirmed"] = LocalOperation((), state="protected")
    reader = asyncio.StreamReader()
    reader.feed_eof()

    async def wait():
        return 1

    runtime.process = SimpleNamespace(stdout=reader, stdin=SimpleNamespace(close=lambda: None),
                                      returncode=1, wait=wait)
    await runtime._read_responses()
    assert runtime._shutdown_task is not None
    await runtime._shutdown_task
    assert storage.validate_api_key(key) is None
    assert serving.inspect("unconfirmed")["state"] == "protected"


@pytest.mark.asyncio
@pytest.mark.parametrize("origin", [
    "https://remote.invalid", "http://user:secret@localhost:8800",
    "http://localhost:8800/path", "http://localhost:8800?key=secret",
    "http://localhost:8800", "https://127.0.0.1:8800", "https://[::1]:8800",
    "http://127.0.0.1:bad", "http://127.0.0.1:65536", "http://[invalid]:8800",
])
async def test_unsafe_serving_origins_refused_without_minting_key(coding_app, monkeypatch, origin):
    app, _ = coding_app
    runtime = CodingRuntime()
    monkeypatch.setenv("UNSLOTH_MIMIR_STUDIO_URL", origin)

    def forbidden_mint(*args, **kwargs):
        raise AssertionError("An unsupported native serving origin must be refused before credential creation")

    monkeypatch.setattr(storage, "create_api_key", forbidden_mint)
    request = Request(dict(type="http", app=app, headers=[]))
    request.state.coding_subject = "unsloth"
    with pytest.raises(CodingRuntimeError, match="trusted loopback"):
        await runtime.configure_local_serving(request)
    assert runtime._local_key_id is None
    assert runtime.local_serving is None


@pytest.mark.asyncio
@pytest.mark.parametrize("origin", ["http://127.0.0.1:8800", "http://[::1]:8800/"])
async def test_supported_native_serving_origins_mint_and_retire_key(coding_app, monkeypatch, origin):
    app, _ = coding_app
    runtime = CodingRuntime()
    monkeypatch.setenv("UNSLOTH_MIMIR_STUDIO_URL", origin)
    await runtime.configure_local_serving(setup_request(app))
    assert runtime._local_origin == origin.rstrip("/")
    key = runtime.local_serving.key
    assert storage.validate_api_key(key) == "unsloth"
    await runtime.close()
    assert storage.validate_api_key(key) is None


@pytest.mark.asyncio
@pytest.mark.parametrize("package", [False, True])
@pytest.mark.parametrize("outcome", ["success", "error", "cancel"])
async def test_private_bootstrap_pipe_never_exports_key_and_closes_on_every_spawn_outcome(monkeypatch, tmp_path, package, outcome):
    import json
    import os
    import stat
    from unittest.mock import AsyncMock

    if os.name != "posix":
        pytest.fail("This Unix inherited-pipe contract test requires the supported native platform")
    runtime = CodingRuntime("bounded-native-fixture")
    runtime.package = None
    if package:
        (tmp_path / "mimir-plugin.toml").write_text('id = "studio.frontend"\n')
        runtime.package = str(tmp_path)
    runtime._local_origin = "http://127.0.0.1:8800"
    runtime.local_serving = CodingLocalServing("4d6bb14e-2af3-446c-bfe3-c94d7cd08b55", "bounded-bootstrap-fixture", "unsloth")
    for name in ("MIMIR_STUDIO_LOCAL_KEY", "MIMIR_STUDIO_LOCAL_URL", "MIMIR_STUDIO_LOCAL_INCARNATION", "MIMIR_STUDIO_LOCAL_FD"):
        monkeypatch.setenv(name, "ambient-legacy-fixture")
    descriptors = []
    calls = []

    async def spawn(*args, **kwargs):
        environment = kwargs["env"]
        calls.append(args[2])
        assert not any(name in environment for name in ("MIMIR_STUDIO_LOCAL_KEY", "MIMIR_STUDIO_LOCAL_URL", "MIMIR_STUDIO_LOCAL_INCARNATION"))
        assert "bounded-bootstrap-fixture" not in str(environment)
        if args[2] == "install":
            assert "MIMIR_STUDIO_LOCAL_FD" not in environment
            assert not kwargs.get("pass_fds")
            return SimpleNamespace(wait=AsyncMock(return_value=0), returncode=0)
        descriptor, = kwargs["pass_fds"]
        descriptors.append(descriptor)
        assert environment["MIMIR_STUDIO_LOCAL_FD"] == str(descriptor)
        assert stat.S_ISFIFO(os.fstat(descriptor).st_mode)
        payload = os.read(descriptor, 16385)
        assert os.read(descriptor, 1) == b"", "The writer must be closed before native startup"
        assert json.loads(payload) == {"origin": runtime._local_origin, "key": "bounded-bootstrap-fixture", "incarnation": runtime.local_serving.incarnation}
        if outcome == "error":
            raise OSError("bounded spawn failure")
        if outcome == "cancel":
            raise asyncio.CancelledError()
        return SimpleNamespace(stdin=None, returncode=0, wait=AsyncMock(return_value=0))

    async def idle_reader():
        return

    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
    monkeypatch.setattr(runtime, "_read_responses", idle_reader)
    monkeypatch.setattr(runtime, "_drain_stderr", idle_reader)
    try:
        if outcome == "success":
            await runtime.start()
            assert runtime.process is not None
        elif outcome == "error":
            with pytest.raises(CodingRuntimeError, match="could not start"):
                await runtime.start()
        else:
            with pytest.raises(asyncio.CancelledError):
                await runtime.start()
        assert calls == (["install", "run"] if package else ["run"])
        assert len(descriptors) == 1
        with pytest.raises(OSError):
            os.fstat(descriptors[0])
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_failed_mint_retirement_is_reconciled_before_replacement_key(coding_app, monkeypatch):
    import threading

    app, _ = coding_app
    runtime = CodingRuntime()
    entered, proceed = threading.Event(), threading.Event()
    create = storage.create_api_key
    revoke = storage.revoke_internal_api_key
    keys = []
    key_ids = []
    revocations = []

    def mint(*args, **kwargs):
        if not keys:
            entered.set()
            assert proceed.wait(5)
        result = create(*args, **kwargs)
        keys.append(result[0])
        key_ids.append(result[1]["id"])
        return result

    def retire(identifier):
        revocations.append(identifier)
        if len(revocations) == 1:
            raise RuntimeError("bounded retirement failure")
        return revoke(identifier)

    monkeypatch.setattr(storage, "create_api_key", mint)
    monkeypatch.setattr(storage, "revoke_internal_api_key", retire)
    monkeypatch.delenv("UNSLOTH_MIMIR_STUDIO_URL", raising=False)
    setup = asyncio.create_task(runtime.configure_local_serving(setup_request(app)))
    try:
        assert await asyncio.to_thread(entered.wait, 5)
        setup.cancel()
        proceed.set()
        with pytest.raises(RuntimeError, match="bounded retirement failure"):
            await setup
        assert runtime._local_key_id is not None
        assert runtime.local_serving is None
        await runtime.configure_local_serving(setup_request(app))
        original_active = storage.validate_api_key(keys[0]) is not None
        assert not original_active, "The retired credential must be reconciled before its ownership ID is replaced"
        assert len(keys) == 2
        await runtime.close()
        active_credentials = sum(storage.validate_api_key(key) is not None for key in keys)
        assert active_credentials == 0
    finally:
        proceed.set()
        await asyncio.gather(setup, return_exceptions=True)
        await runtime.close()
        for identifier in key_ids:
            revoke(identifier)
