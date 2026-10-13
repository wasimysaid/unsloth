# SPDX-License-Identifier: AGPL-3.0-only
"""One supervised Mimir frontend process; no Studio execution or history owner.

Only the installed product plugin owns Session Control handles. Browser lifetime
never owns the process. Production inherits the ordinary Mimir configuration;
MIMIR_CODING_AGENT_DIR is used only by isolated acceptance runs, not set here.
"""
from __future__ import annotations

import asyncio
import anyio
import contextlib
import json
import logging
import os
import struct
from typing import Any

log = logging.getLogger(__name__)
MAX_FRAME = 1024 * 1024
COMMAND_TIMEOUT = 60
PLUGIN_ID = "studio.frontend"


class CodingRuntimeError(Exception):
    def __init__(self, code: str, message: str, overlap: dict | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.overlap = overlap


class CodingRuntime:
    def __init__(self, executable: str | None = None):
        self.executable = executable or os.environ.get("UNSLOTH_MIMIR_EXECUTABLE", "mimir")
        self.package = os.environ.get("UNSLOTH_MIMIR_PLUGIN_PACKAGE")
        self.process: asyncio.subprocess.Process | None = None
        self._start_lock = asyncio.Lock()
        self._write_lock = asyncio.Lock()
        self._pending: dict[int, asyncio.Future] = {}
        self._subscriptions: dict[str, asyncio.Queue] = {}
        self._overflowed: set[str] = set()
        self._abandoned_views: set[int] = set()
        self._cleanup_tasks: set[asyncio.Task] = set()
        self._shutdown_task: asyncio.Task | None = None
        self._sequence = 0
        self._reader: asyncio.Task | None = None
        self._stderr: asyncio.Task | None = None
        self._failure: CodingRuntimeError | None = None
        self._closing = False

    def diagnostics(self) -> dict[str, Any]:
        """Bounded supervisor facts only; inspecting must not start/restart Mimir.

        Never expose executable/package paths, environment, stderr, pending command
        bodies, raw exceptions or credentials. Session execution remains native.
        """
        if self._closing:
            connection = "closing"
        elif self._failure:
            connection = "disconnected"
        elif self.process is None:
            connection = "not_started"
        elif self.process.returncode is not None:
            connection = "exited"
        else:
            connection = "connected"
        return {
            "connection": connection,
            "frontend_plugin": PLUGIN_ID,
            "protocol": 1,
            "pending_commands": len(self._pending),
            "open_views": len(self._subscriptions),
            "command_timeout_seconds": COMMAND_TIMEOUT,
            "max_frame_bytes": MAX_FRAME,
        }

    async def start(self) -> None:
        async with self._start_lock:
            if self._closing:
                raise CodingRuntimeError("unavailable", "The coding runtime is shutting down.")
            if self._failure:
                # Never restart implicitly: a lost response may have opened a saved conversation.
                raise self._failure
            if self.process is not None:
                return
            try:
                if self.package:
                    from pathlib import Path
                    import tomllib
                    try:
                        manifest = tomllib.loads((Path(self.package) / "mimir-plugin.toml").read_text(encoding = "utf-8"))
                        if manifest.get("id") != PLUGIN_ID:
                            raise ValueError("unexpected plugin ID")
                    except (OSError, ValueError) as exc:
                        raise CodingRuntimeError("unavailable", "The configured Mimir frontend package is invalid; rebuild the pinned studio.frontend package.") from exc
                    installer = await asyncio.create_subprocess_exec(
                        self.executable, "plugin", "install", self.package,
                        stdin = asyncio.subprocess.DEVNULL, stdout = asyncio.subprocess.DEVNULL,
                        stderr = asyncio.subprocess.DEVNULL,
                    )
                    try:
                        installed = await asyncio.wait_for(installer.wait(), timeout = 120)
                    except BaseException as exc:
                        with anyio.CancelScope(shield = True):
                            if installer.returncode is None:
                                installer.terminate()
                                try:
                                    await asyncio.wait_for(installer.wait(), timeout = 10)
                                except TimeoutError:
                                    installer.kill()
                                    await installer.wait()
                        if isinstance(exc, TimeoutError):
                            raise CodingRuntimeError("unavailable", "Mimir frontend installation timed out. Check the pinned package on the host.") from exc
                        raise
                    if installed != 0:
                        raise CodingRuntimeError("unavailable", "Mimir could not install the configured studio.frontend package. Rebuild it against the pinned SDK.")
                self.process = await asyncio.create_subprocess_exec(
                    self.executable, "plugin", "run", PLUGIN_ID,
                    stdin = asyncio.subprocess.PIPE,
                    stdout = asyncio.subprocess.PIPE,
                    stderr = asyncio.subprocess.PIPE,
                    limit = MAX_FRAME + 4,
                )
            except OSError as exc:
                raise CodingRuntimeError(
                    "unavailable",
                    "Mimir could not start. Build the pinned runtime and install studio.frontend; "
                    "check UNSLOTH_MIMIR_EXECUTABLE on the Studio host.",
                ) from exc
            self._reader = asyncio.create_task(self._read_responses())
            self._stderr = asyncio.create_task(self._drain_stderr())

    async def _drain_stderr(self) -> None:
        assert self.process and self.process.stderr
        # Drain without exposing raw configuration, credentials, or native diagnostics to HTTP.
        while await self.process.stderr.read(8192):
            pass

    def _fail(self, error: CodingRuntimeError) -> None:
        self._failure = error
        for future in self._pending.values():
            if not future.done():
                future.set_exception(error)
        self._pending.clear()
        for queue in self._subscriptions.values():
            while not queue.empty():
                queue.get_nowait()
            queue.put_nowait(error)

    def _release_late_view(self, result: Any) -> None:
        if isinstance(result, dict) and isinstance(result.get("subscription"), str):
            task = asyncio.create_task(self.unsubscribe(result["subscription"]))
            self._cleanup_tasks.add(task)
            task.add_done_callback(self._cleanup_tasks.discard)

    async def _read_responses(self) -> None:
        assert self.process and self.process.stdout
        try:
            while True:
                header = await self.process.stdout.readexactly(4)
                size = struct.unpack(">I", header)[0]
                if size == 0 or size > MAX_FRAME:
                    raise ValueError("invalid frame size")
                payload = json.loads(await self.process.stdout.readexactly(size))
                if not isinstance(payload, dict):
                    raise ValueError("invalid response envelope")
                if isinstance(payload.get("subscription"), str):
                    queue = self._subscriptions.get(payload["subscription"])
                    if queue is not None and payload["subscription"] not in self._overflowed:
                        if queue.full():
                            while not queue.empty():
                                queue.get_nowait()
                            queue.put_nowait(CodingRuntimeError(
                                "disconnected", "The native view exceeded the delivery buffer. Reconnect for a fresh native view.",
                            ))
                            # Retain the failure, not a partial suffix masquerading as complete.
                            self._overflowed.add(payload["subscription"])
                        else:
                            queue.put_nowait(payload)
                    continue
                if type(payload.get("id")) is not int:
                    raise ValueError("invalid response identity")
                # Validate before removing the matching future. Otherwise a malformed
                # error would orphan that command when the reader fails the transport.
                if "error" in payload:
                    error = payload["error"]
                    if not isinstance(error, dict) or not all(
                        isinstance(error.get(key), str) for key in ("code", "message")
                    ):
                        raise ValueError("invalid error envelope")
                    if error["code"] == "overlap_required":
                        overlap = error.get("overlap")
                        if (
                            not isinstance(overlap, dict)
                            or not isinstance(overlap.get("cwd"), str)
                            or not overlap["cwd"]
                            or not isinstance(overlap.get("conversations"), list)
                            or not 1 <= len(overlap["conversations"]) <= 32
                            or any(not isinstance(row, dict) or not isinstance(row.get("id"), str) or not row["id"]
                                   for row in overlap["conversations"])
                        ):
                            raise ValueError("invalid overlap refusal")
                identifier = payload["id"]
                future = self._pending.pop(identifier, None)
                if identifier in self._abandoned_views:
                    self._abandoned_views.discard(identifier)
                    # The caller timed out, not the native admission. Reconcile
                    # the late resource without blocking this response reader.
                    self._release_late_view(payload.get("result"))
                    continue
                if future is None or future.done():
                    continue
                if "error" in payload:
                    error = payload["error"]
                    future.set_exception(CodingRuntimeError(
                        error["code"], error["message"], error.get("overlap"),
                    ))
                elif "result" in payload:
                    result = payload["result"]
                    if isinstance(result, dict) and isinstance(result.get("subscription"), str):
                        # Register before waking the command caller: a native start may
                        # immediately follow the response in the very same pipe read.
                        queue = asyncio.Queue(maxsize = 128)
                        self._subscriptions[result["subscription"]] = queue
                        if "event" in result:
                            queue.put_nowait(result)
                    future.set_result(result)
                else:
                    future.set_exception(CodingRuntimeError("protocol", "Invalid Mimir response."))
        except (asyncio.IncompleteReadError, OSError, ValueError, KeyError, TypeError):
            self._fail(CodingRuntimeError(
                "disconnected", "The coding runtime disconnected. No operation was replayed. "
                "Check the installed plugin and restart Studio before deliberately reopening history.",
            ))
            if not self._closing and self.process.returncode is None:
                # No more output can be trusted/read. EOF initiates native cleanup;
                # a retained shutdown task awaits reaping without self-awaiting.
                self._shutdown_task = asyncio.create_task(self.close())

    async def command(self, method: str, params: dict[str, Any] | None = None) -> Any:
        await self.start()
        assert self.process and self.process.stdin
        if len(self._pending) + len(self._abandoned_views) >= 128:
            raise CodingRuntimeError("limit", "Too many pending native operations. Wait for their results before retrying.")
        self._sequence += 1
        identifier = self._sequence
        data = json.dumps({"id": identifier, "method": method, "params": params or {}},
                          separators = (",", ":"), allow_nan = False).encode()
        if len(data) > MAX_FRAME:
            raise CodingRuntimeError("invalid", "The coding command is too large.")
        future = asyncio.get_running_loop().create_future()
        self._pending[identifier] = future
        delivered = False
        try:
            async with self._write_lock:
                if self._failure:
                    raise self._failure
                self.process.stdin.write(struct.pack(">I", len(data)) + data)
                await self.process.stdin.drain()
            result = await asyncio.wait_for(asyncio.shield(future), timeout = COMMAND_TIMEOUT)
            delivered = True
            return result
        except TimeoutError as exc:
            raise CodingRuntimeError(
                "uncertain", "Mimir has not confirmed this operation. It was not retried; "
                "reconnect the native view to reconcile its state. Prompt retries must reuse "
                "the original submission identity; do not blindly retry other commands.",
            ) from exc
        except (BrokenPipeError, ConnectionResetError) as exc:
            raise CodingRuntimeError("disconnected", "The coding runtime disconnected; nothing was replayed.") from exc
        finally:
            self._pending.pop(identifier, None)
            if method == "view" and not delivered and not self._failure:
                if future.done() and not future.cancelled():
                    if future.exception() is None:
                        self._release_late_view(future.result())
                else:
                    self._abandoned_views.add(identifier)
            if not future.done():
                future.cancel()

    async def subscribe(self, conversation_id: str) -> tuple[str, asyncio.Queue]:
        opening = asyncio.create_task(self.command("view", {"conversation_id": conversation_id}))
        try:
            result = await asyncio.shield(opening)
        except asyncio.CancelledError:
            # A browser can leave after native admission but before the response.
            # Reconcile this view acquisition; never close the conversation owner.
            with anyio.CancelScope(shield = True):
                try:
                    result = await opening
                    await self.unsubscribe(result["subscription"])
                except CodingRuntimeError:
                    pass
            raise
        key = result["subscription"]
        return key, self._subscriptions[key]

    async def unsubscribe(self, subscription: str) -> None:
        self._subscriptions.pop(subscription, None)
        self._overflowed.discard(subscription)
        if self._failure or self._closing:
            return
        try:
            await self.command("close_view", {"subscription": subscription})
        except CodingRuntimeError:
            log.warning("Native coding view cleanup was not confirmed")

    async def close(self) -> None:
        self._closing = True
        # An in-flight installation/start cannot publish a process after shutdown.
        async with self._start_lock:
            if self.process is None:
                return
            # EOF asks the plugin to await native owner close before returning.
            if self.process.stdin:
                self.process.stdin.close()
            clean = True
            try:
                await asyncio.wait_for(self.process.wait(), timeout = 30)
            except TimeoutError:
                clean = False
                self.process.terminate()
                try:
                    await asyncio.wait_for(self.process.wait(), timeout = 10)
                except TimeoutError:
                    self.process.kill()
                    await self.process.wait()
            for task in (self._reader, self._stderr):
                if task:
                    if not task.done():
                        task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await task
            self._abandoned_views.clear()
            if not clean or self.process.returncode != 0:
                log.error("Mimir shutdown did not confirm clean native cleanup (exit=%s)", self.process.returncode)
        if self._cleanup_tasks:
            await asyncio.gather(*tuple(self._cleanup_tasks), return_exceptions = True)


def runtime_for(app) -> CodingRuntime:
    runtime = getattr(app.state, "coding_runtime", None)
    if runtime is None:
        runtime = CodingRuntime()
        app.state.coding_runtime = runtime
    return runtime


async def close_coding_runtime(app) -> None:
    runtime = getattr(app.state, "coding_runtime", None)
    if runtime is not None:
        await runtime.close()
