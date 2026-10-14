# SPDX-License-Identifier: AGPL-3.0-only
"""Bridge delivery/reconstruction tests; these are not live-native acceptance."""
from __future__ import annotations

import asyncio
import json
import struct
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI

from auth import storage
from auth.authentication import create_access_token
from core.coding_runtime import CodingRuntime, CodingRuntimeError
from routes.coding import router
from .coding_transport_faults import CodingTransportFaults
from .test_coding import coding_app
from .test_coding_local_transport import setup_request
from .test_coding_maintenance import child_runtime


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["prompt", "cancel", "change_goal", "answer"])
async def test_uncertain_command_is_not_replayed_and_late_ack_does_not_poison_reconciliation(monkeypatch, operation):
    import core.coding_runtime as module
    monkeypatch.setattr(module, "COMMAND_TIMEOUT", 0.01)
    stream = asyncio.StreamReader()
    commands = []

    class Writer:
        def write(self, data):
            value = json.loads(data[4:])
            commands.append(value)
            if value["method"] == "state":
                # Native late acceptance precedes the requested reconciliation.
                for payload in (
                    {"id": 1, "result": {"request_id": "accepted-original"}},
                    {"id": value["id"], "result": {"active_request": "accepted-original"}},
                ):
                    body = json.dumps(payload).encode()
                    stream.feed_data(struct.pack(">I", len(body)) + body)

        async def drain(self):
            pass

        def close(self):
            commands.append({"method": "stdin-close"})

    runtime = CodingRuntime()
    runtime.process = SimpleNamespace(stdout=stream, stdin=Writer(), returncode=0,
                                      wait=AsyncMock(return_value=0))
    reader = asyncio.create_task(runtime._read_responses())
    with pytest.raises(CodingRuntimeError, match="not confirmed") as failure:
        await runtime.command(operation, {"conversation_id": "saved", "submission_key": "original"})
    assert failure.value.code == "uncertain"
    state = await runtime.command("state", {"conversation_id": "saved"})
    assert state == {"active_request": "accepted-original"}
    assert [command["method"] for command in commands] == [operation, "state"]
    assert not runtime._pending
    stream.feed_eof()
    await reader
    await runtime._shutdown_task
    assert commands[-1] == {"method": "stdin-close"}
    runtime.process.wait.assert_awaited_once()


@pytest.mark.asyncio
async def test_last_event_id_does_not_turn_new_view_into_arbitrary_replay(monkeypatch, tmp_path):
    monkeypatch.setattr(storage, "DB_PATH", tmp_path / "auth.db")
    storage.create_initial_user("unsloth", "isolated-test-password", "isolated-signing-secret-236-long-enough")
    app = FastAPI()
    app.include_router(router, prefix="/api/coding")
    opened = []
    released = []

    class NativeViews(CodingRuntime):
        async def subscribe(self, conversation, *, expected_generation=None):
            assert expected_generation == 1
            opened.append(conversation)
            queue = asyncio.Queue()
            queue.put_nowait({"subscription": "fresh-view", "position": 100,
                              "event": {"type": "start", "root": {"cut": {"journal": "root", "leaf": "captured"}}}})
            queue.put_nowait({"subscription": "fresh-view", "event": {"type": "closed"}})
            return "fresh-view", queue

        async def unsubscribe(self, subscription):
            released.append(subscription)

    app.state.coding_runtime = NativeViews()
    headers = {"Authorization": "Bearer " + create_access_token("unsloth"), "Last-Event-ID": "arbitrary-obsolete-position", "X-Mimir-Runtime-Generation": "1"}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/coding/conversations/exact-saved-id/events", headers=headers)
    assert response.status_code == 200
    assert '"type":"start"' in response.text
    assert '"leaf":"captured"' in response.text
    assert opened == ["exact-saved-id"]
    assert released == ["fresh-view"]


