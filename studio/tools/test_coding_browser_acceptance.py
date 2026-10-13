# SPDX-License-Identifier: AGPL-3.0-only
"""CPU checks for policy isolation and the external provider protocol fixture."""
import os
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.request

from coding_browser_acceptance import shared_trust_path
from coding_provider_fixture import ProviderFixture, ProviderRequest, text_completion, tool_completion
from coding_question_scenarios import QUESTION_SET, accepted_answer_rows, answer_url


class SharedTrustEvidenceTests(unittest.TestCase):
    def test_default_policy_is_in_native_agent_directory(self):
        # No actual user policy is read or written by this test.
        with patch.dict(os.environ, {}, clear=True), patch.object(Path, "home", return_value=Path("/fixture/home")):
            self.assertEqual(shared_trust_path(), Path("/fixture/home/.mimir/agent/trust.json"))

    def test_explicit_native_agent_directory_is_respected(self):
        with patch.dict(os.environ, {"MIMIR_CODING_AGENT_DIR": "/fixture/native"}, clear=True):
            self.assertEqual(shared_trust_path(), Path("/fixture/native/trust.json"))


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
                req = urllib.request.Request(fixture.base_url + "/chat/completions", data=json.dumps({"messages": [], "tools": []}).encode(), headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(req, timeout=10) as response:
                    responses.append((response.status, response.headers["Content-Type"], response.read()))
            except Exception as exc:
                failures.append(exc)
        client = threading.Thread(target=external_client)
        try:
            client.start()
            request = fixture.request(timeout=5)
            self.assertEqual(request.body, {"messages": [], "tools": []})
            request.text("external protocol evidence")
            client.join(timeout=10)
            self.assertFalse(client.is_alive())
            self.assertFalse(failures)
            self.assertEqual(responses, [(200, "text/event-stream", text_completion("external protocol evidence"))])
            fixture.assert_no_request()
        finally:
            fixture.close()
            client.join(timeout=10)


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
