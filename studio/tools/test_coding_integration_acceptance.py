# SPDX-License-Identifier: AGPL-3.0-only
"""Reject partial/stale success and preserve exact-owner timeout recovery evidence."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from coding_integration_acceptance import (
    COMMON_SCENARIOS, REQUIRED_SCENARIOS, WORKLOAD_ROWS, assess_report,
    command_identity, reconcile, run_driver, source_manifest, write_record,
)


class IntegrationEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.expected = {"source_revisions": {"studio": "current-studio", "mimir": "current-native"},
                         "native_sha256": "built-native", "plugin_sha256": "rebuilt-product",
                         "frontend_index_sha256": "built-ui"}
        self.sources = {"studio": {"sha256": "source-with-local-edits"}, "mimir": {"sha256": "native-source"}}
        self.guests = {"retirement_sha256": "rebuilt-clock-guest", "commands_sha256": "rebuilt-command-guest"}
        self.build = {"status": "passed", "sources": self.sources, "artifacts": {**self.expected, **self.guests}}

    def command(self, workload):
        script = "coding_mcp_browser_acceptance.py" if workload == "mcp" else "coding_browser_acceptance.py"
        command = [sys.executable, script]
        command += ["--apply-reconnect"] if workload == "mcp" else ["--workload", workload]
        if workload == "deterministic":
            command += ["--extensions"]
        if workload == "commands":
            command += ["--commands-package", "/fixture/current-commands"]
        return {"returncode": 0, "sources": self.sources, "command": command}

    def report(self, workload="recovery"):
        ids = REQUIRED_SCENARIOS[workload].split()
        if workload != "mcp":
            ids += COMMON_SCENARIOS.split()
        report = {**self.expected, "status": "passed", "provider_workload": workload,
                  "scenarios": [{"id": name, "status": "passed", "detail": "Terminal evidence fixture for reconciler unit test only"} for name in ids],
                  "cleanup": {"native_process_settled": True, "server_port_closed": True,
                              "provider_thread_settled": True}}
        if workload == "mcp":
            report.update(provider_workload="deterministic-http-protocol-not-live-model", ticket=251,
                          provider_fixture_settled=True, mcp_cleanup={"all_connections_settled": True})
        if workload == "retirement":
            report["plugin_sha256"] = self.guests["retirement_sha256"]
        if workload == "commands":
            report["commands_fixture_sha256"] = self.guests["commands_sha256"]
        return report

    def record(self, evidence):
        return reconcile(evidence, self.expected, self.sources, self.guests, self.build)

    def populate(self, evidence):
        for workload in WORKLOAD_ROWS:
            route = evidence / workload
            route.mkdir()
            write_record(route / "command.json", self.command(workload))
            write_record(route / "report.json", self.report(workload))

    def test_current_artifacts_and_terminal_completion_are_required(self):
        self.assertEqual(assess_report(self.report(), self.expected, workload="recovery"), [])
        for key in self.expected:
            report = self.report()
            report[key] = "stale"
            self.assertTrue(assess_report(report, self.expected, workload="recovery"))
        for status in (None, "running", "blocked", "failed"):
            report = self.report()
            report["status"] = status
            self.assertTrue(assess_report(report, self.expected, workload="recovery"))

    def test_wrong_workload_and_removed_required_scenario_fail(self):
        report = self.report()
        report["provider_workload"] = "opening"
        self.assertTrue(assess_report(report, self.expected, workload="recovery"))
        report = self.report()
        report["scenarios"].pop(0)
        self.assertTrue(assess_report(report, self.expected, workload="recovery"))
        for name in COMMON_SCENARIOS.split():
            report = self.report()
            report["scenarios"] = [row for row in report["scenarios"] if row["id"] != name]
            self.assertTrue(assess_report(report, self.expected, workload="recovery"), name)
        report = self.report("deterministic")
        report["scenarios"] = [row for row in report["scenarios"] if not row["id"].startswith("A8-")]
        self.assertTrue(assess_report(report, self.expected, workload="deterministic"))
        command = self.command("deterministic")["command"]
        command.remove("--extensions")
        self.assertFalse(command_identity("deterministic", command))
        self.assertFalse(command_identity("mcp", [sys.executable, "coding_mcp_browser_acceptance.py"]))

    def test_cleanup_and_mcp_ownership_must_be_confirmed_independently(self):
        for key in ("native_process_settled", "server_port_closed", "provider_thread_settled"):
            report = self.report()
            del report["cleanup"][key]
            self.assertTrue(assess_report(report, self.expected, workload="recovery"))
        for key in ("mcp_cleanup", "provider_fixture_settled"):
            report = self.report("mcp")
            del report[key]
            self.assertTrue(assess_report(report, self.expected, workload="mcp"))

    def test_missing_truncated_and_unrelated_reports_never_establish_success(self):
        with tempfile.TemporaryDirectory() as directory:
            evidence = Path(directory)
            route = evidence / "deterministic"
            route.mkdir()
            write_record(route / "command.json", self.command("deterministic"))
            self.assertEqual(self.record(evidence)["route_status"], "blocked")
            for partial in ('{"status":', '[]', '{"status":"passed","scenarios":null}', json.dumps(self.report("recovery"))):
                with self.subTest(partial=partial):
                    (route / "report.json").write_text(partial)
                    self.assertEqual(self.record(evidence)["workloads"][0]["status"], "failed")

    def test_all_fixture_passes_leave_live_and_human_gates_pending(self):
        with tempfile.TemporaryDirectory() as directory:
            evidence = Path(directory)
            self.populate(evidence)
            record = self.record(evidence)
            self.assertEqual(record["route_status"], "passed")
            self.assertTrue(all(gate["status"] == "pending" for gate in record["pending_gates"]))
            self.assertNotEqual(record["parent_acceptance"], "passed")
            bad = self.command("recovery")
            bad["returncode"] = 1
            write_record(evidence / "recovery/command.json", bad)
            self.assertEqual(self.record(evidence)["route_status"], "blocked")

    def test_uncommitted_source_build_and_commands_guest_changes_invalidate_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            evidence = Path(directory)
            self.populate(evidence)
            self.sources = {**self.sources, "studio": {"sha256": "edited-after-run"}}
            self.assertEqual(self.record(evidence)["route_status"], "blocked")
            self.assertTrue(self.record(evidence)["build_errors"])
            self.sources = self.build["sources"]
            self.guests = {**self.guests, "commands_sha256": "changed-guest-only"}
            record = self.record(evidence)
            command_check = next(row for row in record["workloads"] if row["workload"] == "commands")
            self.assertEqual(command_check["status"], "failed")
            self.assertEqual(record["route_status"], "blocked")

    def test_source_manifest_covers_local_edits_but_not_profiles(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            source = root / "studio/backend/routes/coding.py"
            source.parent.mkdir(parents=True)
            source.write_text("value = 1\n")
            profile = root / ".mimir/settings.json"
            profile.parent.mkdir()
            profile.write_text('{"secret":"not-source"}')
            before = source_manifest(root, ["studio/backend"])
            profile.write_text('{"secret":"changed"}')
            self.assertEqual(source_manifest(root, ["studio/backend"]), before)
            source.write_text("value = 2\n")
            self.assertNotEqual(source_manifest(root, ["studio/backend"]), before)
            frontend = root / "studio/frontend"
            frontend.mkdir()
            for name in ("index.html", "vite.config.ts", "public/runtime.json"):
                path = frontend / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("before")
                scopes = ["studio/backend", "studio/frontend"]
                original = source_manifest(root, scopes)
                path.write_text("after")
                self.assertNotEqual(source_manifest(root, scopes), original, name)

    def test_batch_records_cannot_overwrite_the_serialized_final_record(self):
        with tempfile.TemporaryDirectory() as directory:
            evidence = Path(directory)
            self.populate(evidence)
            complete = self.record(evidence)
            write_record(evidence / "integration-report.json", complete)
            write_record(evidence / "batch-earlier.json", {"workloads": []})
            self.assertEqual(json.loads((evidence / "integration-report.json").read_text())["route_status"], "passed")
            self.assertEqual(list(evidence.glob("*.tmp")), [])

    def test_disappearance_during_initial_identity_capture_retains_terminal_result(self):
        import psutil
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with (root / "driver.log").open("w") as output, patch("psutil.Process", side_effect=psutil.NoSuchProcess(0)):
                result = run_driver([sys.executable, "-c", "raise SystemExit(7)"], root, output, timeout=5)
            self.assertEqual(result["returncode"], 7)
            self.assertIn("initial: NoSuchProcess", result["ownership_capture_errors"])
            self.assertFalse(psutil.pid_exists(result["driver"]["pid"]))

    def test_timeout_descendant_enumeration_race_is_failed_retained_evidence(self):
        import psutil
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with (root / "driver.log").open("w") as output, patch.object(psutil.Process, "children", side_effect=psutil.NoSuchProcess(0)):
                result = run_driver([sys.executable, "-c", "import time; time.sleep(60)"], root, output, timeout=1, grace=10)
            self.assertTrue(result["timed_out"])
            self.assertIsNotNone(result["returncode"])
            self.assertIn("descendants: NoSuchProcess", result["ownership_capture_errors"])
            self.assertFalse(psutil.pid_exists(result["driver"]["pid"]))

    def test_timeout_allows_finally_to_settle_its_exact_owned_child(self):
        import psutil
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            finalized = root / "finalized"
            code = """import subprocess,sys,time
from pathlib import Path
child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
try:
    time.sleep(60)
finally:
    child.terminate()
    child.wait(timeout=5)
    Path(sys.argv[1]).write_text(str(child.pid))
"""
            with (root / "driver.log").open("w") as output:
                result = run_driver([sys.executable, "-c", code, str(finalized)], root, output, timeout=3, grace=10)
            self.assertTrue(result["timed_out"])
            self.assertTrue(finalized.is_file())
            self.assertTrue(result["owned_descendants"])
            self.assertFalse(psutil.pid_exists(int(finalized.read_text())))
            self.assertEqual(result["unsettled"], [])
            self.assertFalse(result["forced_cleanup"])


if __name__ == "__main__":
    unittest.main()
