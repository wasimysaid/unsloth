#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Tickets 250/251: rendered MCP settings through the actual native owner.

Run after building Studio frontend dist and the paired Mimir/product package:
  .venv/bin/python studio/tools/coding_mcp_browser_acceptance.py \
    --mimir /path/to/mimir --plugin-package /path/to/product-package \
    --evidence-dir /path/to/attempt/worker/mcp-browser

Uses the existing coding_acceptance_app composition: production auth/coding
routers, built UI, installed studio.frontend plugin and native binary. No API
routes are mocked. HOME, Studio profile, native agent directory and projects are
isolated beneath evidence-dir. Default mode is save-only with disabled fixtures.
--apply-reconnect adds ticket-251 real configured stdio MCP connections, tools,
safe-idle busy refusal, failure/lifetime evidence and response-loss reconciliation.
Its external HTTP provider is deterministic protocol input, NOT a live model;
no GPU, real provider spend or shared native policy is used. Run as a non-root
user so permission fault injection is meaningful. This is not full-Studio startup.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import urlencode, urlparse

from coding_mcp_apply_scenarios import (
    MCP_TOOL_CAPTURE, STORAGE_VALUES, assert_private_storage_absent, fixture_processes, process_settled, run_apply_reconnect_scenarios,
)
from coding_mcp_stdio_fixture import read_events, write_control
from coding_provider_fixture import ProviderFixture


MCP_API = "/api/coding/conversations/{conversation_id}/mcp"
INVENTORY_SECRET = "mcp-inventory-private-value-" + secrets.token_hex(8)


def fingerprint(path: Path) -> str | None:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def writer_lock_path(path: Path) -> Path:
    """POSIX native lock identity; no lock or directory is created by this helper."""
    digest = hashlib.sha256(os.fsencode(path.resolve())).hexdigest()
    return Path(f"/tmp/mimir-config-write-locks-{os.geteuid()}") / (digest + ".lock")


def create_fixtures(state: Path) -> dict[str, Path]:
    """All four native layered locations are local to this acceptance run."""
    paths = {
        "home": state / "host-home",
        "studio": state / "studio-home",
        "native": state / "mimir-home",
        "project": state / "projects" / "mcp-project",
    }
    paths["shared"] = paths["home"] / ".config" / "mcp" / "mcp.json"
    paths["global"] = paths["native"] / "mcp.json"
    paths["workspace_root"] = paths["project"] / ".mcp.json"
    paths["workspace"] = paths["project"] / ".mimir" / "mcp.json"
    definitions = {
        "shared": {"shared-only": {"command": "shared-disabled-command", "enabled": False}},
        "global": {
            "configured": {"command": "configured-disabled-command", "enabled": False},
            "inventory-only": {"command": "private-disabled-command", "enabled": False,
                               "env": {"ACCEPTANCE_PRIVATE_VALUE": INVENTORY_SECRET}},
        },
        "workspace_root": {"workspace-root-only": {"command": "workspace-disabled-command", "enabled": False}},
        "workspace": {"workspace-only": {"enabled": False}},
    }
    for name in ("home", "studio", "native", "project"):
        paths[name].mkdir(parents = True, exist_ok = True)
    for name, entries in definitions.items():
        paths[name].parent.mkdir(parents = True, exist_ok = True)
        paths[name].write_text(json.dumps({"mcpServers": entries}) + "\n")
        paths[name].chmod(0o600)
    paths["trust"] = paths["native"] / "trust.json"
    paths["trust"].write_text(json.dumps({str(paths["project"].resolve()): False}) + "\n")
    return paths


