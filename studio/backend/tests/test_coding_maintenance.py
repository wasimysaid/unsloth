# SPDX-License-Identifier: AGPL-3.0-only
"""Supervisor fault tests, not live native/model acceptance."""
from __future__ import annotations

import asyncio
import json
import sys

import httpx
import pytest
from fastapi import FastAPI

from auth import storage
from auth.authentication import create_access_token
from core.coding_runtime import CodingRuntime, CodingRuntimeError
from routes.coding import router


async def child_runtime(tmp_path, *, reject=False, confirm=True, exit_code=0, lose_guard=False, admitted=False):
    # Actual owned subprocess and real framed transport; the native admission is
    # deliberately fault-injected here. Real native busy coverage is separate.
    code = '''import sys,struct,json
while True:
    header=sys.stdin.buffer.read(4)
    if not header: break
    command=json.loads(sys.stdin.buffer.read(struct.unpack('>I',header)[0]))
    method=command['method']
    with open(sys.argv[6], 'a') as output: output.write(method+'\\n')
    if method=='prepare_restart' and sys.argv[4]=='True': continue
    if method=='maintenance_status':
        response={'id':command['id'],'result':{'admitted':sys.argv[5]=='True','cleanup_failed':False}}
    elif method=='prepare_restart' and sys.argv[1]=='True':
        response={'id':command['id'],'error':{'code':'busy','message':'Stop every busy conversation and wait for cleanup first.'}}
    elif method in ('prepare_restart','shutdown'):
        response={'id':command['id'],'result':{'cleanup_confirmed':sys.argv[2]=='True'}}
    else:
        response={'id':command['id'],'result':{'protocol':1,'plugin':'studio.frontend'}}
    body=json.dumps(response).encode(); sys.stdout.buffer.write(struct.pack('>I',len(body))+body); sys.stdout.buffer.flush()
sys.exit(int(sys.argv[3]))
'''
    runtime = CodingRuntime()
    runtime.process = await asyncio.create_subprocess_exec(sys.executable, "-c", code, str(reject), str(confirm), str(exit_code), str(lose_guard), str(admitted), str(tmp_path / "native-command-trace"),
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    runtime._reader = asyncio.create_task(runtime._read_responses())
    runtime._stderr = asyncio.create_task(runtime._drain_stderr())
    return runtime


@pytest.mark.asyncio
async def test_restart_refusal_keeps_owned_process_and_transport_alive(tmp_path):
    runtime = await child_runtime(tmp_path, reject=True)
    process = runtime.process
    try:
        with pytest.raises(CodingRuntimeError) as failure:
            await runtime.restart()
        assert failure.value.code == "busy"
        assert runtime.process is process and process.returncode is None
        assert await runtime.command("ping") == {"protocol": 1, "plugin": "studio.frontend"}
    finally:
        await runtime.close()
    assert runtime.status()["cleanup"]["confirmed"] is True


@pytest.mark.asyncio
@pytest.mark.parametrize("confirm,exit_code", [(False, 0), (True, 9)])
async def test_shutdown_helper_exit_is_not_proof_of_native_drain(tmp_path, confirm, exit_code):
    runtime = await child_runtime(tmp_path, confirm=confirm, exit_code=exit_code)
    await runtime.close()
    status = runtime.status()
    assert status["state"] == "cleanup_failed"
    assert status["cleanup"]["confirmed"] is False
    assert status["cleanup"]["exit_code"] == exit_code
    assert status["cleanup"]["native_drain_confirmed"] is confirm
    assert status["cleanup"]["message"]
    assert runtime.process.returncode == exit_code


@pytest.mark.asyncio
async def test_restart_does_not_launch_replacement_when_cleanup_unconfirmed(tmp_path, monkeypatch):
    runtime = await child_runtime(tmp_path, confirm=False)
    launched = []
    async def launch(*args, **kwargs):
        launched.append(args)
        raise AssertionError("Unconfirmed cleanup must not start a replacement")
    monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)
    with pytest.raises(CodingRuntimeError) as failure:
        await runtime.restart()
    assert failure.value.code == "uncertain"
    assert not launched
    assert runtime.process.returncode is None, "Unconfirmed guard must not cancel the original owner"
    assert runtime.status()["state"] == "maintenance_unconfirmed"
    await runtime.close()  # Separately authorized normal shutdown may drain/cancel.
    assert runtime.process.returncode == 0