@pytest.mark.asyncio
async def test_acceptance_reset_uses_actual_capture_and_monotonic_transport_positions():
    captured = {"subscription": "native", "position": 3, "event": {
        "type": "start", "state": {"info": {"id": "saved", "cwd": "/canonical"}},
        "root": {"cut": {"journal": "root", "leaf": "immutable-native-cut"}}, "recovering": False,
    }}
    checkpoint = {"subscription": "native", "position": 7, "event": {
        "type": "checkpoint", "cut": {"journal": "root", "leaf": "next-native-cut"},
    }}
    messages = []

    async def native_transport(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})
        for item in (captured, checkpoint):
            body = b"event: view\ndata: " + json.dumps(item).encode() + b"\n\n"
            await send({"type": "http.response.body", "body": body, "more_body": True})
        await send({"type": "http.response.body", "body": b"", "more_body": False})

    async def receive():
        return {"type": "http.disconnect"}

    async def send(message):
        messages.append(message)

    faults = {"reset_conversation": "saved"}
    middleware = CodingTransportFaults(native_transport, faults)
    await middleware({"type": "http", "method": "GET", "path": "/api/coding/conversations/saved/events"}, receive, send)
    body = b"".join(message.get("body", b"") for message in messages)
    items = [json.loads(frame.split(b"data: ", 1)[1]) for frame in body.split(b"\n\n") if frame]
    assert [item["position"] for item in items] == [6, 7, 14]
    assert [item["event"]["type"] for item in items] == ["start", "reset", "checkpoint"]
    assert items[1]["event"]["state"] == captured["event"]["state"]
    assert items[1]["event"]["root"] == captured["event"]["root"]
    assert items[1]["event"]["recovering"] is True
    assert faults == {}


@pytest.mark.asyncio
async def test_admitted_view_keeps_its_observation_epoch_after_runtime_restart(coding_app):
    app, headers = coding_app
    runtime = CodingRuntime()
    old_epoch = runtime.observation_epoch
    native = {"subscription": "old-view", "position": 1, "event": {"type": "closed"}}

    class RetainedQueue:
        async def get(self):
            # The old view's queued item can wake its browser after publication
            # of a replacement. Its native position is still in the old domain.
            runtime.observation_epoch = "new-process-epoch"
            return native

    async def subscribe(conversation, *, expected_generation=None):
        assert expected_generation == 1
        return "old-view", RetainedQueue()

    runtime.subscribe = subscribe
    runtime.unsubscribe = AsyncMock()
    app.state.coding_runtime = runtime
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/coding/conversations/saved/events", headers=headers)
    assert response.status_code == 200
    observed = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]
    assert observed == [{**native, "observation_epoch": old_epoch}]
    runtime.unsubscribe.assert_awaited_once_with("old-view")


def replacement_frontend(tmp_path, runtime):
    """Real owned framed child consuming the private provider bootstrap, no model."""
    bootstrap = tmp_path / "replacement-bootstrap.json"
    trace = tmp_path / "replacement-commands.jsonl"
    executable = tmp_path / "replacement-frontend"
    executable.write_text(f'''#!{sys.executable}
import sys,os,struct,json
fd=os.environ.get('MIMIR_STUDIO_LOCAL_FD')
provider=json.loads(os.read(int(fd),4096)) if fd else None
if fd: os.close(int(fd))
with open({str(bootstrap)!r}, 'w') as output: json.dump(provider,output)
while True:
    header=sys.stdin.buffer.read(4)
    if not header: break
    command=json.loads(sys.stdin.buffer.read(struct.unpack('>I',header)[0]))
    with open({str(trace)!r}, 'a') as output: output.write(json.dumps(command)+'\\n')
    result={{'protocol':1,'plugin':'studio.frontend'}} if command['method']=='ping' else {{'cleanup_confirmed':True}}
    payload=json.dumps({{'id':command['id'],'result':result}}).encode()
    sys.stdout.buffer.write(struct.pack('>I',len(payload))+payload);sys.stdout.buffer.flush()
''')
    executable.chmod(0o700)
    runtime.executable, runtime.package = str(executable), None
    return bootstrap, trace


@pytest.mark.asyncio
@pytest.mark.parametrize("process_loss", [False, True])
async def test_local_provider_is_fresh_and_authenticated_after_explicit_restart(coding_app, monkeypatch, tmp_path, process_loss):
    app, _ = coding_app
    runtime = CodingRuntime()
    await runtime.configure_local_serving(setup_request(app))
    old_serving, old_key = runtime.local_serving, runtime.local_serving.key
    await child_runtime(tmp_path, runtime=runtime)
    runtime._generation = 1
    old_epoch = runtime.observation_epoch
    old_process = runtime.process
    bootstrap, trace = replacement_frontend(tmp_path, runtime)
    app.state.coding_runtime = runtime

    async def catalog():
        return {"id": "studio-local", "name": "Studio local", "models": [{"id": "downloaded-model"}]}

    monkeypatch.setattr("core.coding_local_models.local_catalog", catalog)
    try:
        if process_loss:
            old_process.kill()
            await runtime._reader
            await runtime._shutdown_task
            assert storage.validate_api_key(old_key) is None
            assert runtime.status()["cleanup"]["confirmed"] is False
        result = await runtime.restart()
        assert result["state"] == "running" and result["generation"] != 1
        assert runtime.observation_epoch != old_epoch
        assert old_process.returncode is not None
        serving = runtime.local_serving
        assert serving is not old_serving and not serving.closing
        assert serving.incarnation != old_serving.incarnation and serving.key != old_key
        assert storage.validate_api_key(old_key) is None
        assert storage.validate_api_key(serving.key) == "unsloth"
        assert json.loads(bootstrap.read_text()) == {
            "origin": "http://127.0.0.1:8800", "key": serving.key, "incarnation": serving.incarnation,
        }
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            native = {"Authorization": "Bearer " + serving.key}
            assert (await client.get("/api/coding/local-models/catalog", headers=native)).json()["models"] == [{"id": "downloaded-model"}]
            assert (await client.get("/api/coding/local-models/catalog", headers={"Authorization": "Bearer " + old_key})).status_code in (401, 403)
            stale = {"incarnation": old_serving.incarnation, "operation_id": "old-operation"}
            assert (await client.post("/api/coding/local-models/release", headers=native, json=stale)).status_code == 403
        with pytest.raises(CodingRuntimeError) as failure:
            await runtime.command("prompt", {"submission_key": "old-owner"}, expected_generation=1)
        assert failure.value.code == "runtime_changed" and failure.value.requires_reopen
        assert [json.loads(line)["method"] for line in trace.read_text().splitlines()] == ["ping"]
    finally:
        await runtime.close()
    assert storage.validate_api_key(runtime.local_serving.key) is None


