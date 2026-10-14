# SPDX-License-Identifier: AGPL-3.0-only
"""Ticket-253 actual-browser reading assertions, with explicit evidence boundaries.

The first phase uses production auth/backend/plugin/native execution and a paced
external HTTP provider (NOT live-model success). The second phase intercepts only
history pages; every added row is labelled SYNTHETIC, never persisted, and never
represented as native execution. It supplies 1,664 chronological rows through
bounded pages, tests access in BOTH directions, then removes the interception.
"""
from __future__ import annotations

import copy
import json
import re

from coding_file_change_scenarios import synthetic_history_rows


VIEWPORTS = ((1440, 1000, "desktop"), (390, 844, "narrow"))
PAGE_ROWS = 64
HISTORY_ROWS = 26 * PAGE_ROWS
MAX_RENDERED_ROWS = 1000  # Production projection bound, not a performance claim.
POSITION_TOLERANCE = 3
FILE_PATH = "reading-repeated.txt"
ACTIVITY_PATTERN = re.compile(r"new activity|new messages?|unread", re.I)

# Drop one viewing connection only; native execution is never replaced/cancelled.
# The original SSE response is otherwise passed through byte-for-byte.
READING_VIEW_FAULT = r"""(() => {
  const nativeFetch = window.fetch.bind(window);
  window.codingReadingDropView = false;
  window.codingReadingDroppedViews = 0;
  window.codingReadingObservedMarkers = [];
  window.codingReadingObserverErrors = [];
  window.codingReadingObservedEvents = [];
  window.fetch = async (...args) => {
    const response = await nativeFetch(...args);
    const url = String(args[0] instanceof Request ? args[0].url : args[0]);
    if (!/\/api\/coding\/conversations\/[^/]+\/events$/.test(url) || !response.ok || !response.body) return response;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const observe = value => {
      try {
        buffer += decoder.decode(value, {stream:true});
        let boundary;
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (!data) continue;
          const envelope = JSON.parse(data);
          const event = envelope.event;
          window.codingReadingObservedEvents.push({type:event?.type, epoch:envelope.observation_epoch, position:envelope.position, state:event?.state, rows:(event?.rows ?? []).map(row => ({id:row.id, marker:(row.text ?? '').slice(-100)}))});
          if (window.codingReadingObservedEvents.length > 128) window.codingReadingObservedEvents.shift();
          for (const row of event?.rows ?? []) {
            for (const marker of (row.text ?? '').match(/READING_STREAM_(?:DESKTOP|NARROW)_[A-Z_0-9]+/g) ?? []) {
              if (!window.codingReadingObservedMarkers.includes(marker)) window.codingReadingObservedMarkers.push(marker);
            }
          }
        }
        if (buffer.length > 2 * 1024 * 1024 || window.codingReadingObservedMarkers.length > 256) throw new Error('Reading observation exceeded public frame/marker bound');
      } catch (error) { window.codingReadingObserverErrors.push(String(error)); }
    };
    return new Response(new ReadableStream({async start(controller) {
      let interrupted = false;
      const disconnect = () => {
        if (interrupted) return;
        interrupted = true;
        window.codingReadingDropView = false;
        window.codingReadingDroppedViews++;
        void reader.cancel();
        controller.error(new TypeError('SYNTHETIC acceptance-only browser SSE disconnect'));
      };
      window.codingReadingDisconnectView = disconnect;
      try {
        for (;;) {
          const {done, value} = await reader.read();
          if (interrupted) return;
          if (window.codingReadingDropView) { disconnect(); return; }
          if (done) { controller.close(); return; }
          observe(value);
          controller.enqueue(value);
        }
      } catch (error) { controller.error(error); }
      finally {
        if (window.codingReadingDisconnectView === disconnect) window.codingReadingDisconnectView = null;
      }
    }, cancel() { return reader.cancel(); }}), {status:response.status, headers:response.headers});
  };
})();"""


def history_id(index):
    return f"SYNTHETIC-reading-entry-{index:04d}"


def history_response_matches(response, entry_url, anchor):
    return (response.url == entry_url and response.request.method == "POST"
            and response.request.post_data_json["anchor"] == anchor)


def synthetic_rows():
    """1,664 fixture rows exceed retention; repeated edits keep separate identities."""
    rows = [{"id": history_id(index), "entry_id": history_id(index),
             "request_id": None, "kind": "assistant", "historical": True,
             "text": f"SYNTHETIC bounded reading history {index:04d} (not native execution)\n"
                     + "Earlier content remains accessible through history navigation.\n"}
            for index in range(HISTORY_ROWS)]
    start = HISTORY_ROWS - PAGE_ROWS
    large = synthetic_history_rows("unused")[-1]
    for offset, lines in ((5, 2), (6, 3), (7, 450)):
        index = start + offset
        row = copy.deepcopy(large)
        row.update(id=history_id(index), entry_id=history_id(index))
        tool = row["tool"]
        tool.update(invocation_id=f"SYNTHETIC-reading-invocation-{index}",
                    call_id=f"SYNTHETIC-reading-call-{index}",
                    title=f"SYNTHETIC repeated edit {offset} (not native execution)")
        file = tool["output_profile"]["files"][0]
        file.update(path="SYNTHETIC-repeated-reading.txt", additions=lines,
                    partial=lines == 450, truncated=lines == 450)
        file["hunks"][0]["lines"] = file["hunks"][0]["lines"][:lines]
        for line in file["hunks"][0]["lines"]:
            line["content"] = line["content"][:36]
        tool["output_profile"]["truncated"] = lines == 450
        rows[index] = row
    index = start + 8
    rows[index] = {"id": history_id(index), "entry_id": history_id(index),
                   "request_id": None, "kind": "tool", "historical": True,
                   "tool": {"invocation_id": f"SYNTHETIC-reading-invocation-{index}",
                            "call_id": f"SYNTHETIC-reading-call-{index}",
                            "request_id": None, "historical": True,
                            "name": "SYNTHETIC_RENDERED_OUTPUT_FIXTURE",
                            "title": "SYNTHETIC large tool output (not native execution)",
                            "status": "saved", "output": "".join(
                                f"SYNTHETIC_OUTPUT_{line:04d} supplied public fixture line\n"
                                for line in range(180)),
                            "clipped": True, "quiet": False, "row_group": None}}
    return rows


