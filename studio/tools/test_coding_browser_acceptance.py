# SPDX-License-Identifier: AGPL-3.0-only
"""CPU checks for policy isolation and the external provider protocol fixture."""
import os
import json
from pathlib import Path
import tempfile
import threading
import subprocess
import sys
import unittest
from unittest.mock import patch
import urllib.request

from coding_browser_acceptance import FIXTURE_WORKLOADS, WORKLOADS, link_compilation_cache, shared_trust_path
from coding_plan_scenarios import ACTION_LABELS, action_body, proposed_plan, provider_context, validate_action_ack
from coding_provider_fixture import ProviderFixture, ProviderRequest, text_completion, tool_completion
from coding_question_scenarios import QUESTION_SET, accepted_answer_rows, answer_url

from coding_child_scenarios import admitted_identity, assert_outcome, validate_child_events
from coding_reading_scenarios import history_response_matches
from types import SimpleNamespace


class HistoryResponseTests(unittest.TestCase):
    def test_paging_awaits_its_cursor_not_concurrent_reconnect_capture(self):
        url = "http://fixture/api/coding/conversations/one/entries"
        anchor = {"after": "SYNTHETIC-reading-entry-1383"}
        def response(cursor, method="POST", response_url=url):
            return SimpleNamespace(url=response_url, request=SimpleNamespace(
                method=method, post_data_json={"anchor": cursor}))
        self.assertTrue(history_response_matches(response(anchor), url, anchor))
        for unrelated in ("latest", {"before": anchor["after"]},
                          {"after": "SYNTHETIC-reading-entry-1319"}):
            self.assertFalse(history_response_matches(response(unrelated), url, anchor))
        self.assertFalse(history_response_matches(response(anchor, method="GET"), url, anchor))
        self.assertFalse(history_response_matches(response(anchor, response_url=url + "-other"), url, anchor))


class SharedTrustEvidenceTests(unittest.TestCase):
    def test_default_policy_is_in_native_agent_directory(self):
        # No actual user policy is read or written by this test.
        with patch.dict(os.environ, {}, clear=True), patch.object(Path, "home", return_value=Path("/fixture/home")):
            self.assertEqual(shared_trust_path(), Path("/fixture/home/.mimir/agent/trust.json"))

    def test_explicit_native_agent_directory_is_respected(self):
        with patch.dict(os.environ, {"MIMIR_CODING_AGENT_DIR": "/fixture/native"}, clear=True):
            self.assertEqual(shared_trust_path(), Path("/fixture/native/trust.json"))


