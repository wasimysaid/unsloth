# SPDX-License-Identifier: AGPL-3.0-only
"""Ticket-237 rendered question acceptance through real auth/routes/plugin/native.

Only the external HTTP provider and explicit browser transport losses are fixtures.
Never fabricate native question IDs, acceptance, history, settlement or tool results.
Invoked by coding_browser_acceptance.py --workload questions after paired builds.
"""
from __future__ import annotations

import json
from urllib.parse import quote
import urllib.request

from coding_recovery_scenarios import VIEW_FAULT_SCRIPT, captured_state, wait_native_terminal


QUESTION_SET = [
    {"id": "change", "prompt": "Which change strategy should Mimir use?", "allow_multiple": False,
     "options": [{"label": "Focused patch", "description": "Change only the requested behavior."},
                 {"label": "Careful change", "description": "Preserve the existing flow and review edge cases."}]},
    {"id": "checks", "prompt": "Which verification should Mimir perform?", "allow_multiple": True,
     "options": [{"label": "Unit checks", "description": "Run focused contract tests."},
                 {"label": "Browser checks", "description": "Exercise the actual rendered coding route."}]},
    {"id": "notes", "prompt": "What additional instruction should Mimir retain?", "allow_multiple": False, "options": []},
]


def freeform_question(prompt):
    return [{"id": "notes", "prompt": prompt, "allow_multiple": False, "options": []}]


def answer_url(base, target):
    values = [quote(target[key], safe="") for key in ("conversation_id", "request_id", "user_request_id")]
    return base + f"/api/coding/conversations/{values[0]}/requests/{values[1]}/questions/{values[2]}/answers"


def accepted_answer_rows(rows, expected):
    """Audit exact public input identities and values, rejecting duplicates/stale input."""
    accepted = [row for row in rows if row.get("answer") is not None]
    assert len(accepted) == len(expected), f"Expected {len(expected)} accepted inputs, got {len(accepted)}"
    seen = set()
    for row in accepted:
        assert row["kind"] == "user" and row.get("entry_id"), "Accepted answers must be durable public user input"
        answer = row["answer"]
        key = (answer["request_id"], answer["user_request_id"])
        assert key not in seen, f"Native question answered twice: {key}"
        seen.add(key)
        assert key in expected, f"A stale/unexpected question was answered: {key}"
        # The native SDK retains its explicit none-of-above flag in public
        # accepted metadata. Studio's current controls never send that choice.
        assert answer["answers"] == [{**item, "none_of_above": False} for item in expected[key]]
    assert seen == set(expected)
    return accepted


def public_history(context, base, headers, conversation):
    """Read one immutable native cut, including older pages if necessary."""
    request = urllib.request.Request(base + f"/api/coding/conversations/{conversation}/events", headers=headers)
    with urllib.request.urlopen(request, timeout=60) as response:
        while True:
            line = response.readline()
            assert line, "Native view closed before atomic capture"
            if line.startswith(b"data: "):
                capture = json.loads(line[6:])["event"]
                assert capture["type"] == "start"
                cut = capture["root"]["cut"]
                break
    rows = []
    anchor = "latest"
    seen = set()
    while True:
        response = context.request.post(base + f"/api/coding/conversations/{conversation}/entries",
                                        headers=headers, data={"cut": cut, "anchor": anchor})
        assert response.ok, response.text()
        page = response.json()
        assert page["cut"] == cut
        rows = page["rows"] + rows
        if not page["older"]:
            return rows
        first = page["first_id"]
        assert first and first not in seen, "Captured-cut history paging failed to advance"
        seen.add(first)
        anchor = {"before": first}


