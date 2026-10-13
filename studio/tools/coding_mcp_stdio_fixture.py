#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""External MCP stdio protocol fixture, never a replacement for the native owner.

Each actual native connection starts a separate process. The task-owned control
file can hold/fail initialize or echo; events contain only fixture values, PID and
protocol identities, not provider context or environment. Stdout is JSON-RPC only.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import signal
import sys
import time


ECHO_TOOL = {
    "name": "echo", "description": "Return the acceptance marker and serving PID.",
    "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}},
                    "required": ["text"], "additionalProperties": False},
}


def read_events(path: Path) -> list[dict]:
    """Native connection processes append one small atomic JSON line at a time."""
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line]


def write_control(path: Path, **modes: str) -> None:
    """Replace atomically so a real child never reads a truncated control file."""
    pending = path.with_name(path.name + ".next")
    pending.write_text(json.dumps(modes))
    pending.replace(path)


def definition(events: Path, control: Path) -> dict:
    return {"command": sys.executable,
            "args": [str(Path(__file__).resolve()), "--events", str(events.resolve()),
                     "--control", str(control.resolve())], "enabled": True}


def serve(events: Path, control: Path) -> None:
    pid = os.getpid()

    def record(event, **detail):
        line = json.dumps({"event": event, "pid": pid, "time_ns": time.time_ns(), **detail}) + "\n"
        descriptor = os.open(events, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            os.write(descriptor, line.encode())
        finally:
            os.close(descriptor)

    def terminated(number, _frame):
        record("signal", signal = number)
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, terminated)
    signal.signal(signal.SIGINT, terminated)
    record("start", ppid = os.getppid())
    try:
        for line in sys.stdin:
            request = json.loads(line)
            method = request.get("method")
            if "id" not in request:
                record("notification", method = method)
                continue
            identifier = request["id"]
            record("request", method = method, request_id = identifier)
            action = "initialize" if method == "initialize" else "echo"
            deadline = time.monotonic() + 60
            holding = False
            while True:
                mode = json.loads(control.read_text()).get(action) if control.exists() else None
                if mode != "hold" or method not in ("initialize", "tools/call"):
                    break
                if not holding:
                    record("held", method = method, request_id = identifier)
                    holding = True
                if time.monotonic() >= deadline:
                    mode = "fail"
                    break
                time.sleep(0.025)
            if mode == "fail" and method in ("initialize", "tools/call"):
                record("failed", method = method, request_id = identifier)
                response = {"error": {"code": -32603, "message": "TICKET251_CONTROLLED_MCP_FAILURE"}}
            elif method == "initialize":
                response = {"result": {"protocolVersion": request.get("params", {}).get("protocolVersion", "2025-03-26"),
                                       "capabilities": {"tools": {}},
                                       "serverInfo": {"name": "ticket251-stdio-echo", "version": "1"}}}
            elif method == "tools/list":
                response = {"result": {"tools": [ECHO_TOOL]}}
            elif method == "tools/call" and request.get("params", {}).get("name") == "echo":
                text = request["params"].get("arguments", {}).get("text", "")
                record("echo", request_id = identifier, text = text)
                response = {"result": {"content": [{"type": "text", "text": json.dumps({"echo": text, "pid": pid})}],
                                       "isError": False}}
            elif method == "ping":
                response = {"result": {}}
            else:
                response = {"error": {"code": -32601, "message": "Method not found"}}
            print(json.dumps({"jsonrpc": "2.0", "id": identifier, **response}), flush = True)
    finally:
        record("exit")


def main() -> None:
    parser = argparse.ArgumentParser(description = __doc__)
    parser.add_argument("--events", type = Path, required = True)
    parser.add_argument("--control", type = Path, required = True)
    args = parser.parse_args()
    serve(args.events, args.control)


if __name__ == "__main__":
    main()