class CompilationCacheTests(unittest.TestCase):
    def test_reuses_only_compiled_bytes_and_keeps_saved_state_isolated(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            native, cache = root / "native", root / "compiled"
            native.mkdir()
            cache.mkdir()
            (native / "settings.json").write_text("isolated settings")
            (cache / "component-key").write_bytes(b"compiled fixture bytes, not a guest execution")
            self.assertEqual(link_compilation_cache(native, cache), cache)
            self.assertEqual((native / "cache/wasmtime/component-key").read_bytes(), b"compiled fixture bytes, not a guest execution")
            self.assertEqual((native / "settings.json").read_text(), "isolated settings")
            self.assertFalse((native / "auth.json").exists())
            with self.assertRaises(FileExistsError):
                link_compilation_cache(native, cache)

    def test_live_cache_reuse_is_refused_before_touching_shared_native_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            shared = root / "must-not-create-shared"
            result = subprocess.run([
                sys.executable, str(Path(__file__).with_name("coding_browser_acceptance.py")),
                "--mimir", str(root / "not-invoked"), "--plugin-package", str(root / "not-installed"),
                "--compilation-cache", str(root / "cache"), "--workload", "live", "--evidence-dir", str(root / "evidence"),
            ], env={**os.environ, "MIMIR_CODING_AGENT_DIR": str(shared)}, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 2)
            self.assertIn("restricted to isolated fixture workloads", result.stderr)
            self.assertFalse(shared.exists())

    def test_refuses_non_directory_and_other_owner(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache, native = root / "compiled", root / "native"
            native.mkdir()
            cache.write_bytes(b"not a directory")
            with self.assertRaises(ValueError):
                link_compilation_cache(native, cache)
            cache.unlink()
            cache.mkdir()
            with patch("coding_browser_acceptance.os.geteuid", return_value=cache.stat().st_uid + 1):
                with self.assertRaises(ValueError):
                    link_compilation_cache(native, cache)
            self.assertFalse((native / "cache").exists())


class DeterministicProviderTests(unittest.TestCase):
    def test_config_is_external_authless_and_does_not_create_credentials(self):
        fixture = ProviderFixture()
        try:
            with tempfile.TemporaryDirectory() as directory:
                native = Path(directory)
                fixture.configure(native)
                settings = json.loads((native / "settings.json").read_text())
                model = json.loads((native / "models.json").read_text())["providers"]["coding-acceptance"]
                self.assertEqual(settings["defaultProvider"], "coding-acceptance")
                self.assertEqual(model["baseUrl"], fixture.base_url)
                self.assertEqual(model["auth"], "none")
                self.assertFalse((native / "auth.json").exists())
                self.assertFalse((native / "trust.json").exists())
        finally:
            fixture.close()

    def test_sse_tool_has_exact_identity_and_arguments(self):
        encoded = tool_completion("real-tool-id", "write_file", {"path": "a.txt", "content": "hello"})
        event = json.loads(encoded.decode().split("\n")[0][6:])
        tool = event["choices"][0]["delta"]["tool_calls"][0]
        self.assertEqual(tool["id"], "real-tool-id")
        self.assertEqual(tool["function"]["name"], "write_file")
        self.assertEqual(json.loads(tool["function"]["arguments"]), {"path": "a.txt", "content": "hello"})
        self.assertTrue(encoded.endswith(b"data: [DONE]\n\n"))
        self.assertIn(b'"finish_reason":"stop"', text_completion("completed"))

    def test_cannot_fake_unadvertised_tool_or_mismatched_result(self):
        request = ProviderRequest({"tools": [{"function": {"name": "shell"}}], "messages": [
            {"role": "tool", "tool_call_id": "other-tool", "content": "wrong result"},
            {"role": "tool", "tool_call_id": "actual-tool", "content": "actual result"}]})
        with self.assertRaisesRegex(AssertionError, "did not advertise"):
            request.tool("id", "write_file", {"path": "a.txt"})
        with self.assertRaisesRegex(AssertionError, "absent"):
            request.tool_result("missing-id")
        self.assertEqual(request.tool_result("actual-tool"), "actual result")

    def test_ask_user_fixture_supplies_only_advertised_tool_arguments(self):
        request = ProviderRequest({"tools": [{"function": {"name": "ask_user"}}]})
        request.ask_user("provider-call-not-native-question-id", QUESTION_SET)
        status, content_type, payload = request.response.get_nowait()
        self.assertEqual((status, content_type), (200, "text/event-stream"))
        event = json.loads(payload.decode().split("\n")[0][6:])
        tool = event["choices"][0]["delta"]["tool_calls"][0]
        self.assertEqual(tool["id"], "provider-call-not-native-question-id")
        self.assertEqual(tool["function"]["name"], "ask_user")
        arguments = json.loads(tool["function"]["arguments"])["questions"]
        self.assertEqual(arguments[:2], QUESTION_SET[:2])
        self.assertEqual(arguments[2], {key: value for key, value in QUESTION_SET[2].items() if key != "options"})
        self.assertNotIn("options", arguments[2], "Open-ended native tool input omits the optional bounded options array")
        self.assertEqual(QUESTION_SET[2]["options"], [], "Expected public controls are not mutated by the provider fixture")
        with self.assertRaisesRegex(AssertionError, "did not advertise"):
            ProviderRequest({"tools": []}).ask_user("call", QUESTION_SET)

    def test_real_loopback_http_consumes_request_and_serves_sse(self):
        fixture = ProviderFixture()
        responses, failures = [], []
        def external_client():
            try:
                req = urllib.request.Request(fixture.base_url + "/chat/completions", data=json.dumps({"messages": [], "tools": [], "stream": True}).encode(), headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(req, timeout=10) as response:
                    responses.append((response.status, response.headers["Content-Type"], response.read()))
            except Exception as exc:
                failures.append(exc)
        client = threading.Thread(target=external_client)
        try:
            client.start()
            request = fixture.request(timeout=5)
            self.assertEqual(request.body, {"messages": [], "tools": [], "stream": True})
            request.text("external protocol evidence")
            client.join(timeout=10)
            self.assertFalse(client.is_alive())
            self.assertFalse(failures)
            self.assertEqual(responses, [(200, "text/event-stream", text_completion("external protocol evidence"))])
            fixture.assert_no_request()
        finally:
            fixture.close()
            client.join(timeout=10)

    def test_summary_request_receives_native_nonstreaming_protocol_response(self):
        request = ProviderRequest({"messages": [], "stream": False})
        request.text("Native summary evidence")
        status, content_type, body = request.response.get_nowait()
        self.assertEqual((status, content_type), (200, "application/json"))
        self.assertEqual(json.loads(body), {"choices": [{"message": {"role": "assistant", "content": "Native summary evidence"}, "finish_reason": "stop"}]})


class ChildWorkloadTests(unittest.TestCase):
    def test_child_routing_uses_current_delegated_brief_not_parent_or_history(self):
        request = ProviderRequest({"messages": [
            {"role": "user", "content": "<delegated_task>OLD</delegated_task>"},
            {"role": "user", "content": [
                {"type": "text", "text": "<prior_attempt>OLD</prior_attempt><delegated_task>NEW</delegated_task><parent_task>OLD</parent_task>"}]}]})
        self.assertTrue(request.is_child("NEW"))
        self.assertFalse(request.is_child("OLD"))
        parent = ProviderRequest({"messages": [
            {"role": "user", "content": "Parent OLD"},
            {"role": "assistant", "content": "<delegated_task>NEW</delegated_task>"}]})
        self.assertFalse(parent.is_child("NEW"))
        self.assertFalse(ProviderRequest({"messages": []}).is_child("NEW"))

    def test_matching_concurrent_provider_requests_retains_unmatched_order(self):
        fixture = ProviderFixture()
        try:
            parent, child, next_parent = [ProviderRequest({"marker": marker}) for marker in ("p", "c", "p2")]
            for request in (parent, child, next_parent):
                fixture.requests.put(request)
            self.assertIs(fixture.request_matching(lambda request: request.body["marker"] == "c", timeout=1), child)
            with self.assertRaisesRegex(AssertionError, "Unexpected"):
                fixture.assert_no_request()
            self.assertIs(fixture.request(), parent)
            self.assertIs(fixture.request(), next_parent)
            fixture.assert_no_request()
        finally:
            fixture.close()

    def test_matching_timeout_does_not_consume_other_parent_request(self):
        fixture = ProviderFixture()
        try:
            request = ProviderRequest({"marker": "parent"})
            fixture.requests.put(request)
            with self.assertRaisesRegex(AssertionError, "matched external provider"):
                fixture.request_matching(lambda request: False, timeout=0.01)
            self.assertIs(fixture.request(), request)
        finally:
            fixture.close()

    def test_exact_native_admission_attempt_and_handle(self):
        self.assertEqual(admitted_identity("Background subagent admitted as running with ID agent-exact, attempt 2. Use this exact agent_id", 2), ("agent-exact", 2))
        with self.assertRaisesRegex(AssertionError, "expected attempt"):
            admitted_identity("ID agent-exact, attempt 1", 2)
        with self.assertRaisesRegex(AssertionError, "omitted"):
            admitted_identity("accepted", 1)

    def test_outcome_cannot_retarget_historical_attempt_or_invent_terminal(self):
        outcome = {"handle": "agent-exact", "attempt": 1, "status": "completed", "result": "old"}
        self.assertIs(assert_outcome({"outcome": outcome}, "agent-exact", 1, "completed"), outcome)
        for handle, attempt, status in (("agent-other", 1, "completed"), ("agent-exact", 2, "completed"), ("agent-exact", 1, "failed")):
            with self.assertRaises(AssertionError):
                assert_outcome({"outcome": outcome}, handle, attempt, status)
        with self.assertRaisesRegex(AssertionError, "absent"):
            assert_outcome({"outcome": None}, "agent-exact", 1, "completed")

    @staticmethod
    def events():
        kinds = [(1, "child", "running"), (1, "activity", None), (1, "checkpoint", None),
                 (1, "child", "completed"), (2, "child", "running"), (2, "activity", None), (2, "child", "failed")]
        return [{"connection": 1, "position": position, "type": kind,
                 "child": {"handle": "agent-exact", "attempt": attempt, "status": status},
                 "cut": {"journal": {"child": "agent-exact"}, "leaf": "saved"} if kind == "checkpoint" else None}
                for position, (attempt, kind, status) in enumerate(kinds, 1)]

    def test_child_wire_order_journal_and_terminal_evidence(self):
        result = validate_child_events(self.events(), "agent-exact")
        self.assertEqual(result["lifecycle_statuses"], {"1": ["running", "completed"], "2": ["running", "failed"]})
        events = self.events()
        events[2]["cut"]["journal"] = "root"
        with self.assertRaisesRegex(AssertionError, "wrong journal"):
            validate_child_events(events, "agent-exact")
        events = self.events()
        events[-1]["child"]["status"] = "running"
        with self.assertRaisesRegex(AssertionError, "settlement"):
            validate_child_events(events, "agent-exact")
        events = self.events()
        events[-1]["position"] = events[-2]["position"]
        with self.assertRaisesRegex(AssertionError, "strictly ordered"):
            validate_child_events(events, "agent-exact")
        events = self.events()
        events[1]["child"]["attempt"] = None
        with self.assertRaisesRegex(AssertionError, "exact attempt"):
            validate_child_events(events, "agent-exact")


class PlanWorkloadTests(unittest.TestCase):
    def test_plan_uses_fixture_without_changing_live_or_opening_workloads(self):
        self.assertIn("plan", WORKLOADS)
        self.assertIn("plan", FIXTURE_WORKLOADS)
        self.assertIn("questions", WORKLOADS)
        self.assertIn("questions", FIXTURE_WORKLOADS)
        self.assertIn("goals", WORKLOADS)
        self.assertIn("goals", FIXTURE_WORKLOADS)
        self.assertIn("maintenance", WORKLOADS)
        self.assertIn("maintenance", FIXTURE_WORKLOADS)
        self.assertEqual(set(FIXTURE_WORKLOADS), {
            "deterministic", "picker", "catalog", "recovery", "maintenance", "plan", "goals", "questions", "commands", "retirement",
            "concurrency", "children", "inputs", "file-changes", "reading",
        })
        self.assertTrue(set(FIXTURE_WORKLOADS).issubset(WORKLOADS))
        self.assertNotIn("live", FIXTURE_WORKLOADS)
        self.assertNotIn("opening", FIXTURE_WORKLOADS)

    def test_proposal_is_a_final_native_block_not_a_simulated_execution(self):
        answer = proposed_plan("Native review", "EVIDENCE_239", "native.txt")
        self.assertTrue(answer.startswith("<proposed_plan>\n# Native review\n"))
        self.assertTrue(answer.endswith("\n</proposed_plan>"))
        for heading in ("## Requirements", "## Technical Design", "## Delivery Plan", "### 1.", "### 2."):
            self.assertIn(heading, answer)
        self.assertIn("EVIDENCE_239", answer)
        self.assertIn("native.txt", answer)

    def test_action_body_preserves_exact_native_artifact_and_revision(self):
        plan = {"id": "native-plan-239", "revision": "review_pending:" + "a" * 64}
        for decision in ACTION_LABELS:
            with self.subTest(decision=decision):
                self.assertEqual(action_body(plan, decision), {
                    "plan_id": plan["id"], "revision": plan["revision"], "decision": decision})
        self.assertEqual(plan, {"id": "native-plan-239", "revision": "review_pending:" + "a" * 64})
        for malformed in ({"revision": "r"}, {"id": "p"}, {"id": "", "revision": "r"}, {"id": "p", "revision": ""}):
            with self.subTest(plan=malformed), self.assertRaises(AssertionError):
                action_body(malformed, "implement")
        with self.assertRaisesRegex(AssertionError, "Unknown"):
            action_body(plan, "switch-to-build-only")

    def test_ack_requires_exact_target_and_native_request_for_implementation(self):
        plan = {"id": "native-plan"}
        for decision in ACTION_LABELS:
            valid = {"conversation_id": "native-conversation", "plan_id": "native-plan",
                     "decision": decision, "request_id": None if decision == "save_and_stop" else "native-request"}
            validate_action_ack(valid, "native-conversation", plan, decision)
            for field, wrong in (("conversation_id", "other-conversation"), ("plan_id", "other-plan"),
                                 ("decision", "other-decision"),
                                 ("request_id", "must-not-run" if decision == "save_and_stop" else None)):
                with self.subTest(decision=decision, field=field), self.assertRaises(AssertionError):
                    validate_action_ack(dict(valid, **{field: wrong}), "native-conversation", plan, decision)
        with self.assertRaisesRegex(AssertionError, "Unknown"):
            validate_action_ack({}, "native-conversation", plan, "unrecognized")

    def test_provider_context_inspects_message_text_not_credentials_or_tool_schema(self):
        request = ProviderRequest({"authorization": "not-message-context", "tools": [{"secret": "not-context"}],
                                   "messages": [{"role": "user", "content": "EARLIER_CONTEXT"},
                                                {"role": "user", "content": [
                                                    {"type": "text", "text": "<accepted_plan>plan</accepted_plan>"},
                                                    {"type": "image_url", "image_url": {"url": "private-url"}}]}]})
        self.assertEqual(provider_context(request), "EARLIER_CONTEXT\n<accepted_plan>plan</accepted_plan>")
        self.assertEqual(provider_context(ProviderRequest({"messages": [{"role": "user", "content": None}]})), "")


class QuestionEvidenceTests(unittest.TestCase):
    def test_exact_ids_are_encoded_as_distinct_url_segments(self):
        self.assertEqual(answer_url("http://test", {"conversation_id": "conversation/one", "request_id": "request?two",
                                                   "user_request_id": "question three", "subscription": "not-in-url"}),
                         "http://test/api/coding/conversations/conversation%2Fone/requests/request%3Ftwo/questions/question%20three/answers")

    def test_history_audit_requires_one_durable_input_for_each_exact_question(self):
        answers = [{"question_id": "notes", "selected_options": [], "freeform_text": "actual answer"}]
        row = {"id": "public-row", "entry_id": "native-entry", "kind": "user", "answer": {
            "request_id": "native-request", "user_request_id": "native-question", "answers": [{**answer, "none_of_above": False} for answer in answers]}}
        expected = {("native-request", "native-question"): answers}
        self.assertEqual(accepted_answer_rows([{"kind": "assistant", "text": "done"}, row], expected), [row])
        for rows, wanted in (([], expected), ([row, row], expected),
                             ([row, row], {**expected, ("native-request", "replacement-question"): answers}),
                             ([row], {("another-request", "native-question"): answers}),
                             ([{**row, "entry_id": None}], expected),
                             ([{**row, "kind": "tool"}], expected),
                             ([row], {("native-request", "native-question"): []})):
            with self.subTest(rows=rows, expected=wanted), self.assertRaises(AssertionError):
                accepted_answer_rows(rows, wanted)


if __name__ == "__main__":
    unittest.main()