@pytest.mark.asyncio
async def test_process_loss_never_becomes_successful_shutdown_or_replay(tmp_path):
    runtime = await child_runtime(tmp_path)
    process = runtime.process
    process.kill()
    await runtime._reader
    if runtime._shutdown_task:
        await runtime._shutdown_task
    assert runtime.status()["state"] == "disconnected"
    assert runtime.status()["cleanup"]["confirmed"] is False
    with pytest.raises(CodingRuntimeError) as failure:
        await runtime.command("prompt", {"submission_key": "same-key"})
    assert failure.value.code == "disconnected"
    assert runtime.process is process
    await runtime.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("ready", [True, False])
async def test_idle_restart_reaps_then_confirms_fresh_frontend_without_reopening_or_replay(tmp_path, ready):
    recorded = tmp_path / "replacement-commands.jsonl"
    executable = tmp_path / "owned-frontend-fixture"
    executable.write_text(f'''#!{sys.executable}
import sys,struct,json
while True:
    header=sys.stdin.buffer.read(4)
    if not header: break
    command=json.loads(sys.stdin.buffer.read(struct.unpack('>I',header)[0]))
    with open({str(recorded)!r}, 'a') as output: output.write(json.dumps(command)+'\\n')
    result={{'protocol':{1 if ready else 9},'plugin':'studio.frontend'}} if command['method']=='ping' else {{'cleanup_confirmed':True}}
    body=json.dumps({{'id':command['id'],'result':result}}).encode()
    sys.stdout.buffer.write(struct.pack('>I',len(body))+body);sys.stdout.buffer.flush()
''')
    executable.chmod(0o700)
    runtime = await child_runtime(tmp_path)
    runtime.executable = str(executable)
    runtime.package = None
    old = runtime.process
    if ready:
        result = await runtime.restart()
        assert result["state"] == "running" and 0 < result["generation"] < (1 << 53)
        assert result["cleanup"]["confirmed"] is True
        assert runtime.process.pid != old.pid and runtime.process.returncode is None
        assert old.returncode == 0
        assert [json.loads(line)["method"] for line in recorded.read_text().splitlines()] == ["ping"]
    else:
        with pytest.raises(CodingRuntimeError) as failure:
            await runtime.restart()
        assert failure.value.code == "disconnected"
        assert runtime.status()["state"] == "disconnected"
        assert runtime.status()["cleanup"]["confirmed"] is False
        assert runtime.process.returncode == 0 and old.returncode == 0
    await runtime.close()


@pytest.mark.asyncio
async def test_runtime_scope_and_auth_are_explicit(monkeypatch, tmp_path):
    monkeypatch.setattr(storage, "DB_PATH", tmp_path / "auth.db")
    storage.create_initial_user("unsloth", "isolated-test-password", "isolated-signing-secret-249-long-enough")
    app = FastAPI()
    app.include_router(router, prefix="/api/coding")
    headers = {"Authorization": "Bearer " + create_access_token("unsloth")}
    calls = []
    class Runtime:
        async def inspect_status(self):
            return {"state": "not_started", "generation": 0, "cleanup": None}
        async def restart(self):
            calls.append("restart")
            raise CodingRuntimeError("busy", "Explicit Stop and confirmed cleanup required for all hosted conversations.")
    app.state.coding_runtime = Runtime()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        for method, path in (("GET", "/runtime"), ("POST", "/runtime/restart")):
            response = await client.request(method, "/api/coding" + path, json={"scope": "all_hosted_conversations"})
            assert response.status_code in (401, 403)
        response = await client.get("/api/coding/runtime", headers=headers)
        assert response.json()["state"] == "not_started"
        for body in ({}, {"scope": "this_conversation"}, {"scope": "all_hosted_conversations", "force": True}):
            response = await client.post("/api/coding/runtime/restart", json=body, headers=headers)
            assert response.status_code == 422
        response = await client.post("/api/coding/runtime/restart", json={"scope": "all_hosted_conversations"}, headers=headers)
        assert response.status_code == 409
        assert "all hosted" in response.json()["detail"]
    assert calls == ["restart"]