def run_question_scenarios(page, context, base, provider, first, second_id, report, scenario, snapshot):
    from playwright.sync_api import expect

    assert provider is not None, "Question acceptance uses the clearly labeled deterministic HTTP provider"
    conversation = page.get_by_test_id("coding-conversation-id").inner_text()
    headers = {"Authorization": "Bearer " + page.evaluate("localStorage.getItem('unsloth_auth_token')")}
    headers["X-Mimir-Runtime-Generation"] = str(context.request.get(base + "/api/coding/runtime", headers=headers).json()["generation"])
    evidence = report.setdefault("questions", {
        "kind": "deterministic-provider-and-browser-transport-faults-real-native-questions",
        "requests": [], "answer_attempts": [], "rejections": [], "accepted_inputs": [],
    })
    expected = {}
    prompt_url = base + f"/api/coding/conversations/{conversation}/prompts"
    event_url = base + f"/api/coding/conversations/{conversation}/events"

    def count_answer(request):
        if request.method == "POST" and request.url.endswith("/answers") and "/api/coding/conversations/" in request.url:
            evidence["answer_attempts"].append({"url": request.url, "body": request.post_data_json})

    page.on("request", count_answer)

    def reopen():
        saved = page.locator('[aria-label="Saved coding conversations"] button').filter(has_text=conversation)
        expect(saved).to_be_visible(timeout=60000)
        saved.click()
        expect(page.get_by_test_id("coding-conversation-id")).to_have_text(conversation, timeout=60000)
        expect(page.get_by_test_id("coding-event-status")).to_contain_text("Native event stream connected", timeout=60000)

    # This existing shim discards actual SSE bytes and cancels only that view. It
    # does not change native state or manufacture a reset/accepted result.
    page.add_init_script(VIEW_FAULT_SCRIPT)
    # Retain bounded public view identities/types for diagnosing real delivery;
    # never record auth headers or provider/model-only bodies.
    page.add_init_script("""(() => {
      const original = window.fetch.bind(window);
      window.codingQuestionViewTrace = [];
      window.codingQuestionFocusTrace = [];
      for (const type of ['focusin', 'focusout']) document.addEventListener(type, event => {
        window.codingQuestionFocusTrace.push({type, tag: event.target.tagName,
          testid: event.target.getAttribute?.('data-testid'),
          question: event.target.closest?.('[data-question-id]')?.getAttribute('data-question-id'),
          answer: event.target.closest?.('[data-native-answer]')?.getAttribute('data-native-answer'),
          relatedTag: event.relatedTarget?.tagName});
        if (window.codingQuestionFocusTrace.length > 100) window.codingQuestionFocusTrace.shift();
      }, true);
      window.fetch = async (...args) => {
        const response = await original(...args);
        const url = String(args[0] instanceof Request ? args[0].url : args[0]);
        if (!url.endsWith('/events') || !url.includes('/api/coding/conversations/') || !response.ok || !response.body) return response;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = '';
        return new Response(new ReadableStream({ async start(controller) {
          try {
            for (;;) {
              const {done, value} = await reader.read();
              if (done) { controller.close(); return; }
              pending += decoder.decode(value, {stream: true});
              const lines = pending.split('\\n'); pending = lines.pop();
              for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                try {
                  const {subscription, position, event} = JSON.parse(line.slice(6));
                  window.codingQuestionViewTrace.push({subscription, position, type: event.type,
                    active_request: event.state?.active_request,
                    question: event.state?.user_request?.id,
                    leaf: event.cut?.leaf ?? event.root?.cut?.leaf,
                    rows: event.rows?.map(row => ({id: row.id, kind: row.kind, answer: Boolean(row.answer)}))});
                  if (window.codingQuestionViewTrace.length > 300) window.codingQuestionViewTrace.shift();
                } catch (_) { /* Normal frontend parser remains authoritative. */ }
              }
              controller.enqueue(value);
            }
          } catch (error) { controller.error(error); }
        }, cancel() { return reader.cancel(); } }), {status: response.status, headers: response.headers});
      };
    })();""")
    page.reload()
    reopen()

    def submit_prompt(marker):
        expect(page.get_by_label("Coding prompt", exact=True)).to_be_enabled(timeout=60000)
        page.get_by_label("Coding prompt", exact=True).fill(marker)
        with page.expect_response(lambda response: response.url == prompt_url and response.request.method == "POST", timeout=60000) as waiting:
            page.get_by_label("Coding prompt", exact=True).press("Enter")
        assert waiting.value.status == 202
        ack = waiting.value.json()
        assert ack["conversation_id"] == conversation
        evidence["requests"].append(dict(ack, text=marker))
        return ack

    def question_card(request_id, questions):
        card = page.get_by_test_id("coding-question-card").filter(has=page.get_by_text(questions[0]["prompt"], exact=True)).last
        expect(card).to_be_visible(timeout=60000)
        expect(card.get_by_test_id("coding-answer-status")).to_have_text("Waiting for your answer", timeout=60000)
        target = {"conversation_id": conversation, "request_id": card.get_attribute("data-request-id"),
                  "user_request_id": card.get_attribute("data-question-id"), "subscription": card.get_attribute("data-subscription")}
        assert target["request_id"] == request_id and target["user_request_id"] and target["subscription"]
        state = captured_state(base, headers, conversation)
        assert state["active_request"] == request_id and state["pending_user_request"] is True
        assert state["user_request"] == {"id": target["user_request_id"], "questions": questions}
        expect(page.get_by_label("Coding prompt", exact=True)).to_be_disabled()
        expect(card.get_by_role("heading", name="Mimir needs your input")).to_be_visible()
        return card, target

    def start_question(marker, tool_id, questions):
        ack = submit_prompt(marker)
        provider.request().ask_user(tool_id, questions)
        card, target = question_card(ack["request_id"], questions)
        return card, target

    def assert_waiting(target):
        state = captured_state(base, headers, conversation)
        assert state["active_request"] == target["request_id"]
        assert state["user_request"]["id"] == target["user_request_id"]
        assert state["pending_user_request"] is True
        provider.assert_no_request()

    def reject(target, answers, reason, *, live_target=None):
        response = context.request.post(answer_url(base, target), headers=headers,
                                        data={"subscription": target["subscription"], "answers": answers})
        assert response.status in (400, 404, 409), f"{reason}: stale/invalid action was not rejected: {response.status} {response.text()}"
        assert response.json().get("detail")
        evidence["rejections"].append({"reason": reason, "target": target, "answers": answers,
                                       "status": response.status, "detail": response.json()["detail"]})
        if live_target:
            assert_waiting(live_target)

    def remember(target, answers):
        key = (target["request_id"], target["user_request_id"])
        assert key not in expected, "Acceptance driver attempted to answer a question twice"
        expected[key] = answers

    def assert_ack(ack, target):
        assert ack == {**target, "accepted": True}, "Only the matching native acknowledgment proves acceptance"

    def send(card, target, answers):
        if not expected:
            def held_before_delivery(route):
                expect(card.get_by_test_id("coding-answer-status")).to_contain_text("Submitting", timeout=60000)
                expect(card.get_by_test_id("coding-submit-answer")).to_be_disabled()
                expect(card.locator("textarea").first).to_be_disabled()
                snapshot(page, "questions-desktop-submitting")
                page.set_viewport_size({"width": 390, "height": 844})
                card.get_by_test_id("coding-submit-answer").scroll_into_view_if_needed()
                snapshot(page, "questions-narrow-submitting")
                assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
                page.set_viewport_size({"width": 1440, "height": 1000})
                route.continue_()  # Deliver the original real command, no fabricated ACK.
            page.route(answer_url(base, target), held_before_delivery, times=1)
        with page.expect_response(lambda response: response.url == answer_url(base, target) and response.request.method == "POST", timeout=60000) as waiting:
            card.get_by_test_id("coding-submit-answer").press("Enter")
        assert waiting.value.status == 200, waiting.value.text()
        assert waiting.value.request.post_data_json == {"subscription": target["subscription"], "answers": answers}
        assert_ack(waiting.value.json(), target)
        remember(target, answers)
        # Earlier-reading/reconstructed windows intentionally do not merge new
        # history until the reader explicitly returns to the latest native cut.
        # Preserve the first answer's focus-handoff check below.
        latest = page.get_by_role("button", name="Jump to latest", exact=True)
        if len(expected) > 1 and latest.is_visible():
            latest.focus()
            latest.press("Enter")
        # Once native history contains this accepted input, the frontend replaces
        # the ephemeral controls with its durable accepted-answer transcript row.
        expect(page.get_by_test_id("coding-transcript").get_by_text("You · accepted answer", exact=True)).to_have_count(len(expected), timeout=60000)
        expect(card).to_have_count(0, timeout=60000)
        if len(expected) == 1:
            accepted = page.locator(f'[data-native-answer="{target["user_request_id"]}"]')
            expect(accepted).to_be_focused(timeout=60000)
            accepted.press("Tab")
            assert page.evaluate("document.activeElement !== document.body && document.activeElement.isConnected"), "Keyboard focus was lost after accepted controls disappeared"
            evidence["accepted_keyboard_focus"] = page.evaluate("({tag: document.activeElement.tagName, label: document.activeElement.getAttribute('aria-label')})")

    def type_freeform(card, questions, text):
        label = questions[0]["prompt"] + " — Your answer"
        textarea = card.get_by_label(label, exact=True)
        textarea.focus()
        expect(textarea).to_be_focused()
        page.keyboard.type(text)
        expect(textarea).to_have_value(text)
        return [{"question_id": "notes", "selected_options": [], "freeform_text": text}]

    def result_request(tool_id, answers):
        request = provider.request()
        result = request.tool_result(tool_id)
        for answer in answers:
            for label in answer["selected_options"]:
                assert label in result, f"Real native ask_user result omitted selected option {label}"
            if answer["freeform_text"]:
                assert answer["freeform_text"] in result
        return request

    def complete(request, marker):
        request.text(marker)
        expect(page.get_by_test_id("coding-run-status")).to_have_text("Completed", timeout=60000)
        expect(page.get_by_test_id("coding-transcript")).to_contain_text(marker, timeout=60000)
        expect(page.get_by_role("button", name="Stop", exact=True)).to_have_count(0)

    def audit():
        rows = public_history(context, base, headers, conversation)
        accepted = accepted_answer_rows(rows, expected)
        evidence["accepted_inputs"] = [{"id": row["id"], "entry_id": row["entry_id"], "answer": row["answer"]} for row in accepted]
        return accepted

    try:
        # Actual native question objects, separate expanded controls, and keyboard
        # input. The radio arrow changes choice; Space toggles independent checks.
        card, target = start_question("QUESTION_KEYBOARD_ACCEPTANCE", "question-keyboard", QUESTION_SET)
        heading = card.get_by_role("heading", name="Mimir needs your input")
        expect(heading).to_be_focused()
        heading.press("Tab")
        radio = card.locator('input[type="radio"]').first
        expect(radio).to_be_focused()
        radio.press("Space")
        expect(radio).to_be_checked()
        radio.press("ArrowDown")
        expect(card.locator('input[type="radio"]').nth(1)).to_be_checked()
        expect(radio).not_to_be_checked()
        for checkbox in (card.locator('input[type="checkbox"]').nth(0), card.locator('input[type="checkbox"]').nth(1)):
            checkbox.focus()
            checkbox.press("Space")
            expect(checkbox).to_be_checked()
        textarea = card.get_by_label(QUESTION_SET[2]["prompt"] + " — Your answer", exact=True)
        textarea.focus()
        page.keyboard.type("QUESTION_CUSTOM_ACCEPTED")
        expect(textarea).to_have_value("QUESTION_CUSTOM_ACCEPTED")
        answers = [{"question_id": "change", "selected_options": ["Careful change"], "freeform_text": None},
                   {"question_id": "checks", "selected_options": ["Unit checks", "Browser checks"], "freeform_text": None},
                   {"question_id": "notes", "selected_options": [], "freeform_text": "QUESTION_CUSTOM_ACCEPTED"}]
        snapshot(page, "questions-desktop-waiting")
        page.set_viewport_size({"width": 390, "height": 844})
        heading.scroll_into_view_if_needed()
        snapshot(page, "questions-narrow-waiting-heading")
        textarea.scroll_into_view_if_needed()
        snapshot(page, "questions-narrow-waiting-controls")
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
        assert card.evaluate("el => [...el.querySelectorAll('input,textarea,button')].every(control => { const box = control.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth; })")
        page.set_viewport_size({"width": 1440, "height": 1000})

        for field, value in (("conversation_id", second_id), ("request_id", "stale-request"),
                             ("user_request_id", "stale-user-request"), ("subscription", "stale-view")):
            reject({**target, field: value}, answers, "wrong-" + field, live_target=target)
        for reason, invalid in (
            ("unknown-question", [{**answers[0], "question_id": "wrong"}, *answers[1:]]),
            ("unknown-option", [{**answers[0], "selected_options": ["Never offered"]}, *answers[1:]]),
            ("single-question-multiple-options", [{**answers[0], "selected_options": ["Focused patch", "Careful change"]}, *answers[1:]]),
            ("missing-question", answers[:2]),
            ("duplicate-question", [answers[0], answers[0], answers[2]]),
            ("empty-answer", [*answers[:2], {**answers[2], "freeform_text": None}]),
        ):
            reject(target, invalid, reason, live_target=target)
        scenario("A2-exact-live-question-validation", "Wrong conversation/request/question/subscription and invalid answer controls were rejected by actual native admission, preserving the waiting question and producing no provider continuation")
        send(card, target, answers)
        complete(result_request("question-keyboard", answers), "QUESTION_KEYBOARD_COMPLETED")
        expect(page.get_by_test_id("coding-transcript").get_by_text("You · accepted answer", exact=True)).to_have_count(1)
        audit()
        accepted = page.locator(f'[data-native-answer="{target["user_request_id"]}"]')
        accepted.scroll_into_view_if_needed()
        snapshot(page, "questions-desktop-accepted")
        page.set_viewport_size({"width": 390, "height": 844})
        accepted.scroll_into_view_if_needed()
        snapshot(page, "questions-narrow-accepted")
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
        page.set_viewport_size({"width": 1440, "height": 1000})
        reopen()
        expect(page.get_by_test_id("coding-transcript")).to_contain_text("QUESTION_CUSTOM_ACCEPTED", timeout=60000)
        expect(page.get_by_test_id("coding-transcript").get_by_text("You · accepted answer", exact=True)).to_have_count(1)
        reject(target, answers, "completed-and-reopened-question")
        audit()
        scenario("A2-A10-keyboard-accepted-restored", "Native single/multiple/freeform controls operated by Tab/Space/arrow keys and typing; accepted public input restored after reopen, desktop/narrow layouts captured, exact values retained once")

        # Loss BEFORE delivery: fresh view confirms still waiting, retains the
        # draft, and permits only an explicit second user action with a new view.
        questions = freeform_question("What should survive a failed answer delivery?")
        card, before_target = start_question("QUESTION_BEFORE_DELIVERY", "question-before", questions)
        before_answers = type_freeform(card, questions, "QUESTION_DRAFT_RETAINED")
        # Deliberately release earlier-reading focus to body. The transcript
        # container is now keyboard-focusable, so blur the actual clicked owner,
        # not the textarea that no longer owns focus. Recovery must not reclaim it.
        focus_target = dict(before_target)
        page.get_by_test_id("coding-transcript").get_by_text("QUESTION_BEFORE_DELIVERY", exact=True).click()
        page.evaluate("document.activeElement.blur()")
        assert page.evaluate("document.activeElement === document.body")
        page.evaluate("window.codingDropView = true")
        expect(page.get_by_test_id("coding-disconnect-banner")).to_be_visible(timeout=60000)
        assert page.evaluate("document.activeElement === document.body"), "Disconnected card stole deliberately released focus"
        page.evaluate("window.codingDropView = false")
        expect(page.get_by_test_id("coding-event-status")).to_contain_text("Native event stream connected", timeout=60000)
        assert page.evaluate("document.activeElement === document.body"), "Reconnected card stole earlier-reading focus"
        before_target = {**before_target, "subscription": card.get_attribute("data-subscription")}
        reject(focus_target, before_answers, "outside-focus-reconnect-stale-view", live_target=before_target)
        expect(card.locator("textarea")).to_have_value("QUESTION_DRAFT_RETAINED")
        scenario("A10-question-focus-recovery", "Deliberate outside transcript click/body blur preserved reading focus through actual stream loss/reconnect; draft retained and stale view rejected")
        failures = []
        def lose_before(route):
            failures.append(route.request.post_data_json)
            route.abort("connectionreset")
        page.route(answer_url(base, before_target), lose_before, times=1)
        count = len(evidence["answer_attempts"])
        card.get_by_test_id("coding-submit-answer").press("Enter")
        expect(card.get_by_test_id("coding-answer-status")).to_contain_text("Answer not accepted", timeout=60000)
        expect(card.get_by_role("alert")).to_be_visible()
        expect(card.get_by_label(questions[0]["prompt"] + " — Your answer", exact=True)).to_have_value("QUESTION_DRAFT_RETAINED")
        expect(card.get_by_test_id("coding-submit-answer")).to_be_enabled(timeout=60000)
        page.wait_for_function("old => { const card = document.querySelector('[data-question-id=' + JSON.stringify(old.id) + ']'); return card && card.dataset.subscription && card.dataset.subscription !== old.subscription; }",
                               arg={"id": before_target["user_request_id"], "subscription": before_target["subscription"]}, timeout=60000)
        assert failures == [{"subscription": before_target["subscription"], "answers": before_answers}]
        assert len(evidence["answer_attempts"]) == count + 1, "Uncertain answer was blindly replayed"
        assert_waiting(before_target)
        card.scroll_into_view_if_needed()
        snapshot(page, "questions-before-delivery-draft-error")
        current_target = {**before_target, "subscription": card.get_attribute("data-subscription")}
        reject(before_target, before_answers, "before-delivery-reconnected-stale-view", live_target=current_target)
        send(card, current_target, before_answers)
        complete(result_request("question-before", before_answers), "QUESTION_BEFORE_COMPLETED")
        audit()
        scenario("A7-answer-loss-before-delivery", "Actual answer POST aborted before delivery; fresh native view confirmed same waiting question, draft/error retained, zero blind retries, old subscription rejected and explicit current-view action accepted once")

        # Loss AFTER native delivery. Block replacement browser views while the
        # accepted input persists natively, making the unknown state observable.
        questions = freeform_question("What answer must reconcile without replay?")
        card, after_target = start_question("QUESTION_AFTER_DELIVERY", "question-after", questions)
        after_answers = type_freeform(card, questions, "QUESTION_ACK_LOST_ACCEPTED")
        outage = {"active": True}
        def unavailable_view(route):
            route.abort("connectionreset") if outage["active"] else route.continue_()
        page.route(event_url, unavailable_view)
        accepted_ack = []
        def lose_after(route):
            response = route.fetch(timeout=60000)
            assert response.ok, response.text()
            assert_ack(response.json(), after_target)
            accepted_ack.append(response.json())
            route.abort("connectionreset")
        page.route(answer_url(base, after_target), lose_after, times=1)
        page.evaluate("window.codingDropView = true")
        count = len(evidence["answer_attempts"])
        card.get_by_test_id("coding-submit-answer").press("Enter")
        expect(card.get_by_test_id("coding-answer-status")).to_contain_text("unconfirmed", timeout=60000)
        expect(card.get_by_test_id("coding-submit-answer")).to_be_disabled()
        continuation = result_request("question-after", after_answers)
        assert len(accepted_ack) == 1
        remember(after_target, after_answers)
        audit()  # Accepted public history is native evidence, not an HTTP send.
        snapshot(page, "questions-desktop-after-delivery-unconfirmed")
        page.set_viewport_size({"width": 390, "height": 844})
        card.scroll_into_view_if_needed()
        snapshot(page, "questions-narrow-after-delivery-unconfirmed")
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
        page.set_viewport_size({"width": 1440, "height": 1000})
        page.wait_for_timeout(1300)
        assert len(evidence["answer_attempts"]) == count + 1
        page.evaluate("window.codingDropView = false")
        outage["active"] = False
        expect(page.get_by_test_id("coding-event-status")).to_contain_text("Native event stream connected", timeout=60000)
        expect(page.get_by_test_id("coding-transcript").get_by_text("You · accepted answer", exact=True)).to_have_count(len(expected), timeout=60000)
        expect(card).to_have_count(0, timeout=60000)
        assert len(evidence["answer_attempts"]) == count + 1
        page.unroute(event_url, unavailable_view)
        scenario("A7-answer-loss-after-delivery", "ACK discarded after actual matching native acceptance while browser views were unavailable; unconfirmed/disabled controls shown at both viewports, no replay, fresh captured history reconciled accepted input exactly once")

        # A replacement question within the SAME native request cannot be
        # answered by an old card even if the old action uses the fresh view ID.
        replacement = freeform_question("What should the replacement question receive?")
        continuation.ask_user("question-replacement", replacement)
        replacement_card, replacement_target = question_card(after_target["request_id"], replacement)
        assert replacement_target["user_request_id"] != after_target["user_request_id"]
        reject({**after_target, "subscription": replacement_target["subscription"]}, after_answers,
               "replaced-question-with-current-view", live_target=replacement_target)
        reject(current_target, before_answers, "completed-request-while-another-question-waits", live_target=replacement_target)
        replacement_answers = type_freeform(replacement_card, replacement, "QUESTION_REPLACEMENT_ACCEPTED")
        send(replacement_card, replacement_target, replacement_answers)
        complete(result_request("question-replacement", replacement_answers), "QUESTION_REPLACEMENT_COMPLETED")
        audit()
        scenario("A2-stale-replacement-isolation", "Real second ask_user in the same request received a distinct native pending-question ID; old question/current subscription and prior completed request rejected without changing its waiting state")

        # Reopen while waiting establishes a new subscription, then Stop settles
        # the exact native request and removes live answer controls authoritatively.
        questions = freeform_question("Which draft must not be accepted after Stop?")
        card, stopped_target = start_question("QUESTION_STOP_WHILE_WAITING", "question-stop", questions)
        stopped_answers = type_freeform(card, questions, "QUESTION_STOP_DRAFT_NOT_ACCEPTED")
        reopen()
        card, reopened_target = question_card(stopped_target["request_id"], questions)
        assert reopened_target["user_request_id"] == stopped_target["user_request_id"]
        assert reopened_target["subscription"] != stopped_target["subscription"]
        reject(stopped_target, stopped_answers, "reopen-stale-waiting-subscription", live_target=reopened_target)
        cancel_url = base + f"/api/coding/conversations/{conversation}/requests/{stopped_target['request_id']}/cancel"
        with page.expect_response(lambda response: response.url == cancel_url and response.request.method == "POST", timeout=60000) as waiting:
            page.get_by_role("button", name="Stop", exact=True).click()
        assert waiting.value.ok
        assert waiting.value.json() == {"conversation_id": conversation, "request_id": stopped_target["request_id"], "cancel_requested": True}
        wait_native_terminal(base, headers, conversation, stopped_target["request_id"], expected_status="cancelled")
        expect(page.get_by_test_id("coding-run-status")).to_contain_text("Stopped", timeout=60000)
        expect(page.get_by_role("button", name="Stop", exact=True)).to_have_count(0)
        expect(page.get_by_label("Coding prompt", exact=True)).to_be_enabled(timeout=60000)
        state = captured_state(base, headers, conversation)
        assert state["active_request"] is None and state["user_request"] is None and state["pending_user_request"] is False
        assert any(item["id"] == stopped_target["request_id"] and item["status"] == "cancelled" for item in state["requests"])
        reject(reopened_target, stopped_answers, "cancelled-question-current-old-view")
        provider.assert_no_request()
        snapshot(page, "questions-stop-terminal-cleanup")
        reopen()
        expect(page.get_by_test_id("coding-question-card")).to_have_count(0)
        expect(page.get_by_test_id("coding-transcript").get_by_text("You · accepted answer", exact=True)).to_have_count(len(expected))
        audit()
        scenario("A2-A7-stop-waiting-terminal-cleanup", "Deliberate waiting reopen rejected old subscription; Stop targeted the exact native request, eventual cancelled state cleared active/pending question, stale answer rejected, no continuation or accepted stopped draft")
        evidence["status"] = "passed"
    finally:
        evidence["public_view_trace"] = page.evaluate("window.codingQuestionViewTrace || []")
        evidence["focus_trace"] = page.evaluate("window.codingQuestionFocusTrace || []")
        evidence["final_focus"] = page.evaluate("({tag: document.activeElement.tagName, testid: document.activeElement.getAttribute('data-testid'), answer: document.activeElement.getAttribute('data-native-answer')})")
        page.remove_listener("request", count_answer)
