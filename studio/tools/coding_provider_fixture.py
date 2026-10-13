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


PICKER_PROVIDER_A = "coding-picker-a"
PICKER_PROVIDER_B = "coding-picker-b"
PICKER_MODEL = "shared"
PICKER_PLAIN_MODEL = "plain"
PICKER_API_A = "acceptance-wire-a"
PICKER_API_B = "acceptance-wire-b"
PICKER_API_PLAIN = "acceptance-wire-plain"
PICKER_PROVIDER_LABEL = "Shared acceptance provider"
PICKER_MODEL_LABEL = "Shared coding model"
PICKER_LEVELS_A = ("low", "medium", "high")
PICKER_LEVELS_B = ("minimal", "high")


def picker_providers(base_url: str) -> dict:
    """Only native models.json input, never a Studio-owned inventory.

    Deliberately collide labels and provider-local IDs while preserving distinct
    wire IDs. Extra native entries make the rendered list require scrolling.
    The isolated global high default is offered by both reasoning models.
    """
    def model(name, api_model, levels=()):
        return {"name": name, "apiModel": api_model,
                "limit": {"context": 128000}, "input": ["text"],
                "reasoning": bool(levels),
                **({"thinkingLevelMap": {level: level for level in levels}} if levels else {})}

    first = {PICKER_MODEL: model(PICKER_MODEL_LABEL, PICKER_API_A, PICKER_LEVELS_A)}
    first.update({f"scroll-{index:02d}": model(f"Scrollable native model {index:02d}", f"acceptance-scroll-{index:02d}")
                  for index in range(32)})
    second = {PICKER_MODEL: model(PICKER_MODEL_LABEL, PICKER_API_B, PICKER_LEVELS_B),
              PICKER_PLAIN_MODEL: model("No reasoning control", PICKER_API_PLAIN)}
    return {identifier: {"name": PICKER_PROVIDER_LABEL, "baseUrl": base_url,
                         "api": "openai-chat-completions", "auth": "none",
                         "defaultModel": PICKER_MODEL, "models": models}
            for identifier, models in ((PICKER_PROVIDER_A, first), (PICKER_PROVIDER_B, second))}


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

    def configure(self, native: Path, *, picker: bool = False, images: bool = False) -> None:
        (native / "settings.json").write_text(json.dumps({
            "defaultProvider": PICKER_PROVIDER_A if picker else "coding-acceptance",
            "defaultModel": PICKER_MODEL if picker else "offline",
            "model": {"thinkingEffort": "high"}}) + "\n")
        providers = picker_providers(self.base_url) if picker else {"coding-acceptance": {
            "name": "Deterministic acceptance HTTP provider", "baseUrl": self.base_url,
            "api": "openai-chat-completions", "auth": "none", "models": {"offline": {
                "name": "Deterministic protocol (not a live model)", "limit": {"context": 128000},
                "input": ["text", "image"] if images else ["text"], "reasoning": True, "thinkingLevelMap": {"high": "high"}}}}}
        (native / "models.json").write_text(json.dumps({"providers": providers}) + "\n")
