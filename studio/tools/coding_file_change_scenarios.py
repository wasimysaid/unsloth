# SPDX-License-Identifier: AGPL-3.0-only
"""Ticket-238 rendered acceptance: real tools first, labelled synthetic history last.

The passive browser stream observer records only public tool activity. It neither
replaces provider replies nor alters a native event. The optional synthetic cases
intercept only bounded history responses *after* real execution/replay assertions.
"""
from __future__ import annotations

import copy
import hashlib
import json
import re

from coding_ui import expect_connected, open_saved, opened_id


FILE_PATH = "studio-file-changes.txt"
INITIAL = "FILE_CHANGE_HEADER\nphase=one\nFILE_CHANGE_FOOTER\n"
EDITED = INITIAL.replace("phase=one", "phase=two")
FINAL = EDITED.replace("FILE_CHANGE_FOOTER", "FILE_CHANGE_FOOTER_FINAL")
OUTSIDE = "OUTSIDE_NATIVE_CURRENT_STATE_NOT_REPORTED\n"
SHELL_MARKER = "FILE_CHANGES_REAL_SHELL_OUTPUT"
CALLS = ("file-change-write", "file-change-edit-one", "file-change-edit-two")
# Tool output and diff viewports are max-h-108 (27rem = 432px at the default UI scale).
OUTPUT_BOUND = 433

# Installed before navigation. Clone consumption is read-only; original fetch
# response/body remains untouched. Never retain request bodies, auth or model data.
LIVE_PROFILE_OBSERVER = r"""(() => {
  const nativeFetch = window.fetch.bind(window);
  window.codingFileChangeLiveRows = [];
  window.codingFileChangeModel = null;
  window.codingFileChangeObserverErrors = [];
  window.fetch = async (...args) => {
    const response = await nativeFetch(...args);
    const url = String(args[0] instanceof Request ? args[0].url : args[0]);
    if (!/\/api\/coding\/conversations\/[^/]+\/events$/.test(url) || !response.ok || !response.body) return response;
    const clone = response.clone();
    void (async () => {
      const reader = clone.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const {done, value} = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, {stream:true});
          let match;
          while ((match = /\r?\n\r?\n/.exec(buffer))) {
            const frame = buffer.slice(0, match.index);
            buffer = buffer.slice(match.index + match[0].length);
            const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (!data) continue;
            const event = JSON.parse(data).event;
            if (event?.state?.configuration) {
              const config = event.state.configuration;
              window.codingFileChangeModel = {provider:config.provider, model:config.model, reasoning:config.reasoning};
            }
            if (event?.type !== 'activity') continue;
            for (const row of event.rows ?? []) {
              const tool = row.tool;
              if (!tool || tool.status === 'running' || tool.output_profile?.kind !== 'file_change') continue;
              const rows = window.codingFileChangeLiveRows;
              const key = tool.invocation_id + '\0' + tool.call_id;
              if (rows.some(item => item.key === key)) continue;
              if (rows.length >= 32) throw new Error('Public tool observation count exceeded bound');
              rows.push({key, call_id:tool.call_id, invocation_id:tool.invocation_id,
                name:tool.name, output_profile:tool.output_profile});
            }
          }
          if (buffer.length > 2 * 1024 * 1024) throw new Error('Public event observation exceeded frame bound');
        }
      } catch (error) {
        // An intentional view detach is normal; parsing/bound failures are not.
        if (!(error instanceof TypeError || error.name === 'AbortError')) window.codingFileChangeObserverErrors.push(String(error));
      } finally { await reader.cancel().catch(() => {}); }
    })();
    return response;
  };
})();"""


def supplied_lines(file):
    """Independent diff-body oracle: only reported prefixes and content, no diffing."""
    prefixes = {"added": "+", "removed": "-", "context": " "}
    return [prefixes[line["kind"]] + line["content"].removesuffix("\n").removesuffix("\r")
            for hunk in file["hunks"] for line in hunk["lines"]]


def verify_transition(file, before, after):
    """Small complete native fixture must describe this operation, not a net patch."""
    assert file["path"] == FILE_PATH
    assert not file.get("binary") and not file.get("partial") and not file.get("truncated")
    assert not file.get("unavailable")
    lines = [line for hunk in file["hunks"] for line in hunk["lines"]]
    # Three-line fixture fits one native context hunk. Removed/context lines
    # reconstruct before; added/context lines reconstruct after exactly.
    old = [line["content"].removesuffix("\n").removesuffix("\r") for line in lines if line["kind"] != "added"]
    new = [line["content"].removesuffix("\n").removesuffix("\r") for line in lines if line["kind"] != "removed"]
    assert old == before.splitlines(), (old, before)
    assert new == after.splitlines(), (new, after)
    assert file["additions"] == sum(line["kind"] == "added" for line in lines)
    assert file["deletions"] == sum(line["kind"] == "removed" for line in lines)
    assert file["status"] == ("created" if not before else "updated")


