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
from coding_extension_scenarios import (DISABLED_PLUGIN, NONLIVE_PLUGIN, EFFECTIVE_SKILL,
                                        DISABLED_SKILL, prepare_extension_fixtures,
                                        advance_disabled_fixture_version,
                                        assert_inventory, assert_same_activation, plugin_by_id)

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


class ExtensionDriverTests(unittest.TestCase):
    def inventory(self):
        return {"conversation_id": "target", "inventory": {
            "session_id": "target", "session_live_available": True, "runtime_live_available": True,
            "plugins": [
                {"id": DISABLED_PLUGIN, "installed": True, "enabled": False, "live": False},
                {"id": NONLIVE_PLUGIN, "installed": True, "enabled": True, "selected": False, "live": False},
                {"id": "studio.frontend", "selected_frontend": True, "live": True, "mount_id": "real-mount-1"}],
            "reload": None}, "skills": [{"name": EFFECTIVE_SKILL}]}

    def test_fixture_setup_preserves_provider_and_uses_isolated_native_home_skills(self):
        import tomllib
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            native = root / "agent"
            native.mkdir()
            (native / "settings.json").write_text(json.dumps({"defaultProvider": "external-fixture", "model": {"thinkingEffort": "high"}}))
            product = root / "product"
            product.mkdir()
            (product / "plugin.wasm").write_bytes(b"fixture-bytes-for-copy-test-only")
            packages = prepare_extension_fixtures(root, native, product)
            settings = json.loads((native / "settings.json").read_text())
            self.assertEqual(settings["defaultProvider"], "external-fixture")
            self.assertEqual(settings["model"], {"thinkingEffort": "high"})
            self.assertEqual(settings["plugins"][DISABLED_PLUGIN], {"enabled": False})
            self.assertEqual(settings["skills"][DISABLED_SKILL], {"enabled": False})
            for name in (EFFECTIVE_SKILL, DISABLED_SKILL):
                skill = root / ".mimir" / "skills" / name / "SKILL.md"
                self.assertTrue(skill.is_file())
                self.assertIn("name: " + name, skill.read_text())
            self.assertFalse((native / "skills").exists(), "Agent-dir is not the native global skills root")
            manifests = [tomllib.loads((package / "mimir-plugin.toml").read_text()) for package in packages]
            self.assertEqual([manifest["id"] for manifest in manifests], [DISABLED_PLUGIN, NONLIVE_PLUGIN])
            self.assertEqual(manifests[1]["frontends"], ["tui"])
            for package in packages:
                self.assertEqual((package / "plugin.wasm").read_bytes(), (product / "plugin.wasm").read_bytes())
            manifest = packages[0] / "mimir-plugin.toml"
            advance_disabled_fixture_version(manifest)
            changed = tomllib.loads(manifest.read_text())
            self.assertEqual(changed["version"], "0.2.0")
            self.assertEqual({key: value for key, value in changed.items() if key != "version"},
                             {key: value for key, value in manifests[0].items() if key != "version"})
            with self.assertRaises(AssertionError):
                advance_disabled_fixture_version(manifest)
            other = packages[1] / "mimir-plugin.toml"
            other_before = other.read_bytes()
            with self.assertRaises(AssertionError):
                advance_disabled_fixture_version(other)
            self.assertEqual(other.read_bytes(), other_before)

    def test_inventory_assertions_reject_installed_as_live_or_enabled(self):
        inventory = self.inventory()
        assert_inventory(inventory, "target")
        plugin_by_id(inventory, DISABLED_PLUGIN)["live"] = True
        with self.assertRaises(AssertionError):
            assert_inventory(inventory, "target")
        inventory = self.inventory()
        plugin_by_id(inventory, NONLIVE_PLUGIN)["selected"] = True
        with self.assertRaises(AssertionError):
            assert_inventory(inventory, "target")

    def test_inventory_rejects_wrong_owner_or_disabled_skills_or_instruction_leak(self):
        with self.assertRaises(AssertionError):
            assert_inventory(self.inventory(), "different-session")
        inventory = self.inventory()
        inventory["skills"].append({"name": DISABLED_SKILL})
        with self.assertRaises(AssertionError):
            assert_inventory(inventory, "target")
        inventory = self.inventory()
        inventory["skills"][0]["instructions"] = "TICKET252_SKILL_BODY_NOT_PUBLIC"
        with self.assertRaises(AssertionError):
            assert_inventory(inventory, "target")

    def test_scope_requires_native_activation_identity_not_just_live_flag(self):
        assert_same_activation({"live": True, "mount_id": "a"}, {"live": True, "mount_id": "a"})
        for after in ({"live": True, "mount_id": "b"}, {"live": False, "mount_id": "a"}, {"live": True}):
            with self.assertRaises(AssertionError):
                assert_same_activation({"live": True, "mount_id": "a"}, after)
        with self.assertRaises(AssertionError):
            assert_same_activation({"live": True}, {"live": True})

    def test_duplicate_inventory_identity_is_not_accepted(self):
        inventory = self.inventory()
        inventory["inventory"]["plugins"].append(dict(inventory["inventory"]["plugins"][0]))
        with self.assertRaises(AssertionError):
            plugin_by_id(inventory, DISABLED_PLUGIN)

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
