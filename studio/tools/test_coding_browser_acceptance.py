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
from coding_child_scenarios import admitted_identity, assert_outcome, validate_child_events


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


if __name__ == "__main__":
    unittest.main()