def synthetic_history_rows(entry_id):
    """Acceptance-only rendered fixtures; never persisted or called native proof."""
    def file(path):
        return dict(path=path, status="updated", additions=None, deletions=None,
                    replacements=None, binary=False, partial=False, truncated=False,
                    unavailable=False, hunks=[])

    binary = file("SYNTHETIC-binary.dat")
    binary["binary"] = True
    partial = file("SYNTHETIC-partial.txt")
    partial.update(partial=True, hunks=[{"lines": [
        {"old_line": None, "new_line": 12, "kind": "added", "content": "SYNTHETIC_PARTIAL_REPORTED_LINE"}]}])
    unavailable = file("SYNTHETIC-unavailable.txt")
    unavailable["unavailable"] = True
    large = file("SYNTHETIC-large.txt")
    large.update(partial=True, truncated=True, additions=450, deletions=0,
                 hunks=[{"lines": [{"old_line": None, "new_line": n + 1, "kind": "added",
                     "content": f"SYNTHETIC_LARGE_{n:03d}_" + "x" * 80} for n in range(450)]}])
    rows = []
    for index, value in enumerate((binary, partial, unavailable, large)):
        rows.append({"id": f"synthetic-file-profile-{index}", "entry_id": entry_id,
            "request_id": None, "kind": "tool", "historical": True, "tool": {
                "invocation_id": f"synthetic-invocation-{index}", "call_id": f"synthetic-call-{index}",
                "request_id": None, "historical": True, "name": "SYNTHETIC_RENDERED_PROFILE_FIXTURE",
                "title": "SYNTHETIC rendered profile fixture (not native execution)",
                "status": "saved", "output": "SYNTHETIC acceptance-only bounded-history profile; not native execution.",
                "clipped": False, "quiet": False, "row_group": None,
                "output_profile": {"kind": "file_change", "files": [value], "truncated": index == 3}}})
    return rows


def inject_synthetic_history(body):
    """Preserve the real cut/pagination/rows; append explicitly synthetic profiles."""
    result = copy.deepcopy(body)
    assert isinstance(result["rows"], list) and result["last_id"]
    result["rows"].extend(synthetic_history_rows(result["last_id"]))
    assert len(json.dumps(result).encode()) <= 128 * 1024, "Synthetic history exceeded accepted page budget"
    return result


def tool_header(row):
    """A tool row's "<Verb> <argument>" disclosure button; output renders only when expanded."""
    return row.locator(":scope > div > button[aria-expanded]")


def expand_activity(scope):
    """Settled activity groups are folded and render no tool rows: open each by keyboard."""
    from playwright.sync_api import expect

    headers = scope.locator('[data-testid="coding-activity-group"] > button[aria-expanded]')
    for index in range(headers.count()):
        header = headers.nth(index)
        if header.get_attribute("aria-expanded") == "false":
            header.press("Enter")
            expect(header).to_have_attribute("aria-expanded", "true", timeout=60000)