def synthetic_page(rows, native_latest, cut, anchor):
    """Independent pagination oracle; retain real cut and real latest tail."""
    start = HISTORY_ROWS - PAGE_ROWS
    end = HISTORY_ROWS
    latest = anchor == "latest"
    if not latest:
        assert isinstance(anchor, dict) and len(anchor) == 1, anchor
        direction, identifier = next(iter(anchor.items()))
        assert direction in ("before", "after")
        assert identifier.startswith("SYNTHETIC-reading-entry-"), identifier
        index = int(identifier.rsplit("-", 1)[1])
        assert 0 <= index < HISTORY_ROWS
        if direction == "before":
            end = index
            start = max(0, end - PAGE_ROWS)
        else:
            start = index + 1
            end = min(HISTORY_ROWS, start + PAGE_ROWS)
            latest = end == HISTORY_ROWS
    selected = copy.deepcopy(rows[start:end])
    if latest:
        selected.extend(copy.deepcopy(native_latest["rows"]))
    assert selected, "Synthetic history navigation made no progress"
    result = {"cut": copy.deepcopy(cut), "rows": selected,
              "older": start > 0, "newer": not latest,
              "first_id": selected[0]["entry_id"],
              "last_id": native_latest["last_id"] if latest else selected[-1]["entry_id"]}
    assert len(json.dumps(result).encode()) <= 128 * 1024, "Synthetic page exceeded the native page budget"
    return result


GEOMETRY = """element => {
  const rect = element.getBoundingClientRect();
  const active = document.activeElement;
  const first = element.querySelector('[data-native-entry]');
  const content = element.firstElementChild;
  const leadingHeight = first && content ? first.getBoundingClientRect().top-content.getBoundingClientRect().top : 0;
  return {leadingHeight, scrollTop:element.scrollTop, scrollHeight:element.scrollHeight,
    clientHeight:element.clientHeight, viewportTop:rect.top,
    bottomGap:element.scrollHeight-element.clientHeight-element.scrollTop,
    rows:Array.from(element.querySelectorAll('[data-native-entry]')).map(row => {
      const box = row.getBoundingClientRect();
      return {id:row.getAttribute('data-native-entry'), top:box.top-rect.top,
        bottom:box.bottom-rect.top, height:box.height};
    }), focus:{tag:active?.tagName, label:active?.getAttribute('aria-label'),
      testId:active?.getAttribute('data-testid'),
      entry:active?.closest('[data-native-entry]')?.getAttribute('data-native-entry'),
      inTranscript:element.contains(active), text:active?.textContent?.slice(0,100)}};
}"""


