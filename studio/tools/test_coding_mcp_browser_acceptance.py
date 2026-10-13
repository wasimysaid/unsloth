# SPDX-License-Identifier: AGPL-3.0-only
"""Driver fixture checks; these do not substitute for rendered native acceptance."""
import json
import os
from pathlib import Path
import tempfile
import unittest
import select
import subprocess
import sys
import time

from coding_mcp_browser_acceptance import INVENTORY_SECRET, create_fixtures, fingerprint, writer_lock_path
from coding_mcp_apply_scenarios import (
    assert_connected, assert_operation, fixture_processes, process_settled,
    assert_correlation_storage, assert_private_storage_absent, assert_editor_observation, correlation_key,
)
from coding_mcp_stdio_fixture import definition, read_events, write_control


class McpBrowserFixtureTests(unittest.TestCase):
    def setUp(self):
        # Keep all files inside this project's owned tools scope during tests.
        self.temporary = tempfile.TemporaryDirectory(dir = Path(__file__).parent)
        self.root = Path(self.temporary.name)
        self.paths = create_fixtures(self.root / "isolated-state")

    def tearDown(self):
        self.temporary.cleanup()

    def test_every_native_layer_and_profile_is_isolated(self):
        for path in self.paths.values():
            self.assertTrue(path.is_relative_to(self.root))
        self.assertEqual(self.paths["shared"], self.paths["home"] / ".config/mcp/mcp.json")
        self.assertEqual(self.paths["global"], self.paths["native"] / "mcp.json")
        self.assertEqual(self.paths["workspace_root"], self.paths["project"] / ".mcp.json")
        self.assertEqual(self.paths["workspace"], self.paths["project"] / ".mimir/mcp.json")
        self.assertEqual(json.loads(self.paths["trust"].read_text()), {str(self.paths["project"].resolve()): False})

    def test_every_fixture_is_disabled_without_provider_or_mcp_execution(self):
        for name in ("shared", "global", "workspace_root", "workspace"):
            entries = json.loads(self.paths[name].read_text())["mcpServers"]
            self.assertTrue(entries)
            for entry in entries.values():
                self.assertIs(entry["enabled"], False)
        self.assertIn(INVENTORY_SECRET, self.paths["global"].read_text())
        self.assertNotIn(INVENTORY_SECRET, self.paths["shared"].read_text())

    def test_writer_lock_identity_is_canonical_and_does_not_create_files(self):
        lock = writer_lock_path(self.paths["global"])
        self.assertEqual(lock.parent, Path(f"/tmp/mimir-config-write-locks-{os.geteuid()}"))
        self.assertEqual(len(lock.stem), 64)
        self.assertEqual(lock.suffix, ".lock")
        self.assertFalse(lock.exists())
        alias = self.root / "global-alias.json"
        alias.symlink_to(self.paths["global"])
        self.assertEqual(writer_lock_path(alias), lock)
        self.assertNotEqual(writer_lock_path(self.paths["shared"]), lock)

    def test_permission_faults_are_real_and_leave_bytes_unchanged(self):
        self.assertEqual(os.name, "posix", "Acceptance permission checks require POSIX")
        self.assertNotEqual(os.geteuid(), 0, "Acceptance permission checks cannot run as root")
        before = fingerprint(self.paths["global"])
        self.paths["global"].chmod(0)
        try:
            with self.assertRaises(PermissionError):
                self.paths["global"].read_bytes()
        finally:
            self.paths["global"].chmod(0o600)
        self.paths["native"].chmod(0o500)
        try:
            # Native atomic persistence needs to create its temporary document
            # beside the target, not merely write the existing readable file.
            with self.assertRaises(PermissionError):
                with tempfile.TemporaryFile(dir = self.paths["native"]):
                    pass
        finally:
            self.paths["native"].chmod(0o755)
        self.assertEqual(fingerprint(self.paths["global"]), before)