@pytest.mark.asyncio
async def test_cold_restart_sets_up_local_provider_before_native_launch(coding_app, monkeypatch, tmp_path):
    app, headers = coding_app
    monkeypatch.setenv("UNSLOTH_MIMIR_STUDIO_URL", "http://127.0.0.1:8800")
    runtime = CodingRuntime()
    app.state.coding_runtime = runtime
    bootstrap, trace = replacement_frontend(tmp_path, runtime)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post("/api/coding/runtime/restart", headers=headers,
                                        json={"scope": "all_hosted_conversations"})
        assert response.status_code == 200
        assert runtime.local_serving is not None
        assert not runtime.local_serving.closing
        assert json.loads(bootstrap.read_text())["key"] == runtime.local_serving.key
        assert storage.validate_api_key(runtime.local_serving.key) == "unsloth"
        assert [json.loads(line)["method"] for line in trace.read_text().splitlines()] == ["ping"]
    finally:
        await runtime.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("exit_code", [0, 9])
async def test_unconfirmed_local_hold_blocks_replacement_even_after_process_exit(coding_app, monkeypatch, tmp_path, exit_code):
    from core.coding_local_models import LocalOperation
    from core.inference import llama_keepwarm as kw

    app, _ = coding_app
    monkeypatch.setattr(kw, "_coding_holds", {})
    runtime = CodingRuntime()
    await runtime.configure_local_serving(setup_request(app))
    serving, key = runtime.local_serving, runtime.local_serving.key
    backend = SimpleNamespace(is_loaded=True, model_identifier="resident-model")
    hold = kw.hold_coding_model("unconfirmed-owner", backend, identity=kw.coding_model_identity(backend))
    serving.operations["unconfirmed-owner"] = LocalOperation((), state="protected")
    await child_runtime(tmp_path, runtime=runtime, exit_code=exit_code)
    replacement_frontend(tmp_path, runtime)
    try:
        runtime.process.stdin.close()  # EOF/zero exit WITHOUT a native drain acknowledgment.
        await runtime._reader
        await runtime._shutdown_task
        old = runtime.process
        assert old.returncode == exit_code
        assert storage.validate_api_key(key) is None
        with pytest.raises(CodingRuntimeError) as failure:
            await runtime.restart()
        assert failure.value.code == "cleanup_failed"
        assert runtime.status()["state"] == "cleanup_failed"
        assert runtime.process is old and runtime.local_serving is serving
        assert serving.inspect("unconfirmed-owner")["state"] == "protected"
        assert kw._coding_holds["unconfirmed-owner"] is hold
        assert kw.coding_model_protection_count(backend) == 1
        assert not (tmp_path / "replacement-commands.jsonl").exists()
    finally:
        await runtime.close()
        kw.release_coding_model("unconfirmed-owner")  # Dispose only this test-owned receipt.