@pytest.mark.asyncio
async def test_waiting_delivery_cannot_retarget_a_replaced_process():
    from types import SimpleNamespace
    entered = asyncio.Event()
    class Runtime(CodingRuntime):
        async def start(self, *, maintenance=False):
            entered.set()
    class Writer:
        def __init__(self): self.frames = []
        def write(self, data): self.frames.append(data)
        async def drain(self): pass
    runtime = Runtime()
    old, new = Writer(), Writer()
    runtime.process = SimpleNamespace(stdin=old)
    runtime._generation = 1
    await runtime._write_lock.acquire()
    command = asyncio.create_task(runtime.command("view", {"conversation_id": "saved"}))
    await entered.wait()
    runtime.process = SimpleNamespace(stdin=new)
    runtime._generation = 2
    runtime._write_lock.release()
    with pytest.raises(CodingRuntimeError) as failure:
        await command
    assert failure.value.code == "disconnected"
    assert not old.frames and not new.frames
    assert not runtime._abandoned_views and not runtime._pending


@pytest.mark.asyncio
async def test_open_stamp_uses_delivery_incarnation_not_later_status():
    import struct
    from types import SimpleNamespace
    stream = asyncio.StreamReader()
    runtime = CodingRuntime()
    class Writer:
        def write(self, data):
            command = json.loads(data[4:])
            body = json.dumps({"id": command["id"], "result": {"info": {"id": "saved", "cwd": "/canonical"}}}).encode()
            stream.feed_data(struct.pack(">I", len(body)) + body)
        async def drain(self):
            # A later supervision status does not restamp this admitted owner.
            runtime._generation = 2
    runtime.process = SimpleNamespace(stdin=Writer(), stdout=stream, returncode=0)
    runtime._generation = 1
    reader = asyncio.create_task(runtime._read_responses())
    result = await runtime.command("open", {"conversation_id": "saved"})
    assert result["info"] == {"id": "saved", "cwd": "/canonical", "runtime_generation": 1}
    assert runtime.status()["generation"] == 2
    stream.feed_eof()
    await reader


@pytest.mark.asyncio
async def test_shutdown_remains_stopping_until_native_drain_finishes(tmp_path):
    runtime = await child_runtime(tmp_path)
    entered, release = asyncio.Event(), asyncio.Event()
    original = runtime._request
    async def delayed(method, params=None, *, maintenance=False, expected_generation=None):
        if method == "shutdown":
            entered.set()
            await release.wait()
        return await original(method, params, maintenance=maintenance, expected_generation=expected_generation)
    runtime._request = delayed
    closing = asyncio.create_task(runtime.close())
    await entered.wait()
    assert runtime.status()["state"] == "stopping"
    assert runtime.process.returncode is None
    release.set()
    await closing
    assert runtime.status()["state"] == "stopped"
    assert runtime.status()["cleanup"]["confirmed"] is True


