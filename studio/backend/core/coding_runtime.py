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
import secrets
import struct
from typing import Any

log = logging.getLogger(__name__)
MAX_FRAME = 1024 * 1024
COMMAND_TIMEOUT = 60
DRAIN_TIMEOUT = 30
TERMINATE_TIMEOUT = 10
PLUGIN_ID = "studio.frontend"


class CodingRuntimeError(Exception):
    def __init__(self, code: str, message: str, overlap: dict | None = None, *, requires_reopen: bool = False):
        super().__init__(message)
        self.code = code
        self.message = message
        self.overlap = overlap
        self.requires_reopen = requires_reopen


class CodingRuntime:
    def __init__(self, executable: str | None = None):
        self.executable = executable or os.environ.get("UNSLOTH_MIMIR_EXECUTABLE", "mimir")
        self.package = os.environ.get("UNSLOTH_MIMIR_PLUGIN_PACKAGE")
        self.process: asyncio.subprocess.Process | None = None
        self._start_lock = asyncio.Lock()
        self._write_lock = asyncio.Lock()
        self._pending: dict[int, asyncio.Future] = {}
        self._opening_views: set[int] = set()
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
        self._maintaining = False
        self._expected_exit = False
        self._maintenance_lock = asyncio.Lock()
        self._close_task: asyncio.Task | None = None
        self._restart_task: asyncio.Task | None = None
        self._generation = 0
        # A backend restart must not reset the browser's ownership fence to the
        # same small counter. Keep JS-safe unique epochs, monotonic per supervisor.
        self._next_generation = secrets.randbelow(1 << 50) + 1
        self._cleanup: dict[str, Any] | None = None
        self._cleanup_failed = False
        self._restart_uncertain = False
        self._restart_prepared = False

    def status(self) -> dict[str, Any]:
        # Reading diagnostics never launches a process or opens an execution owner.
        state = "not_started"
        if self._cleanup_failed:
            state = "cleanup_failed"
        elif self._maintaining and not self._closing:
            state = "restarting"
        elif self._failure and not self._closing:
            state = "disconnected"
        elif self._closing:
            state = "stopped" if self._close_task and self._close_task.done() else "stopping"
        elif self._restart_uncertain:
            state = "maintenance_unconfirmed"
        elif self._restart_prepared:
            state = "restart_prepared"
        elif self.process is not None:
            state = "running"
        return {"state": state, "generation": self._generation, "cleanup": self._cleanup}

    async def inspect_status(self) -> dict[str, Any]:
        # Reconcile a lost maintenance ACK by inspection, never guard replay or
        # process shutdown. A prepared runtime needs another explicit action.
        if self._restart_uncertain and not self._maintaining and not self._failure and not self._closing:
            generation, process = self._generation, self.process
            try:
                result = await self._request("maintenance_status", maintenance = True)
                if self._generation != generation or self.process is not process or self._closing:
                    return self.status()
                if not isinstance(result, dict) or type(result.get("admitted")) is not bool or type(result.get("cleanup_failed")) is not bool:
                    raise CodingRuntimeError("uncertain", "Native maintenance admission remains unconfirmed.")
                self._restart_uncertain = False
                self._restart_prepared = result["admitted"]
                if result["cleanup_failed"]:
                    self._cleanup_failed = True
                    self._record_cleanup(False, False, None)
            except CodingRuntimeError:
                # Preserve unknown admission and the original process; inspection
                # failures cannot authorize cancellation or a replacement.
                pass
        return self.status()

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

    async def start(self, *, maintenance: bool = False) -> None:
        async with self._start_lock:
            if self._maintaining and not maintenance:
                raise CodingRuntimeError("busy", "Whole-runtime maintenance is in progress. Wait for it to settle.")
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
            self._generation = self._next_generation
            self._next_generation += 1
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
                    if identifier in self._opening_views and isinstance(result, dict) and isinstance(result.get("subscription"), str):
                        # Only view admission acquires a queue. Answer ACKs echo the
                        # existing subscription; replacing it strands the SSE reader.
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
            error = CodingRuntimeError(
                "disconnected", "The coding runtime disconnected. Work may be interrupted; no operation was replayed. "
                "Use Restart whole Mimir runtime, then deliberately reopen saved history and explicitly continue if needed.",
                requires_reopen = True,
            )
            self._fail(error)
            if not self._expected_exit:
                # EOF is not a successful Stop. Reap our exact supervised process,
                # retaining unconfirmed cleanup and the failure until explicit restart.
                if self.process.returncode is None:
                    self._shutdown_task = asyncio.create_task(self._finish_process(False))
                else:
                    self._record_cleanup(False, False, self.process.returncode)

    async def command(self, method: str, params: dict[str, Any] | None = None, *, expected_generation: int | None = None) -> Any:
        if expected_generation is not None and expected_generation != self._generation:
            raise CodingRuntimeError("runtime_changed", "This conversation belongs to an earlier runtime incarnation. Deliberately reopen saved history; nothing was delivered or replayed.", requires_reopen = True)
        await self.start()
        return await self._request(method, params, expected_generation = expected_generation)

    async def _request(self, method: str, params: dict[str, Any] | None = None, *, maintenance: bool = False, expected_generation: int | None = None) -> Any:
        assert self.process and self.process.stdin
        generation = self._generation
        process = self.process
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
        if method == "view":
            self._opening_views.add(identifier)
        delivered = False
        written = False
        try:
            async with self._write_lock:
                if (self._maintaining or self._closing) and not maintenance:
                    raise CodingRuntimeError("busy", "Whole-runtime maintenance is in progress. Nothing was submitted; reopen after it settles.")
                if self._failure:
                    raise self._failure
                if not maintenance and (self._restart_prepared or (self._restart_uncertain and method in ("create", "open", "prompt"))):
                    raise CodingRuntimeError("busy", "Native restart admission must be reconciled before new work. Inspect runtime status; nothing was submitted.")
                if expected_generation is not None and expected_generation != self._generation:
                    raise CodingRuntimeError("runtime_changed", "The opened runtime incarnation changed. Deliberately reopen saved history before this action.", requires_reopen = True)
                if self.process is not process or self._generation != generation:
                    raise CodingRuntimeError("disconnected", "The runtime incarnation changed before delivery. Nothing was replayed; deliberately reopen and reconcile first.")
                process.stdin.write(struct.pack(">I", len(data)) + data)
                written = True
                await process.stdin.drain()
            result = await asyncio.wait_for(asyncio.shield(future), timeout = COMMAND_TIMEOUT)
            delivered = True
            if method in ("create", "open") and isinstance(result, dict) and isinstance(result.get("info"), dict):
                # Pin the HTTP owner to the incarnation that accepted it, not a
                # later status poll (which may race deliberate reopen).
                result = {**result, "info": {**result["info"], "runtime_generation": generation}}
            return result
        except TimeoutError as exc:
            reconciliation = (
                "load the saved MCP version for comparison before deliberately retrying. Your draft is retained."
                if method == "mcp_save" else
                "reconnect the native view to reconcile its state. Prompt retries must reuse "
                "the original submission identity; do not blindly retry other commands."
            )
            raise CodingRuntimeError(
                "uncertain", "Mimir has not confirmed this operation. It was not retried; " + reconciliation,
            ) from exc
        except (BrokenPipeError, ConnectionResetError) as exc:
            raise CodingRuntimeError("disconnected", "The coding runtime disconnected; nothing was replayed.") from exc
        finally:
            self._pending.pop(identifier, None)
            self._opening_views.discard(identifier)
            if method == "view" and written and not delivered and not self._failure:
                if future.done() and not future.cancelled():
                    if future.exception() is None:
                        self._release_late_view(future.result())
                else:
                    self._abandoned_views.add(identifier)
            if not future.done():
                future.cancel()
            elif not future.cancelled():
                future.exception()  # Observe a failure delivered before a write refusal.

    async def subscribe(self, conversation_id: str, *, expected_generation: int | None = None) -> tuple[str, asyncio.Queue]:
        opening = asyncio.create_task(self.command("view", {"conversation_id": conversation_id}, expected_generation = expected_generation))
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

    async def _finish_process(self, native_confirmed: bool) -> dict[str, Any]:
        process = self.process
        forced = bool(self._cleanup and self._cleanup["forced"])
        if process is not None:
            stdin = getattr(process, "stdin", None)
            if stdin:
                stdin.close()  # EOF still invokes native activation recovery.
            if process.returncode is None:
                try:
                    await asyncio.wait_for(process.wait(), timeout = DRAIN_TIMEOUT)
                except TimeoutError:
                    forced = True
                    with contextlib.suppress(ProcessLookupError):
                        process.terminate()
                    try:
                        await asyncio.wait_for(process.wait(), timeout = TERMINATE_TIMEOUT)
                    except TimeoutError:
                        with contextlib.suppress(ProcessLookupError):
                            process.kill()
                        await process.wait()
            for task in (self._reader, self._stderr):
                if task and task is not asyncio.current_task():
                    if not task.done():
                        task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await task
        if self._cleanup_tasks:
            await asyncio.gather(*tuple(self._cleanup_tasks), return_exceptions = True)
        self._abandoned_views.clear()
        return self._record_cleanup(native_confirmed, forced, process.returncode if process else None)

    def _record_cleanup(self, native_confirmed: bool, forced: bool, exit_code: int | None) -> dict[str, Any]:
        confirmed = native_confirmed and not forced and exit_code == 0
        self._cleanup = {
            "confirmed": confirmed, "native_drain_confirmed": native_confirmed,
            "exit_code": exit_code, "forced": forced,
            "message": "Native session drain and process cleanup confirmed." if confirmed else
                "Native drain/cleanup was not confirmed. Process exit is not proof that tools, children or MCP work settled; inspect host diagnostics before continuing interrupted work.",
        }
        if not confirmed:
            log.error("Mimir cleanup was not confirmed (exit=%s, forced=%s)", exit_code, forced)
        return self._cleanup

    async def _drain(self, method: str) -> dict[str, Any]:
        confirmed = False
        result = None
        try:
            if self.process is not None and not self._failure:
                result = await self._request(method, maintenance = True)
                confirmed = isinstance(result, dict) and result.get("cleanup_confirmed") is True
        except CodingRuntimeError as exc:
            if method == "prepare_restart":
                # No native permission means no EOF/termination. Even a lost ACK
                # is not permission to cancel busy hosted work.
                if exc.code in ("uncertain", "disconnected"):
                    self._restart_uncertain = True
                elif exc.code == "cleanup_failed":
                    self._cleanup_failed = True
                    self._record_cleanup(False, False, None)
                raise
            log.error("Mimir native drain was not confirmed (%s)", exc.code)
        if method == "prepare_restart" and not confirmed:
            self._restart_uncertain = True
            raise CodingRuntimeError("uncertain", "Native restart admission was not confirmed. The original process was preserved. Inspect runtime status before another action.")
        self._expected_exit = True
        if self._shutdown_task:
            await asyncio.shield(self._shutdown_task)
        cleanup = await self._finish_process(confirmed)
        # Retain sanitized native owner identities as terminal/ownership evidence.
        ids = result.get("conversation_ids") if isinstance(result, dict) else None
        if isinstance(ids, list) and len(ids) <= 32 and all(isinstance(item, str) and len(item) <= 128 for item in ids):
            cleanup["conversation_ids"] = ids
        return cleanup

    async def restart(self) -> dict[str, Any]:
        # Retain the whole operation if the browser disconnects. HTTP lifetime
        # neither cancels accepted maintenance nor causes a second process launch.
        if self._restart_task and not self._restart_task.done():
            raise CodingRuntimeError("busy", "Whole-runtime restart is already in progress. Refresh runtime status; do not replay it.")
        self._restart_task = asyncio.create_task(self._restart())
        # Retain and observe errors even when its HTTP caller disappears.
        self._restart_task.add_done_callback(lambda task: task.exception() if not task.cancelled() else None)
        with anyio.CancelScope(shield = True):
            return await asyncio.shield(self._restart_task)

    async def _restart(self) -> dict[str, Any]:
        async with self._maintenance_lock:
            if self._closing:
                raise CodingRuntimeError("unavailable", "The Studio backend is shutting down.")
            if self._cleanup_failed:
                raise CodingRuntimeError("cleanup_failed", "Previous runtime cleanup was incomplete. Inspect host diagnostics before starting another process.")
            if self._restart_uncertain and not self._failure:
                raise CodingRuntimeError("uncertain", "Restart admission is still unknown. Refresh runtime status to inspect it; the original process was preserved.")
            async with self._write_lock:
                self._maintaining = True
            try:
                # Wait for a concurrent start before preparing the native guard.
                async with self._start_lock:
                    pass
                if self._failure:
                    if self._shutdown_task:
                        await asyncio.shield(self._shutdown_task)
                    else:
                        await self._finish_process(False)
                    # Unexpected loss has no clean Stop claim. A reaped process
                    # permits explicit replacement, not automatic accepted-work replay.
                    if self._cleanup and self._cleanup["forced"]:
                        self._cleanup_failed = True
                        raise CodingRuntimeError("cleanup_failed", self._cleanup["message"])
                elif self.process is not None:
                    if self._restart_prepared:
                        self._expected_exit = True
                        cleanup = await self._finish_process(True)
                    else:
                        cleanup = await self._drain("prepare_restart")
                    if not cleanup["confirmed"]:
                        self._cleanup_failed = True
                        raise CodingRuntimeError("cleanup_failed", cleanup["message"])
                self._subscriptions.clear()
                self._overflowed.clear()
                self.process = None
                self._reader = self._stderr = self._shutdown_task = None
                self._failure = None
                self._expected_exit = False
                self._restart_uncertain = self._restart_prepared = False
                await self.start(maintenance = True)
                # Establish frontend activation/protocol readiness, not just helper launch.
                try:
                    pong = await self._request("ping", maintenance = True)
                    if pong != {"protocol": 1, "plugin": PLUGIN_ID}:
                        raise CodingRuntimeError("disconnected", "The replacement Mimir frontend did not confirm protocol readiness.")
                except CodingRuntimeError:
                    self._fail(CodingRuntimeError("disconnected", "The replacement Mimir frontend did not confirm protocol readiness. No owner was reopened or work replayed."))
                    self._expected_exit = True
                    if self._shutdown_task:
                        await asyncio.shield(self._shutdown_task)
                    else:
                        await self._finish_process(False)
                    raise self._failure
                return {**self.status(), "state": "running"}
            finally:
                self._maintaining = False

    async def close(self) -> None:
        if self._close_task is None:
            self._close_task = asyncio.create_task(self._close())
        with anyio.CancelScope(shield = True):
            await asyncio.shield(self._close_task)

    async def _close(self) -> None:
        self._closing = True
        async with self._maintenance_lock:
            async with self._start_lock:
                pass
            async with self._write_lock:
                self._maintaining = True
            try:
                if self.process is not None:
                    cleanup = await self._drain("shutdown")
                    self._cleanup_failed = not cleanup["confirmed"]
            finally:
                self._maintaining = False


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
