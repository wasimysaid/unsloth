#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Exercise the built /coding UI through production auth, Python, Wasm and native tools.

Run with the backend acceptance dependencies and Python Playwright installed:
  .venv/bin/python studio/tools/coding_refresh_acceptance.py \
    --mimir ../mimir-input/target/debug/mimir \
    --plugin-package ../mimir-input/target/studio-input-package \
    --evidence-dir ../evidence/browser-initial

Every invocation creates a new isolated run directory. Only the external model
protocol is deterministic. No coding API, browser row or tool result is mocked.
No shared credentials, profiles, GPU, inference server or external model is used.
"""
from __future__ import annotations

import argparse
import base64
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import random
import secrets
import socket
import struct
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.request
from urllib.parse import urlparse
import zlib

from coding_provider_fixture import ProviderFixture


SKILL = "refresh-visual"
SKILL_MARKER = "REFRESH_NATIVE_SKILL_BODY"
RESULT = "REFRESH_NATIVE_FILE_CONTENT\n"
FINAL = "REFRESH_NATIVE_COMPLETED"


def sha256(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def large_png() -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))

    random_bytes = random.Random(233)
    pixels = b"".join(b"\x00" + random_bytes.randbytes(470 * 3) for _ in range(470))
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", 470, 470, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b""))


def validate_mentions(body: dict, project: Path) -> dict:
    text = body["text"].encode("utf-8")
    skill = body["skill_mentions"]
    agent = body["subagent_mentions"]
    assert len(skill) == len(agent) == 1, "Both selected mention identities must reach native admission"
    assert skill[0]["name"] == SKILL
    assert skill[0]["path"] == str(project / ".agents" / "skills" / SKILL / "SKILL.md")
    assert agent[0]["name"] == "explore"
    for mention in [*skill, *agent]:
        assert text[mention["start"]:mention["end"]] == ("@" + mention["name"]).encode()
    assert skill[0]["start"] == len("é 😀 ".encode())
    return {"text": body["text"], "skill_mentions": skill, "subagent_mentions": agent}


def native_capture(base: str, headers: dict, conversation: str) -> dict:
    request = urllib.request.Request(base + f"/api/coding/conversations/{conversation}/events", headers=headers)
    with urllib.request.urlopen(request, timeout=60) as response:
        for _ in range(20):
            line = response.readline()
            if line.startswith(b"data: "):
                event = json.loads(line[6:])["event"]
                assert event["type"] == "start", "A fresh native capture must start with its atomic cut"
                return event
    raise AssertionError("Native stream did not return its initial capture")


def network_counts(requests: list[dict], conversation: str) -> dict:
    prefix = f"/api/coding/conversations/{conversation}/"
    counts = Counter(item["path"].removeprefix(prefix) for item in requests
                     if item["path"].startswith(prefix))
    return {key: counts[key] for key in ("events", "entries")}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mimir", type=Path, required=True)
    parser.add_argument("--plugin-package", type=Path, required=True)
    parser.add_argument("--evidence-dir", type=Path, required=True)
    parser.add_argument("--compilation-cache", type=Path)
    parser.add_argument("--image", type=Path)
    parser.add_argument("--chrome", default="/usr/bin/google-chrome")
    parser.add_argument("--install-timeout", type=int, default=600)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    evidence_root = args.evidence_dir.resolve()
    evidence_root.mkdir(parents=True, exist_ok=True)
    run = evidence_root / ("run-" + time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(3))
    run.mkdir()
    native = run / "mimir-home"
    native.mkdir()
    project = run / "project"
    project.mkdir()
    report = {
        "status": "running", "stage": "setup", "run_id": run.name,
        "command": [sys.executable, *sys.argv], "evidence_dir": str(run),
        "composition": "production auth/coding routers + built Studio UI + installed studio.frontend Wasm + native Mimir",
        "provider": "deterministic loopback OpenAI Chat HTTP fixture; real native execution",
        "limitations": ["No external real-model or GPU validation.",
                        "Unrelated ML/training APIs are not mounted.",
                        "This fixture's Chat reasoning maps to native ThinkingKind::Hidden, not public Summary. Public reasoning rendering is not a live result of this run."],
        "scenarios": [], "requests": [], "browser_requests": [], "page_errors": [],
        "console_errors": [], "http_errors": [], "screenshots": [], "visual_findings": [], "cleanup": {},
    }
    provider = server = browser = context = page = output = None
    product = []
    headers = {}
    base = ""

    def persist():
        (run / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        (evidence_root / "latest.json").write_text(json.dumps({"report": str(run / "report.json"), "status": report["status"]}, indent=2) + "\n")

    def scenario(name: str, detail):
        report["scenarios"].append({"id": name, "status": "passed", "detail": detail})
        print("PASS", name, flush=True)
        persist()

    def stage(name: str):
        report["stage"] = name
        print("STAGE", name, flush=True)
        persist()

    def snapshot(name: str):
        path = run / (name + ".png")
        page.screenshot(path=str(path), full_page=True, animations="disabled")
        report["screenshots"].append(str(path))

    def api(method: str, suffix: str, **kwargs):
        response = getattr(context.request, method)(base + suffix, headers=headers, timeout=90000, **kwargs)
        assert response.ok, f"{method} {suffix}: {response.status} {response.text()}"
        return response.json()

    try:
        mimir = args.mimir.resolve(strict=True)
        package = args.plugin_package.resolve(strict=True)
        files = [mimir, package / "plugin.wasm", package / "mimir-plugin.toml",
                 root / "studio/frontend/dist/index.html", Path(__file__)]
        files += sorted((root / "studio/frontend/dist/assets").glob("*"))
        report["artifacts"] = {str(path): {"bytes": path.stat().st_size, "sha256": sha256(path)}
                               for path in files if path.is_file()}
        report["studio_revision"] = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
        report["studio_diff_sha256"] = hashlib.sha256(subprocess.check_output(["git", "diff"], cwd=root)).hexdigest()
        if args.compilation_cache:
            cache = args.compilation_cache.resolve(strict=True)
            assert cache.is_dir() and cache.stat().st_uid == os.geteuid(), "Cache must be task-owned"
            (native / "cache").mkdir()
            (native / "cache/wasmtime").symlink_to(cache, target_is_directory=True)
            report["compilation_cache"] = str(cache)
        skill = project / ".agents/skills" / SKILL / "SKILL.md"
        skill.parent.mkdir(parents=True)
        skill.write_text(f"---\nname: {SKILL}\ndescription: Refresh image acceptance skill\n---\n{SKILL_MARKER}\nRead supplied image context. Use native tools for requested file changes.\n")
        (native / "trust.json").write_text(json.dumps({str(project): True}) + "\n")
        provider = ProviderFixture()
        provider.configure(native, images=True)
        catalog_path = native / "models.json"
        catalog = json.loads(catalog_path.read_text())
        models = catalog["providers"]["coding-acceptance"]["models"]
        models["alternate"] = {**models["offline"], "name": "Refresh alternate model", "apiModel": "refresh-alternate"}
        catalog_path.write_text(json.dumps(catalog) + "\n")
        image = args.image or run / "refresh-large.png"
        if args.image is None:
            image.write_bytes(large_png())
        png = image.read_bytes()
        assert 512 * 1024 < len(png) <= 10 * 1024 * 1024 and png.startswith(b"\x89PNG\r\n\x1a\n")
        report["image"] = {"source": str(image), "bytes": len(png), "sha256": hashlib.sha256(png).hexdigest()}
        password = secrets.token_urlsafe(24)
        env = dict(os.environ, HOME=str(run), UNSLOTH_STUDIO_HOME=str(run / "studio-home"),
                   MIMIR_CODING_AGENT_DIR=str(native), UNSLOTH_MIMIR_EXECUTABLE=str(mimir),
                   UNSLOTH_MIMIR_PLUGIN_PACKAGE=str(package), CODING_ACCEPTANCE_PASSWORD=password,
                   CUDA_VISIBLE_DEVICES="", UNSLOTH_MIMIR_LOCAL_SERVING="0", MIMIR_DISABLE_MODELS_FETCH="1",
                   MIMIR_MODELS_PATH=str(native / "catalog.json"), PYTHONPATH=str(root / "studio/backend"))
        for key in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "MIMIR_SKILLS_DIR"):
            env.pop(key, None)
        stage("install-product-plugin")
        with (run / "plugin-install.log").open("w") as install_log:
            subprocess.run([str(mimir), "plugin", "install", str(package)], env=env, cwd=project,
                           stdout=install_log, stderr=subprocess.STDOUT, check=True, timeout=args.install_timeout)
        scenario("installed-product-plugin", {"native_sha256": report["artifacts"][str(mimir)]["sha256"],
                                               "wasm_sha256": report["artifacts"][str(package / "plugin.wasm")]["sha256"]})
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        base = f"http://127.0.0.1:{port}"
        report["base_url"] = base
        output = (run / "server.log").open("w")
        server = subprocess.Popen([sys.executable, "-m", "uvicorn", "tests.coding_acceptance_app:create_app", "--factory",
                                   "--host", "127.0.0.1", "--port", str(port)],
                                  cwd=root / "studio/backend", env=env, stdout=output, stderr=subprocess.STDOUT)
        report["server_pid"] = server.pid
        stage("backend-startup")
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            assert server.poll() is None, "Acceptance backend exited; inspect server.log"
            try:
                urllib.request.urlopen(base + "/api/auth/status", timeout=1).close()
                break
            except (urllib.error.URLError, TimeoutError):
                time.sleep(0.2)
        else:
            raise AssertionError("Backend startup exceeded 120 seconds")

        import psutil
        from playwright.sync_api import sync_playwright, expect
        expect.set_options(timeout=60000)
        with sync_playwright() as playwright:
            try:
                browser = playwright.chromium.launch(executable_path=args.chrome, headless=True, args=["--disable-gpu"])
                context = browser.new_context(viewport={"width": 1440, "height": 1000}, reduced_motion="reduce")
                report["browser"] = {"version": browser.version, "hardware_acceleration": False}
                page = context.new_page()
                page.set_default_timeout(60000)
                page.on("pageerror", lambda error: report["page_errors"].append(str(error)))
                page.on("console", lambda message: report["console_errors"].append(message.text) if message.type == "error" else None)
                page.on("request", lambda request: report["browser_requests"].append({"method": request.method, "path": urlparse(request.url).path}))
                page.on("response", lambda response: report["http_errors"].append({"status": response.status, "path": urlparse(response.url).path}) if response.status >= 400 else None)
                stage("authentication")
                unauthenticated = context.request.get(base + "/api/coding/conversations")
                assert unauthenticated.status in (401, 403)
                page.goto(base + "/coding")
                expect(page).to_have_url(base + "/login")
                login = context.request.post(base + "/api/auth/login", data={"username": "unsloth", "password": password})
                assert login.ok
                tokens = login.json()
                page.evaluate("tokens => { localStorage.setItem('unsloth_auth_token', tokens.access_token); localStorage.setItem('unsloth_auth_refresh_token', tokens.refresh_token); localStorage.setItem('unsloth_auth_session_mark', 'refresh-acceptance'); }", tokens)
                headers["Authorization"] = "Bearer " + tokens["access_token"]
                page.goto(base + "/coding")
                expect(page.get_by_test_id("coding-project-chooser")).to_be_visible()
                scenario("real-auth", "Unauthenticated API rejected and route redirected; production password login accepted")
                stage("project-open")
                page.get_by_role("button", name="Choose project folder", exact=True).click()
                expect(page.get_by_test_id("coding-browsed-path")).to_be_visible()
                page.get_by_label("Host folder path", exact=True).fill(str(project))
                page.get_by_role("button", name="Browse", exact=True).click()
                expect(page.get_by_test_id("coding-browsed-path")).to_have_text(str(project))
                with page.expect_response(lambda response: response.url == base + "/api/coding/conversations" and response.request.method == "POST") as opened:
                    page.get_by_role("button", name="Open project", exact=True).click()
                assert opened.value.status == 201, opened.value.text()
                conversation = opened.value.json()["id"]
                report["conversation_id"] = conversation
                headers["X-Mimir-Runtime-Generation"] = str(api("get", "/api/coding/runtime")["generation"])
                expect(page.get_by_test_id("coding-opened-conversation")).to_be_visible()
                expect(page.get_by_role("radio", name="Build", exact=True)).to_be_enabled()
                page.get_by_test_id("coding-session-details").click()
                expect(page.get_by_test_id("coding-conversation-id")).to_have_text(conversation)
                snapshot("desktop-session")
                page.keyboard.press("Escape")
                product = [child for child in psutil.Process(server.pid).children()
                           if child.cmdline()[1:] == ["plugin", "run", "studio.frontend"]]
                assert len(product) == 1
                report["native_process"] = {"pid": product[0].pid, "create_time": product[0].create_time(), "executable": product[0].exe()}
                scenario("project-open", {"conversation_id": conversation, "cwd": str(project)})
                prefix = f"/api/coding/conversations/{conversation}"
                prompt = page.get_by_label("Coding prompt", exact=True)
                transcript = page.get_by_test_id("coding-transcript")
                stage("definitive-mode-clicks")
                prompt.fill("Editable draft é 😀")
                before = network_counts(report["browser_requests"], conversation)
                for mode in ("Plan", "Build", "Plan", "Build"):
                    with page.expect_response(lambda response: response.url == base + prefix + "/mode" and response.request.method == "POST") as changed:
                        page.get_by_role("radio", name=mode, exact=True).click()
                    assert changed.value.ok, changed.value.text()
                    expect(page.get_by_role("radio", name=mode, exact=True)).to_be_checked()
                    expect(prompt).to_be_editable()
                    expect(prompt).to_have_value("Editable draft é 😀")
                page.wait_for_timeout(5500)
                after = network_counts(report["browser_requests"], conversation)
                assert after == before, f"Definitive mode clicks reloaded browser streams/history: {before} -> {after}"
                scenario("mode-no-reconnect", {"before": before, "after": after, "clicks": 4, "draft_retained": True, "fallback_observation_ms": 5500, "timing_claim": False})

                stage("real-mention-catalogs")
                skills = api("get", prefix + "/skills")["skills"]
                agents = api("get", prefix + "/subagents")["subagents"]
                assert any(skill["qualified_name"] == SKILL for skill in skills)
                assert any(agent["name"] == "explore" for agent in agents), agents
                report["catalogs"] = {"skills": skills, "subagents": agents}
                prompt.fill("é 😀 @")
                menu = page.get_by_test_id("coding-mention-list")
                expect(menu.get_by_role("group", name="Skills", exact=True)).to_be_visible()
                expect(menu.get_by_role("group", name="Subagents", exact=True)).to_be_visible()
                snapshot("desktop-mentions")
                prompt.fill("é 😀 @refresh")
                expect(menu.locator('[data-mention-name="refresh-visual"]')).to_be_visible()
                prompt.press("Enter")
                expect(prompt).to_have_value(f"é 😀 @{SKILL} ")
                prompt.press("End")
                prompt.type("@explore")
                expect(menu.locator('[data-mention-name="explore"]')).to_be_visible()
                prompt.press("Enter")
                expected_text = f"é 😀 @{SKILL} @explore Inspect the image, then write and read refresh-result.txt."
                prompt.press("End")
                prompt.type("Inspect the image, then write and read refresh-result.txt.")
                expect(prompt).to_have_value(expected_text)
                expect(page.get_by_label("Selected mentions", exact=True)).to_contain_text("@explore")
                provider.assert_no_request()
                scenario("real-mention-menu", {"groups": ["Skills", "Subagents"], "selected": [SKILL, "explore"], "utf8_prefix": "é 😀 "})

                stage("large-image-native-admission")
                page.get_by_label("Coding image files", exact=True).set_input_files({"name": "refresh-large.png", "mimeType": "image/png", "buffer": png})
                expect(page.get_by_role("button", name="Inspect refresh-large.png", exact=True)).to_be_visible()
                expect(prompt).to_be_editable()
                snapshot("desktop-ready")
                with page.expect_response(lambda response: response.url == base + prefix + "/prompts" and response.request.method == "POST") as admitted:
                    page.get_by_role("button", name="Send", exact=True).click()
                assert admitted.value.status == 202, admitted.value.text()
                ack = admitted.value.json()
                body = admitted.value.request.post_data_json
                mentions = validate_mentions(body, project)
                assert base64.b64decode(body["images"][0]["data"]) == png
                report["requests"].append({**ack, "submission_key": body["submission_key"], **mentions, "image_count": len(body["images"])})
                request = provider.request()
                native_context = json.dumps(request.body)
                assert SKILL_MARKER in native_context, "Native prompt did not load the selected skill body"
                assert "<subagent_mentions>" in native_context and "<name>explore</name>" in native_context, "Native prompt omitted selected subagent guidance"
                parts = [part for message in request.body.get("messages", []) if isinstance(message.get("content"), list) for part in message["content"]]
                images = [part["image_url"]["url"] for part in parts if part.get("type") == "image_url"]
                assert len(images) == 1 and base64.b64decode(images[0].split(",", 1)[1]) == png
                expect(page.get_by_test_id("coding-run-status")).to_have_text("Running")
                prompt.fill("Editable next draft while native request runs")
                expect(prompt).to_be_editable()
                expect(prompt).to_have_value("Editable next draft while native request runs")
                prompt.fill("")
                scenario("large-image-native-admission", {"request_id": ack["request_id"], "bytes": len(png), "provider_image_bytes_equal": True, "skill_body_loaded": True, "native_subagent_guidance_loaded": True, "mentions": mentions})

                stage("native-tool-activity")
                request.tool("refresh-write", "write_file", {"path": "refresh-result.txt", "content": RESULT})
                request = provider.request()
                write_output = request.tool_result("refresh-write")
                assert "refresh-result.txt" in write_output
                assert (project / "refresh-result.txt").read_text() == RESULT
                request.tool("refresh-read", "read_file", {"paths": ["refresh-result.txt"]})
                request = provider.request()
                read_output = request.tool_result("refresh-read")
                assert RESULT.strip() in read_output
                request.text(FINAL)
                expect(page.get_by_test_id("coding-run-status")).to_have_text("Completed")
                expect(transcript).to_contain_text(FINAL)
                expect(transcript).to_contain_text("1 image sent with this prompt")
                capture = native_capture(base, headers, conversation)
                native_state = capture["state"]
                report["terminal_state"] = native_state
                assert native_state.get("active_request") is None
                assert any(item["id"] == ack["request_id"] and item["status"] == "completed" for item in native_state["requests"]), native_state
                group = page.get_by_test_id("coding-activity-group")
                expect(group).to_have_count(1)
                toggle = group.locator(":scope > button")
                if toggle.get_attribute("aria-expanded") != "true":
                    toggle.click()
                for call, expected in (("refresh-write", "refresh-result.txt"), ("refresh-read", RESULT.strip())):
                    row = page.locator(f'[data-testid="coding-tool-row"][data-call-id="{call}"]')
                    expect(row).to_have_attribute("data-tool-status", "completed")
                    line = row.locator("button[aria-expanded][aria-controls]")
                    if line.get_attribute("aria-expanded") != "true":
                        line.click()
                    expect(row.get_by_label("Actual public tool output", exact=True)).to_contain_text(expected)
                snapshot("desktop-expanded-tools")
                scenario("native-tools-terminal-group", {"request_id": ack["request_id"], "group_summary": toggle.inner_text(), "write_output": write_output, "read_output": read_output, "file_sha256": sha256(project / "refresh-result.txt")})

                stage("model-picker")
                provider_count = len(provider.pending)
                page.get_by_test_id("coding-model-trigger").click()
                expect(page.get_by_test_id("coding-model-picker")).to_be_visible()
                page.get_by_role("button", name="Choose coding model", exact=True).click()
                expect(page.get_by_test_id("coding-model-picker")).to_contain_text("Deterministic protocol (not a live model)")
                snapshot("desktop-model-picker")
                model_geometry = page.locator("button[data-model]").evaluate_all("""rows => rows.map(row => {
                    const label = row.querySelector('span')?.firstElementChild;
                    if (!label) throw new Error('Native model choice has no rendered name');
                    const range = document.createRange(); range.selectNodeContents(label);
                    const text = range.getBoundingClientRect(), button = row.getBoundingClientRect();
                    return {model: row.dataset.model, label: label.textContent, textRight: text.right,
                        buttonRight: button.right, labelWidth: label.clientWidth, labelScrollWidth: label.scrollWidth,
                        whiteSpace: getComputedStyle(label).whiteSpace, overflow: getComputedStyle(label).overflow};
                })""")
                report["model_geometry"] = model_geometry
                for geometry in model_geometry:
                    if geometry["textRight"] > geometry["buttonRight"] + 1 and geometry["overflow"] == "visible":
                        report["visual_findings"].append({"id": "model-label-overlaps-favorite", "status": "failed", "detail": geometry, "screenshot": str(run / "desktop-model-picker.png")})
                with page.expect_response(lambda response: response.url == base + prefix + "/configuration" and response.request.method == "POST") as configured:
                    page.locator('button[data-provider="coding-acceptance"][data-model="alternate"]').click()
                assert configured.value.ok, configured.value.text()
                expect(page.get_by_role("button", name="Choose coding model", exact=True)).to_contain_text("Refresh alternate model")
                page.keyboard.press("Escape")
                selection = native_capture(base, headers, conversation)["state"]["configuration"]
                assert selection["provider"] == "coding-acceptance" and selection["model"] == "alternate"
                assert len(provider.pending) == provider_count
                scenario("native-model-picker", {"selection": selection, "provider_requests_before": provider_count, "provider_requests_after": len(provider.pending)})

                stage("saved-reopen")
                history_before = api("post", prefix + "/entries", data={"cut": capture["root"]["cut"], "anchor": "latest", "max_entries": 128, "max_bytes": 262144})
                (run / "history-before.json").write_text(json.dumps(history_before, indent=2) + "\n")
                page.get_by_test_id("coding-session-details").click()
                with page.expect_response(lambda response: response.url == base + prefix + "/open" and response.request.method == "POST") as reopened:
                    page.get_by_test_id("coding-reopen-saved").click()
                assert reopened.value.ok, reopened.value.text()
                page.keyboard.press("Escape")
                expect(page.get_by_test_id("coding-reopened")).to_be_visible()
                expect(transcript).to_contain_text(expected_text)
                expect(transcript).to_contain_text("1 image sent with this prompt")
                expect(transcript).to_contain_text(FINAL)
                reopened_capture = native_capture(base, headers, conversation)
                history_after = api("post", prefix + "/entries", data={"cut": reopened_capture["root"]["cut"], "anchor": "latest", "max_entries": 128, "max_bytes": 262144})
                (run / "history-after.json").write_text(json.dumps(history_after, indent=2) + "\n")
                users = [row for row in history_after["rows"] if row["kind"] == "user"]
                assert len(users) == 1 and users[0]["image_count"] == 1
                assert users[0]["text"] == expected_text + "\n[Image: image/png]"
                assert not any("base64" in json.dumps(row) or SKILL_MARKER in json.dumps(row) for row in history_after["rows"])
                assert history_before["rows"] == history_after["rows"], "Reopen changed the persisted public rows"
                provider.assert_no_request()
                assert len(provider.pending) == provider_count
                scenario("saved-reopen-continuity", {"conversation_id": conversation, "image_count": 1, "mention_tokens": ["@" + SKILL, "@explore"], "no_provider_replay": True})

                stage("responsive-screenshots")
                geometry = []
                for size, viewport in (("desktop", {"width": 1440, "height": 1000}), ("narrow", {"width": 390, "height": 844})):
                    page.set_viewport_size(viewport)
                    for theme in ("light", "dark"):
                        page.evaluate("theme => { document.documentElement.classList.toggle('dark', theme === 'dark'); document.documentElement.style.colorScheme = theme; }", theme)
                        prompt.fill("é 😀 @")
                        expect(menu).to_be_visible()
                        snapshot(f"{size}-{theme}-mentions")
                        prompt.press("Escape")
                        prompt.fill("")
                        snapshot(f"{size}-{theme}-reopened")
                        dimensions = page.evaluate("""() => ({width: innerWidth, scrollWidth: document.documentElement.scrollWidth, height: innerHeight,
                            composer: (() => { const r = document.querySelector('[aria-label="Coding composer"]').getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom}; })()})""")
                        assert dimensions["scrollWidth"] <= dimensions["width"], dimensions
                        assert dimensions["composer"]["bottom"] <= dimensions["height"] + 1, dimensions
                        geometry.append({"size": size, "theme": theme, **dimensions})
                report["geometry"] = geometry
                scenario("desktop-narrow-light-dark", geometry)
                assert not report["page_errors"], report["page_errors"]
                unavailable_apis = {"/api/health", "/api/engines", "/api/hub/active-downloads", "/api/hub/datasets/active-downloads", "/api/llama/update-status", "/api/studio/update-status"}
                unexpected_http = [item for item in report["http_errors"] if item["status"] != 404 or item["path"] not in unavailable_apis]
                assert not unexpected_http, unexpected_http
                unexpected_console = [message for message in report["console_errors"] if message != "Failed to load resource: the server responded with a status of 404 (Not Found)"]
                assert not unexpected_console, unexpected_console
                scenario("browser-errors", {"page_errors": report["page_errors"], "console_errors": report["console_errors"], "http_errors": report["http_errors"], "unexpected_console_errors": unexpected_console, "note": "Only 404s from the explicitly listed unmounted APIs are allowed; all errors are retained."})
                report["status"] = "failed" if report["visual_findings"] else "passed"
            except BaseException:
                if headers and report.get("conversation_id"):
                    try:
                        report["failure_native_capture"] = native_capture(base, headers, report["conversation_id"])
                    except Exception as error:
                        report["failure_native_capture_error"] = str(error)
                if page is not None:
                    try:
                        snapshot("failure")
                        (run / "failure-body.txt").write_text(page.locator("body").inner_text())
                    except Exception:
                        pass
                raise
            finally:
                if context is not None and headers:
                    try:
                        cleanup = api("post", "/api/coding-acceptance/shutdown")
                        report["cleanup"]["native"] = cleanup
                        assert cleanup["state"] == "stopped" and cleanup["cleanup"]["confirmed"] is True
                        assert cleanup["cleanup"]["exit_code"] == 0 and cleanup["cleanup"]["forced"] is False
                    except Exception as error:
                        report["cleanup"]["native_error"] = str(error)
                        report["status"] = "failed"
                if browser is not None:
                    browser.close()
                    report["cleanup"]["browser_closed"] = True
    except BaseException as error:
        report.update(status="failed", error=str(error), traceback=traceback.format_exc())
        print(report["traceback"], file=sys.stderr, flush=True)
    finally:
        if server is not None:
            try:
                if server.poll() is None:
                    server.terminate()
                report["cleanup"]["server_exit"] = server.wait(timeout=90)
            except subprocess.TimeoutExpired:
                server.kill()
                report["cleanup"]["server_forced_exit"] = server.wait(timeout=30)
                report["status"] = "failed"
            for child in product:
                alive = child.is_running()
                report["cleanup"]["native_process_alive_after_server"] = alive
                if alive:
                    if child.create_time() == report["native_process"]["create_time"] and child.cmdline()[1:] == ["plugin", "run", "studio.frontend"]:
                        child.terminate()
                        child.wait(timeout=30)
                    report["status"] = "failed"
        if output is not None:
            output.close()
        if provider is not None:
            report["provider_requests"] = len(provider.pending)
            try:
                provider.close()
            except Exception as error:
                report["cleanup"]["provider_error"] = str(error)
                report["status"] = "failed"
            report["cleanup"]["provider_thread_alive"] = provider.thread.is_alive()
        persist()
        print("REPORT", run / "report.json", flush=True)
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
