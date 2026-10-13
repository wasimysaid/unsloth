# SPDX-License-Identifier: AGPL-3.0-only
"""Acceptance-only SSE fault shim; never used by the production application.

The native stream still supplies every state/history cut and executes every
request. One chosen next view duplicates its actual atomic start as a recovering
reset. Positions are remapped monotonically, not interpreted as replay cursors.
This is deterministic transport evidence, not a naturally occurring native reset.
"""
from __future__ import annotations

import json


class CodingTransportFaults:
    def __init__(self, app, faults: dict):
        self.app = app
        self.faults = faults

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "")
        conversation = self.faults.get("reset_conversation")
        reset = (
            scope["type"] == "http"
            and scope.get("method") == "GET"
            and conversation is not None
            and path == f"/api/coding/conversations/{conversation}/events"
        )
        # Consume only for the chosen view; never alter unrelated/auth responses.
        if reset:
            self.faults.pop("reset_conversation", None)
        injected = False

        async def fault_send(message):
            nonlocal injected
            if reset and message["type"] == "http.response.body":
                body = message.get("body", b"")
                prefix = b"event: view\ndata: "
                if body.startswith(prefix):
                    value = json.loads(body[len(prefix):].strip())
                    position = value.get("position")
                    if isinstance(position, int):
                        value["position"] = position * 2
                    body = prefix + json.dumps(value, separators=(",", ":")).encode() + b"\n\n"
                    if value.get("event", {}).get("type") == "start" and not injected:
                        assert isinstance(position, int)
                        captured = dict(value)
                        captured["position"] += 1
                        captured["event"] = dict(value["event"], type="reset", recovering=True)
                        body += prefix + json.dumps(captured, separators=(",", ":")).encode() + b"\n\n"
                        injected = True
                    message = dict(message, body=body)
            await send(message)

        await self.app(scope, receive, fault_send)