def run_file_change_scenarios(page, context, base, provider, first, second_id,
                              report, scenario, snapshot, *, live=False):
    from playwright.sync_api import expect

    conversation = opened_id(page)
    status = page.get_by_test_id("coding-run-status")
    composer = page.get_by_label("Coding prompt", exact=True)
    prompt_url = base + f"/api/coding/conversations/{conversation}/prompts"
    evidence = report.setdefault("file_changes", {
        "kind": "live-host-provider-real-native-tools" if live else "deterministic-http-provider-real-native-tools",
        "requests": [], "operations": [], "synthetic_profiles": []})
    assert not (first / FILE_PATH).exists(), "Primary fixture must start as a nonexistent disposable file"
    assert provider is None if live else provider is not None

    def submit(text):
        composer.fill(text)
        expect(page.get_by_role("button", name="Send", exact=True)).to_be_enabled(timeout=60000)
        with page.expect_response(lambda response: response.url == prompt_url and response.request.method == "POST", timeout=60000) as waiting:
            composer.press("Enter")
        response = waiting.value
        assert response.status == 202
        ack = response.json()
        assert ack["conversation_id"] == conversation
        assert ack["submission_key"] == response.request.post_data_json["submission_key"]
        evidence["requests"].append(ack)
        return ack

    def tool_row(call):
        return page.locator('[data-testid="coding-tool-row"][data-call-id=' + json.dumps(call) + ']')

    def file_row(call, path=FILE_PATH):
        # The file diff renders inside this precise tool result once expanded.
        return tool_row(call).locator(
            '[data-testid="coding-file-change-row"][data-path=' + json.dumps(path) + ']')

    def keyboard_expand(row):
        header = tool_header(row)
        header.focus()
        expect(header).to_be_focused()
        assert header.get_attribute("aria-expanded") == "false", "Rows must initially be collapsed"
        header.press("Enter")
        expect(header).to_have_attribute("aria-expanded", "true")
        expect(header).to_be_focused()

    def keyboard_collapse(row):
        tool_header(row).press("Enter")
        expect(tool_header(row)).to_have_attribute("aria-expanded", "false")

    def inspect(call, file, *, reopen=False):
        expand_activity(page)
        row = tool_row(call)
        expect(row).to_have_count(1, timeout=60000)
        invocation = row.get_attribute("data-invocation-id")
        assert invocation and invocation not in ("null", "undefined", "not supplied")
        # Before expansion the row header already shows the supplied counts.
        expect(tool_header(row)).to_contain_text(f'+{file["additions"]} −{file["deletions"]}')
        keyboard_expand(row)
        changed = file_row(call, file["path"])
        expect(changed).to_have_count(1, timeout=60000)
        heading = changed.locator("p").first
        expect(heading).to_contain_text(file["path"])
        expect(heading).to_contain_text(f'+{file["additions"]}')
        expect(heading).to_contain_text(f'−{file["deletions"]}')
        diff = changed.get_by_label("Diff for " + file["path"], exact=True)
        expect(diff).to_be_visible()
        diff.focus()
        expect(diff).to_be_focused()
        # One block per diff line; the ---/+++ header repeats the path line above.
        text = diff.inner_text()
        lines = text.splitlines()
        actual_lines = [line for line in lines if not line.startswith("@@ ")]
        assert actual_lines == supplied_lines(file), "Rendered diff altered supplied native lines"
        assert lines and lines[0].startswith("@@ -"), "Rendered diff omitted its supplied hunk header"
        assert diff.evaluate("(element, bound) => element.clientHeight <= bound", OUTPUT_BOUND), "Diff viewport is not bounded"
        result = {"call_id": call, "invocation_id": invocation, "path": file["path"],
                  "diff": text, "diff_sha256": hashlib.sha256(text.encode()).hexdigest()}
        if not reopen:
            keyboard_collapse(row)
        return result

    def observed():
        return page.evaluate("window.codingFileChangeLiveRows")

    def wait_observed(call):
        page.wait_for_function("call => window.codingFileChangeLiveRows.some(row => row.call_id === call && row.output_profile.kind === 'file_change')", arg=call, timeout=60000)
        return next(row for row in observed() if row["call_id"] == call)

    def no_approval_or_overflow():
        expect(page.get_by_role("button", name=re.compile(r"^(Apply|Revert)(?:\b|$)", re.I))).to_have_count(0)
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "Document horizontally overflows"

    if live:
        submit(f"In this disposable project only, sequentially use native write_file to create {FILE_PATH} with exactly {json.dumps(INITIAL)}; then native edit_file replacing phase=one with phase=two; then a SECOND native edit_file replacing FILE_CHANGE_FOOTER with FILE_CHANGE_FOOTER_FINAL. Do not combine or parallelize edits and do not use shell to write files. Then native shell command printf {SHELL_MARKER} and native read_file to verify {FILE_PATH}. Do not read credentials or change any other files. Report completion briefly.")
        evidence["deadline_seconds"] = 180
        # Provider/model failure is not reported as success merely because a file exists.
        expect(status).to_have_text(re.compile(r"Completed|Failed|Interrupted|Stopped", re.I), timeout=180000)
        evidence["terminal_status"] = status.inner_text()
        assert status.inner_text() == "Completed", "Live host provider did not complete the requested workload"
        effects = [row for row in observed() if row["output_profile"].get("kind") == "file_change"]
        # Retain bounded, public identities even when the strict workload check fails.
        evidence["provider_model"] = page.evaluate("window.codingFileChangeModel")
        evidence["observed_effect_identities"] = [
            {key: row[key] for key in ("name", "call_id", "invocation_id")}
            for row in effects]
        assert [row["name"] for row in effects] == ["write_file", "edit_file", "edit_file"], "Live model must complete exactly the requested sequential native operations"
        calls = [row["call_id"] for row in effects]
        assert len(set(calls)) == 3 and len({row["invocation_id"] for row in effects}) == 3
        expand_activity(page)
        # Folded rows read "<Verb> <argument>": the shell row names its command,
        # the read row its file.
        shell_rows = page.get_by_test_id("coding-tool-row").filter(has_text=SHELL_MARKER)
        assert shell_rows.count() == 1
        shell_call = shell_rows.first.get_attribute("data-call-id")
        read = page.get_by_test_id("coding-tool-row").filter(has_text=re.compile(r"^Read")).filter(has_text=FILE_PATH)
        expect(read).to_have_count(1)
        keyboard_expand(read)
        expect(read.get_by_label("Tool output", exact=True)).to_contain_text("phase=two")
        expect(read.get_by_label("Tool output", exact=True)).to_contain_text("FILE_CHANGE_FOOTER_FINAL")
    else:
        submit("FILE_CHANGES_ACCEPTANCE: write one disposable file, edit it twice sequentially, then report a real shell output")
        request = provider.request()
        calls = list(CALLS)
        operations = (("write_file", {"path": FILE_PATH, "content": INITIAL}, INITIAL),
                      ("edit_file", {"path": FILE_PATH, "old_string": "phase=one", "new_string": "phase=two"}, EDITED),
                      ("edit_file", {"path": FILE_PATH, "old_string": "FILE_CHANGE_FOOTER", "new_string": "FILE_CHANGE_FOOTER_FINAL"}, FINAL))
        for index, (name, arguments, expected) in enumerate(operations):
            request.tool(calls[index], name, arguments)
            request = provider.request()
            assert FILE_PATH in request.tool_result(calls[index])
            assert (first / FILE_PATH).read_text() == expected, "Real native file effect differs from requested operation"
            live_row = wait_observed(calls[index])
            profile = live_row["output_profile"]
            assert len(profile["files"]) == 1 and not profile.get("truncated")
            verify_transition(profile["files"][0], ("", INITIAL, EDITED)[index], expected)
            rendered = inspect(calls[index], profile["files"][0])
            assert rendered["invocation_id"] == live_row["invocation_id"]
            evidence["operations"].append(dict(rendered, name=name,
                content_sha256=hashlib.sha256(expected.encode()).hexdigest(), source="actual native live activity"))
            expect(status).to_have_text("Running")
            changed = tool_row(calls[index])
            keyboard_expand(changed)
            file_row(calls[index]).get_by_label("Diff for " + FILE_PATH, exact=True).scroll_into_view_if_needed()
            no_approval_or_overflow()
            snapshot(page, f"file-changes-live-operation-{index + 1}")
            if index == 2:
                page.set_viewport_size({"width": 390, "height": 844})
                file_row(calls[index]).get_by_label("Diff for " + FILE_PATH, exact=True).scroll_into_view_if_needed()
                no_approval_or_overflow()
                snapshot(page, "file-changes-live-narrow")
                page.set_viewport_size({"width": 1440, "height": 1000})
            keyboard_collapse(changed)
        shell_call = "file-change-shell"
        request.tool(shell_call, "shell", {"command": "printf " + SHELL_MARKER, "timeout_seconds": 30, "yield_time_ms": 10000})
        request = provider.request()
        assert SHELL_MARKER in request.tool_result(shell_call)
        request.text("FILE_CHANGES_NATIVE_COMPLETED")
        expect(status).to_have_text("Completed", timeout=60000)
        provider.assert_no_request()

    assert (first / FILE_PATH).read_text() == FINAL
    evidence["model_identity"] = page.evaluate("window.codingFileChangeModel")
    assert evidence["model_identity"] and evidence["model_identity"]["provider"] and evidence["model_identity"]["model"]
    expect(page.get_by_role("button", name="Stop", exact=True)).to_have_count(0)
    original = []
    for index, call in enumerate(calls):
        live_row = wait_observed(call)
        file = live_row["output_profile"]["files"][0]
        verify_transition(file, ("", INITIAL, EDITED)[index], (INITIAL, EDITED, FINAL)[index])
        original.append(inspect(call, file))
        if live:
            evidence["operations"].append(dict(original[-1], name=live_row["name"], source="actual native live activity"))
    assert [row.get_attribute("data-call-id") for row in page.get_by_test_id("coding-tool-row").all()][:3] == calls, "Repeated native edits lost chronology"
    assert len({row["invocation_id"] for row in original}) == 3
    scenario("A3-real-repeated-edits", "Real write_file + two sequential edit_file effects and three independent supplied live profiles match each exact operation, path, counts, call and invocation identity")

    shell = tool_row(shell_call)
    expect(shell).to_have_count(1)
    keyboard_expand(shell)
    expect(shell.get_by_label("Tool output", exact=True)).to_contain_text(SHELL_MARKER)
    expect(shell.get_by_test_id("coding-file-changes")).to_have_count(0)
    expect(shell).not_to_contain_text(re.compile(r"no (?:files? )?chang(?:e|es|ed)", re.I))
    scenario("A3-no-profile-output", "Actual native shell output remains inspectable without fabricated diff or false no-change assertion")

    def reopen():
        open_saved(page, base, second_id, ready=False)
        open_saved(page, base, conversation, ready=False)
        expect_connected(page)

    # External mutation is deliberately after all real execution/content checks.
    (first / FILE_PATH).write_text(OUTSIDE)
    reopen()
    replay = []
    for call in calls:
        live_row = wait_observed(call)
        replay.append(inspect(call, live_row["output_profile"]["files"][0], reopen=True))
    assert replay == original, "Replay changed call/invocation/file identity or supplied unified diff"
    assert [row.get_attribute("data-call-id") for row in page.get_by_test_id("coding-tool-row").all()][:3] == calls, "Replay reordered repeated edits"
    keyboard_expand(tool_row(shell_call))
    expect(tool_row(shell_call).get_by_label("Tool output", exact=True)).to_contain_text(SHELL_MARKER)
    expect(tool_row(shell_call).get_by_test_id("coding-file-changes")).to_have_count(0)
    assert (first / FILE_PATH).read_text() == OUTSIDE
    expect(page.get_by_test_id("coding-transcript")).not_to_contain_text(OUTSIDE.strip())
    for width, height, name in ((1440, 1000, "desktop"), (390, 844, "narrow")):
        page.set_viewport_size({"width": width, "height": height})
        file_row(calls[-1]).get_by_label("Diff for " + FILE_PATH, exact=True).scroll_into_view_if_needed()
        no_approval_or_overflow()
        snapshot(page, "file-changes-historical-" + name)
    page.set_viewport_size({"width": 1440, "height": 1000})
    # Read an earlier record rather than letting expansion jump to the latest tool.
    earlier = tool_row(calls[0])
    summary = tool_header(earlier)
    summary.focus()
    summary.press("Enter")
    expect(summary).to_have_attribute("aria-expanded", "false")
    summary.scroll_into_view_if_needed()
    summary.focus()
    viewport = page.get_by_test_id("coding-transcript")
    before_expand = viewport.evaluate("element => element.scrollTop")
    summary.press("Enter")
    expect(file_row(calls[0]).get_by_label("Diff for " + FILE_PATH, exact=True)).to_be_visible()
    assert abs(viewport.evaluate("element => element.scrollTop") - before_expand) <= 2, "Expanding an earlier diff moved the reading position"
    expect(summary).to_be_focused()
    evidence["reading_position"] = {"before_expand": before_expand, "after_expand": viewport.evaluate("element => element.scrollTop")}
    scenario("A10-diff-reading-position", "Expanding an earlier historical diff preserved transcript scroll position and keyboard focus without jumping to latest")
    evidence["replay"] = replay
    evidence["outside_mutation_sha256"] = hashlib.sha256(OUTSIDE.encode()).hexdigest()
    scenario("A1-A3-historical-state", "Reopened same native conversation after external file mutation: unchanged separate chronological reported diffs and exact tool/file identities; the mutated current file content is not shown")
    scenario("A10-file-diff-keyboard-bounds", "Folded settled activity and initially collapsed tool rows, Enter expansion with retained header focus, focusable bounded diff; inspection only, no Apply/Revert, desktop/narrow screenshots and no document overflow")

    if not live:
        _synthetic_scenarios(page, base, conversation, reopen, tool_row, file_row,
                             keyboard_expand, no_approval_or_overflow, evidence, scenario, snapshot)
    assert not page.evaluate("window.codingFileChangeObserverErrors"), "Read-only public activity observation failed"
    evidence["status"] = "passed"