def main() -> None:
    parser = argparse.ArgumentParser(description = __doc__)
    runtime = parser.add_mutually_exclusive_group(required = True)
    runtime.add_argument("--mimir", type = Path)
    runtime.add_argument("--mimir-source", type = Path)
    parser.add_argument("--plugin-package", type = Path)
    parser.add_argument("--compilation-cache", type = Path,
                        help = "Reuse a task-owned native Wasmtime artifact cache only; configuration/history remain isolated")
    parser.add_argument("--evidence-dir", type = Path, required = True)
    parser.add_argument("--browser", choices = ("chromium", "firefox"), default = "chromium")
    parser.add_argument("--chrome", default = "/usr/bin/google-chrome")
    parser.add_argument("--apply-reconnect", action = "store_true",
                        help = "Ticket 251 native MCP tools/busy/lifetime/reconciliation with deterministic external provider")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    evidence = args.evidence_dir.resolve()
    if evidence.is_relative_to(root):
        parser.error("Evidence must be outside the Git worktree")
    if os.name != "posix" or os.geteuid() == 0:
        parser.error("Permission acceptance requires a non-root POSIX user")
    evidence.mkdir(parents = True, exist_ok = True)
    report = {
        "kind": "browser", "ticket": 251 if args.apply_reconnect else 250, "status": "running",
        "composition": "production coding/auth routers + built Studio UI + installed product plugin + native Mimir",
        "provider_workload": False, "viewports": [[1440, 1000], [390, 844]],
        "revision_contract": "Opaque retained native edit-resource token; fresh editors have independent revisions, saved definition is checked on disk and by a fresh native read.",
        "scenarios": [], "artifacts": [],
        "limitations": [
            "No provider or GPU workload; busy coverage is native persistence-writer lock contention, not busy-sensitive runtime apply.",
            "Live MCP apply/reconnect belongs to ticket 251 and is not exercised.",
            "Unrelated Studio ML/training routers and full-Studio startup are not mounted.",
        ],
    }
    if args.apply_reconnect:
        report["provider_workload"] = "deterministic-http-protocol-not-live-model"
        report["limitations"] = [
            "Provider input is a deterministic external HTTP fixture, not a completed live-model workload; native MCP connections/tools are real.",
            "Transient SDK attachment grants/cleanup require separate native lifetime tests; this driver exercises configured session ownership.",
            "Unrelated Studio ML/training routers and full-Studio startup are not mounted.",
        ]
    server = None
    provider = None
    mcp_processes = []
    output = None
    products = []
    port = None
    paths = None
    page = None

    def scenario(identifier: str, detail: str) -> None:
        report["scenarios"].append({"id": identifier, "status": "passed", "detail": detail})

    def snapshot(name: str) -> None:
        path = evidence / (name + ".png")
        page.screenshot(path = str(path), full_page = False, animations = "disabled")
        report["artifacts"].append(str(path))

    try:
        if args.mimir_source:
            source = args.mimir_source.resolve()
            with (evidence / "paired-build.log").open("w") as build_log:
                subprocess.run(["cargo", "build", "--locked", "-p", "mimir-cli"], cwd = source,
                               stdout = build_log, stderr = subprocess.STDOUT, check = True, timeout = 1200)
                metadata = json.loads(subprocess.check_output(
                    ["cargo", "metadata", "--no-deps", "--format-version", "1"], cwd = source, timeout = 60))
                args.mimir = Path(metadata["target_directory"]) / "debug" / "mimir"
                args.plugin_package = evidence / "current-product-package"
                subprocess.run([sys.executable, "plugins/studio-frontend/build.py", "--output", str(args.plugin_package)],
                               cwd = source, stdout = build_log, stderr = subprocess.STDOUT, check = True, timeout = 1000)
        elif args.plugin_package is None:
            parser.error("--plugin-package is required with --mimir")
        if not (root / "studio/frontend/dist/index.html").is_file():
            raise RuntimeError("Build Studio frontend dist before acceptance")
        paths = create_fixtures(evidence / ("state-" + secrets.token_hex(4)))
        if args.compilation_cache:
            cache = args.compilation_cache.resolve(strict = True)
            if not cache.is_dir() or cache.stat().st_uid != os.geteuid():
                raise ValueError("Compilation cache must be a task-owned directory")
            (paths["native"] / "cache").mkdir(exist_ok = True)
            (paths["native"] / "cache" / "wasmtime").symlink_to(cache, target_is_directory = True)
            report["compilation_cache"] = str(cache)
        if args.apply_reconnect:
            provider = ProviderFixture()
            provider.configure(paths["native"])
            paths["mcp_events"] = paths["native"].parent / "mcp-events.jsonl"
            paths["mcp_control"] = paths["native"].parent / "mcp-control.json"
            write_control(paths["mcp_control"])
        report["state_root"] = str(paths["native"].parent)
        report["native_sha256"] = fingerprint(args.mimir.resolve())
        report["plugin_sha256"] = fingerprint(args.plugin_package.resolve() / "plugin.wasm")
        report["frontend_index_sha256"] = fingerprint(root / "studio/frontend/dist/index.html")
        paired_source = args.mimir_source.resolve() if args.mimir_source else root.parent / "mimir"
        report["source_revisions"] = {"studio": subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd = root, text = True, timeout = 30).strip()}
        if (paired_source / ".git").exists():
            report["source_revisions"]["mimir"] = subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd = paired_source, text = True, timeout = 30).strip()
        trust_before = fingerprint(paths["trust"])
        password = secrets.token_urlsafe(24)
        env = dict(os.environ, HOME = str(paths["home"]), XDG_CONFIG_HOME = str(paths["home"] / ".config"),
                   UNSLOTH_STUDIO_HOME = str(paths["studio"]), MIMIR_CODING_AGENT_DIR = str(paths["native"]),
                   UNSLOTH_MIMIR_EXECUTABLE = str(args.mimir.resolve()),
                   UNSLOTH_MIMIR_PLUGIN_PACKAGE = str(args.plugin_package.resolve()),
                   CODING_ACCEPTANCE_PASSWORD = password, MIMIR_DISABLE_MODELS_FETCH = "1",
                   MIMIR_MODELS_PATH = str(paths["native"] / "catalog.json"), CUDA_VISIBLE_DEVICES = "",
                   PYTHONPATH = str(root / "studio/backend"))
        for key in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "MIMIR_SKILLS_DIR"):
            env.pop(key, None)
        with (evidence / "plugin-install.log").open("w") as install_log:
            subprocess.run([str(args.mimir.resolve()), "plugin", "install", str(args.plugin_package.resolve())],
                           env = env, stdout = install_log, stderr = subprocess.STDOUT, check = True, timeout = 600)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        base = f"http://127.0.0.1:{port}"
        output = (evidence / "server.log").open("w")
        server = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "tests.coding_acceptance_app:create_app", "--factory",
             "--host", "127.0.0.1", "--port", str(port)], cwd = root / "studio/backend", env = env,
            stdout = output, stderr = subprocess.STDOUT)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if server.poll() is not None:
                raise RuntimeError("Acceptance server exited; inspect server.log")
            try:
                with urllib.request.urlopen(base + "/api/auth/status", timeout = 1):
                    break
            except (urllib.error.URLError, TimeoutError):
                time.sleep(0.1)
        else:
            raise RuntimeError("Acceptance server did not become ready within 30 seconds")
        from playwright.sync_api import sync_playwright, expect
        import psutil
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
            if args.apply_reconnect:
                context.add_init_script(MCP_TOOL_CAPTURE)
            page = context.new_page()
            page.goto(base + "/coding")
            expect(page).to_have_url(base + "/login")
            login = context.request.post(base + "/api/auth/login", data = {"username": "unsloth", "password": password})
            assert login.ok, f"Login failed ({login.status})"
            tokens = login.json()
            page.evaluate("tokens => { localStorage.setItem('unsloth_auth_token', tokens.access_token); localStorage.setItem('unsloth_auth_refresh_token', tokens.refresh_token); localStorage.setItem('unsloth_auth_session_mark', 'mcp-acceptance'); }", tokens)
            headers = {"Authorization": "Bearer " + tokens["access_token"]}
            page.goto(base + "/coding")
            expect(page.get_by_role("heading", name = "Build with Mimir")).to_be_visible()
            page.get_by_role("button", name = "Choose project folder", exact = True).click()
            page.get_by_label("Host folder path", exact = True).fill(str(paths["project"]))
            page.get_by_role("button", name = "Browse", exact = True).click()
            expect(page.get_by_test_id("coding-browsed-path")).to_have_text(str(paths["project"].resolve()))
            page.get_by_role("button", name = "Open project", exact = True).click()
            expect(page.get_by_test_id("coding-event-status")).to_contain_text("Native event stream connected", timeout = 60000)
            conversation_id = page.get_by_test_id("coding-conversation-id").inner_text()
            report["conversation_id"] = conversation_id
            products = [child for child in psutil.Process(server.pid).children()
                        if child.cmdline()[1:] == ["plugin", "run", "studio.frontend"]]
            assert len(products) == 1, "Expected one supervised actual product process"
            report["supervised_pid"] = products[0].pid
            scenario("A1-A8-real-path", "Established Studio login and native conversation, using one installed product process")
            try:
                exercise_settings(page, context, playwright, base, headers, paths, conversation_id, report, scenario, snapshot, expect)
                if args.apply_reconnect:
                    run_apply_reconnect_scenarios(page, context, playwright, base, headers, paths, conversation_id,
                                                 provider, report, scenario, snapshot, expect)
            except BaseException:
                # Capture before sync_playwright tears down the browser on unwind.
                try:
                    snapshot("failure")
                except Exception:
                    report["limitations"].append("Failure screenshot could not be captured.")
                raise
            assert products[0].is_running(), "Settings must not stop the supervised native process"
            assert fingerprint(paths["trust"]) == trust_before, "Settings changed saved native trust"
            scenario("A8-session-process-trust-retained" if args.apply_reconnect else "A8-no-hidden-apply",
                     "Native process and original conversation survive settings; saved distrust unchanged")
            browser.close()
        assert INVENTORY_SECRET not in (evidence / "server.log").read_text(), "Private definition leaked into backend logs"
        assert INVENTORY_SECRET not in (evidence / "plugin-install.log").read_text(), "Private definition leaked into installation logs"
        report["status"] = "passed"
    except BaseException as exc:
        report["status"] = "failed"
        report["error"] = str(exc)
        if page is not None and not page.is_closed():
            try:
                snapshot("failure")
            except Exception:
                report["limitations"].append("Failure screenshot unavailable after browser teardown.")
        raise
    finally:
        if paths:
            # Restore only permissions changed on this run's isolated fixtures.
            paths["global"].chmod(0o600)
            paths["native"].chmod(0o755)
        if paths and "mcp_events" in paths:
            write_control(paths["mcp_control"])
            mcp_processes = fixture_processes(paths["mcp_events"])
        if server is not None:
            server.terminate()
            try:
                server.wait(timeout = 45)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait(timeout = 10)
                report["limitations"].append("Acceptance server needed forced termination; clean drain not established.")
            report["server_exit"] = server.returncode
        if output:
            output.close()
        if provider:
            provider.close()
            report["provider_fixture_settled"] = True
        if paths and "mcp_events" in paths:
            deadline = time.monotonic() + 10
            while not all(process_settled(identity) for identity in mcp_processes) and time.monotonic() < deadline:
                time.sleep(0.1)
            report["mcp_cleanup"] = {
                "processes": [{**identity, "settled": process_settled(identity)} for identity in mcp_processes],
                "all_connections_settled": all(process_settled(identity) for identity in mcp_processes),
                "events_path": str(paths["mcp_events"]), "events": read_events(paths["mcp_events"]),
                "deadline_seconds": 10,
            }
        settled = all(not product.is_running() for product in products) if products else None
        closed = None
        if port:
            with socket.socket() as probe:
                closed = probe.connect_ex(("127.0.0.1", port)) != 0
        report["cleanup"] = {"native_process_settled": settled, "server_port_closed": closed}
        cleanup_failed = report["status"] == "passed" and not (
            settled and closed and server is not None and server.returncode in (0, -15)
            and (not args.apply_reconnect or report.get("mcp_cleanup", {}).get("all_connections_settled") is True))
        if cleanup_failed:
            report["status"] = "failed"
            report["limitations"].append("Native settlement/server cleanup not confirmed.")
        (evidence / "report.json").write_text(json.dumps(report, indent = 2) + "\n")
        if cleanup_failed:
            raise RuntimeError("Acceptance cleanup failed; inspect report.json")