def run_reading_scenarios(page, context, base, provider, first, second_id,
                          report, scenario, snapshot):
    from playwright.sync_api import expect

    assert provider is not None, "Reading workload requires isolated deterministic provider"
    conversation = page.get_by_test_id("coding-conversation-id").inner_text()
    transcript = page.get_by_test_id("coding-transcript")
    status = page.get_by_test_id("coding-run-status")
    prompt_url = base + f"/api/coding/conversations/{conversation}/prompts"
    entry_url = base + f"/api/coding/conversations/{conversation}/entries"
    evidence = report.setdefault("reading", {
        "kind": "deterministic-http-provider-real-native-execution + separately labelled SYNTHETIC rendered history",
        "live_model_success": False, "requests": [], "positions": [],
        "synthetic_history": {"kind": "SYNTHETIC browser history interception; not native execution or persisted history",
                              "total_rows": HISTORY_ROWS, "page_rows": PAGE_ROWS,
                              "maximum_rendered_rows": MAX_RENDERED_ROWS, "requests": []}})

    def measure(label):
        value = transcript.evaluate(GEOMETRY)
        value.update(label=label, viewport=page.viewport_size)
        evidence["positions"].append(value)
        if "reconnect-after" in label:
            evidence.setdefault("reconstruction_event_traces", {})[label] = page.evaluate("window.codingReadingObservedEvents")
        assert value["clientHeight"] >= 192, "Transcript collapsed below its usable reading height"
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "Horizontal page overflow"
        return value

    def row(identifier):
        return transcript.locator("[data-native-entry=" + json.dumps(identifier) + "]")

    def place(target, offset=60):
        # The surrounding panel scrolls on short screens so controls and a real
        # reading region both remain accessible. Bring that region onscreen first.
        transcript.scroll_into_view_if_needed()
        # Controlled browser scrolling is the reading action, not a renderer stub.
        target.evaluate("(node, offset) => { const viewport=node.closest('[data-testid=\"coding-transcript\"]'); viewport.scrollTop += node.getBoundingClientRect().top-viewport.getBoundingClientRect().top-offset; }", offset)
        page.wait_for_timeout(100)

    def focus(target):
        target.evaluate("node => node.focus({preventScroll:true})")
        expect(target).to_be_focused()

    def anchor(before):
        candidates = [item for item in before["rows"] if item["bottom"] > 0 and item["top"] < before["clientHeight"]]
        assert candidates, "No visible chronological row to anchor"
        return candidates[0]

    def preserved(before, label, *, target=None, same_scroll=True):
        page.wait_for_timeout(150)  # Allow ResizeObserver/layout/assistant-ui effects to settle.
        after = measure(label)
        chosen = target or anchor(before)
        current = next((item for item in after["rows"] if item["id"] == chosen["id"]), None)
        assert current is not None, f"{label}: visible anchor disappeared: {chosen['id']}"
        assert abs(current["top"] - chosen["top"]) <= POSITION_TOLERANCE, (label, chosen, current)
        if same_scroll:
            # A truthful historical/loading notice above the unchanged rows can
            # add height. Its independently measured prefix must be compensated
            # exactly; unchanged scrollTop would move the reader's visual anchor.
            prefix_change = after["leadingHeight"] - before["leadingHeight"]
            assert abs(before["scrollTop"] + prefix_change - after["scrollTop"]) <= POSITION_TOLERANCE, (label, before["scrollTop"], after["scrollTop"], prefix_change)
        return after

    def latest_action():
        return page.get_by_role("button", name=re.compile(r"Jump to latest", re.I))

    def activity_text():
        indicator = page.get_by_test_id("coding-new-activity")
        return indicator.inner_text() if indicator.count() else ""

    def no_unread():
        expect(page.get_by_test_id("coding-new-activity")).to_have_count(0)

    def observed(marker):
        # A frozen bounded reading window may intentionally exclude new live
        # rows. Observe only our public test marker on the real native SSE, then
        # assert the rendered activity indication and reader position separately.
        page.wait_for_function("marker => window.codingReadingObservedMarkers.includes(marker)", arg=marker, timeout=60000)
        assert not page.evaluate("window.codingReadingObserverErrors")

    def jump(label):
        button = latest_action()
        expect(button).to_be_visible(timeout=60000)
        focus(button)
        before = measure(label + "-keyboard-focused")
        button.press("Enter")
        page.wait_for_function("() => { const v=document.querySelector('[data-testid=\"coding-transcript\"]'); return v && v.scrollHeight-v.clientHeight-v.scrollTop<=3; }", timeout=60000)
        after = measure(label + "-after")
        assert after["bottomGap"] <= POSITION_TOLERANCE
        assert after["focus"]["inTranscript"] or after["focus"]["label"] == "Coding prompt", "Jump removed focused action without a meaningful transcript/composer focus destination"
        no_unread()
        snapshot(page, label)
        return before, after

    def submit(text):
        composer = page.get_by_label("Coding prompt", exact=True)
        composer.fill(text)
        expect(page.get_by_role("button", name="Send", exact=True)).to_be_enabled(timeout=60000)
        with page.expect_response(lambda response: response.url == prompt_url and response.request.method == "POST", timeout=60000) as waiting:
            composer.press("Enter")
        assert waiting.value.status == 202
        ack = waiting.value.json()
        assert ack["conversation_id"] == conversation
        evidence["requests"].append(ack)
        return ack

    def reopen(identifier=conversation):
        saved = page.locator('[aria-label="Saved coding conversations"] button').filter(has_text=identifier)
        if page.viewport_size["width"] < 768 and not saved.is_visible():
            page.get_by_role("button", name="Toggle coding sidebar", exact=True).click()
        expect(saved).to_be_visible(timeout=60000)
        saved.click()
        expect(page.get_by_test_id("coding-conversation-id")).to_have_text(identifier, timeout=60000)
        expect(page.get_by_test_id("coding-event-status")).to_contain_text("Native event stream connected", timeout=60000)
        expect(transcript).to_have_attribute("aria-busy", "false", timeout=60000)
        if page.viewport_size["width"] < 768:
            # A connected view can arrive before the mobile sheet finishes its
            # closing animation. Do not click a departing saved-row instance on
            # the next reopen; await the actual sidebar's closed state instead.
            expect(page.locator('[data-sidebar="sidebar"][data-mobile="true"]')).to_be_hidden(timeout=60000)

    def toggle(details, label, *, large=False, tool=False):
        summary = details.locator(":scope > summary")
        place(summary)
        focus(summary)
        before = measure(label + "-before")
        summary.press("Enter")
        expect(details).to_have_attribute("open", "")
        expect(summary).to_be_focused()
        preserved(before, label + "-expanded")
        output = details.get_by_label("Actual public tool output", exact=True) if tool else details.locator("pre")
        expect(output).to_be_visible()
        assert output.evaluate("node => node.clientHeight <= 321"), "Output viewport is unbounded"
        if large:
            assert output.evaluate("node => node.scrollHeight > node.clientHeight"), "Large output is not scrollable"
            if tool:
                expect(details.locator("..")).to_contain_text("Output clipped to the presentation bound")
            else:
                expect(details).to_contain_text("Diff truncated to a presentation bound")
                assert len(output.text_content()) <= 16 * 1024
                assert len(output.text_content().splitlines()) <= 400
        focus(output)
        before_scroll = measure(label + "-output-focused")
        output.press("Control+End")
        page.wait_for_function("node => node.scrollHeight-node.clientHeight-node.scrollTop <= 3", arg=output.element_handle())
        assert output.evaluate("node => node.scrollHeight-node.clientHeight-node.scrollTop <= 3"), "Keyboard did not reach supported output end"
        preserved(before_scroll, label + "-inner-keyboard-scroll")
        expect(output).to_be_focused()
        if large and not tool:
            previous = details.get_by_role("button", name="Previous diff section", exact=True)
            following = details.get_by_role("button", name="Next diff section", exact=True)
            expect(previous).to_be_disabled()
            expect(following).to_be_enabled()
            assert previous.get_attribute("data-reading-control") != following.get_attribute("data-reading-control")
            first_section = output.text_content()
            sections = [first_section]
            while following.is_enabled() and len(sections) < 32:
                focus(following)
                before_section = measure(label + f"-next-section-{len(sections)}-before")
                following.press("Enter")
                expect(output).to_be_focused()
                expect(details.get_by_role("status")).to_contain_text(f"Reported diff section {len(sections) + 1} of")
                expect(details.get_by_role("status")).to_contain_text("Continued supplied content")
                preserved(before_section, label + f"-next-section-{len(sections)}-after")
                expect(output).to_be_focused()
                supplied = output.text_content()
                assert len(supplied.encode("utf-8")) <= 16 * 1024
                assert len(supplied.split("\n")) <= 400
                assert output.evaluate("node => node.clientHeight <= 321 && node.scrollTop === 0")
                sections.append(supplied)
            expect(following).to_be_disabled()
            expect(output).to_contain_text("SYNTHETIC_LARGE_449_")
            supplied_lines = re.findall(r"^\+SYNTHETIC_LARGE_(\d{3})_", "".join(sections), re.M)
            assert supplied_lines == [f"{index:03d}" for index in range(450)], "Sections duplicated or omitted supplied synthetic diff lines"
            snapshot(page, label + "-supported-tail")
            for index in range(len(sections) - 2, -1, -1):
                focus(previous)
                before_section = measure(label + f"-previous-section-{index}-before")
                previous.press("Enter")
                expect(output).to_be_focused()
                expect(output).to_have_text(sections[index], use_inner_text=False)
                assert output.text_content() == sections[index]
                preserved(before_section, label + f"-previous-section-{index}-after")
                expect(output).to_be_focused()
            expect(previous).to_be_disabled()
            assert output.text_content() == first_section
            evidence.setdefault("diff_sections", []).append({
                "label": label, "kind": "SYNTHETIC rendered 450-line supplied diff, not native execution",
                "sections": len(sections), "supplied_lines_accessible": 450,
                "keyboard_forward_backward": True, "tail": "SYNTHETIC_LARGE_449_"})
        snapshot(page, label + "-expanded")
        focus(summary)
        before_collapse = measure(label + "-collapse-before")
        summary.press("Enter")
        expect(details).not_to_have_attribute("open", "")
        expect(summary).to_be_focused()
        preserved(before_collapse, label + "-collapsed")

    # Native tool effects, repeated edit identity, and a long saved native answer.
    submit("READING_NATIVE_SETUP: use the real fixture-requested native tools in this disposable project only.")
    request = provider.request()
    operations = (("reading-write", "write_file", {"path": FILE_PATH, "content": "phase=one\n"}),
                  ("reading-edit-one", "edit_file", {"path": FILE_PATH, "old_string": "one", "new_string": "two"}),
                  ("reading-edit-two", "edit_file", {"path": FILE_PATH, "old_string": "two", "new_string": "three"}),
                  ("reading-shell", "shell", {"command": "printf READING_REAL_NATIVE_TOOL_OUTPUT", "timeout_seconds": 30, "yield_time_ms": 10000}))
    for call, name, arguments in operations:
        request.tool(call, name, arguments)
        request = provider.request()
        result = request.tool_result(call)
        assert FILE_PATH in result if name != "shell" else "READING_REAL_NATIVE_TOOL_OUTPUT" in result
    assert (first / FILE_PATH).read_text() == "phase=three\n"
    # Keep this 100-line native record within the plugin's 4KiB serialized entry
    # bound. Larger presentation records are explicitly clipped by the native
    # projection; the labelled synthetic phase exercises larger supplied content.
    seed = "READING_NATIVE_SAVED_LONG_ANSWER\n" + "".join(f"READING_NATIVE_LINE_{index:03d} saved\n" for index in range(100))
    request.text(seed)
    expect(status).to_have_text("Completed", timeout=60000)
    expect(transcript).to_contain_text("READING_NATIVE_LINE_099", timeout=60000)
    provider.assert_no_request()
    evidence["native_operations"] = [{"call_id": call, "name": name} for call, name, _ in operations]

    for width, height, size in VIEWPORTS:
        page.set_viewport_size({"width": width, "height": height})
        # Reopen is a deliberate navigation, not the reconstruction assertion.
        reopen(second_id)
        reopen()
        expect(transcript).to_contain_text("READING_NATIVE_LINE_099", timeout=60000)
        native_calls = [item.get_attribute("data-call-id") for item in page.get_by_test_id("coding-tool-row").all()]
        assert native_calls[:4] == [call for call, _, _ in operations], "Repeated native edits lost chronology on reopen"
        invocations = [item.get_attribute("data-invocation-id") for item in page.get_by_test_id("coding-tool-row").all()][:4]
        assert all(invocations) and len(set(invocations)) == 4
        evidence.setdefault("native_reopen_identities", {})[size] = [
            {"call_id": call, "invocation_id": invocation}
            for call, invocation in zip(native_calls[:4], invocations)]
        measure("reading-native-reopen-" + size)
        snapshot(page, "reading-native-reopen-" + size)
        seed_row = transcript.locator("[data-native-entry]").filter(has_text="READING_NATIVE_SAVED_LONG_ANSWER").first
        bounded = seed_row.get_by_label("Bounded native message content", exact=True)
        expect(seed_row).to_contain_text("Long message · scroll within the content")
        place(seed_row)
        focus(bounded)
        assert bounded.evaluate("node => node.clientHeight <= 385 && node.scrollHeight > node.clientHeight")
        before_content = measure("reading-native-long-content-" + size + "-before")
        bounded.press("Control+End")
        expect(bounded).to_have_js_property("scrollTop", bounded.evaluate("node => node.scrollHeight-node.clientHeight"))
        assert bounded.evaluate("node => node.scrollHeight-node.clientHeight-node.scrollTop <= 3")
        expect(bounded).to_be_focused()
        preserved(before_content, "reading-native-long-content-" + size + "-after")
        snapshot(page, "reading-native-long-content-" + size)
        for call, _, _ in operations[:3]:
            tool = page.locator('[data-testid="coding-tool-row"][data-call-id=' + json.dumps(call) + ']')
            expect(tool.locator("summary")).to_contain_text("Historical report")
            changed = tool.locator("..").get_by_test_id("coding-file-change-row")
            expect(changed).to_have_count(1)
            toggle(changed, f"reading-native-{size}-{call}")
        tool = page.locator('[data-testid="coding-tool-row"][data-call-id="reading-shell"]')
        toggle(tool, "reading-native-tool-" + size, tool=True)
        # This explicit action establishes bottom-following before submission.
        if latest_action().count():
            jump("reading-native-follow-" + size)
        else:
            transcript.evaluate("node => {node.scrollTop=node.scrollHeight; node.dispatchEvent(new Event('scroll'));}")
        ack = submit("READING_PACED_STREAM_" + size)
        stream = provider.request().begin_stream()
        try:
            prefix = "READING_STREAM_" + size.upper()
            for chunk in range(3):
                marker = f"{prefix}_BOTTOM_{chunk}"
                stream.text("\n" + marker + "\n" + "streaming at bottom\n" * 8)
                expect(transcript).to_contain_text(marker, timeout=60000)
                page.wait_for_timeout(150)
                current = measure(f"reading-{size}-bottom-chunk-{chunk}")
                assert current["bottomGap"] <= POSITION_TOLERANCE, "Streaming did not follow an already-bottom reader"
            stable = transcript.locator("[data-native-entry]").filter(has_text="READING_NATIVE_SAVED_LONG_ANSWER").first
            expect(stable).to_have_count(1)
            place(stable)
            expect(latest_action()).to_be_visible()
            no_unread()
            focus(transcript)
            reading = measure("reading-" + size + "-above-before")
            assert reading["bottomGap"] > 48
            for chunk in range(3):
                marker = f"{prefix}_AWAY_{chunk}"
                stream.text("\n" + marker + "\n" + "new activity below reader\n" * 8)
                observed(marker)
                expect(page.get_by_test_id("coding-new-activity")).to_have_text("New activity", timeout=60000)
                preserved(reading, f"reading-{size}-above-chunk-{chunk}")
                expect(transcript).to_be_focused()
                assert ACTIVITY_PATTERN.search(activity_text()), "New activity is not truthfully indicated next to accessible Jump action"
            snapshot(page, "reading-stream-away-" + size)
            jump("reading-stream-jump-" + size)
            stream.text("\n" + prefix + "_RESUMED\n" + prefix + "_RECONNECT_CAPTURE\n" + "following after keyboard jump\n" * 10)
            expect(transcript).to_contain_text(prefix + "_RESUMED", timeout=60000)
            page.wait_for_timeout(150)
            assert measure("reading-" + size + "-resumed")["bottomGap"] <= POSITION_TOLERANCE
            place(stable)
            no_unread()
            focus(transcript)
            before_drop = measure("reading-" + size + "-reconnect-before")
            dropped = page.evaluate("window.codingReadingDroppedViews")
            # Disconnect viewing without producing any new native activity.
            # Replayed already-seen positions must not invent an unread flag.
            # Genuinely unseen replayed activity is covered independently by the
            # position/observation-epoch regression, and is correctly indicated.
            import time
            delayed_reads = []
            def delayed_latest(route):
                nonlocal before_drop
                if route.request.post_data_json.get("anchor") != "latest":
                    route.continue_()
                    return
                response = route.fetch(timeout=60000)
                assert response.ok
                started = time.monotonic()
                time.sleep(0.3)
                # Browser layout continues during this explicit transport hold.
                # Inspect before fulfillment, not just after reconstruction ends.
                during = measure("reading-" + size + "-reconnect-delayed-history")
                chosen = anchor(before_drop)
                current = next((item for item in during["rows"] if item["id"] == chosen["id"]), None)
                delayed_reads.append({
                    "kind": "SYNTHETIC browser history-response timing fault; real native response unchanged",
                    "requested_delay_ms": 300, "actual_delay_ms": round((time.monotonic() - started) * 1000, 2),
                    "viewport": page.viewport_size, "anchor": "latest"})
                evidence.setdefault("delayed_reconstruction", []).append(delayed_reads[-1])
                assert current is not None, "Delayed reconstruction removed the mounted reading anchor"
                assert abs(current["top"] - chosen["top"]) <= POSITION_TOLERANCE
                assert abs(during["scrollTop"] - before_drop["scrollTop"]) <= POSITION_TOLERANCE
                expect(transcript).to_be_focused()
                expect(transcript).to_have_attribute("aria-busy", "true")
                # Retained busy content remains readable. A genuine keyboard
                # movement must replace the old anchor, unlike layout clamping.
                transcript.press("ArrowDown")
                page.wait_for_timeout(150)
                moved = measure("reading-" + size + "-reader-moved-during-reconstruction")
                assert moved["scrollTop"] - during["scrollTop"] >= 10, "Reader could not navigate retained busy history"
                evidence.setdefault("busy_reading_gestures", []).append({"viewport": page.viewport_size, "gesture": "ArrowDown", "before_scrollTop": during["scrollTop"], "after_scrollTop": moved["scrollTop"]})
                # Navigation keys also scroll the region when an inline summary
                # owns focus; only Space activation must be excluded there.
                summary = page.get_by_test_id("coding-tool-row").last.locator("summary")
                focus(summary)
                summary.press("ArrowDown")
                page.wait_for_timeout(300)
                control_moved = measure("reading-" + size + "-summary-navigation-during-reconstruction")
                assert control_moved["scrollTop"] - moved["scrollTop"] >= 10, "Summary navigation did not scroll retained history"
                expect(summary).to_be_focused()
                evidence["busy_reading_gestures"].append({"viewport": page.viewport_size, "gesture": "ArrowDown from tool summary", "before_scrollTop": moved["scrollTop"], "after_scrollTop": control_moved["scrollTop"]})
                focus(transcript)
                before_drop = control_moved
                route.fulfill(response=response)
            page.route(entry_url, delayed_latest)
            try:
                with page.expect_response(lambda response: response.url == entry_url and response.request.method == "POST", timeout=60000) as reconstructed:
                    with page.expect_request(lambda req: req.url.endswith(f"/{conversation}/events"), timeout=60000):
                        page.evaluate("window.codingReadingDisconnectView()")
                assert reconstructed.value.ok
                assert delayed_reads, "Delayed native history reconstruction was not exercised"
            finally:
                # Never delay the separate terminal checkpoint below.
                page.unroute(entry_url, delayed_latest)
            expect(page.get_by_test_id("coding-event-status")).to_contain_text("Native event stream connected", timeout=60000)
            expect(transcript).to_have_attribute("aria-busy", "false", timeout=60000)
            assert page.evaluate("window.codingReadingDroppedViews") == dropped + 1
            preserved(before_drop, "reading-" + size + "-reconnect-after")
            expect(transcript).to_be_focused()
            no_unread()
            expect(page.get_by_test_id("coding-request-id")).to_contain_text(ack["request_id"])
            provider.assert_no_request()
            before_finish = measure("reading-" + size + "-provisional-before")
            provisional_id = transcript.locator("[data-native-entry]").filter(has_text=prefix + "_RESUMED").get_attribute("data-native-entry")
            with page.expect_response(lambda response: response.url == entry_url and response.request.method == "POST", timeout=60000) as checkpoint:
                stream.finish()
            assert checkpoint.value.ok
            saved_page = checkpoint.value.json()
            durable = [item for item in saved_page["rows"] if prefix + "_RESUMED" in item.get("text", "")]
            assert len(durable) == 1 and durable[0].get("entry_id"), "No durable native assistant entry supplied at terminal checkpoint"
            expect(status).to_have_text("Completed", timeout=60000)
            expect(transcript).to_have_attribute("aria-busy", "false", timeout=60000)
            # The reader may still be viewing a frozen bounded snapshot. The
            # durable row need not replace it until the explicit latest action.
            preserved(before_finish, "reading-" + size + "-saved-after")
            expect(transcript).to_be_focused()
            # Completion is actual new native activity, unlike the preceding
            # capture/checkpoint. It must be indicated while the reader is away.
            expect(page.get_by_test_id("coding-new-activity")).to_have_text("New activity")
            evidence.setdefault("native_reconstruction", {})[size] = {
                "request_id": ack["request_id"], "provisional_row_id": provisional_id,
                "saved_row_id": durable[0]["id"], "saved_entry_id": durable[0]["entry_id"],
                "cut": saved_page["cut"], "browser_stream_faults": 1}
            snapshot(page, "reading-reconstructed-saved-" + size)
            jump("reading-reconstructed-explicit-latest-" + size)
            saved = row(durable[0]["id"])
            expect(saved).to_have_count(1, timeout=60000)
            assert prefix + "_RECONNECT_CAPTURE" in saved.inner_text()
            provider.assert_no_request()
        finally:
            stream.finish()
        scenario("A3-A10-reading-native-" + size,
                 f"{width}x{height}: native repeated tools/reopen; paced HTTP SSE bottom-follow, earlier-reading row geometry/scrollTop/focus, truthful activity, keyboard Jump/focus and resumed follow; one labelled browser SSE fault + real native provisional-to-saved reconstruction preserved the reader and did not fabricate unread activity. NOT live-model success.")

    _run_synthetic_history(page, base, entry_url, conversation, transcript, evidence,
                           reopen, measure, place, focus, preserved, latest_action,
                           activity_text, no_unread, jump, toggle, scenario, snapshot)
    evidence["status"] = "passed"


