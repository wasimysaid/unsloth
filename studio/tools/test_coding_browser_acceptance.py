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

from coding_browser_acceptance import FIXTURE_WORKLOADS, WORKLOADS, shared_trust_path
from coding_plan_scenarios import ACTION_LABELS, action_body, proposed_plan, provider_context, validate_action_ack
from coding_provider_fixture import ProviderFixture, ProviderRequest, text_completion, tool_completion


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


class PlanWorkloadTests(unittest.TestCase):
    def test_plan_uses_fixture_without_changing_live_or_opening_workloads(self):
        self.assertIn("plan", WORKLOADS)
        self.assertIn("plan", FIXTURE_WORKLOADS)
        self.assertEqual(set(FIXTURE_WORKLOADS), {"deterministic", "recovery", "plan"})
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


if __name__ == "__main__":
    unittest.main()
