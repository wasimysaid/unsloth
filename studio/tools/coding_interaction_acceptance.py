#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Real production-native interaction checks against an explicitly supplied UI dist.

Example from the Studio repository root:
  .venv/bin/python studio/tools/coding_interaction_acceptance.py \
    --mimir /path/to/mimir --plugin-package /path/to/package \
    --frontend-dist .verification/interaction-refresh/dist \
    --evidence-dir ../evidence/interaction-browser

Only external model replies are deterministic. Response gates withhold actual
backend HTTP responses, without changing their bodies. They prove browser-state
behavior, not native head-of-line or long-session performance. Every run owns its
profiles, project, browser, provider and backend. No live app, GPU or paid model.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import shlex
import socket
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.request
from urllib.parse import urlparse

from coding_provider_fixture import ProviderFixture
from coding_refresh_acceptance import large_png, native_capture, sha256
from coding_recovery_scenarios import wait_native_terminal


FILE_PATH = "notes/é report.txt"
FILE_BODY = "INTERACTION_NATIVE_FILE_REFERENCE_BODY\n"
DIRECTORY_CHILD = "native-directory-member.txt"
THINKING = "I will inspect the selected project file and compare its contents."
OPAQUE = "INTERACTION_OPAQUE_REASONING_MUST_NOT_RENDER"
FINAL = "INTERACTION_NATIVE_REASONING_COMPLETED"

STREAM_DISCONNECT = """(() => {
  const original = window.fetch.bind(window);
  window.interactionDropNextChunk = false;
  window.interactionDroppedStreams = 0;
  window.fetch = async (...args) => {
    const response = await original(...args);
    const url = String(args[0] instanceof Request ? args[0].url : args[0]);
    if (!url.includes('/api/coding/conversations/') || !url.endsWith('/events') || !response.ok || !response.body) return response;
    const reader = response.body.getReader();
    return new Response(new ReadableStream({async start(controller) {
      try {
        for (;;) {
          const {done, value} = await reader.read();
          if (window.interactionDropNextChunk) {
            window.interactionDropNextChunk = false;
            window.interactionDroppedStreams++;
            await reader.cancel();
            controller.error(new TypeError('Acceptance-only browser stream disconnect'));
            return;
          }
          if (done) { controller.close(); return; }
          controller.enqueue(value);
        }
      } catch (error) { controller.error(error); }
    }, cancel() { return reader.cancel(); }}), {status: response.status, headers: response.headers});
  };
})();"""


def thinking_frame(text: str, opaque: str) -> bytes:
    delta = {"reasoning_content": text,
             "reasoning_details": [{"type": "reasoning.encrypted", "data": opaque}]}
    return ("data: " + json.dumps({"choices": [{"delta": delta, "finish_reason": None}]}) + "\n\n").encode()


def file_token(path: str, kind: str) -> str:
    value = path.rstrip("/") + "/" if kind == "directory" else path
    assert '"' not in value and "\\" not in value and "\n" not in value
    return '@"' + value + '"' if any(char.isspace() for char in value) else "@" + value


def assert_file_mentions(body: dict, selected: list[dict]) -> None:
    mentions = body.get("file_mentions", [])
    assert len(mentions) == len(selected) == 2, "Both selected typed references must reach native admission"
    encoded = body["text"].encode()
    end = 0
    for mention, entry in zip(mentions, selected, strict=True):
        assert mention["path"] == entry["path"] and mention["kind"] == entry["kind"]
        assert mention["start"] >= end
        token = file_token(entry["path"], entry["kind"]).encode()
        assert encoded[mention["start"]:mention["end"]] == token
        end = mention["end"]
    assert mentions[0]["start"] == len("é 😀 ".encode())


def assert_rich_draft(actual: dict, expected: dict, create_count: int) -> None:
    assert actual == expected, f"Latest landing draft was not preserved: {actual!r} != {expected!r}"
    assert create_count == 1, f"Expected exactly one native creation, got {create_count}"


def wait_until(page, predicate, message: str, timeout: float = 60):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        page.wait_for_timeout(25)
    raise AssertionError(message)


class ResponseGate:
    """One real HTTP response retained until the bounded scenario releases it."""
    def __init__(self, page, url: str, evidence: list, ready=lambda: True, *, method: str | None = None):
        self.page, self.url, self.route, self.response = page, url, None, None
        self.ready, self.method = ready, method
        self.record = {"url": url, "kind": "actual backend response withheld in browser transport", "state": "armed"}
        evidence.append(self.record)

    def hold(self, route):
        if self.route is not None or (self.method is not None and route.request.method != self.method) or not self.ready():
            route.continue_()
            return
        self.response = route.fetch(timeout=60000)
        self.route = route
        self.record.update(state="held", backend_status=self.response.status)
        assert self.response.ok, self.response.text()

    def __enter__(self):
        self.page.route(self.url, self.hold)
        return self

    def wait(self):
        wait_until(self.page, lambda: self.route is not None, "Browser request never reached its real-response gate")
        assert self.record["state"] == "held"

    def release(self):
        if self.route is not None and self.record["state"] == "held":
            self.route.fulfill(response=self.response)
            self.record["state"] = "released"

    def __exit__(self, *_):
        try:
            self.release()
        finally:
            self.page.unroute(self.url, self.hold)


