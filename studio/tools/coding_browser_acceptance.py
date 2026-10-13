#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Actual rendered coding acceptance; real native tools, no GPU or mocked execution APIs.

Prerequisites: build frontend dist and pinned Mimir + studio.frontend package;
install backend/test dependencies and Python playwright in a task-owned venv.
Example (from repository root):
 .venv/bin/python studio/tools/coding_browser_acceptance.py \
   --mimir /path/to/mimir --plugin-package /path/to/studio-frontend/package \
   --evidence-dir /path/to/attempt/worker/browser

The child server mounts production auth/coding modules and built Studio UI only,
not ML/training startup. Default deterministic mode uses an external HTTP protocol
fixture and real native tools, not a live model. --workload live uses the existing
native provider/credential profile directly; history remains Mimir-owned there.
Disposable projects, Studio auth and evidence stay in evidence-dir. Use a distinct
evidence directory for each run. --workload opening runs the previous opening suite.
--workload questions covers keyboard answers, durable history, stale targets,
pre/post-delivery ACK loss, reconnect/reopen and Stop while native ask_user waits.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import select
import socket
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request

from coding_provider_fixture import ProviderFixture
from coding_run_scenarios import run_scenarios
from coding_recovery_scenarios import run_recovery_scenarios
from coding_question_scenarios import run_question_scenarios


def shared_trust_path() -> Path:
    """Locate the actual native saved policy before installing isolated fixtures."""
    # mimir-memory::paths::agent_dir defaults to ~/.mimir/agent, not ~/.mimir.
    return Path(os.environ.get("MIMIR_CODING_AGENT_DIR", Path.home() / ".mimir" / "agent")) / "trust.json"


