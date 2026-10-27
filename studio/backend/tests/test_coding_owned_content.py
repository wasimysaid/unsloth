# SPDX-License-Identifier: AGPL-3.0-only
"""Owned content lifetime across the real framed backend reader and ASGI response."""
import asyncio
import json
import struct
from types import SimpleNamespace

import pytest

from core.coding_runtime import CodingRuntime, CodingRuntimeError
from routes.coding import NativeContentResponse


class NativePeer:
    def __init__(self, held = None):
        self.runtime = CodingRuntime()
        self.runtime._generation = 1
        self.source = asyncio.StreamReader()
        self.runtime.process = SimpleNamespace(stdin = self, stdout = self.source, returncode = 0)
        self.runtime._reader = asyncio.create_task(self.runtime._read_responses())
        self.transfers = {}
        self.commands = []
        self.held = held
        self.waiting = asyncio.Event()
        self.release = None
        self.bad_offset = False

    def write(self, data):
        request = json.loads(data[4:])
        method, params = request["method"], request["params"]
        self.commands.append((method, params))
        key = params.get("transfer_id")
        if method == "open_public_entry":
            self.transfers[key] = params
            result = params
        elif method == "read_public_entry":
            identity = self.transfers[key]
            text = "漢🙂\"\\\n" * 10000 + identity["entry_id"]
            result = {**identity, "offset": 1 if self.bad_offset else 0,
                      "data": json.dumps([{"id": "row", "entry_id": identity["entry_id"], "text": text}], ensure_ascii = False), "done": True}
        elif method == "close_public_entry":
            self.transfers.pop(key, None)
            result = {}
        elif method == "cancel":
            result = {"cancel_requested": True}
        else:
            raise AssertionError(method)
        def reply():
            encoded = json.dumps({"id": request["id"], "result": result}).encode()
            self.source.feed_data(struct.pack(">I", len(encoded)) + encoded)
        if method == self.held:
            self.release = reply
            self.waiting.set()
        else:
            reply()

    async def drain(self):
        pass

    async def close(self):
        self.runtime._reader.cancel()
        await asyncio.gather(self.runtime._reader, return_exceptions = True)
        assert not self.runtime._content_files
        assert not self.runtime._cleanup_tasks
        assert not self.runtime._pending
        assert not self.transfers


CUT = {"journal": "root", "leaf": "leaf"}


@pytest.mark.asyncio
async def test_concurrent_files_outlive_native_release_and_stop_remains_available():
    peer = NativePeer()
    runtime = peer.runtime
    try:
        first, second = await asyncio.gather(*[
            runtime.public_entry("saved", CUT, entry, expected_generation = 1) for entry in ["one", "two"]
        ])
        assert not peer.transfers
        assert len(runtime._content_files) == 2
        assert await runtime.command("cancel", {"conversation_id": "saved", "request_id": "active"}, expected_generation = 1) == {"cancel_requested": True}
        for content, entry in [(first, "one"), (second, "two")]:
            rows = json.load(content)
            assert rows == [{"id": "row", "entry_id": entry, "text": "漢🙂\"\\\n" * 10000 + entry}]
            runtime.release_content(content)
            assert content.closed
        assert [method for method, _ in peer.commands].count("open_public_entry") == 2
        assert [method for method, _ in peer.commands].count("read_public_entry") == 2
        assert [method for method, _ in peer.commands].count("close_public_entry") == 2
    finally:
        await peer.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("held", ["open_public_entry", "read_public_entry", "close_public_entry"])
async def test_cancelled_http_work_reconciles_admission_and_joins_release(held):
    peer = NativePeer(held)
    task = asyncio.create_task(peer.runtime.public_entry("saved", CUT, "entry", expected_generation = 1))
    try:
        await asyncio.wait_for(peer.waiting.wait(), 5)
        task.cancel()
        if held == "close_public_entry":
            await asyncio.sleep(0)
            assert not task.done(), "cancellation must not detach native cleanup"
            peer.release()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 5)
        if held != "close_public_entry":
            peer.release()
            await asyncio.sleep(0)
        assert [method for method, _ in peer.commands].count("close_public_entry") == 1
    finally:
        await peer.close()


@pytest.mark.asyncio
async def test_invalid_native_chunk_closes_transfer_and_file():
    peer = NativePeer()
    peer.bad_offset = True
    try:
        with pytest.raises(CodingRuntimeError, match = "inconsistent"):
            await peer.runtime.public_entry("saved", CUT, "entry", expected_generation = 1)
        assert peer.commands[-1][0] == "close_public_entry"
    finally:
        await peer.close()


@pytest.mark.asyncio
async def test_disconnect_before_headers_cancels_production_and_releases_file():
    peer = NativePeer("read_public_entry")
    sent = []
    async def receive():
        await peer.waiting.wait()
        return {"type": "http.disconnect"}
    async def send(message):
        sent.append(message)
    try:
        response = NativeContentResponse(peer.runtime, "saved", {"cut": CUT, "entry_id": "entry"}, 1)
        await asyncio.wait_for(response({}, receive, send), 5)
        assert not sent
        assert peer.commands[-1][0] == "close_public_entry"
        peer.release()
        await asyncio.sleep(0)
    finally:
        await peer.close()


@pytest.mark.asyncio
async def test_slow_response_does_not_hold_native_production_or_other_readers():
    peer = NativePeer()
    blocked = asyncio.Event()
    disconnect = asyncio.Event()
    sent = []
    async def receive():
        await disconnect.wait()
        return {"type": "http.disconnect"}
    async def send(message):
        sent.append(message)
        if message["type"] == "http.response.body":
            blocked.set()
            await asyncio.Future()
    response = NativeContentResponse(peer.runtime, "saved", {"cut": CUT, "entry_id": "first"}, 1)
    serving = asyncio.create_task(response({}, receive, send))
    try:
        await asyncio.wait_for(blocked.wait(), 5)
        assert not peer.transfers
        assert peer.commands[-1][0] == "close_public_entry"
        second = await asyncio.wait_for(peer.runtime.public_entry("saved", CUT, "second", expected_generation = 1), 5)
        assert json.load(second)[0]["entry_id"] == "second"
        peer.runtime.release_content(second)
        assert len(peer.runtime._content_files) == 1
        disconnect.set()
        await asyncio.wait_for(serving, 5)
    finally:
        await peer.close()