@pytest.mark.asyncio
async def test_busy_restart_preserves_current_local_credentials_and_protections(coding_app, tmp_path):
    from core.coding_local_models import LocalOperation

    app, _ = coding_app
    runtime = CodingRuntime()
    await runtime.configure_local_serving(setup_request(app))
    serving = runtime.local_serving
    serving.operations["active-request"] = LocalOperation((), state="protected")
    await child_runtime(tmp_path, runtime=runtime, reject=True)
    old = runtime.process
    try:
        with pytest.raises(CodingRuntimeError) as failure:
            await runtime.restart()
        assert failure.value.code == "busy"
        assert runtime.process is old and old.returncode is None
        assert runtime.local_serving is serving and not serving.closing
        assert storage.validate_api_key(serving.key) == "unsloth"
        assert serving.inspect("active-request")["state"] == "protected"
        assert (tmp_path / "native-command-trace").read_text().splitlines() == ["prepare_restart"]
    finally:
        await runtime.close()
    assert serving.inspect("active-request")["state"] == "released"
    assert storage.validate_api_key(serving.key) is None


@pytest.mark.asyncio
@pytest.mark.parametrize("failure_kind", ["release", "retirement"])
async def test_failed_local_cleanup_retains_receipts_and_refuses_replacement(coding_app, monkeypatch, tmp_path, failure_kind):
    from core.coding_local_models import LocalOperation
    from core.inference import llama_keepwarm as kw

    app, _ = coding_app
    monkeypatch.setattr(kw, "_coding_holds", {})
    runtime = CodingRuntime()
    await runtime.configure_local_serving(setup_request(app))
    serving = runtime.local_serving
    backend = SimpleNamespace(is_loaded=True, model_identifier="resident-model")
    hold = kw.hold_coding_model("cleanup-owner", backend, identity=kw.coding_model_identity(backend))
    serving.operations["cleanup-owner"] = LocalOperation((), state="protected")
    await child_runtime(tmp_path, runtime=runtime)
    old = runtime.process
    replacement_frontend(tmp_path, runtime)
    app.state.coding_runtime = runtime

    def fail(*args, **kwargs):
        raise RuntimeError("isolated local cleanup failure")

    try:
        with monkeypatch.context() as patch:
            if failure_kind == "release":
                patch.setattr(kw, "release_coding_model", fail)
            else:
                patch.setattr(storage, "revoke_internal_api_key", fail)
            with pytest.raises(CodingRuntimeError) as failure:
                await runtime.restart()
            assert failure.value.code == "cleanup_failed"
            assert runtime.status()["state"] == "cleanup_failed"
            assert runtime.status()["cleanup"]["native_drain_confirmed"] is True
            assert runtime.status()["cleanup"]["confirmed"] is False
            assert runtime.process is old and old.returncode == 0
            assert runtime.local_serving is serving and serving.closing
            assert not (tmp_path / "replacement-commands.jsonl").exists()
            if failure_kind == "release":
                assert serving.inspect("cleanup-owner")["state"] == "protected"
                assert kw._coding_holds["cleanup-owner"] is hold
                assert storage.validate_api_key(serving.key) is None
            else:
                assert serving.inspect("cleanup-owner")["state"] == "released"
                assert kw.coding_model_protection_count(backend) == 0
                assert runtime._local_key_id is not None
                assert storage.validate_api_key(serving.key) == "unsloth"
                # Storage failure cannot keep the old incarnation authoritative.
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                    native = {"Authorization": "Bearer " + serving.key}
                    assert (await client.get("/api/coding/local-models/catalog", headers=native)).status_code == 403
                    assert (await client.post("/api/coding/local-models/release", headers=native,
                                              json={"incarnation": serving.incarnation, "operation_id": "cleanup-owner"})).status_code == 403
    finally:
        await runtime.close()
        kw.release_coding_model("cleanup-owner")
    assert storage.validate_api_key(serving.key) is None


@pytest.mark.asyncio
async def test_replacement_credential_remains_bound_to_authenticated_generation(coding_app, monkeypatch, tmp_path):
    app, _ = coding_app
    runtime = CodingRuntime()
    await runtime.configure_local_serving(setup_request(app))
    old_key = runtime.local_serving.key
    await child_runtime(tmp_path, runtime=runtime)
    old = runtime.process
    replacement_frontend(tmp_path, runtime)
    storage.update_password("unsloth", "isolated-rotated-password")
    try:
        with pytest.raises(CodingRuntimeError) as failure:
            await runtime.restart()
        assert failure.value.code == "denied"
        assert old.returncode == 0 and runtime.process is None
        assert storage.validate_api_key(old_key) is None
        assert runtime._local_key_id is None
        assert not (tmp_path / "replacement-commands.jsonl").exists()
        # A fresh authenticated setup can deliberately retry, not replay work.
        await runtime.configure_local_serving(setup_request(app))
        result = await runtime.restart()
        assert result["state"] == "running"
        assert storage.validate_api_key(runtime.local_serving.key) == "unsloth"
        assert [json.loads(line)["method"] for line in (tmp_path / "replacement-commands.jsonl").read_text().splitlines()] == ["ping"]
    finally:
        await runtime.close()