class McpBrowserStorageEvidenceTests(unittest.TestCase):
    """Schema/evidence guards; actual reload/tab behavior is checked by the driver."""
    def correlation(self, **changes):
        return {"version": 1, "conversation_id": "session", "id": "exact-operation",
                "kind": "reconnect", "name": None, **changes}

    def stores(self, value = None):
        return {"localStorage": {}, "sessionStorage": {
            correlation_key("session"): json.dumps(value if value is not None else self.correlation())}}

    def test_reload_snapshots_require_exact_session_storage_correlation_only(self):
        before = self.stores()
        # The reload assertion consumes a new native-correlated storage snapshot,
        # never a persisted draft/configuration mirror or a synthesized receipt.
        after = json.loads(json.dumps(before))
        first = assert_correlation_storage(before, "session", "exact-operation", "reconnect")
        second = assert_correlation_storage(after, "session", "exact-operation", "reconnect")
        self.assertEqual(first, second)
        self.assertEqual(set(second), {"version", "conversation_id", "id", "kind", "name"})
        self.assertEqual(before["localStorage"], {})

    def test_local_storage_missing_identity_or_extra_definition_cannot_pass(self):
        bad_stores = [
            {"localStorage": self.stores()["sessionStorage"], "sessionStorage": {}},
            {"localStorage": self.stores()["sessionStorage"], "sessionStorage": self.stores()["sessionStorage"]},
            {"localStorage": {}, "sessionStorage": {}},
        ]
        bad_stores.extend(self.stores(self.correlation(**changes)) for changes in (
            {"conversation_id": "other"}, {"id": "other"}, {"kind": "apply"}, {"name": "other"},
            {"version": True}, {"json": '{"command":"secret-definition"}'}, {"draft": "private-draft"},
            {"revision": "not-delivery-metadata"},
        ))
        for stores in bad_stores:
            with self.subTest(stores = stores), self.assertRaises(AssertionError):
                assert_correlation_storage(stores, "session", "exact-operation", "reconnect")

    def test_correlation_key_uses_encode_uri_component_semantics(self):
        self.assertEqual(correlation_key("project/session ?#"), "unsloth:coding:pending-mcp:project%2Fsession%20%3F%23")

    def test_raw_drafts_and_private_markers_are_forbidden_in_both_stores(self):
        text = '{"command":"private-draft-command","enabled":false}'
        safe = {"localStorage": ["auth-token"], "sessionStorage": [json.dumps(self.correlation())]}
        assert_private_storage_absent(safe, text, INVENTORY_SECRET, "{")
        for name in safe:
            with self.subTest(storage = name), self.assertRaises(AssertionError):
                assert_private_storage_absent({**safe, name: [text]}, text)
            with self.subTest(marker_storage = name), self.assertRaises(AssertionError):
                assert_private_storage_absent({**safe, name: ["prefix-" + INVENTORY_SECRET]}, INVENTORY_SECRET)

    def test_background_editor_evidence_rejects_disabled_busy_or_stolen_focus(self):
        good = {"disabled": False, "focused": True, "busy": False}
        assert_editor_observation([good, good])
        for changed in (None, {"disabled": True}, {"focused": False}, {"busy": True}):
            states = [] if changed is None else [good, {**good, **changed}, good]
            with self.subTest(changed = changed), self.assertRaises(AssertionError):
                assert_editor_observation(states)


class McpOperationEvidenceTests(unittest.TestCase):
    def record(self, **changes):
        return {"operation_id": "op", "session_id": "session", "kind": "apply", "name": None,
                "status": "completed", "error": None, "saved_revision": "saved", "applied_revision": "saved",
                "live_available": True, "configured_tools": 1, **changes}

    def test_completed_requires_actual_tools_revisions_and_exact_owner(self):
        assert_operation(self.record(), "op", "session", "apply")
        for changes in ({"session_id": "other"}, {"operation_id": "other"}, {"status": "running"},
                        {"configured_tools": 0}, {"configured_tools": True}, {"live_available": False},
                        {"applied_revision": "old"}, {"error": "failure"}, {"name": "attachment"}):
            with self.subTest(changes = changes), self.assertRaises(AssertionError):
                assert_operation(self.record(**changes), "op", "session", "apply")

    def test_failed_is_not_completed_and_requires_error(self):
        failed = self.record(status = "failed", error = "Connection failed", configured_tools = 0)
        assert_operation(failed, "op", "session", "apply", "failed")
        with self.assertRaises(AssertionError):
            assert_operation(failed, "op", "session", "apply")
        with self.assertRaises(AssertionError):
            assert_operation({**failed, "error": None}, "op", "session", "apply", "failed")

    def test_connected_requires_configured_not_transient_ownership(self):
        inventory = {"live_available": True, "configured_tools": 1, "saved_revision": "saved",
                     "applied_revision": "saved", "live": [{"name": "configured", "ownership": "configured",
                     "pending_apply": False, "status": {"connected": True, "tools": 1, "error": None}}]}
        assert_connected(inventory)
        for changes in ({"ownership": "attachment"}, {"pending_apply": True},
                        {"status": {"connected": False, "tools": 0, "error": "failure"}}):
            with self.subTest(changes = changes), self.assertRaises(AssertionError):
                assert_connected({**inventory, "live": [{**inventory["live"][0], **changes}]})