def main() -> None:
    parser = argparse.ArgumentParser(description = __doc__)
    runtime_input = parser.add_mutually_exclusive_group(required = True)
    runtime_input.add_argument("--mimir", type = Path)
    runtime_input.add_argument("--mimir-source", type = Path, help = "Build the current paired source and product package before acceptance")
    parser.add_argument("--plugin-package", type = Path)
    parser.add_argument("--evidence-dir", type = Path, required = True)
    parser.add_argument("--workload", choices = ("opening", "deterministic", "recovery", "questions", "live"), default = "deterministic",
                        help = "Live uses the existing native provider/credential profile; never copies credentials")
    parser.add_argument("--browser", choices = ("chromium", "firefox"), default = "chromium")
    parser.add_argument("--chrome", default = "/usr/bin/google-chrome", help = "Chromium executable; ignored for Firefox")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    evidence = args.evidence_dir.resolve()
    if evidence.is_relative_to(root):
        parser.error("Evidence must be outside the Git worktree")
    evidence.mkdir(parents = True, exist_ok = True)
    if args.mimir_source:
        source = args.mimir_source.resolve()
        with (evidence / "paired-build.log").open("w") as build_log:
            subprocess.run(["cargo", "build", "--locked", "-p", "mimir-cli"], cwd = source,
                           stdout = build_log, stderr = subprocess.STDOUT, check = True, timeout = 1200)
            metadata = json.loads(subprocess.check_output(["cargo", "metadata", "--no-deps", "--format-version", "1"], cwd = source))
            args.mimir = Path(metadata["target_directory"]) / "debug" / ("mimir.exe" if os.name == "nt" else "mimir")
            args.plugin_package = evidence / "current-product-package"
            subprocess.run([sys.executable, "plugins/studio-frontend/build.py", "--output", str(args.plugin_package)],
                           cwd = source, stdout = build_log, stderr = subprocess.STDOUT, check = True, timeout = 1000)
    elif args.plugin_package is None:
        parser.error("--plugin-package is required with --mimir")
    state_root = evidence / ("state-" + secrets.token_hex(4))
    state_root.mkdir()
    home = state_root / "studio-home"
    live = args.workload == "live"
    native = shared_trust_path().parent if live else state_root / "mimir-home"
    native.mkdir(exist_ok = True)
    provider = ProviderFixture() if args.workload in ("deterministic", "recovery", "questions") else None
    if provider:
        provider.configure(native)
    projects = state_root / "projects"
    projects.mkdir(exist_ok = True)
    first, second, denied = [projects / name for name in ("first-project", "second-project", "os-denied")]
    for folder in (first, second, denied):
        folder.mkdir(exist_ok = True)
    (first / "src").mkdir(exist_ok = True)
    alias = projects / "first-alias"
    if not alias.exists():
        alias.symlink_to(first, target_is_directory = True)
    file_path = projects / "not-a-directory.txt"
    file_path.write_text("directory validation fixture\n")
    denied.chmod(0)
    trust_path = native / "trust.json"
    if not live:
        trust_path.write_text(json.dumps({str(projects.resolve()): False}) + "\n")
    shared_trust = shared_trust_path()
    def fingerprint(path):
        return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
    trust_before = fingerprint(trust_path)
    shared_before = fingerprint(shared_trust)
    password = secrets.token_urlsafe(24)
    env = dict(os.environ, UNSLOTH_STUDIO_HOME = str(home), MIMIR_CODING_AGENT_DIR = str(native),
               UNSLOTH_MIMIR_EXECUTABLE = str(args.mimir.resolve()),
               UNSLOTH_MIMIR_PLUGIN_PACKAGE = str(args.plugin_package.resolve()), CODING_ACCEPTANCE_PASSWORD = password,
               CUDA_VISIBLE_DEVICES = "", PYTHONPATH = str(root / "studio" / "backend"))
    if not live:
        # Fixture tools must not discover the user's native instructions or credentials.
        env.update(HOME = str(state_root), MIMIR_DISABLE_MODELS_FETCH = "1",
                   MIMIR_MODELS_PATH = str(native / "catalog.json"))
        for key in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"):
            env.pop(key, None)
    source_revisions = {"studio": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd = root, text = True).strip()}
    paired_source = args.mimir_source.resolve() if args.mimir_source else root.parent / "mimir"
    if (paired_source / ".git").exists():
        source_revisions["mimir"] = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd = paired_source, text = True).strip()
    report = {"kind": "browser", "command": [sys.executable, *sys.argv], "source_revisions": source_revisions,
              "native_sha256": fingerprint(args.mimir.resolve()),
              "plugin_sha256": fingerprint(args.plugin_package.resolve() / "plugin.wasm"),
              "frontend_index_sha256": fingerprint(root / "studio/frontend/dist/index.html"),
              "projects": {"first": str(first), "second": str(second)},
              "composition": "production coding/auth routers + built Studio UI + installed product plugin + native Mimir",
              "provider_workload": args.workload, "run_id": state_root.name,
              "viewports": [[1440, 1000], [390, 844]], "scenarios": [],
              "conversation_ids": [], "artifacts": [], "limitations": ["Unrelated Studio ML/training routers are not mounted by this CPU-only acceptance composition."]}
    if provider:
        report["limitations"].append("Deterministic HTTP protocol fixture is not live-model success; native plugin/runtime/tools are real.")
    def scenario(name, detail):
        report["scenarios"].append({"id": name, "status": "passed", "detail": detail})
    def snapshot(page, name):
        path = evidence / f"{name}.png"
        page.screenshot(path = str(path), full_page = True, animations = "disabled")
        report["artifacts"].append(str(path))
    # No shared configuration or trust records are modified by installation.
    with (evidence / "plugin-install.log").open("w") as output:
        subprocess.run([str(args.mimir.resolve()), "plugin", "install", str(args.plugin_package.resolve())],
                       env = env, stdout = output, stderr = subprocess.STDOUT, check = True, timeout = 240)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    output = (evidence / "server.log").open("w")
    server_args = [sys.executable, "-m", "uvicorn", "tests.coding_acceptance_app:create_app", "--factory",
                   "--host", "127.0.0.1", "--port", str(port)]
    server = subprocess.Popen(server_args, cwd = root / "studio" / "backend", env = env,
                              stdout = output, stderr = subprocess.STDOUT)

    def restart_server():
        nonlocal server
        import psutil
        children = [child for child in psutil.Process(server.pid).children()
                    if child.cmdline()[1:] == ["plugin", "run", "studio.frontend"]]
        assert len(children) == 1
        before = children[0].pid
        server.terminate()
        assert server.wait(timeout = 45) in (0, -15)
        assert not children[0].is_running(), "Clean acceptance restart did not await native cleanup"
        report.setdefault("runtime_generations", []).append({"pid": before, "native_settled": True})
        server = subprocess.Popen(server_args, cwd = root / "studio" / "backend", env = env,
                                  stdout = output, stderr = subprocess.STDOUT)
        for _ in range(100):
            assert server.poll() is None, "Restarted acceptance server exited"
            try:
                urllib.request.urlopen(base + "/api/auth/status", timeout = 1).close()
                return
            except (urllib.error.URLError, TimeoutError):
                time.sleep(0.1)
        raise AssertionError("Restarted acceptance server did not become ready")

    try:
        for _ in range(100):
            if server.poll() is not None:
                raise RuntimeError("Acceptance server exited; inspect server.log")
            try:
                urllib.request.urlopen(base + "/api/auth/status", timeout = 1)
                break
            except (urllib.error.URLError, TimeoutError):
                time.sleep(0.1)
        else:
            raise RuntimeError("Acceptance server did not become ready")
        from playwright.sync_api import sync_playwright, expect
        with sync_playwright() as playwright:
            if args.browser == "firefox":
                browser = playwright.firefox.launch(headless = True, firefox_user_prefs = {
                    "gfx.webrender.software": True, "layers.acceleration.disabled": True,
                })
            else:
                browser = playwright.chromium.launch(executable_path = args.chrome, headless = True,
                                                      args = ["--disable-gpu"])
            report["browser"] = {"engine": args.browser, "version": browser.version,
                                 "rendering": "hardware acceleration disabled"}
            context = browser.new_context(viewport = {"width": 1440, "height": 1000})
            context.add_init_script("localStorage.setItem('unsloth_show_loaded_models_indicator', 'true')")
            page = context.new_page()
            page.on("pageerror", lambda error: report.setdefault("page_errors", []).append(str(error)))
            ordinary_status_requests = []
            ordinary_status_paths = {"/api/inference/status", "/api/inference/images/status",
                                     "/api/inference/video/status", "/api/inference/audio/stt/status"}
            from urllib.parse import urlparse
            page.on("request", lambda request: ordinary_status_requests.append(urlparse(request.url).path)
                    if urlparse(request.url).path in ordinary_status_paths else None)
            page.goto(base + "/coding")
            expect(page).to_have_url(base + "/login")
            scenario("A6-auth-route", "Unauthenticated coding navigation redirects to Studio login")
            # Authenticate through the real Studio password endpoint, no auth dependency override.
            login = context.request.post(base + "/api/auth/login", data = {"username": "unsloth", "password": password})
            assert login.ok, f"Login failed ({login.status})"
            tokens = login.json()
            page.evaluate("tokens => { localStorage.setItem('unsloth_auth_token', tokens.access_token); localStorage.setItem('unsloth_auth_refresh_token', tokens.refresh_token); localStorage.setItem('unsloth_auth_session_mark', 'coding-acceptance'); }", tokens)
            ordinary_status_requests.clear()
            page.goto(base + "/coding")
            expect(page.get_by_role("heading", name = "Build with Mimir")).to_be_visible()
            expect(page.get_by_role("button", name = "Send", exact = True)).to_be_disabled()
            composer = page.get_by_role("group", name = "Coding composer") if page.get_by_role("group", name = "Coding composer").count() else page.locator('[aria-label="Coding composer"]')
            composer_box = composer.bounding_box()
            chooser_box = page.get_by_test_id("coding-project-chooser").bounding_box()
            assert composer_box and chooser_box and chooser_box["y"] >= composer_box["y"] + composer_box["height"]
            snapshot(page, "desktop-unopened")
            scenario("A10-layout", "1440x1000: chooser beneath composer, Send disabled before selection")

            def browse(path):
                expect(page.get_by_role("button", name = "Browse", exact = True)).to_be_enabled(timeout = 60000)
                page.get_by_label("Host folder path", exact = True).fill(str(path))
                expect(page.get_by_label("Host folder path", exact = True)).to_have_value(str(path))
                page.get_by_role("button", name = "Browse", exact = True).click()
            def open_project(path):
                page.get_by_role("button", name = "Choose another project" if page.get_by_test_id("coding-opened-conversation").count() else "Choose project folder", exact = True).click()
                # The chooser starts an initial OS browse. Await its rendered path
                # before filling so that initialization is not typing into the field.
                expect(page.get_by_test_id("coding-browsed-path")).to_be_visible(timeout = 60000)
                browse(path)
                expect(page.get_by_test_id("coding-browsed-path")).to_have_text(str(Path(path).resolve()))
                with page.expect_response(lambda response: response.url == base + "/api/coding/conversations" and response.request.method == "POST", timeout = 60000) as created:
                    page.get_by_role("button", name = "Open project", exact = True).click()
                assert created.value.status == 201
                identifier = created.value.json()["id"]
                expect(page.get_by_role("dialog")).not_to_be_visible(timeout = 60000)
                expect(page.get_by_role("heading", name = "Your coding conversation is open")).to_be_visible(timeout = 60000)
                expect(page.get_by_test_id("coding-conversation-id")).to_have_text(identifier, timeout = 60000)
                expect(page.get_by_test_id("coding-event-status")).to_contain_text("Native event stream connected", timeout = 60000)
                report["conversation_ids"].append(identifier)
                return identifier

            page.get_by_role("button", name = "Choose project folder", exact = True).click()
            for name, path, message in (("missing", projects / "missing", "does not exist"),
                                         ("file", file_path, "not a file"),
                                         ("denied", denied, "denies access")):
                browse(path)
                expect(page.get_by_role("alert").filter(has_text = message)).to_be_visible()
                expect(page.get_by_role("button", name = "Open project", exact = True)).to_be_disabled()
                snapshot(page, "desktop-" + name)
                scenario("A6-folder-" + name, "Real host OS failure shown with actionable error; opening disabled")
            page.get_by_role("button", name = "Cancel", exact = True).click()
            first_id = open_project(alias)
            import psutil
            product = [child for child in psutil.Process(server.pid).children()
                       if child.cmdline()[1:] == ["plugin", "run", "studio.frontend"]]
            assert len(product) == 1, "Studio must supervise exactly one native product process"
            report["supervised_pid"] = product[0].pid
            expect(page.get_by_test_id("coding-canonical-cwd")).to_have_text(str(first))
            snapshot(page, "desktop-opened")
            scenario("A6-canonical", "Symlink selected; native conversation reports canonical directory " + str(first))
            for name, message in (("native-missing", "does not exist"), ("native-denied", "denies access")):
                changing = projects / name
                changing.mkdir(exist_ok = True)
                page.get_by_role("button", name = "Choose another project", exact = True).click()
                browse(changing)
                expect(page.get_by_test_id("coding-browsed-path")).to_have_text(str(changing))
                if name == "native-missing":
                    changing.rmdir()
                else:
                    changing.chmod(0)
                try:
                    page.get_by_role("button", name = "Open project", exact = True).click()
                    expect(page.get_by_role("alert").filter(has_text = message)).to_be_visible(timeout = 60000)
                    expect(page.get_by_test_id("coding-conversation-id")).to_have_text(first_id)
                    snapshot(page, name)
                    scenario("A6-" + name, "Folder changed after browsing; native opening refused with actionable error and existing conversation preserved")
                finally:
                    if changing.exists():
                        changing.chmod(0o700)
                page.get_by_role("button", name = "Cancel", exact = True).click()
            second_id = open_project(second)
            assert second_id != first_id
            expect(page.get_by_test_id("coding-canonical-cwd")).to_have_text(str(second))
            refresh = page.get_by_role("button", name = "Refresh coding conversations", exact = True)
            refresh.click()
            expect(refresh).to_be_enabled(timeout = 60000)
            original = page.locator('[aria-label="Saved coding conversations"] button').filter(has_text = first_id)
            expect(original).to_be_visible()
            with page.expect_response(lambda response: response.url == base + f"/api/coding/conversations/{first_id}/open" and response.request.method == "POST", timeout = 60000) as reopened:
                original.click()
            assert reopened.value.ok and reopened.value.json()["id"] == first_id
            expect(page.get_by_test_id("coding-conversation-id")).to_have_text(first_id, timeout = 60000)
            expect(page.get_by_test_id("coding-canonical-cwd")).to_have_text(str(first))
            expect(page.get_by_test_id("coding-event-status")).to_contain_text("Native event stream connected", timeout = 60000)
            scenario("A6-change-reopen", "Different project creates a different native identity; deliberate reopen preserves first ID and cwd")
            if args.workload == "recovery":
                saved_second = page.locator('[aria-label="Saved coding conversations"] button').filter(has_text = second_id)
                for failure, expected_error in (("denied", "denies access"), ("missing", "does not exist")):
                    if failure == "denied":
                        second.chmod(0)
                    else:
                        second.rmdir()  # This empty disposable folder was created above by this run.
                    try:
                        saved_second.click()
                        expect(page.get_by_role("alert").filter(has_text = expected_error)).to_be_visible(timeout = 60000)
                        expect(page.get_by_test_id("coding-conversation-id")).to_have_text(first_id)
                        snapshot(page, "recovery-saved-folder-" + failure)
                    finally:
                        if failure == "missing":
                            second.mkdir()
                        second.chmod(0o700)
                scenario("A6-saved-folder-reopen-errors", "Missing and OS-denied saved folders were refused on deliberate reopen even with retained native ownership; current conversation identity stayed unchanged, no replacement folder or fork")
            if args.workload != "opening":
                try:
                    if args.workload == "recovery":
                        run_recovery_scenarios(page, context, base, provider, first, second_id,
                                               report, scenario, snapshot, restart_server)
                        product = [child for child in psutil.Process(server.pid).children()
                                   if child.cmdline()[1:] == ["plugin", "run", "studio.frontend"]]
                        assert len(product) == 1
                        report["supervised_pid"] = product[0].pid
                    elif args.workload == "questions":
                        run_question_scenarios(page, context, base, provider, first, second_id,
                                               report, scenario, snapshot)
                    else:
                        run_scenarios(page, context, base, provider, first, second_id,
                                      report, scenario, snapshot, live = live)
                except Exception:
                    show_error = page.get_by_role("button", name = "Show Error", exact = True)
                    if show_error.count():
                        show_error.click()
                        report["browser_failure_details"] = page.locator("pre").all_inner_texts()
                    snapshot(page, "failed-workload")
                    raise
            # Fault injection affects only one browser stream connection; reopening
            # and the replacement subscription still use the real native process.
            event_url = base + f"/api/coding/conversations/{first_id}/events"
            page.route(event_url, lambda route: route.abort("connectionreset"), times = 1)
            original.click()
            expect(page.get_by_test_id("coding-event-status")).to_contain_text("Native event stream unavailable", timeout = 60000)
            original.click()
            expect(page.get_by_test_id("coding-event-status")).to_contain_text("Native event stream connected", timeout = 60000)
            expect(page.get_by_test_id("coding-conversation-id")).to_have_text(first_id)
            scenario("A6-same-id-view-reopen", "One browser SSE connection was fault-aborted; deliberate same-ID reopen obtained a fresh real native stream without changing identity")
            # A separate actual native process owns a third conversation. The Studio
            # process must refuse it, leave its current owner alone, then open only
            # after that other process confirms EOF cleanup.
            with (evidence / "foreign-owner.log").open("w") as foreign_log:
                foreign = subprocess.Popen([str(args.mimir.resolve()), "plugin", "run", "studio.frontend"],
                                           env = env, stdin = subprocess.PIPE, stdout = subprocess.PIPE,
                                           stderr = foreign_log)
                try:
                    data = json.dumps({"id": 1, "method": "create", "params": {"cwd": str(second)}}).encode()
                    foreign.stdin.write(struct.pack(">I", len(data)) + data)
                    foreign.stdin.flush()
                    def read_exact(count):
                        result = b""
                        deadline = time.monotonic() + 60
                        while len(result) < count:
                            remaining = deadline - time.monotonic()
                            assert remaining > 0 and select.select([foreign.stdout], [], [], remaining)[0], "Foreign native owner timed out"
                            chunk = os.read(foreign.stdout.fileno(), count - len(result))
                            assert chunk, "Foreign native owner disconnected"
                            result += chunk
                        return result
                    size = struct.unpack(">I", read_exact(4))[0]
                    assert 0 < size <= 1024 * 1024
                    result = json.loads(read_exact(size))
                    assert "result" in result, result
                    foreign_id = result["result"]["info"]["id"]
                    report["conversation_ids"].append(foreign_id)
                    page.get_by_role("button", name = "Refresh coding conversations", exact = True).click()
                    owned_elsewhere = page.locator('[aria-label="Saved coding conversations"] button').filter(has_text = foreign_id)
                    expect(owned_elsewhere).to_be_visible()
                    owned_elsewhere.click()
                    expect(page.get_by_role("alert").filter(has_text = "another process")).to_be_visible(timeout = 60000)
                    expect(page.get_by_test_id("coding-conversation-id")).to_have_text(first_id)
                    assert foreign.poll() is None, "Studio cancelled the foreign owner"
                    snapshot(page, "desktop-lease-refusal")
                    foreign.stdin.close()
                    assert foreign.wait(timeout = 30) == 0
                    owned_elsewhere.click()
                    expect(page.get_by_test_id("coding-conversation-id")).to_have_text(foreign_id, timeout = 60000)
                    scenario("A6-cross-process-lease", "Browser showed in-use refusal without changing current ID or cancelling foreign owner; same ID opened after confirmed native EOF cleanup")
                finally:
                    if foreign.poll() is None:
                        foreign.stdin.close()
                        try:
                            foreign.wait(timeout = 30)
                        except subprocess.TimeoutExpired:
                            foreign.kill()
                            foreign.wait()
            children = psutil.Process(server.pid).children()
            product = [child for child in children if child.cmdline()[1:] == ["plugin", "run", "studio.frontend"]]
            assert len(product) == 1, "Studio must supervise one product process across conversations"
            assert report["supervised_pid"] == product[0].pid, "Studio replaced the native owner during browser scenarios"
            scenario("A1-one-runtime", "Three native conversations retained in one Studio-supervised product process")
            page.set_viewport_size({"width": 390, "height": 844})
            expect(page.get_by_test_id("coding-project-chooser")).to_be_visible()
            assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
            page.get_by_role("button", name = "Choose another project", exact = True).click()
            expect(page.get_by_role("dialog")).to_be_visible()
            expect(page.get_by_label("Host folder path", exact = True)).to_be_focused()
            snapshot(page, "narrow-picker")
            page.keyboard.press("Escape")
            expect(page.get_by_role("dialog")).not_to_be_visible()
            expect(page.get_by_role("button", name = "Choose another project", exact = True)).to_be_focused()
            snapshot(page, "narrow-opened")
            scenario("A10-narrow-keyboard", "390x844: no horizontal document overflow; picker focus, Escape dismissal, and trigger focus restored")
            # Requests on known IDs still require ordinary Studio authentication.
            unauth = playwright.request.new_context(base_url = base)
            from urllib.parse import urlencode
            denied_requests = []
            for method, path, kwargs in (
                ("get", "/api/coding/projects/browse", {}),
                ("get", "/api/coding/catalog?" + urlencode({"cwd": str(first)}), {}),
                ("get", "/api/coding/conversations", {}),
                ("post", "/api/coding/conversations", {"data": {"cwd": str(first)}}),
                ("post", f"/api/coding/conversations/{first_id}/open", {}),
                ("get", f"/api/coding/conversations/{first_id}/events", {}),
                ("post", f"/api/coding/conversations/{first_id}/prompts", {"data": {"submission_key": "unauthenticated-valid-key", "text": "Must not execute"}}),
                ("post", f"/api/coding/conversations/{first_id}/requests/{report.get('workload', report.get('recovery', {})).get('requests', [{}])[0].get('request_id', 'known-request')}/cancel", {}),
                ("post", f"/api/coding/conversations/{first_id}/entries", {"data": {"cut": {}, "anchor": "latest", "max_entries": 10, "max_bytes": 1024}}),
            ):
                response = getattr(unauth, method)(path, **kwargs)
                assert response.status in (401, 403), (method, path, response.status)
                denied_requests.append({"method": method, "path": path, "status": response.status})
            unauth.dispose()
            if provider:
                provider.assert_no_request()
            report["unauthenticated_requests"] = denied_requests
            scenario("A6-known-id-auth", "All nine coding surfaces (browse/catalog/history/create/open/SSE/prompt/cancel/bounded entries), including real conversation/request IDs, refused unauthenticated requests")
            # Measure over more than two ordinary indicator polling intervals.
            # No ordinary-model status response is mocked and no model is loaded.
            page.wait_for_timeout(11000)
            assert not ordinary_status_requests, ordinary_status_requests
            expect(page.get_by_role("button", name = "Close loaded models", exact = True)).to_have_count(0)
            report["ordinary_model_observer"] = {"preference_enabled": True,
                                                  "minimum_observation_ms": 11000,
                                                  "status_requests": ordinary_status_requests}
            scenario("A9-ordinary-observer-isolation", "Direct coding route with loaded-model preference enabled issued no ordinary inference/media status polls; no ordinary workload was loaded or cancelled")
            browser.close()
        assert fingerprint(trust_path) == trust_before, "Isolated saved ancestor distrust was changed"
        assert fingerprint(shared_trust) == shared_before, "Shared saved trust changed during acceptance"
        report["trust"] = {"isolated_before": trust_before, "isolated_after": fingerprint(trust_path),
                           "shared_before": shared_before, "shared_after": fingerprint(shared_trust),
                           "shared_path": str(shared_trust)}
        scenario("A6-saved-policy", "Native saved trust fingerprints unchanged" if live else "Opened/reopened beneath isolated saved ancestor distrust; isolated and real shared trust fingerprints unchanged")
        report["status"] = report.get("workload", {}).get("status", "passed")
    except BaseException as exc:
        report["status"] = "failed"
        report["error"] = str(exc)
        raise
    finally:
        denied.chmod(0o700)
        server.terminate()
        try:
            server.wait(timeout = 45)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait()
            report["limitations"].append("Acceptance server required forced termination; clean drain not established.")
        output.close()
        if provider:
            provider.close()
        report["server_exit"] = server.returncode
        # A successful browser interaction is not proof that native owners drained.
        # Inspect the exact child captured above, not an arbitrary same-user PID.
        native_settled = all(not child.is_running() for child in product) if "product" in locals() else None
        with socket.socket() as probe:
            port_closed = probe.connect_ex(("127.0.0.1", port)) != 0
        report["cleanup"] = {"native_process_settled": native_settled,
                             "server_port_closed": port_closed}
        cleanup_failed = report.get("status") == "passed" and not (
            native_settled and port_closed and server.returncode in (0, -15)
        )
        if cleanup_failed:
            report["status"] = "failed"
            report["limitations"].append("Acceptance cleanup did not confirm native settlement and a closed server port.")
        (evidence / "report.json").write_text(json.dumps(report, indent = 2) + "\n")
        if cleanup_failed:
            raise RuntimeError("Acceptance cleanup failed; inspect report.json and server.log")
    if report.get("status") in ("blocked", "failed"):
        raise SystemExit(2 if report["status"] == "blocked" else 1)


if __name__ == "__main__":
    main()
