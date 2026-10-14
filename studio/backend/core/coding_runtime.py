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
import uuid
from typing import Any

log = logging.getLogger(__name__)
MAX_FRAME = 1024 * 1024
COMMAND_TIMEOUT = 60
# Cold native component validation/compilation may exceed two minutes on a
# development build. This setup bound never extends execution-command deadlines.
INSTALL_TIMEOUT = 600
PLUGIN_ID = "studio.frontend"


class CodingRuntimeError(Exception):
    def __init__(self, code: str, message: str, overlap: dict | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.overlap = overlap


class CodingRuntime:
    def __init__(self, executable: str | None = None):
        # Native positions are comparable only within this non-restarting runtime.
        # An opaque random epoch scopes browser observation, not execution authority.
        self.observation_epoch = uuid.uuid4().hex
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
        self.local_serving = None
        self._local_key_id: int | None = None
        self._local_origin: str | None = None

    async def configure_local_serving(self, request) -> None:
        """Configure one native provider over a trusted host socket, never Host headers.

        ASGI unit/CPU-only compositions without a server tuple do not gain local
        serving. Production uses the real listening socket (or explicit loopback
        origin). The ephemeral workflow credential stays host-side and is stored
        only as a hash by the established Studio credential owner.
        """
        if os.environ.get("UNSLOTH_MIMIR_LOCAL_SERVING") == "0":
            return
        from urllib.parse import urlsplit
        import uuid

        origin = os.environ.get("UNSLOTH_MIMIR_STUDIO_URL")
        if not origin:
            server = request.scope.get("server")
            if not server:
                return
            port = server[1]
            if not isinstance(port, int) or not 1 <= port <= 65535:
                return
            origin = f"http://127.0.0.1:{port}"
        import ipaddress

        try:
            parsed = urlsplit(origin)
            loopback = ipaddress.ip_address(parsed.hostname or "").is_loopback
            port = parsed.port  # Validate malformed/out-of-range ports before minting.
            valid = (loopback and parsed.scheme == "http"
                     and (port is None or 1 <= port <= 65535)
                     and not parsed.username and not parsed.password
                     and parsed.path in ("", "/") and not parsed.query and not parsed.fragment)
        except ValueError:
            valid = False
        if not valid:
            # Match native's numeric-loopback HTTP contract, not browser Host/DNS.
            raise CodingRuntimeError("invalid", "The Studio local serving origin must be a trusted loopback numeric HTTP origin without credentials or a path.")
        # Setup, process publication and shutdown share one linearization lock.
        async with self._start_lock:
            if self.local_serving is not None:
                if self._local_origin != origin.rstrip("/"):
                    raise CodingRuntimeError("conflict", "The live Studio serving endpoint changed. Drain work before an explicit runtime restart.")
                return
            if self.process is not None or self._closing:
                raise CodingRuntimeError("busy", "Local serving was not configured before native startup. Drain work before an explicit runtime restart.")
            subject = getattr(request.state, "coding_subject", None)
            if not subject:
                raise CodingRuntimeError("denied", "Studio authentication is required before local serving setup.")
            from auth.storage import CredentialRotated, create_api_key, revoke_internal_api_key
            from core.coding_local_models import CodingLocalServing
            if self._local_key_id is not None:
                # A failed cancellation retirement remains owned. Never overwrite
                # that receipt with a new mint while its credential may be live.
                try:
                    await asyncio.to_thread(revoke_internal_api_key, self._local_key_id)
                except Exception:
                    raise CodingRuntimeError("unavailable", "The previous native workflow credential has not retired. Restore Studio credential storage and explicitly retry; no replacement was created.") from None
                self._local_key_id = None
            incarnation = str(uuid.uuid4())
            mint = asyncio.create_task(asyncio.to_thread(
                create_api_key, subject, "mimir coding " + incarnation, internal=True,
                expect_gen=getattr(request.state, "coding_credential_generation", None),
            ))
            try:
                key, record = await asyncio.shield(mint)
            except asyncio.CancelledError:
                # Retain an independent cleanup task: repeated Task.cancel() must
                # not propagate into mint/revocation while SQLite keeps running.
                async def retire_mint():
                    try:
                        _key, minted = await mint
                    except CredentialRotated:
                        return
                    self._local_key_id = minted["id"]
                    await asyncio.to_thread(revoke_internal_api_key, minted["id"])
                    self._local_key_id = None

                retirement = asyncio.create_task(retire_mint())
                self._cleanup_tasks.add(retirement)
                retirement.add_done_callback(self._cleanup_tasks.discard)
                with anyio.CancelScope(shield=True):
                    while not retirement.done():
                        try:
                            await asyncio.shield(retirement)
                        except asyncio.CancelledError:
                            continue
                    retirement.result()
                raise
            except CredentialRotated:
                raise CodingRuntimeError("denied", "The Studio credential changed. Sign in again before starting local serving.") from None
            self._local_key_id = record["id"]
            if self._closing:
                with anyio.CancelScope(shield=True):
                    await self._close_local_serving(clean=True)
                raise CodingRuntimeError("unavailable", "The coding runtime shut down during serving setup.")
            self._local_origin = origin.rstrip("/")
            self.local_serving = CodingLocalServing(incarnation, key, subject)

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
                environment = dict(os.environ)
                # Neither installer nor native guests inherit an old incarnation.
                for name in ("MIMIR_STUDIO_LOCAL_URL", "MIMIR_STUDIO_LOCAL_KEY",
                             "MIMIR_STUDIO_LOCAL_INCARNATION", "MIMIR_STUDIO_LOCAL_FD"):
                    environment.pop(name, None)
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
                        stderr = asyncio.subprocess.DEVNULL, env = environment,
                    )
                    try:
                        installed = await asyncio.wait_for(installer.wait(), timeout = INSTALL_TIMEOUT)
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
                read_fd = write_fd = None
                try:
                    if self.local_serving is not None:
                        if os.name != "posix":
                            raise CodingRuntimeError("unavailable", "Studio local serving requires the native inherited-pipe bootstrap on a supported Unix host.")
                        bootstrap = json.dumps({
                            "origin": self._local_origin,
                            "key": self.local_serving.key,
                            "incarnation": self.local_serving.incarnation,
                        }, separators=(",", ":")).encode("utf-8")
                        read_fd, write_fd = os.pipe()
                        # Fit an atomic write before spawning; no buffered writer
                        # or credential-bearing environment survives into Mimir.
                        if len(bootstrap) > min(4096, os.fpathconf(write_fd, "PC_PIPE_BUF")):
                            raise CodingRuntimeError("invalid", "Studio local serving bootstrap exceeds its private pipe limit.")
                        if os.write(write_fd, bootstrap) != len(bootstrap):
                            raise OSError("Incomplete private bootstrap write")
                        os.close(write_fd)
                        write_fd = None
                        environment["MIMIR_STUDIO_LOCAL_FD"] = str(read_fd)
                    self.process = await asyncio.create_subprocess_exec(
                        self.executable, "plugin", "run", PLUGIN_ID,
                        stdin = asyncio.subprocess.PIPE,
                        stdout = asyncio.subprocess.PIPE,
                        stderr = asyncio.subprocess.PIPE,
                        limit = MAX_FRAME + 4,
                        env = environment,
                        pass_fds = (read_fd,) if read_fd is not None else (),
                    )
                finally:
                    # Native consumes/closes its transferred copy before plugins
                    # or threads start. Parent copies close even on cancellation.
                    for descriptor in (write_fd, read_fd):
                        if descriptor is not None:
                            os.close(descriptor)
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
            self._fail(CodingRuntimeError(
                "disconnected", "The coding runtime disconnected. No operation was replayed. "
                "Check the installed plugin and restart Studio before deliberately reopening history.",
            ))
            if not self._closing:
                # Also retire credentials when reaping won the race with EOF. An
                # exited process still owes supervisor/key cleanup; nonzero exit
                # never releases unconfirmed model holds.
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
        if method == "view":
            self._opening_views.add(identifier)
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
            reconciliation = (
                "load the saved MCP version for comparison before deliberately retrying. Your draft is retained."
                if method == "mcp_save" else
                "inspect the exact native MCP operation before another apply or reconnect. Saved configuration and drafts are retained."
                if method in {"mcp_apply", "mcp_reconnect"} else
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
                await self._close_local_serving(clean=True)
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
            await self._close_local_serving(clean=clean and self.process.returncode == 0)
        if self._cleanup_tasks:
            await asyncio.gather(*tuple(self._cleanup_tasks), return_exceptions = True)

    async def _close_local_serving(self, *, clean: bool) -> None:
        try:
            if self.local_serving is not None:
                await self.local_serving.close(clean=clean)
        finally:
            if self._local_key_id is not None:
                from auth.storage import revoke_internal_api_key
                await asyncio.to_thread(revoke_internal_api_key, self._local_key_id)
                self._local_key_id = None


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
