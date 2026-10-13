# SPDX-License-Identifier: AGPL-3.0-only
"""Driver fixture checks; these do not substitute for rendered native acceptance."""
import json
import os
from pathlib import Path
import tempfile
import unittest

from coding_mcp_browser_acceptance import INVENTORY_SECRET, create_fixtures, fingerprint, writer_lock_path


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


if __name__ == "__main__":
    unittest.main()