@pytest.mark.asyncio
async def test_unresponsive_process_requires_force_and_never_confirms_cleanup(monkeypatch):
    import core.coding_runtime as module
    monkeypatch.setattr(module, "DRAIN_TIMEOUT", 0.01)
    monkeypatch.setattr(module, "TERMINATE_TIMEOUT", 0.01)
    # Actual child acknowledges sessions settled, then deliberately ignores EOF
    # and SIGTERM. Native acknowledgment alone is not process cleanup either.
    code = '''import sys,struct,json,signal,time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
header=sys.stdin.buffer.read(4)
command=json.loads(sys.stdin.buffer.read(struct.unpack('>I',header)[0]))
body=json.dumps({'id':command['id'],'result':{'cleanup_confirmed':True}}).encode()
sys.stdout.buffer.write(struct.pack('>I',len(body))+body);sys.stdout.buffer.flush()
sys.stdin.buffer.read()
while True: time.sleep(1)
'''
    runtime = CodingRuntime()
    runtime.process = await asyncio.create_subprocess_exec(sys.executable, "-c", code,
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    runtime._reader = asyncio.create_task(runtime._read_responses())
    runtime._stderr = asyncio.create_task(runtime._drain_stderr())
    await runtime.close()
    status = runtime.status()
    assert status["state"] == "cleanup_failed"
    assert status["cleanup"]["forced"] is True
    assert status["cleanup"]["confirmed"] is False
    assert status["cleanup"]["exit_code"] != 0


@pytest.mark.asyncio
async def test_maintenance_closes_admission_and_survives_browser_cancellation(tmp_path):
    runtime = await child_runtime(tmp_path, confirm=False)
    entered, release = asyncio.Event(), asyncio.Event()
    original = runtime._request
    async def delayed(method, params=None, *, maintenance=False, expected_generation=None):
        if method == "prepare_restart":
            entered.set()
            await release.wait()
        return await original(method, params, maintenance=maintenance, expected_generation=expected_generation)
    runtime._request = delayed
    # An incomplete native response prevents replacement, but caller cancellation
    # must not abort the retained drain operation.
    restarting = asyncio.create_task(runtime.restart())
    await entered.wait()
    assert runtime.status()["state"] == "restarting"
    with pytest.raises(CodingRuntimeError) as refused:
        await runtime.command("prompt", {"submission_key": "must-not-admit", "text": "no replay"})
    assert refused.value.code == "busy"
    with pytest.raises(CodingRuntimeError) as duplicate:
        await runtime.restart()
    assert duplicate.value.code == "busy"
    restarting.cancel()
    with pytest.raises(asyncio.CancelledError):
        await restarting
    assert not runtime._restart_task.done()
    release.set()
    with pytest.raises(CodingRuntimeError) as failed:
        await runtime._restart_task
    assert failed.value.code == "uncertain"
    assert runtime.process.returncode is None
    assert runtime.status()["state"] == "maintenance_unconfirmed"
    await runtime.close()
    assert runtime.status()["cleanup"]["confirmed"] is False


@pytest.mark.asyncio
@pytest.mark.parametrize("admitted", [False, True])
async def test_lost_restart_guard_preserves_process_and_requires_inspection_not_replay(tmp_path, monkeypatch, admitted):
    import core.coding_runtime as module
    normal_timeout = module.COMMAND_TIMEOUT
    monkeypatch.setattr(module, "COMMAND_TIMEOUT", 0.05)
    runtime = await child_runtime(tmp_path, lose_guard=True, admitted=admitted)
    process = runtime.process
    with pytest.raises(CodingRuntimeError) as failure:
        await runtime.restart()
    assert failure.value.code == "uncertain"
    assert process.returncode is None and not process.stdin.is_closing()
    assert runtime.status()["state"] == "maintenance_unconfirmed"
    with pytest.raises(CodingRuntimeError) as repeat:
        await runtime.restart()
    assert repeat.value.code == "uncertain"
    # Only the lost-ACK phase is fault-timed. Inspection and the explicitly
    # authorized replacement must use ordinary readiness/cleanup deadlines.
    monkeypatch.setattr(module, "COMMAND_TIMEOUT", normal_timeout)
    inspected = await runtime.inspect_status()
    assert inspected["state"] == ("restart_prepared" if admitted else "running")
    assert process.returncode is None, "Inspection is not permission to terminate or replace"
    assert (tmp_path / "native-command-trace").read_text().splitlines() == ["prepare_restart", "maintenance_status"]
    if admitted:
        executable = tmp_path / "prepared-replacement"
        executable.write_text(f'''#!{sys.executable}
import sys,struct,json
while True:
    header=sys.stdin.buffer.read(4)
    if not header: break
    command=json.loads(sys.stdin.buffer.read(struct.unpack('>I',header)[0]))
    with open({str(tmp_path / 'native-command-trace')!r}, 'a') as output: output.write(command['method']+'\\n')
    result={{'protocol':1,'plugin':'studio.frontend'}} if command['method']=='ping' else {{'cleanup_confirmed':True}}
    body=json.dumps({{'id':command['id'],'result':result}}).encode()
    sys.stdout.buffer.write(struct.pack('>I',len(body))+body);sys.stdout.buffer.flush()
''')
        executable.chmod(0o700)
        runtime.executable, runtime.package = str(executable), None
        completed = await runtime.restart()  # A separate, explicit user action.
        assert completed["state"] == "running" and completed["cleanup"]["confirmed"] is True
        assert process.returncode == 0 and runtime.process.pid != process.pid
        assert (tmp_path / "native-command-trace").read_text().splitlines() == ["prepare_restart", "maintenance_status", "ping"]
    await runtime.close()


@pytest.mark.asyncio
async def test_local_limit_cannot_authorize_restart_without_sending_native_guard(tmp_path):
    runtime = await child_runtime(tmp_path)
    process = runtime.process
    futures = [asyncio.get_running_loop().create_future() for _ in range(128)]
    runtime._pending.update(enumerate(futures, 1))
    with pytest.raises(CodingRuntimeError) as failure:
        await runtime.restart()
    assert failure.value.code == "limit"
    assert process.returncode is None and not process.stdin.is_closing()
    assert runtime.status()["state"] == "running"
    assert not (tmp_path / "native-command-trace").exists()
    runtime._pending.clear()
    for future in futures: future.cancel()
    await runtime.close()


@pytest.mark.asyncio
async def test_owner_http_calls_are_fenced_before_delivery_even_after_other_tab_reopens(monkeypatch, tmp_path):
    monkeypatch.setattr(storage, "DB_PATH", tmp_path / "auth.db")
    storage.create_initial_user("unsloth", "isolated-test-password", "isolated-signing-secret-249-owner-fence")
    runtime = await child_runtime(tmp_path)
    runtime._generation = 20  # Replacement owner deliberately opened by another tab.
    app = FastAPI()
    app.include_router(router, prefix="/api/coding")
    app.state.coding_runtime = runtime
    token = {"Authorization": "Bearer " + create_access_token("unsloth")}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        for method, path, body in (
            ("POST", "/conversations/same-saved-id/prompts", {"submission_key": "old-tab-new-key", "text": "must not run"}),
            ("POST", "/conversations/same-saved-id/requests/exact/cancel", None),
            ("POST", "/conversations/same-saved-id/entries", {"cut": {"journal": "root", "leaf": None}}),
            ("GET", "/conversations/same-saved-id/events", None),
        ):
            missing = await client.request(method, "/api/coding" + path, headers=token, json=body)
            assert missing.status_code == 422
            stale = await client.request(method, "/api/coding" + path,
                headers={**token, "X-Mimir-Runtime-Generation": "19"}, json=body)
            assert stale.status_code == 409
            assert stale.headers["X-Mimir-Requires-Reopen"] == "true"
            assert "Deliberately reopen" in stale.json()["detail"]
    assert runtime.process.returncode is None
    assert not (tmp_path / "native-command-trace").exists(), "No stale prompt, Stop, view, or history command reached the new owner"
    await runtime.close()