class InteractionRun:
    def __init__(self, args):
        self.args = args
        self.root = Path(__file__).resolve().parents[2]
        self.run = args.evidence_dir.resolve() / ("run-" + time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(3))
        self.run.mkdir(parents=True)
        self.native = self.run / "mimir-home"
        self.native.mkdir()
        self.projects = [self.run / "project-a", self.run / "project-b"]
        for project in self.projects:
            project.mkdir()
        self.report = {"status": "running", "stage": "setup", "run_id": self.run.name,
                       "command": [sys.executable, *sys.argv], "coverage": args.only,
                       "composition": "production auth/coding routers + supplied frontend dist + installed product Wasm + native runtime",
                       "limitations": ["Deterministic loopback provider, not external-model or GPU validation.",
                                       "Browser response holds do not measure or prove native dispatcher concurrency.",
                                       "Stop uses a cancellable real shell wait, not wait_for_updates with a native child agent."],
                       "scenarios": [], "requests": [], "conversation_ids": [], "gates": [],
                       "screenshots": [], "page_errors": [], "console_errors": [], "http_errors": [],
                       "browser_requests": [], "tool_processes": [], "cleanup": {}}
        self.provider = self.server = self.browser = self.page = self.context = self.log = None
        self.product = None
        self.headers = {}
        self.base = ""
        self.live_tool_processes = []

    def persist(self):
        (self.run / "report.json").write_text(json.dumps(self.report, indent=2) + "\n")
        (self.run.parent / "latest.json").write_text(json.dumps({"report": str(self.run / "report.json"), "status": self.report["status"]}, indent=2) + "\n")

    def stage(self, name):
        self.report["stage"] = name
        print("STAGE", name, flush=True)
        self.persist()

    def passed(self, name, detail):
        self.report["scenarios"].append({"id": name, "status": "passed", "detail": detail})
        print("PASS", name, flush=True)
        self.persist()

    def snapshot(self, name):
        path = self.run / (name + ".png")
        self.page.screenshot(path=str(path), full_page=True, animations="disabled")
        self.report["screenshots"].append(str(path))

    def api(self, method, path, **kwargs):
        response = getattr(self.context.request, method)(self.base + path, headers=self.headers, timeout=90000, **kwargs)
        assert response.ok, f"{method} {path}: {response.status} {response.text()}"
        return response.json()

    def setup(self):
        args = self.args
        mimir, package, dist = (path.resolve(strict=True) for path in (args.mimir, args.plugin_package, args.frontend_dist))
        assert (dist / "index.html").is_file() and (dist / "assets").is_dir()
        files = [mimir, package / "plugin.wasm", package / "mimir-plugin.toml", Path(__file__), dist / "index.html", *sorted((dist / "assets").glob("*"))]
        self.report["artifacts"] = {str(path): {"sha256": sha256(path), "bytes": path.stat().st_size} for path in files if path.is_file()}
        self.report["frontend_dist"] = str(dist)
        if args.compilation_cache:
            cache = args.compilation_cache.resolve(strict=True)
            assert cache.is_dir() and cache.stat().st_uid == os.geteuid()
            (self.native / "cache").mkdir()
            (self.native / "cache/wasmtime").symlink_to(cache, target_is_directory=True)
            self.report["compilation_cache"] = str(cache)
        (self.native / "trust.json").write_text(json.dumps({str(project): True for project in self.projects}) + "\n")
        file = self.projects[0] / FILE_PATH
        file.parent.mkdir()
        file.write_text(FILE_BODY)
        (file.parent / DIRECTORY_CHILD).write_text("Native directory reference member.\n")
        skill = self.projects[0] / ".agents/skills/interaction-check/SKILL.md"
        skill.parent.mkdir(parents=True)
        skill.write_text("---\nname: interaction-check\ndescription: Isolated interaction acceptance\n---\nOnly use the disposable project.\n")
        self.provider = ProviderFixture()
        self.provider.configure(self.native)
        self.password = secrets.token_urlsafe(24)
        env = dict(os.environ, HOME=str(self.run), UNSLOTH_STUDIO_HOME=str(self.run / "studio-home"),
                   MIMIR_CODING_AGENT_DIR=str(self.native), UNSLOTH_MIMIR_EXECUTABLE=str(mimir),
                   UNSLOTH_MIMIR_PLUGIN_PACKAGE=str(package), CODING_ACCEPTANCE_PASSWORD=self.password,
                   CODING_ACCEPTANCE_DIST=str(dist), CUDA_VISIBLE_DEVICES="", UNSLOTH_MIMIR_LOCAL_SERVING="0",
                   MIMIR_DISABLE_MODELS_FETCH="1", MIMIR_MODELS_PATH=str(self.native / "catalog.json"),
                   PYTHONPATH=str(self.root / "studio/backend"), RAYON_NUM_THREADS="4", TOKIO_WORKER_THREADS="4",
                   OMP_NUM_THREADS="4", OPENBLAS_NUM_THREADS="4", MKL_NUM_THREADS="4")
        for key in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "MIMIR_SKILLS_DIR"):
            env.pop(key, None)
        self.stage("install-product")
        with (self.run / "plugin-install.log").open("w") as output:
            subprocess.run([str(mimir), "plugin", "install", str(package)], cwd=self.projects[0], env=env,
                           stdout=output, stderr=subprocess.STDOUT, check=True, timeout=args.install_timeout)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        self.base = f"http://127.0.0.1:{port}"
        self.report["base_url"] = self.base
        self.log = (self.run / "server.log").open("w")
        self.server = subprocess.Popen([sys.executable, "-m", "uvicorn", "tests.coding_acceptance_app:create_app", "--factory", "--host", "127.0.0.1", "--port", str(port)],
                                       cwd=self.root / "studio/backend", env=env, stdout=self.log, stderr=subprocess.STDOUT)
        self.report["server_pid"] = self.server.pid
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            assert self.server.poll() is None, "Acceptance server exited"
            try:
                urllib.request.urlopen(self.base + "/api/auth/status", timeout=1).close()
                return
            except (urllib.error.URLError, TimeoutError):
                time.sleep(0.1)
        raise AssertionError("Acceptance server did not start")

    def attach_browser(self, playwright):
        from playwright.sync_api import expect
        self.expect = expect
        expect.set_options(timeout=60000)
        self.browser = playwright.chromium.launch(executable_path=self.args.chrome, headless=True, args=["--disable-gpu"])
        self.context = self.browser.new_context(viewport={"width": 1440, "height": 1000}, reduced_motion="reduce")
        self.context.add_init_script(STREAM_DISCONNECT)
        self.page = self.context.new_page()
        self.page.set_default_timeout(60000)
        self.page.on("pageerror", lambda error: self.report["page_errors"].append(str(error)))
        self.page.on("console", lambda message: self.report["console_errors"].append(message.text) if message.type == "error" else None)
        self.page.on("request", lambda request: self.report["browser_requests"].append({"method": request.method, "path": urlparse(request.url).path}))
        self.page.on("response", lambda response: self.report["http_errors"].append({"status": response.status, "path": urlparse(response.url).path}) if response.status >= 400 else None)
        self.report["browser"] = self.browser.version
        self.stage("authentication")
        assert self.context.request.get(self.base + "/api/coding/conversations").status in (401, 403)
        self.page.goto(self.base + "/coding")
        expect(self.page).to_have_url(self.base + "/login")
        login = self.context.request.post(self.base + "/api/auth/login", data={"username": "unsloth", "password": self.password})
        assert login.ok
        tokens = login.json()
        self.headers["Authorization"] = "Bearer " + tokens["access_token"]
        self.page.evaluate("t => { localStorage.setItem('unsloth_auth_token', t.access_token); localStorage.setItem('unsloth_auth_refresh_token', t.refresh_token); localStorage.setItem('unsloth_auth_session_mark', 'interaction-acceptance'); }", tokens)
        self.page.goto(self.base + "/coding")
        served = self.context.request.get(self.base + "/index.html")
        assert served.body() == (self.args.frontend_dist / "index.html").read_bytes(), "Server did not serve the explicitly supplied dist"
        self.passed("production-auth-staged-assets", "Real auth and the exact supplied frontend index")

    def create_project(self, project):
        page, expect = self.page, self.expect
        if page.get_by_test_id("coding-opened-conversation").count():
            page.get_by_test_id("coding-opened-conversation").click()
        else:
            page.get_by_role("button", name="Choose project", exact=True).click()
            page.get_by_role("menuitem", name="Choose project folder…", exact=True).click()
        expect(page.get_by_test_id("coding-browsed-path")).to_be_visible()
        page.get_by_label("Host folder path", exact=True).fill(str(project))
        page.get_by_role("button", name="Browse", exact=True).click()
        expect(page.get_by_test_id("coding-browsed-path")).to_have_text(str(project))
        with page.expect_response(lambda response: response.url == self.base + "/api/coding/conversations" and response.request.method == "POST") as created:
            page.get_by_role("button", name="Open project", exact=True).click()
        assert created.value.status == 201, created.value.text()
        identifier = created.value.json()["id"]
        self.report["conversation_ids"].append(identifier)
        self.headers["X-Mimir-Runtime-Generation"] = str(self.api("get", "/api/coding/runtime")["generation"])
        expect(page.get_by_test_id("coding-canonical-cwd")).to_have_text(str(project))
        expect(page.get_by_label("Coding prompt", exact=True)).to_be_editable()
        expect(page.get_by_role("radio", name="Build", exact=True)).to_be_enabled()
        if not self.product:
            import psutil
            children = [child for child in psutil.Process(self.server.pid).children() if child.cmdline()[1:] == ["plugin", "run", "studio.frontend"]]
            assert len(children) == 1
            self.product = children[0]
            self.report["native_process"] = {"pid": self.product.pid, "create_time": self.product.create_time(), "executable": self.product.exe()}
        return identifier

    def saved(self, identifier):
        return self.page.locator(f'[aria-label="Saved coding conversations"] button[data-conversation-id="{identifier}"]')

    def open_saved(self, identifier, project):
        page = self.page
        with page.expect_response(lambda response: response.url == self.base + f"/api/coding/conversations/{identifier}/open" and response.request.method == "POST") as opened:
            self.saved(identifier).click()
        assert opened.value.ok, opened.value.text()
        self.expect(page.get_by_test_id("coding-canonical-cwd")).to_have_text(str(project))
        self.expect(page.get_by_label("Coding prompt", exact=True)).to_be_editable()
        self.expect(page.get_by_role("radio", name="Build", exact=True)).to_be_enabled()

    def landing(self):
        self.stage("new-conversation-blank")
        page = self.page
        before = len([item for item in self.report["browser_requests"] if item == {"method": "POST", "path": "/api/coding/conversations"}])
        page.get_by_role("button", name="New coding conversation", exact=True).click()
        self.snapshot("new-conversation")
        assert page.get_by_role("dialog").count() == 0, "New coding conversation forced the folder picker"
        self.expect(page.get_by_test_id("coding-opened-conversation")).to_have_count(0)
        self.expect(page.get_by_label("Coding prompt", exact=True)).to_be_editable()
        self.expect(page.get_by_role("button", name="Choose project", exact=True)).to_be_visible()
        after = len([item for item in self.report["browser_requests"] if item == {"method": "POST", "path": "/api/coding/conversations"}])
        assert before == after, "New navigation unexpectedly created a native conversation"
        self.provider.assert_no_request()
        self.passed("new-conversation-blank", {"no_dialog": True, "native_create_count_unchanged": True})

        self.stage("landing-rich-draft-during-create")
        prompt = page.get_by_label("Coding prompt", exact=True)
        prompt.fill("Earlier draft before choosing a project")
        png = large_png()
        filename = "landing-draft.png"
        latest = "Latest é 😀 draft edited while native creation is pending"
        expected = {"text": latest, "images": [{"filename": filename, "sha256": hashlib.sha256(png).hexdigest()}]}
        url = self.base + "/api/coding/conversations"
        with ResponseGate(page, url, self.report["gates"], method="POST") as gate:
            page.get_by_role("button", name="Choose project", exact=True).click()
            page.locator(f'[role="menuitem"][title="{self.projects[0]}"]').click()
            gate.wait()
            assert gate.response.status == 201, gate.response.text()
            identifier = gate.response.json()["id"]
            self.report["conversation_ids"].append(identifier)
            self.expect(page.get_by_test_id("coding-opened-conversation")).to_have_count(0)
            self.expect(prompt).to_be_editable()
            prompt.fill(latest)
            page.get_by_label("Coding image files", exact=True).set_input_files({"name": filename, "mimeType": "image/png", "buffer": png})
            self.expect(page.get_by_role("button", name="Inspect " + filename, exact=True)).to_be_visible()
            self.expect(prompt).to_have_value(latest)
            self.snapshot("landing-rich-draft-create-pending")
            assert gate.record["state"] == "held"
            gate.release()
        self.expect(page.get_by_test_id("coding-canonical-cwd")).to_have_text(str(self.projects[0]))
        self.expect(prompt).to_be_editable()
        self.expect(prompt).to_have_value(latest)
        self.expect(page.get_by_role("button", name="Inspect " + filename, exact=True)).to_be_visible()
        images = page.get_by_role("list", name="Attached coding images", exact=True).evaluate("""async list => {
          return Promise.all(Array.from(list.querySelectorAll('button[aria-label^="Inspect "]')).map(async button => {
            const image = button.querySelector('img');
            const response = await fetch(image.currentSrc || image.src);
            if (!response.ok) throw new Error('Preserved image is unreadable');
            const bytes = await response.arrayBuffer();
            const digest = await crypto.subtle.digest('SHA-256', bytes);
            return {filename: button.getAttribute('aria-label').slice('Inspect '.length),
              sha256: Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('')};
          }));
        }""")
        creates = len([item for item in self.report["browser_requests"] if item == {"method": "POST", "path": "/api/coding/conversations"}]) - before
        actual = {"text": prompt.input_value(), "images": images}
        assert_rich_draft(actual, expected, creates)
        self.provider.assert_no_request()
        self.snapshot("landing-rich-draft-created")
        self.passed("landing-rich-draft-preserved", {"conversation_id": identifier, "draft": actual, "native_create_count": creates, "provider_requests": 0, "edited_before_create_response_released": True})
        page.get_by_role("button", name="Remove " + filename, exact=True).click()
        prompt.fill("")

    def submit(self, identifier, text):
        prompt = self.page.get_by_label("Coding prompt", exact=True)
        prompt.fill(text)
        return self.send(identifier)

    def send(self, identifier):
        with self.page.expect_response(lambda response: response.url == self.base + f"/api/coding/conversations/{identifier}/prompts" and response.request.method == "POST") as admitted:
            self.page.get_by_role("button", name="Send", exact=True).click()
        assert admitted.value.status == 202, admitted.value.text()
        ack = admitted.value.json()
        body = admitted.value.request.post_data_json
        self.report["requests"].append({**ack, "text": body["text"], "file_mentions": body.get("file_mentions", [])})
        self.persist()
        return ack, body, self.provider.request()

    def files_and_thinking(self, identifier):
        page, expect = self.page, self.expect
        self.stage("native-file-mentions-and-readable-thinking")
        prefix = f"/api/coding/conversations/{identifier}"
        catalog = self.api("get", prefix + "/files?query=notes&max_results=40")
        assert len(catalog["files"]) <= 40 and isinstance(catalog["truncated"], bool)
        file = next(item for item in catalog["files"] if item["path"] == FILE_PATH and item["kind"] == "file")
        directory = next(item for item in catalog["files"] if item["path"].rstrip("/") == "notes" and item["kind"] == "directory")
        assert file["mention"] == file_token(FILE_PATH, "file")
        assert directory["mention"] == "@notes/"
        self.report["file_catalog"] = catalog
        prompt = page.get_by_label("Coding prompt", exact=True)
        prompt.fill("é 😀 @")
        menu = page.get_by_test_id("coding-mention-list")
        for group in ("Skills", "Subagents", "Files"):
            expect(menu.get_by_role("group", name=group, exact=True)).to_be_visible()
        prompt.fill("é 😀 @notes")
        option = menu.locator('[data-mention-kind="file"]').filter(has_text=FILE_PATH)
        expect(option).to_be_visible()
        assert option.get_attribute("aria-disabled") != "true", "Quoted file paths are incorrectly disabled"
        option.click()
        expected = "é 😀 " + file_token(file["path"], file["kind"]) + " "
        expect(prompt).to_have_value(expected)
        prompt.press("End")
        prompt.type("@notes")
        option = menu.locator('[data-mention-kind="file"][data-mention-name="' + directory["path"] + '"]')
        expect(option).to_be_visible()
        option.click()
        expected += file_token(directory["path"], directory["kind"]) + " Inspect the selected file and directory."
        prompt.press("End")
        prompt.type("Inspect the selected file and directory.")
        expect(prompt).to_have_value(expected)
        self.snapshot("selected-file-references")
        ack, body, request = self.send(identifier)
        assert_file_mentions(body, [file, directory])
        native_context = json.dumps(request.body, ensure_ascii=False)
        assert FILE_BODY.strip() in native_context, "Typed native file reference did not load actual file contents"
        assert DIRECTORY_CHILD in native_context, "Typed directory reference did not reach native provider context"
        stream = request.begin_stream()
        stream.chunks.put(thinking_frame(THINKING, OPAQUE), timeout=10)
        reasoning = page.get_by_test_id("coding-reasoning")
        expect(reasoning).to_be_visible()
        line = reasoning.locator("button[aria-expanded][aria-controls]")
        if line.get_attribute("aria-expanded") != "true":
            line.click()
        expect(reasoning).to_contain_text(THINKING)
        assert OPAQUE not in page.get_by_test_id("coding-transcript").inner_text()
        expect(page.get_by_test_id("coding-run-status")).to_have_text("Running")
        self.snapshot("live-readable-thinking")
        stream.text(FINAL)
        stream.finish()
        wait_native_terminal(self.base, self.headers, identifier, ack["request_id"])
        expect(page.get_by_test_id("coding-run-status")).to_have_text("Completed")
        capture = native_capture(self.base, self.headers, identifier)
        history = self.api("post", prefix + "/entries", data={"cut": capture["root"]["cut"], "anchor": "latest"})
        assert any(row["kind"] == "reasoning" and THINKING in row.get("text", "") for row in history["rows"])
        assert OPAQUE not in json.dumps(history)
        (self.run / "reasoning-history.json").write_text(json.dumps(history, indent=2) + "\n")
        self.open_saved(identifier, self.projects[0])
        expect(reasoning).to_be_visible()
        if reasoning.locator("button[aria-expanded][aria-controls]").get_attribute("aria-expanded") != "true":
            reasoning.locator("button[aria-expanded][aria-controls]").click()
        expect(reasoning).to_contain_text(THINKING)
        expect(page.get_by_test_id("coding-transcript")).to_contain_text(expected)
        self.snapshot("saved-readable-thinking")
        self.passed("native-files-readable-thinking", {"request_id": ack["request_id"], "file_mentions": body["file_mentions"], "live_and_saved_readable_thinking": True, "opaque_payload_absent": True})

    def start_wait(self, identifier, marker, *, disconnect=False):
        import psutil
        ack, _, request = self.submit(identifier, "Run the isolated cancellable shell wait " + marker)
        if disconnect:
            self.page.evaluate("window.interactionDropNextChunk = true")
        command = f"echo $$ > {shlex.quote(marker + '.pid')}; sleep 150; printf INTERACTION_WAIT_EXPIRED"
        request.tool(marker, "shell", {"command": command, "timeout_seconds": 180, "yield_time_ms": 30000})
        pid_file = self.projects[0] / (marker + ".pid")
        wait_until(self.page, pid_file.exists, "Native shell never wrote its own process identity")
        process = psutil.Process(int(pid_file.read_text().strip()))
        assert process.uids().real == os.getuid() and Path(process.cwd()) == self.projects[0]
        assert command in " ".join(process.cmdline())
        wait_until(self.page, lambda: bool(process.children()), "Native shell wait child never started")
        processes = [process, *process.children(recursive=True)]
        for child in processes:
            record = {"pid": child.pid, "create_time": child.create_time(), "cmdline": child.cmdline()}
            self.live_tool_processes.append((child, record))
            self.report["tool_processes"].append(record)
        self.persist()
        return ack, processes

    @staticmethod
    def process_alive(process):
        import psutil
        return process.is_running() and process.status() != psutil.STATUS_ZOMBIE

    def stop(self, identifier, ack, processes):
        stop = self.page.get_by_role("button", name="Stop", exact=True)
        self.expect(stop).to_be_enabled()
        url = self.base + f"/api/coding/conversations/{identifier}/requests/{ack['request_id']}/cancel"
        with self.page.expect_response(lambda response: response.url == url and response.request.method == "POST") as cancelled:
            stop.click()
        assert cancelled.value.ok, cancelled.value.text()
        wait_native_terminal(self.base, self.headers, identifier, ack["request_id"], expected_status="cancelled")
        wait_until(self.page, lambda: not any(self.process_alive(process) for process in processes), "Native cancellation left its shell process group alive", timeout=30)
        self.report.setdefault("terminal_requests", []).append({"id": ack["request_id"], "status": "cancelled", "processes_settled": [process.pid for process in processes]})
        settled_continuations = 0
        while not self.provider.requests.empty():
            self.provider.request().text("CANCELLED_NATIVE_WAIT_NOT_REPLAYED")
            settled_continuations += 1
        self.report["terminal_requests"][-1]["settled_provider_continuations"] = settled_continuations

    def stop_during_navigation(self, first, second):
        page, expect = self.page, self.expect
        self.stage("stop-during-deferred-open")
        ack, processes = self.start_wait(first, "interaction-pending-open")
        url = self.base + f"/api/coding/conversations/{second}/open"
        with ResponseGate(page, url, self.report["gates"]) as gate:
            self.saved(second).click()
            gate.wait()
            expect(page.get_by_test_id("coding-canonical-cwd")).to_have_text(str(self.projects[0]))
            expect(page.get_by_role("button", name="Stop", exact=True)).to_be_enabled()
            self.snapshot("pending-open-live-stop")
            self.stop(first, ack, processes)
            assert gate.record["state"] == "held", "Navigation response was released before Stop settled"
            gate.release()
        expect(page.get_by_test_id("coding-canonical-cwd")).to_have_text(str(self.projects[1]))
        self.open_saved(first, self.projects[0])
        self.passed("pending-open-live-stop", {"request_id": ack["request_id"], "old_session_remained_visible": True, "cancelled_before_open_response_released": True})

    def stop_during_recovery(self, first):
        page, expect = self.page, self.expect
        self.stage("stop-during-history-recovery")
        url = self.base + f"/api/coding/conversations/{first}/entries"
        with ResponseGate(page, url, self.report["gates"], ready=lambda: page.evaluate("window.interactionDroppedStreams === 1")) as gate:
            ack, processes = self.start_wait(first, "interaction-recovery", disconnect=True)
            gate.wait()
            page.wait_for_function("window.interactionDroppedStreams === 1")
            expect(page.get_by_test_id("coding-transcript")).to_have_attribute("aria-busy", "true")
            expect(page.get_by_role("button", name="Stop", exact=True)).to_be_enabled()
            self.snapshot("history-pending-live-stop")
            self.stop(first, ack, processes)
            assert gate.record["state"] == "held"
            gate.release()
        expect(page.get_by_test_id("coding-transcript")).to_have_attribute("aria-busy", "false")
        self.passed("recovering-history-live-stop", {"request_id": ack["request_id"], "browser_streams_disconnected": 1, "cancelled_before_history_response_released": True, "fault_scope": "browser transport only; all native rows and HTTP bodies remain real"})

    def controls(self):
        page, expect = self.page, self.expect
        self.stage("compact-picker-and-context")
        provider_count = len(self.provider.pending)
        page.get_by_test_id("coding-model-trigger").click()
        picker = page.get_by_test_id("coding-model-picker")
        expect(picker).to_be_visible()
        assert "Catalog details" not in picker.inner_text()
        assert "API model" not in picker.inner_text()
        page.get_by_role("button", name="Choose coding model", exact=True).click()
        expect(picker.locator('button[data-model="offline"]')).to_be_visible()
        self.snapshot("compact-model-picker")
        page.keyboard.press("Escape")
        page.keyboard.press("Escape")
        usage = page.get_by_test_id("coding-context-usage")
        expect(usage).to_be_visible()
        before = len([item for item in self.report["browser_requests"] if "/diagnostics/" in item["path"]])
        usage.hover()
        tooltip = page.get_by_role("tooltip")
        expect(tooltip).to_be_visible()
        tooltip_text = tooltip.inner_text()
        assert "token" in tooltip_text.lower() and len(tooltip_text) < 200
        assert "{" not in tooltip_text and "diagnostic" not in tooltip_text.lower()
        self.snapshot("minimal-context-tooltip")
        usage.click()
        assert page.get_by_role("dialog").count() == 0
        assert page.get_by_test_id("coding-diagnostic-result").count() == 0
        after = len([item for item in self.report["browser_requests"] if "/diagnostics/" in item["path"]])
        assert before == after and provider_count == len(self.provider.pending)
        self.passed("compact-picker-context", {"tooltip": tooltip_text, "diagnostic_requests_before": before, "diagnostic_requests_after": after, "provider_requests_unchanged": True})

    def screenshots(self):
        self.stage("desktop-narrow-light-dark")
        page, expect = self.page, self.expect
        geometry = []
        for label, size in (("desktop", {"width": 1440, "height": 1000}), ("narrow", {"width": 390, "height": 844})):
            page.set_viewport_size(size)
            for theme in ("light", "dark"):
                page.evaluate("theme => { document.documentElement.classList.toggle('dark', theme === 'dark'); document.documentElement.style.colorScheme = theme; }", theme)
                self.snapshot(label + "-" + theme)
                box = page.get_by_label("Coding composer", exact=True).bounding_box()
                assert box and box["x"] >= 0 and box["x"] + box["width"] <= size["width"] + 1
                assert box["y"] + box["height"] <= size["height"] + 1
                assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
                prompt = page.get_by_label("Coding prompt", exact=True)
                prompt.fill("@")
                menu = page.get_by_test_id("coding-mention-list")
                files = menu.get_by_role("group", name="Files", exact=True)
                expect(files).to_be_visible()
                expect(files.locator('[data-mention-kind="file"][data-mention-name="' + FILE_PATH + '"]')).to_be_visible()
                expect(files).not_to_contain_text("Searching files")
                self.snapshot(label + "-" + theme + "-files")
                bounds = menu.bounding_box()
                assert bounds and bounds["x"] >= 0 and bounds["y"] >= 0
                assert bounds["x"] + bounds["width"] <= size["width"] + 1
                prompt.press("Escape")
                prompt.fill("")
                geometry.append({"size": size, "theme": theme, "composer": box, "menu": bounds})
        self.passed("viewport-geometry", geometry)

    def exercise(self):
        second = self.create_project(self.projects[1])
        first = self.create_project(self.projects[0])
        self.passed("two-production-projects", {"first": first, "second": second})
        only = self.args.only
        if only in ("all", "landing"):
            self.landing()
            if only == "landing":
                return
            self.open_saved(first, self.projects[0])
        if only in ("all", "stop"):
            self.stop_during_navigation(first, second)
            self.stop_during_recovery(first)
        if only in ("all", "inputs"):
            self.files_and_thinking(first)
        if only in ("all", "controls"):
            self.controls()
        if only == "all":
            self.screenshots()
        assert not self.report["page_errors"], self.report["page_errors"]
        allowed = {"/api/health", "/api/engines", "/api/hub/active-downloads", "/api/hub/datasets/active-downloads", "/api/llama/update-status", "/api/studio/update-status"}
        assert all(item["status"] == 404 and item["path"] in allowed for item in self.report["http_errors"]), self.report["http_errors"]
        unexpected_console = [message for message in self.report["console_errors"] if message != "Failed to load resource: the server responded with a status of 404 (Not Found)"]
        assert not unexpected_console, unexpected_console
        self.passed("browser-errors-audited", {"page_errors": [], "http_errors": self.report["http_errors"], "console_errors": self.report["console_errors"]})

    def shutdown_browser(self):
        if self.context is not None and self.headers:
            try:
                result = self.api("post", "/api/coding-acceptance/shutdown")
                self.report["cleanup"]["native"] = result
                assert result["state"] == "stopped" and result["cleanup"]["confirmed"]
                assert result["cleanup"]["exit_code"] == 0 and not result["cleanup"]["forced"]
            except Exception as error:
                self.report["cleanup"]["native_error"] = str(error)
                self.report["status"] = "failed"
        if self.browser is not None:
            self.browser.close()
            self.report["cleanup"]["browser_closed"] = True

    def shutdown(self):
        if self.server is not None:
            if self.server.poll() is None:
                self.server.terminate()
            try:
                self.report["cleanup"]["server_exit"] = self.server.wait(timeout=90)
            except subprocess.TimeoutExpired:
                self.server.kill()
                self.report["cleanup"]["server_forced_exit"] = self.server.wait(timeout=30)
                self.report["status"] = "failed"
        if self.product is not None:
            self.report["cleanup"]["native_alive"] = self.process_alive(self.product)
            if self.report["cleanup"]["native_alive"]:
                if self.product.create_time() == self.report["native_process"]["create_time"] and self.product.cmdline()[1:] == ["plugin", "run", "studio.frontend"]:
                    self.product.terminate()
                    self.product.wait(timeout=30)
                self.report["status"] = "failed"
        for process, record in self.live_tool_processes:
            alive = self.process_alive(process)
            record["alive_after_native_shutdown"] = alive
            if alive:
                if process.create_time() == record["create_time"] and process.cmdline() == record["cmdline"] and process.uids().real == os.getuid():
                    process.terminate()
                    process.wait(timeout=30)
                self.report["status"] = "failed"
        if self.log is not None:
            self.log.close()
        if self.provider is not None:
            self.report["provider_requests"] = len(self.provider.pending)
            try:
                self.provider.close()
            except Exception as error:
                self.report["cleanup"]["provider_error"] = str(error)
                self.report["status"] = "failed"
            self.report["cleanup"]["provider_thread_alive"] = self.provider.thread.is_alive()
        self.persist()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mimir", type=Path, required=True)
    parser.add_argument("--plugin-package", type=Path, required=True)
    parser.add_argument("--frontend-dist", type=Path, required=True)
    parser.add_argument("--evidence-dir", type=Path, required=True)
    parser.add_argument("--compilation-cache", type=Path)
    parser.add_argument("--install-timeout", type=int, default=300)
    parser.add_argument("--chrome", default="/usr/bin/google-chrome")
    parser.add_argument("--only", choices=("all", "landing", "stop", "inputs", "controls"), default="all")
    args = parser.parse_args()
    run = InteractionRun(args)
    try:
        run.setup()
        from playwright.sync_api import sync_playwright
        with sync_playwright() as playwright:
            try:
                run.attach_browser(playwright)
                run.exercise()
                run.report["status"] = "passed"
            except BaseException:
                if run.page is not None:
                    try:
                        run.snapshot("failure")
                        (run.run / "failure-body.txt").write_text(run.page.locator("body").inner_text())
                    except Exception as error:
                        run.report["failure_capture_error"] = str(error)
                raise
            finally:
                run.shutdown_browser()
    except BaseException as error:
        run.report.update(status="failed", error=str(error), traceback=traceback.format_exc())
        print(run.report["traceback"], file=sys.stderr, flush=True)
    finally:
        run.shutdown()
        print("REPORT", run.run / "report.json", flush=True)
    return 0 if run.report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