def _synthetic_scenarios(page, base, conversation, reopen, tool_row, file_row,
                         keyboard_expand, no_approval_or_overflow, evidence, scenario, snapshot):
    from playwright.sync_api import expect

    entry_url = base + f"/api/coding/conversations/{conversation}/entries"
    intercepted = []
    def synthetic(route):
        response = route.fetch(timeout=60000)
        assert response.ok
        body = response.json()
        if route.request.post_data_json.get("anchor") != "latest":
            route.fulfill(response=response)
            return
        injected = inject_synthetic_history(body)
        intercepted.append({"cut": body["cut"], "kind": "SYNTHETIC acceptance-only bounded-history browser interception", "added_rows": 4})
        route.fulfill(response=response, json=injected)

    page.route(entry_url, synthetic)
    try:
        reopen()
        expand_activity(page)
        for index, source in enumerate(synthetic_history_rows("unused")):
            tool = source["tool"]
            file = tool["output_profile"]["files"][0]
            call = tool["call_id"]
            row = file_row(call, file["path"])
            expect(tool_row(call)).to_contain_text("SYNTHETIC rendered profile fixture")
            keyboard_expand(tool_row(call))
            heading = row.locator("p").first
            expect(heading).to_contain_text(file["path"])
            # Supplied reporting limits are named exactly; unknown counts are omitted, never zero.
            notes = " · ".join(label for key, label in (("binary", "binary"), ("partial", "partial"),
                               ("truncated", "truncated"), ("unavailable", "diff unavailable")) if file[key])
            expect(heading.locator("span").filter(has_text=re.compile("^" + notes + "$"))).to_have_count(1)
            if file["additions"] is None:
                expect(heading).not_to_contain_text("+0")
                expect(heading).not_to_contain_text("−0")
                expect(tool_header(tool_row(call))).not_to_contain_text("+0")
            if file["binary"]:
                expect(row.locator("pre")).to_have_count(0)
            elif file["unavailable"]:
                expect(row.locator("pre")).to_have_count(0)
            else:
                diff = row.get_by_label("Diff for " + file["path"], exact=True)
                expect(diff).to_be_visible()
                diff.focus()
                expect(diff).to_be_focused()
                if file["truncated"]:
                    # One bounded section of the supplied report is mounted at a time.
                    text = diff.inner_text()
                    assert len(text.encode()) <= 16 * 1024
                    assert len(text.splitlines()) <= 400
                    expect(diff).not_to_contain_text("SYNTHETIC_LARGE_449_")
                    assert diff.evaluate("(element, bound) => element.clientHeight <= bound && element.scrollHeight > element.clientHeight", OUTPUT_BOUND)
                    diff.press("End")
                else:
                    expect(diff).to_contain_text("SYNTHETIC_PARTIAL_REPORTED_LINE")
                    expect(diff).to_contain_text("@@ -?,?")
            evidence["synthetic_profiles"].append({"kind": "SYNTHETIC rendered profile only, not native execution", "path": file["path"], "binary": file["binary"], "partial": file["partial"], "truncated": file["truncated"], "counts_available": file["additions"] is not None})
        for width, height, name in ((1440, 1000, "desktop"), (390, 844, "narrow")):
            page.set_viewport_size({"width": width, "height": height})
            no_approval_or_overflow()
            snapshot(page, "file-changes-SYNTHETIC-profiles-" + name)
        assert intercepted, "Synthetic bounded-history fixture was never rendered"
        evidence["synthetic_interceptions"] = intercepted
        scenario("A3-SYNTHETIC-edge-profiles", "Explicitly labelled acceptance-only bounded-history rendered fixtures: binary metadata/no text, unavailable counts/diff, partial unknown ranges, truncated large content <=16KiB/400 lines, keyboard focus and bounded scroll; NOT native execution evidence")
    finally:
        page.unroute(entry_url, synthetic)
        page.set_viewport_size({"width": 1440, "height": 1000})
    reopen()
    # Folded groups render no tool rows; open them so absence is meaningful.
    expand_activity(page)
    expect(page.get_by_test_id("coding-transcript")).not_to_contain_text("SYNTHETIC rendered profile fixture")
    expect(page.locator('[data-testid="coding-tool-row"][data-call-id^="synthetic-call-"]')).to_have_count(0)
    scenario("A1-SYNTHETIC-not-persisted", "Removed acceptance-only history interception and reopened real native history; synthetic profiles did not persist")
