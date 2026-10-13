# SPDX-License-Identifier: AGPL-3.0-only
"""Deterministic external HTTP provider; native Mimir executes every tool.

Never replaces Studio execution APIs or writes the expected project artifacts.
Provider bodies/headers are intentionally not persisted: they may contain native
model-only context. The browser driver controls replies and asserts tool results.
"""
from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import queue
import threading


def text_completion(text: str) -> bytes:
    return ("data: " + json.dumps({"choices": [{"delta": {"content": text}, "finish_reason": None}]}) +
            '\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n').encode()


def tool_completion(identifier: str, name: str, arguments: dict) -> bytes:
    return ("data: " + json.dumps({"choices": [{"delta": {"tool_calls": [{
        "index": 0, "id": identifier, "type": "function", "function": {
            "name": name, "arguments": json.dumps(arguments)}}]}, "finish_reason": "tool_calls"}]}) +
            "\n\ndata: [DONE]\n\n").encode()


class ProviderRequest:
    def __init__(self, body: dict):
        self.body = body
        self.response = queue.Queue(maxsize=1)

    def text(self, text: str) -> None:
        self.response.put((200, "text/event-stream", text_completion(text)))

    def tool(self, identifier: str, name: str, arguments: dict) -> None:
        assert any(tool.get("function", {}).get("name") == name for tool in self.body.get("tools", [])), f"Native provider did not advertise {name}"
        self.response.put((200, "text/event-stream", tool_completion(identifier, name, arguments)))

    def ask_user(self, identifier: str, questions: list[dict]) -> None:
        # Only provider tool-call identity/arguments are supplied by the fixture.
        # Native Mimir creates the actual pending user-request identity and waits.
        # Native's tool schema admits omitted options for open-ended questions,
        # but an explicitly supplied options array must contain 2–4 choices.
        arguments = [{key: value for key, value in question.items()
                      if key != "options" or value} for question in questions]
        self.tool(identifier, "ask_user", {"questions": arguments})

    def fail(self) -> None:
        # No secret/configuration content in the public fixture failure.
        self.response.put((400, "text/plain", b"ACCEPTANCE_PROVIDER_FAILURE"))

    def tool_result(self, identifier: str) -> str:
        matches = [message for message in self.body.get("messages", [])
                   if message.get("role") == "tool" and message.get("tool_call_id") == identifier]
        assert matches, f"Native tool result absent for {identifier}"
        content = matches[-1]["content"]
        assert isinstance(content, str)
        return content


class ProviderFixture:
    def __init__(self):
        self.requests = queue.Queue()
        self.pending = []
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass  # Never log raw provider requests, headers or model-only context.

            def do_POST(self):
                if not self.path.endswith("/chat/completions"):
                    self.send_error(404)
                    return
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 4 * 1024 * 1024:
                    self.send_error(413)
                    return
                request = ProviderRequest(json.loads(self.rfile.read(size)))
                fixture.pending.append(request)
                fixture.requests.put(request)
                try:
                    status, content_type, body = request.response.get(timeout=120)
                except queue.Empty:
                    status, content_type, body = 504, "text/plain", b"Provider fixture response deadline"
                try:
                    self.send_response(status)
                    self.send_header("Content-Type", content_type)
                    self.send_header("Content-Length", str(len(body)))
                    self.send_header("Connection", "close")
                    self.end_headers()
                    self.wfile.write(body)
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    pass  # Exact native cancellation closes the external request.

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_port}/v1"

    def request(self, timeout: float = 60) -> ProviderRequest:
        try:
            return self.requests.get(timeout=timeout)
        except queue.Empty:
            raise AssertionError("Native Mimir did not reach external provider before deadline") from None

    def assert_no_request(self) -> None:
        assert self.requests.empty(), "Unexpected external provider call"

    def close(self) -> None:
        for request in self.pending:
            try:
                request.response.put_nowait((503, "text/plain", b"Fixture shutting down"))
            except queue.Full:
                pass
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def configure(self, native: Path) -> None:
        (native / "settings.json").write_text(json.dumps({
            "defaultProvider": "coding-acceptance", "defaultModel": "offline",
            "model": {"thinkingEffort": "high"}}) + "\n")
        (native / "models.json").write_text(json.dumps({"providers": {"coding-acceptance": {
            "name": "Deterministic acceptance HTTP provider", "baseUrl": self.base_url,
            "api": "openai-chat-completions", "auth": "none", "models": {"offline": {
                "name": "Deterministic protocol (not a live model)", "limit": {"context": 128000},
                "input": ["text"], "reasoning": True, "thinkingLevelMap": {"high": "high"}}}}}}) + "\n")