def _run_synthetic_history(page, base, entry_url, conversation, transcript, evidence,
                           reopen, measure, place, focus, preserved, latest_action,
                           activity_text, no_unread, jump, toggle, scenario, snapshot):
    from playwright.sync_api import expect

    rows = synthetic_rows()
    synthetic = evidence["synthetic_history"]
    template = {}
    pending_jump = False
    reconnect_probe = False
    def intercept(route):
        nonlocal pending_jump, reconnect_probe
        payload = route.request.post_data_json
        anchor = payload["anchor"]
        if anchor == "latest":
            if reconnect_probe:
                # The native capture is pending here. Reconnecting the same
                # conversation must not unmount the focused paging control.
                expect(transcript).to_have_attribute("aria-busy", "true")
                expect(earlier).to_be_focused()
                expect(transcript).to_contain_text("Historical reading window")
                reconnect_probe = False
            response = route.fetch(timeout=60000)
            assert response.ok
            body = response.json()
            assert body["cut"] == payload["cut"] and body["last_id"]
            template.clear()
            template.update(body)
            result = synthetic_page(rows, template, payload["cut"], anchor)
            route.fulfill(response=response, json=result)
        elif isinstance(anchor, dict) and next(iter(anchor.values())).startswith("SYNTHETIC-reading-entry-"):
            assert template, "Synthetic earlier/forward request preceded real capture"
            result = synthetic_page(rows, template, payload["cut"], anchor)
            if pending_jump:
                pending_jump = False
                expect(transcript).to_have_attribute("aria-busy", "true")
                jump("reading-SYNTHETIC-jump-during-pending-history")
                page.wait_for_timeout(300)
                synthetic.setdefault("pending_jump_probes", []).append({"kind": "SYNTHETIC delayed history response, explicit keyboard Jump before fulfillment", "viewport": page.viewport_size, "anchor": anchor})
            route.fulfill(status=200, content_type="application/json", json=result)
        else:
            route.continue_()
            return
        synthetic["requests"].append({"kind": "SYNTHETIC labelled history interception",
                                      "anchor": anchor, "cut": payload["cut"],
                                      "first_id": result["first_id"], "last_id": result["last_id"],
                                      "older": result["older"], "newer": result["newer"],
                                      "rows": len(result["rows"]), "bytes": len(json.dumps(result).encode())})

    def count_bound():
        count = transcript.locator("[data-native-entry]").count()
        assert 0 < count <= MAX_RENDERED_ROWS, f"Rendered {count} rows beyond the projection bound"
        return count

    def navigate(button, label, direction="before"):
        expect(button).to_be_enabled(timeout=60000)
        focus(button)
        before = measure(label + "-before")
        chosen = next((item for item in before["rows"] if item["bottom"] > 0 and item["top"] < before["clientHeight"]), None)
        assert chosen
        edge = before["rows"][0 if direction == "before" else -1]["id"]
        # A concurrent SSE reconnect also reads this URL with anchor="latest".
        # Await the page requested by this keyboard action, not that capture.
        anchor = {direction: edge}
        with page.expect_response(lambda response: history_response_matches(response, entry_url, anchor), timeout=60000) as waiting:
            button.press("Enter")
        assert waiting.value.ok
        supplied = waiting.value.json()["rows"]
        assert supplied
        expect(transcript.locator("[data-native-entry=" + json.dumps(supplied[0]["id"]) + "]")).to_have_count(1, timeout=60000)
        expect(transcript).to_have_attribute("aria-busy", "false", timeout=60000)
        # Prepending changes scrollTop but must retain visual per-row geometry.
        preserved(before, label + "-after", target=chosen, same_scroll=False)
        no_unread()
        synthetic.setdefault("rendered_counts", []).append(count_bound())
        active = transcript.evaluate("node => node.contains(document.activeElement)")
        assert active, "History action lost meaningful focus"

    page.route(entry_url, intercept)
    try:
        for width, height, size in VIEWPORTS:
            page.set_viewport_size({"width": width, "height": height})
            reopen()
            expect(transcript).to_contain_text("SYNTHETIC bounded reading history", timeout=60000)
            count_bound()
            start = HISTORY_ROWS - PAGE_ROWS
            for offset in (5, 6, 7):
                call = f"SYNTHETIC-reading-call-{start + offset}"
                tool = page.locator('[data-testid="coding-tool-row"][data-call-id=' + json.dumps(call) + ']')
                expect(tool.locator("summary")).to_contain_text("Historical report")
                changed = tool.locator("..").get_by_test_id("coding-file-change-row")
                expect(changed.locator("summary")).to_contain_text("Historical reported change")
                toggle(changed, f"reading-SYNTHETIC-{size}-repeat-{offset}", large=offset == 7)
            call = f"SYNTHETIC-reading-call-{start + 8}"
            tool = page.locator('[data-testid="coding-tool-row"][data-call-id=' + json.dumps(call) + ']')
            toggle(tool, "reading-SYNTHETIC-large-output-" + size, large=True, tool=True)
            ids = transcript.locator('[data-testid="coding-tool-row"][data-call-id^="SYNTHETIC-reading-call-"]').evaluate_all("nodes => nodes.map(node => node.getAttribute('data-invocation-id'))")
            assert len(ids) == 4 and len(set(ids)) == 4, "Repeated synthetic edits lost independent chronology"
            earlier = page.get_by_role("button", name="Load earlier history", exact=True)
            # Explicit latest intent must supersede the FIRST pending earlier
            # read, whose pre-request historical window is still null.
            place(transcript.locator("[data-native-entry]").first, 90)
            focus(earlier)
            pending_jump = True
            with page.expect_response(lambda response: response.url == entry_url and response.request.method == "POST", timeout=60000) as delayed:
                earlier.press("Enter")
            assert delayed.value.ok and not pending_jump
            expect(transcript).to_have_attribute("aria-busy", "false", timeout=60000)
            expect(transcript).not_to_contain_text("Historical reading window")
            expect(transcript.locator("[data-native-entry]").first).to_have_attribute("data-native-entry", history_id(start))
            assert measure("reading-SYNTHETIC-" + size + "-pending-jump-settled")["bottomGap"] <= POSITION_TOLERANCE
            no_unread()
            for index in range(25):
                first = transcript.locator("[data-native-entry]").first
                place(first, 90)
                if index == 1:
                    focus(earlier)
                    before_reconnect = measure(f"reading-SYNTHETIC-{size}-paging-reconnect-before")
                    reconnect_probe = True
                    with page.expect_response(lambda response: response.url == entry_url and response.request.post_data_json["anchor"] == "latest", timeout=60000):
                        page.evaluate("() => { if (!window.codingReadingDisconnectView) throw new Error('No live reading connection'); window.codingReadingDisconnectView(); }")
                    expect(transcript).to_have_attribute("aria-busy", "false", timeout=60000)
                    expect(earlier).to_be_focused()
                    assert not reconnect_probe, "Reconnect never reached the real capture boundary"
                    preserved(before_reconnect, f"reading-SYNTHETIC-{size}-paging-reconnect-after")
                    synthetic.setdefault("paging_reconnect", []).append({"viewport": page.viewport_size, "focused_control_retained": True, "reading_window_retained": True})
                navigate(earlier, f"reading-SYNTHETIC-{size}-older-{index:02d}")
                expected = history_id(max(0, start - (index + 1) * PAGE_ROWS))
                expect(transcript.locator("[data-native-entry]").first).to_have_attribute("data-native-entry", expected)
            expect(earlier).to_have_count(0)
            expect(transcript).to_contain_text("SYNTHETIC bounded reading history 0000")
            expect(transcript).to_contain_text(re.compile(r"newer.*(not shown|bounded|history)|bounded.*newer", re.I))
            snapshot(page, "reading-SYNTHETIC-oldest-" + size)
            # Forward access is REQUIRED, not optional even if Jump can skip pages.
            # More than 1,000 supplied rows forces newer-page eviction and thus
            # exercises the new HTTP {after: ...} navigation path, not only cache.
            newer = page.get_by_role("button", name="Load newer history", exact=True)
            forward_count = 0
            while newer.count() and forward_count < 26:
                last = transcript.locator("[data-native-entry]").last
                place(last, 90)
                navigate(newer, f"reading-SYNTHETIC-{size}-newer-{forward_count:02d}", "after")
                forward_count += 1
            assert forward_count > 0, "Newer bounded content has no supported navigation"
            assert not newer.count(), "Forward navigation did not reach latest within the finite fixture"
            expect(transcript).to_contain_text("READING_NATIVE_LINE_099", timeout=60000)
            synthetic.setdefault("forward_pages", {})[size] = forward_count
            # Force another earlier navigation and verify Jump restores latest.
            expect(earlier).to_be_enabled()
            place(transcript.locator("[data-native-entry]").first, 90)
            navigate(earlier, "reading-SYNTHETIC-" + size + "-before-latest")
            jump("reading-SYNTHETIC-jump-latest-" + size)
            expect(transcript).to_contain_text("READING_NATIVE_LINE_099")
            count_bound()
            reopen()
            expect(transcript).to_contain_text("SYNTHETIC bounded reading history 1663", timeout=60000)
            count_bound()
            measure("reading-SYNTHETIC-reopen-" + size)
            snapshot(page, "reading-SYNTHETIC-reopen-" + size)
            scenario("A3-A10-reading-SYNTHETIC-" + size,
                     f"{width}x{height}: explicitly SYNTHETIC 1,664 chronological rows in <=128KiB pages; keyboard repeated/large diffs and clipped bounded tool output, per-row anchor geometry/focus during older and newer navigation, finite oldest-to-latest access, <=1,000 rendered rows, latest action and reopen. NOT native long-history or live-model proof.")
        assert any(isinstance(item["anchor"], dict) and "after" in item["anchor"] for item in synthetic["requests"]), "No real browser forward-page request exercised"
    finally:
        page.unroute(entry_url, intercept)
        page.set_viewport_size({"width": 1440, "height": 1000})
    reopen()
    expect(transcript).not_to_contain_text("SYNTHETIC bounded reading history")
    expect(transcript).to_contain_text("READING_NATIVE_LINE_099", timeout=60000)
    scenario("A1-reading-SYNTHETIC-not-persisted", "Removed labelled history interception and reopened real native saved history; synthetic long-history/diff/tool fixtures did not persist.")