class McpStdioProtocolFixtureTests(unittest.TestCase):
    """Actual fixture subprocess checks, not native runtime acceptance claims."""
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir = Path(__file__).parent)
        self.root = Path(self.temporary.name)
        self.events = self.root / "events.jsonl"
        self.control = self.root / "control.json"
        write_control(self.control)
        self.config = definition(self.events, self.control)
        self.process = subprocess.Popen([self.config["command"], *self.config["args"]],
                                        stdin = subprocess.PIPE, stdout = subprocess.PIPE, stderr = subprocess.PIPE,
                                        text = True, bufsize = 1)

    def tearDown(self):
        if self.process.poll() is None:
            self.process.terminate()
        self.process.wait(timeout = 5)
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            stream.close()
        self.temporary.cleanup()

    def send(self, identifier, method, params = None):
        value = {"jsonrpc": "2.0", "method": method, "params": params or {}}
        if identifier is not None:
            value["id"] = identifier
        self.process.stdin.write(json.dumps(value) + "\n")
        self.process.stdin.flush()

    def receive(self):
        self.assertTrue(select.select([self.process.stdout], [], [], 3)[0], "Fixture protocol response deadline")
        result = json.loads(self.process.stdout.readline())
        self.assertEqual(result["jsonrpc"], "2.0")
        return result

    def wait_event(self, event):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            matches = [entry for entry in read_events(self.events) if entry["event"] == event]
            if matches:
                return matches[-1]
            time.sleep(0.01)
        self.fail("Fixture event deadline: " + event)

    def test_definition_handshake_discovery_echo_and_awaited_exit(self):
        self.assertEqual(self.config["command"], sys.executable)
        self.assertTrue(self.config["enabled"])
        self.send(1, "initialize", {"protocolVersion": "2025-03-26"})
        result = self.receive()
        self.assertEqual(result["id"], 1)
        self.assertEqual(result["result"]["protocolVersion"], "2025-03-26")
        self.send(None, "notifications/initialized")
        self.send(2, "tools/list")
        self.assertEqual(self.receive()["result"]["tools"][0]["name"], "echo")
        self.send(3, "tools/call", {"name": "echo", "arguments": {"text": "helper-marker"}})
        output = json.loads(self.receive()["result"]["content"][0]["text"])
        self.assertEqual(output, {"echo": "helper-marker", "pid": self.process.pid})
        identities = fixture_processes(self.events)
        self.assertEqual(len(identities), 1)
        self.assertFalse(identities[0]["already_exited"])
        self.assertFalse(process_settled(identities[0]))
        self.process.stdin.close()
        self.process.wait(timeout = 5)
        self.assertTrue(process_settled(identities[0]))
        self.assertEqual(self.wait_event("exit")["pid"], self.process.pid)

    def test_initialize_and_echo_failure_are_real_jsonrpc_errors(self):
        for identifier, method, action in ((1, "initialize", "initialize"), (2, "tools/call", "echo")):
            write_control(self.control, **{action: "fail"})
            self.send(identifier, method, {"name": "echo", "arguments": {"text": "not-returned"}})
            result = self.receive()
            self.assertEqual(result["id"], identifier)
            self.assertEqual(result["error"]["code"], -32603)
            self.assertNotIn("result", result)
        self.assertFalse(any(event["event"] == "echo" for event in read_events(self.events)))

    def test_real_tool_hold_release_and_signal_cleanup(self):
        write_control(self.control, echo = "hold")
        self.send(7, "tools/call", {"name": "echo", "arguments": {"text": "held-marker"}})
        held = self.wait_event("held")
        self.assertEqual(held["request_id"], 7)
        self.assertFalse(select.select([self.process.stdout], [], [], 0.05)[0])
        write_control(self.control)
        self.assertIn("held-marker", self.receive()["result"]["content"][0]["text"])
        self.process.terminate()
        self.process.wait(timeout = 5)
        self.assertEqual(self.wait_event("signal")["pid"], self.process.pid)
        self.assertEqual(self.wait_event("exit")["pid"], self.process.pid)

    def test_zombie_is_not_mistaken_for_awaited_cleanup(self):
        import psutil
        self.wait_event("start")
        identity = fixture_processes(self.events)[0]
        self.process.terminate()
        deadline = time.monotonic() + 3
        while psutil.Process(self.process.pid).status() != psutil.STATUS_ZOMBIE and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual(psutil.Process(self.process.pid).status(), psutil.STATUS_ZOMBIE)
        self.assertFalse(process_settled(identity))
        zombie_identity = fixture_processes(self.events)[0]
        self.assertFalse(zombie_identity["already_exited"])
        self.assertFalse(process_settled(zombie_identity))
        self.process.wait(timeout = 5)
        self.assertTrue(process_settled(identity))
        self.assertTrue(process_settled(zombie_identity))

    def test_atomic_control_replacement_does_not_leave_temporary_file(self):
        write_control(self.control, initialize = "hold", echo = "fail")
        self.assertEqual(json.loads(self.control.read_text()), {"initialize": "hold", "echo": "fail"})
        self.assertFalse(self.control.with_name(self.control.name + ".next").exists())
        write_control(self.control)
        self.assertEqual(json.loads(self.control.read_text()), {})

    def test_initialize_hold_releases_only_when_control_changes(self):
        write_control(self.control, initialize = "hold")
        self.send(8, "initialize", {"protocolVersion": "2025-03-26"})
        self.assertEqual(self.wait_event("held")["method"], "initialize")
        self.assertFalse(select.select([self.process.stdout], [], [], 0.05)[0])
        write_control(self.control)
        self.assertEqual(self.receive()["result"]["serverInfo"]["name"], "ticket251-stdio-echo")


if __name__ == "__main__":
    unittest.main()
