# SPDX-License-Identifier: AGPL-3.0-only
"""Check or run a Mimir terminal command in the selected Linux checkout."""

import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time

# Invoked as python -I with a user checkout as cwd. Import from the installed backend.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from fastapi import HTTPException

from auth.policy import installation_has_managed_accounts
from core.inference import os_sandbox, tools
from state import tool_policy

TIMEOUT_SECONDS = 120


def checkout(mode: str) -> str:
    if sys.platform != "linux":
        raise ValueError("The Studio coding terminal requires Linux.")
    if installation_has_managed_accounts():
        raise ValueError(
            "The Studio coding terminal requires a single-owner Studio installation."
        )

    tool_policy.require_tool_access(mode)
    from core.inference import sandbox_linux
    from core.rag.folder_sync import validate_folder_path

    cwd = validate_folder_path(os.getcwd())
    if sandbox_linux._holds_studio_state(cwd):
        raise ValueError("Select a project checkout outside Studio storage.")
    return cwd


def check(mode: str, command: str) -> int:
    # Off can skip even a risky command because run requires OS isolation and
    # refuses a failed launch. New Chat can also run with software safeguards.
    ask = tool_policy.needs_tool_confirmation(
        confirm_tool_calls = mode != "off",
        bypass_permissions = mode == "full",
        permission_mode = mode,
        name = "terminal",
        arguments = {"command": command},
        sandbox_level = "high",
    )
    return 10 if ask else 0


def run(mode: str, cwd: str, command: str, cancelled: threading.Event) -> int:
    full = mode == "full"
    if full:
        if not tools._harden_parent_against_proc_env_leak():
            raise ValueError("Studio could not prepare the Full access terminal.")
    else:
        tools._refresh_sandbox_memory_limit()
    prepared = os_sandbox.prepare_tool_launch(
        os_sandbox.ToolLaunchPlan(
            argv = ("/bin/bash", "--noprofile", "--norc", "-c", command),
            workdir = cwd,
            env = tools._build_safe_env(cwd, temp_dir = "/tmp"),
            preexec_fn = tools._bypass_preexec if full else tools._sandbox_preexec,
            requested_mode = "full" if full else "required",
            execution_kind = "terminal",
            cancel_event = cancelled,
            timeout_seconds = TIMEOUT_SECONDS,
            share_model_storage = False,
        )
    )
    proc = None
    try:
        if cancelled.is_set():
            return 130
        # Inherit stdout/stderr separately so the plugin can stream and bound both.
        options = tools._apply_prepared_launch(prepared, {"stdin": subprocess.DEVNULL})
        proc = os_sandbox.spawn_prepared_launch(prepared, **options)
        deadline = time.monotonic() + TIMEOUT_SECONDS
        while proc.poll() is None:
            if cancelled.is_set():
                return 130
            if time.monotonic() >= deadline:
                print("Studio terminal timed out.", file=sys.stderr)
                return 124
            time.sleep(0.025)
        return proc.returncode if proc.returncode >= 0 else 128 - proc.returncode
    finally:
        if proc is not None:
            # Each launch owns its process group, which can outlive its shell.
            tools._killpg_captured(proc.pid)
            proc.wait()
        prepared.cleanup()


def main() -> int:
    cancelled = threading.Event()

    def cancel(signum, frame):
        cancelled.set()

    signal.signal(signal.SIGTERM, cancel)
    signal.signal(signal.SIGINT, cancel)
    try:
        if len(sys.argv) != 3:
            raise ValueError("Expected a permission mode and a check or run operation.")
        mode, operation = sys.argv[1:]
        if mode not in {"ask", "auto", "off", "full"} or operation not in {"check", "run"}:
            raise ValueError("Unknown terminal permission mode or operation.")
        request = json.load(sys.stdin)
        if (
            not isinstance(request, dict)
            or set(request) != {"command"}
            or not isinstance(request["command"], str)
            or not request["command"].strip()
            or "\x00" in request["command"]
        ):
            raise ValueError('Expected a nonempty terminal "command".')
        cwd = checkout(mode)
        if operation == "check":
            # This short-lived policy process classifies absolute checkout paths
            # against the same root the separate launch process will mount.
            os.environ["UNSLOTH_STUDIO_SANDBOX_HOME"] = cwd
            return check(mode, request["command"])
        return run(mode, cwd, request["command"], cancelled)
    except HTTPException as exc:
        print(f"Studio terminal: {exc.detail}", file=sys.stderr)
        return 125
    except (OSError, ValueError, os_sandbox.SandboxUnavailableError) as exc:
        print(f"Studio terminal: {exc}", file=sys.stderr)
        return 130 if cancelled.is_set() else 125


if __name__ == "__main__":
    raise SystemExit(main())