def exercise_settings(page, context, playwright, base, headers, paths, conversation_id,
                      report, scenario, snapshot, expect) -> None:
    """Real browser edits plus another authenticated backend writer, never routes/stubs."""
    prefix = MCP_API.format(conversation_id = conversation_id)
    inventory_path, edit_path, save_path = [prefix + suffix for suffix in ("/inventory", "/edit", "/save")]
    settings = page.get_by_role("main", name = "Mimir Settings", exact = True)
    configuration = settings.get_by_role("region", name = "MCP configuration", exact = True)
    views = page.get_by_role("navigation", name = "Coding views", exact = True)
    settings_tab = views.get_by_role("button", name = "Mimir Settings", exact = True)
    conversation_tab = views.get_by_role("button", name = "Conversation", exact = True)
    observed_requests = []
    page.on("request", lambda request: observed_requests.append({"method": request.method, "path": urlparse(request.url).path}))

    def read_inventory():
        response = context.request.get(base + inventory_path, headers = headers, timeout = 60000)
        assert response.ok, f"Native inventory HTTP {response.status}"
        value = response.json()
        assert INVENTORY_SECRET not in json.dumps(value), "Private definition leaked into inventory"
        return value

    def api_edit(source, name):
        response = context.request.post(base + edit_path, headers = headers,
                                        data = {"source": source, "name": name}, timeout = 60000)
        assert response.ok, f"Second writer edit HTTP {response.status}"
        return response.json()

    def api_save(draft, text):
        response = context.request.post(base + save_path, headers = headers,
                                        data = {"edit_id": draft["edit_id"], "revision": draft["revision"], "json": text}, timeout = 60000)
        assert response.ok, f"Second writer save HTTP {response.status}"
        result = response.json()
        assert result["draft"]["revision"] != draft["revision"], "Second writer did not persist a new revision"
        return result

    def browser_command(button_name, endpoint, keyboard = False):
        button = settings.get_by_role("button", name = button_name, exact = True)
        revision_label = settings.get_by_text(re.compile(r"^Editing revision: "))
        previous_revision_text = revision_label.inner_text() if revision_label.count() else None
        with page.expect_response(lambda response: urlparse(response.url).path == endpoint
                                  and response.request.method == "POST", timeout = 60000) as pending:
            if keyboard:
                button.focus()
                expect(button).to_be_focused()
                page.keyboard.press("Enter")
            else:
                button.click()
        response = pending.value
        # Wait for the controller's finally branch, not just the HTTP response.
        expect(configuration).to_have_attribute("aria-busy", "false", timeout = 60000)
        if not response.ok and previous_revision_text is not None:
            expect(revision_label).to_have_text(previous_revision_text)
        return response

    def text_for(command):
        return json.dumps({"command": command, "enabled": False}, indent = 2)

    def persisted(name = "configured"):
        return json.loads(paths["global"].read_text())["mcpServers"][name]

    def draft_retained(text, switch_tabs = False):
        expect(settings.get_by_label("MCP definition JSON", exact = True)).to_have_value(text)
        if switch_tabs:
            conversation_tab.focus()
            page.keyboard.press("Enter")
            expect(page.get_by_test_id("coding-conversation-id")).to_have_text(conversation_id)
            settings_tab.focus()
            page.keyboard.press("Enter")
            expect(settings.get_by_label("MCP definition JSON", exact = True)).to_have_value(text)
            expect(configuration).to_have_attribute("aria-busy", "false", timeout = 60000)
        assert_private_storage_absent(page.evaluate(STORAGE_VALUES), text, INVENTORY_SECRET)

    def expect_error(pattern):
        alert = settings.get_by_role("alert")
        expect(alert).to_be_visible()
        expect(alert).to_contain_text(re.compile(pattern, re.I))
        expect(alert).to_contain_text("draft and original revision are retained")
        expect(alert).to_be_focused()
        return alert

    def compare(text):
        response = browser_command("Load saved version for comparison", edit_path)
        assert response.ok, f"Native comparison HTTP {response.status}"
        latest = response.json()
        draft_retained(text)
        expect(settings.get_by_label("Saved definition JSON", exact = True)).to_have_value(latest["json"])
        return latest

    def successful_save(text, previous_revision):
        response = browser_command("Save configuration", save_path, keyboard = True)
        assert response.ok, f"Native save HTTP {response.status}"
        result = response.json()
        revision = result["draft"]["revision"]
        assert revision and revision != previous_revision, "Save must return its actual new persisted revision"
        assert json.loads(result["draft"]["json"]) == json.loads(text)
        assert persisted(result["draft"]["name"]) == json.loads(text), "Native save did not persist the editor definition"
        fresh = api_edit(result["draft"]["source"], result["draft"]["name"])
        # Revisions identify retained native edit resources, not content hashes.
        # A new editor resource has its own opaque token; compare saved content.
        assert json.loads(fresh["json"]) == json.loads(text), "Fresh native read disagrees with saved definition"
        expect(settings.get_by_test_id("mcp-save-result")).to_contain_text("Persisted revision: " + revision)
        expect(settings.get_by_test_id("mcp-save-result")).to_contain_text("Saved only — runtime connections were not changed.")
        expect(settings.get_by_test_id("mcp-applied-state")).to_contain_text("No configured connections currently applied in this conversation.")
        applied = [row for row in result["inventory"]["live"] if row["status"] is not None]
        baseline_applied = [row for row in baseline["live"] if row["status"] is not None]
        assert applied == baseline_applied, "Saving changed applied native state"
        report.setdefault("persisted_revisions", []).append(revision)
        return result["draft"]

    report["active_scenario"] = "A8-scoped-read"
    baseline = read_inventory()
    assert baseline["live_available"] is True, "Native applied observation unavailable at idle acceptance baseline"
    labels = {
        "shared": "User .config/mcp/mcp.json",
        "global": "Mimir user MCP configuration",
        "workspace_root": "Project .mcp.json",
        "workspace": "Project .mimir/mcp.json",
    }
    sources = {source["label"]: source for source in baseline["documents"]}
    assert len(sources) == 4, "Native inventory must expose its four layered sources"
    assert len({source["source"] for source in baseline["documents"]}) == 4
    for name, label in labels.items():
        assert label in sources, f"Native inventory missed isolated {name} source"
        source = sources[label]
        expected_scope = "global" if name in ("shared", "global") else "workspace"
        assert source["scope"] == expected_scope
        # Deliberate opening grants controller-only workspace trust, regardless
        # of the saved distrust fixture; it must not change the saved policy.
        assert source["trusted"] and source["writable"] and source["exists"]
    assert not any(row["status"] is not None for row in baseline["live"]), "Disabled fixtures must not start MCP connections"
    global_source = sources[labels["global"]]["source"]
    entries = {entry["name"]: entry for entry in baseline["entries"]}
    for name, fixture in (("shared-only", "shared"), ("configured", "global"),
                          ("workspace-root-only", "workspace_root"), ("workspace-only", "workspace")):
        assert entries[name]["source"] == sources[labels[fixture]]["source"]
    catalog = context.request.get(base + "/api/coding/catalog?" + urlencode({"cwd": str(paths["project"])}),
                                  headers = headers, timeout = 60000)
    assert catalog.ok, f"Real native catalog HTTP {catalog.status}"
    assert INVENTORY_SECRET not in catalog.text(), "Private definition leaked into catalog"
    settings_tab.focus()
    expect(settings_tab).to_be_focused()
    page.keyboard.press("Enter")
    expect(settings.get_by_role("heading", name = "Mimir Settings", exact = True)).to_be_visible()
    expect(settings.get_by_role("button", name = "Edit configured", exact = True)).to_be_enabled(timeout = 60000)
    expect(settings.get_by_role("button", name = "Edit workspace-only", exact = True)).to_be_enabled()
    expect(settings.get_by_role("button", name = "Edit workspace-root-only", exact = True)).to_be_enabled()
    for label in labels.values():
        expect(settings.get_by_text(label, exact = True)).to_be_visible()
    expect(settings.get_by_text("Saving does not apply runtime changes or reconnect servers. It never stops active work.", exact = True)).to_be_visible()
    assert INVENTORY_SECRET not in settings.inner_text(), "Private definition rendered in metadata"
    snapshot("desktop-scoped-inventory")
    scenario("A8-scoped-read", "Four real native global/workspace sources and per-source identities, controller-only project trust, redacted inventory/catalog")

    report["active_scenario"] = "A8-valid-save"
    response = browser_command("Edit configured", edit_path, keyboard = True)
    assert response.ok, f"Native editor HTTP {response.status}"
    original = response.json()
    editor = settings.get_by_label("MCP definition JSON", exact = True)
    expect(editor).to_have_value(original["json"])
    expect(editor).to_be_focused()
    valid = text_for("browser-saved-disabled")
    editor.fill(valid)
    draft_retained(valid, switch_tabs = True)
    # A readable lower layer need not be writable to save this writable source.
    # No preexisting adjacent lock may hide a dependency-lock permission regression.
    shared_before = paths["shared"].read_bytes()
    assert not (paths["shared"].parent / ".mcp.json.mimir-write.lock").exists()
    paths["shared"].chmod(0o400)
    paths["shared"].parent.chmod(0o500)
    try:
        saved = successful_save(valid, original["revision"])
        assert paths["shared"].read_bytes() == shared_before, "Saving changed the read-only inherited source"
        scenario("A8-read-only-inheritance", "Writable source saved through actual native persistence while its inherited source and parent were readable but non-writable, without a preexisting adjacent lock or lower-layer mutation")
    finally:
        paths["shared"].parent.chmod(0o755)
        paths["shared"].chmod(0o600)
    snapshot("desktop-saved-not-applied")
    scenario("A8-valid-save", "Keyboard-opened explicit editor; real native save, persisted disk/re-read revision and saved-versus-unapplied presentation agree")

    report["active_scenario"] = "A8-native-busy-refusal"
    import fcntl
    # Hold the native persistence owner's advisory writer lock in this separate
    # process. The authenticated save must reach the real native busy refusal.
    busy_text = text_for("browser-busy-draft")
    editor.fill(busy_text)
    before_busy = paths["global"].read_bytes()
    writer_lock = writer_lock_path(paths["global"])
    assert writer_lock.is_file(), "The verified native save must establish its canonical writer lock"
    with writer_lock.open("r+b") as held:
        fcntl.flock(held.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        response = browser_command("Save configuration", save_path, keyboard = True)
        assert response.status == 409, f"Native writer lock should refuse busy, got HTTP {response.status}"
        expect_error("another process|writer|saved|busy|retry")
        assert paths["global"].read_bytes() == before_busy, "Native busy refusal mutated the document"
        snapshot("desktop-native-busy")
        draft_retained(busy_text, switch_tabs = True)
        fcntl.flock(held.fileno(), fcntl.LOCK_UN)
    saved = successful_save(busy_text, saved["revision"])
    scenario("A8-native-busy-refusal", "Real cross-process native writer lock refused save through Settings/backend/plugin with focused error and retained draft/revision; deliberate retry succeeded without cancelling/reopening work")

    report["active_scenario"] = "A8-invalid-json-config"
    before = paths["global"].read_bytes()
    for identifier, invalid in (("json", "{"), ("config", '{"command":false,"enabled":true}')):
        editor.fill(invalid)
        response = browser_command("Save configuration", save_path)
        assert response.status == 400, f"Invalid {identifier} should fail validation, got HTTP {response.status}"
        expect_error("json|invalid|definition|command|configuration")
        assert paths["global"].read_bytes() == before, "Invalid draft changed persistent configuration"
        snapshot("desktop-invalid-" + identifier)
        draft_retained(invalid, switch_tabs = True)
        scenario("A8-invalid-" + identifier, "Actual native validation refused save; disk and original draft preserved through error/tab switch; alert took keyboard focus")

    report["active_scenario"] = "A8-conflict-keep"
    kept = text_for("browser-kept-draft")
    editor.fill(kept)
    writer = api_save(api_edit(global_source, "configured"), text_for("second-writer-one"))["draft"]
    before = paths["global"].read_bytes()
    response = browser_command("Save configuration", save_path)
    assert response.status == 409, f"Stale first-writer save should conflict, got HTTP {response.status}"
    expect_error("conflict|changed|revision|modified")
    assert paths["global"].read_bytes() == before, "Conflict silently overwrote second writer"
    snapshot("desktop-conflict")
    draft_retained(kept, switch_tabs = True)
    latest = compare(kept)
    assert json.loads(latest["json"]) == json.loads(writer["json"]), "Comparison missed second writer's persisted content"
    settings.get_by_role("button", name = "Keep draft and use latest revision", exact = True).click()
    draft_retained(kept)
    expect(settings.get_by_text("Editing revision: " + latest["revision"], exact = True)).to_be_visible()
    saved = successful_save(kept, latest["revision"])
    scenario("A8-conflict-keep", "Authenticated second writer persisted first; stale UI refused without overwrite; explicit compare/keep adopted latest revision and retry persisted the retained draft")

    report["active_scenario"] = "A8-conflict-replace"
    replaced = text_for("browser-draft-to-replace")
    editor.fill(replaced)
    writer = api_save(api_edit(global_source, "configured"), text_for("second-writer-two"))["draft"]
    before = paths["global"].read_bytes()
    response = browser_command("Save configuration", save_path)
    assert response.status == 409, f"Second stale UI save should conflict, got HTTP {response.status}"
    expect_error("conflict|changed|revision|modified")
    draft_retained(replaced)
    latest = compare(replaced)
    assert json.loads(latest["json"]) == json.loads(writer["json"]), "Comparison missed second writer's persisted content"
    mutations_before = len([request for request in observed_requests if request["path"] == save_path])
    settings.get_by_role("button", name = "Replace draft with saved version", exact = True).click()
    expect(editor).to_have_value(latest["json"])
    expect(settings.get_by_text("Editing revision: " + latest["revision"], exact = True)).to_be_visible()
    assert paths["global"].read_bytes() == before, "Draft replacement must not implicitly save"
    assert mutations_before == len([request for request in observed_requests if request["path"] == save_path])
    snapshot("desktop-deliberate-replacement")
    scenario("A8-conflict-replace", "Another real conflicting writer; saved comparison preserved original draft until deliberate replacement, without hidden save")

    report["active_scenario"] = "A8-persistence-error"
    retry = text_for("browser-permission-retry")
    editor.fill(retry)
    before = paths["global"].read_bytes()
    paths["native"].chmod(0o500)
    try:
        response = browser_command("Save configuration", save_path)
        assert response.status >= 400 and response.status != 409, f"Persistence fault did not produce native access/write error: HTTP {response.status}"
        expect_error("permission|denied|access|persist|write|read-only")
        assert paths["global"].read_bytes() == before, "Failed persistence changed saved configuration"
        snapshot("desktop-persistence-error")
        page.set_viewport_size({"width": 390, "height": 844})
        alert = expect_error("permission|denied|access|persist|write|read-only")
        alert.scroll_into_view_if_needed()
        box = alert.bounding_box()
        assert box and box["x"] >= 0 and box["x"] + box["width"] <= 390, "Narrow native error is clipped horizontally"
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "Narrow settings page overflows horizontally"
        snapshot("narrow-persistence-error")
        draft_retained(retry, switch_tabs = True)
        scenario("A8-A10-persistence-error", "Actual native atomic persistence refused by isolated parent-directory permissions; no disk mutation, focused readable error, draft/tab retention at desktop and narrow widths")
    finally:
        paths["native"].chmod(0o755)

    report["active_scenario"] = "A8-access-error"
    paths["global"].chmod(0)
    try:
        response = browser_command("Load saved version for comparison", edit_path, keyboard = True)
        assert response.status >= 400, f"Unreadable isolated source did not fail native edit: HTTP {response.status}"
        alert = expect_error("permission|denied|access|read|document|configuration")
        alert.scroll_into_view_if_needed()
        snapshot("narrow-access-error")
        draft_retained(retry, switch_tabs = True)
        scenario("A8-A10-access-error", "Native explicit read denied by isolated file permissions; comparison failed safely, draft/original revision retained and error received keyboard focus")
    finally:
        paths["global"].chmod(0o600)
    assert paths["global"].read_bytes() == before
    with page.expect_response(lambda response: urlparse(response.url).path == inventory_path, timeout = 60000):
        settings.get_by_role("button", name = "Refresh inventory", exact = True).click()
    expect(configuration).to_have_attribute("aria-busy", "false", timeout = 60000)
    draft_retained(retry)
    saved = successful_save(retry, latest["revision"])
    editor.focus()
    expect(editor).to_be_focused()
    page.keyboard.press("Tab")
    expect(settings.get_by_role("button", name = "Save configuration", exact = True)).to_be_focused()
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
    snapshot("narrow-keyboard-recovered")
    scenario("A8-A10-permission-recovery", "Permissions restored; inventory refresh kept draft, same original revision retried successfully; textarea-to-save keyboard traversal and narrow layout verified")

    report["active_scenario"] = "A8-create-draft"
    page.set_viewport_size({"width": 1440, "height": 1000})
    settings.get_by_role("button", name = "Discard draft", exact = True).click()
    settings.get_by_role("button", name = "Confirm discard draft", exact = True).click()
    expect(editor).to_have_count(0)
    settings.get_by_label("Configuration source", exact = True).select_option(global_source)
    settings.get_by_label("Server name", exact = True).fill("browser-added")
    response = browser_command("Create draft", edit_path, keyboard = True)
    assert response.ok, f"Native add draft HTTP {response.status}"
    added = response.json()
    assert added["name"] == "browser-added" and added["source"] == global_source
    assert "browser-added" not in json.loads(paths["global"].read_text())["mcpServers"], "Creating a draft implicitly persisted configuration"
    addition = text_for("browser-added-disabled")
    editor.fill(addition)
    draft_retained(addition, switch_tabs = True)
    saved = successful_save(addition, added["revision"])
    snapshot("desktop-created-saved")
    scenario("A8-create-draft", "Source-scoped native add stays unpersisted until explicit save; draft survives tabs and native disk/revision confirms saved entry")

    report["active_scenario"] = "A8-normalized-editor-bound"
    # Compact input fits the request bound, but its normalized editor representation
    # exceeds it. Reject BEFORE persistence, not after an oversized acknowledgement.
    expanded = json.dumps({"command": "browser-expanded-disabled", "args": ["x"] * 90000, "enabled": False}, separators = (",", ":"))
    assert len(expanded.encode()) < 512 * 1024
    editor.fill(expanded)
    before_expanded = paths["global"].read_bytes()
    response = browser_command("Save configuration", save_path, keyboard = True)
    assert paths["global"].read_bytes() == before_expanded, "Oversized normalized draft persisted before refusal"
    assert response.status in (400, 429), f"Expanded editor representation must be refused before commit: HTTP {response.status}"
    expect_error("limit|size|bound|large|exceed")
    draft_retained(expanded)
    comparison = compare(expanded)
    assert json.loads(comparison["json"]) == persisted("browser-added"), "Bound refusal made the saved editor unreadable"
    settings.get_by_role("button", name = "Keep draft and use latest revision", exact = True).click()
    recovered_bound = text_for("browser-normalized-bound-recovered")
    editor.fill(recovered_bound)
    saved = successful_save(recovered_bound, comparison["revision"])
    scenario("A8-normalized-editor-bound", "Compact input with 90000 arguments refused before disk mutation because normalized editor output is too large; retained draft and saved comparison remained usable, explicit smaller retry succeeded")

    report["active_scenario"] = "A8-enabled-saved-not-applied"
    # Nonexistent command is deliberate: persistence validates transport structure,
    # but save must not attempt to execute/connect it or mutate live owners.
    enabled = json.dumps({"command": "mcp-save-must-not-execute-250", "enabled": True}, indent = 2)
    editor.fill(enabled)
    saved = successful_save(enabled, saved["revision"])
    after_enabled = read_inventory()
    enabled_entry = next(row for row in after_enabled["entries"]
                         if row["name"] == "browser-added" and row["source"] == global_source)
    assert enabled_entry["state"] == "enabled", "Saved configured state did not reflect enabled source"
    pending = next(row for row in after_enabled["live"] if row["name"] == "browser-added")
    assert pending["pending_apply"] and pending["status"] is None, "Save must leave enabled configuration pending, not connected"
    expect(settings.get_by_test_id("mcp-applied-state")).to_contain_text("Saved configuration pending apply")
    settings.get_by_test_id("mcp-applied-state").scroll_into_view_if_needed()
    snapshot("desktop-enabled-pending-apply")
    scenario("A8-enabled-saved-not-applied", "Enabled entry persisted and native configured state changed, but command never connected/executed; native pending-apply status remains distinct from save")

    report["active_scenario"] = "A8-bounded-save-acknowledgement"
    # Test-only oversized metadata fixture in a higher-priority native layer.
    # The lower source's retained editor remains valid; save acknowledgement must
    # confirm persistence even when the full inventory cannot fit the private frame.
    original_workspace = paths["workspace_root"].read_bytes()
    oversized_metadata = {f"bounded-metadata-{index:05d}-" + "x" * 32:
                          {"command": "disabled-metadata-command", "enabled": False}
                          for index in range(5000)}
    paths["workspace_root"].write_text(json.dumps({"mcpServers": oversized_metadata}) + "\n")
    bounded_text = text_for("browser-bounded-acknowledgement")
    editor.fill(bounded_text)
    try:
        response = browser_command("Save configuration", save_path, keyboard = True)
        assert response.ok, f"Committed save must not become ordinary failure when inventory is large: HTTP {response.status}"
        result = response.json()
        assert persisted("browser-added") == json.loads(bounded_text), "Bounded acknowledgement disagrees with actual persistence"
        assert result["draft"]["revision"] != saved["revision"]
        assert result["configured_state"] == "disabled"
        assert result["inventory"] is None and result["inventory_error"], "Oversized metadata needs an explicit unavailable inventory, not partial success metadata"
        saved = result["draft"]
        expect(settings.get_by_test_id("mcp-save-result")).to_contain_text("Persisted revision: " + saved["revision"])
        expect(settings.get_by_test_id("mcp-save-result")).to_contain_text("Saved configured state at this source: disabled")
        expect(settings.get_by_test_id("mcp-inventory-unavailable")).to_contain_text("configured/applied inventory is unavailable")
        expect(settings.get_by_test_id("mcp-applied-state")).to_have_count(0)
        assert settings.get_by_role("alert").count() == 0, "Confirmed persistence must not be mislabeled as a failed save"
        snapshot("desktop-bounded-save-acknowledgement")
    finally:
        paths["workspace_root"].write_bytes(original_workspace)
    with page.expect_response(lambda response: urlparse(response.url).path == inventory_path, timeout = 60000):
        settings.get_by_role("button", name = "Refresh inventory", exact = True).click()
    expect(configuration).to_have_attribute("aria-busy", "false", timeout = 60000)
    expect(settings.get_by_test_id("mcp-inventory-unavailable")).to_have_count(0)
    expect(settings.get_by_test_id("mcp-applied-state")).to_be_visible()
    draft_retained(saved["json"])
    scenario("A8-bounded-save-acknowledgement", "5000-entry native metadata fixture exceeded the transport bound; actual saved revision/configured state still acknowledged, stale applied metadata cleared with explicit unavailable status, later inventory refresh recovered without replay")

    report["active_scenario"] = "A8-established-auth"
    unauth = playwright.request.new_context(base_url = base)
    denied = []
    try:
        for method, path, data in (
            ("get", inventory_path, None),
            ("post", edit_path, {"source": global_source, "name": "configured"}),
            ("post", save_path, {"edit_id": saved["edit_id"], "revision": saved["revision"], "json": saved["json"]}),
            ("post", prefix + "/release", {"edit_id": saved["edit_id"]}),
        ):
            response = getattr(unauth, method)(path, **({"data": data} if data is not None else {}))
            assert response.status in (401, 403), f"Known native MCP request bypassed auth: HTTP {response.status}"
            denied.append({"method": method, "path": path, "status": response.status})
    finally:
        unauth.dispose()
    report["unauthenticated_requests"] = denied
    scenario("A8-established-auth", "All four MCP surfaces refuse unauthenticated requests with valid known native identities/inputs")
    forbidden = [request for request in observed_requests if request["method"] == "POST"
                 and (request["path"] == "/api/coding/conversations" or request["path"].endswith("/open"))]
    assert not forbidden, "Settings recreated/reopened a conversation as hidden apply"
    report["settings_requests"] = observed_requests
    report.pop("active_scenario", None)
    conversation_tab.click()
    expect(page.get_by_test_id("coding-conversation-id")).to_have_text(conversation_id)
    expect(page.get_by_test_id("coding-event-status")).to_contain_text("Native event stream connected", timeout = 60000)


if __name__ == "__main__":
    main()
