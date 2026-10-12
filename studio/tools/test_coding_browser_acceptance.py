# SPDX-License-Identifier: AGPL-3.0-only
"""Regression checks for the browser evidence driver's native policy location."""
import os
from pathlib import Path
import unittest
from unittest.mock import patch

from coding_browser_acceptance import shared_trust_path


class SharedTrustEvidenceTests(unittest.TestCase):
    def test_default_policy_is_in_native_agent_directory(self):
        # No actual user policy is read or written by this test.
        with patch.dict(os.environ, {}, clear=True), patch.object(Path, "home", return_value=Path("/fixture/home")):
            self.assertEqual(shared_trust_path(), Path("/fixture/home/.mimir/agent/trust.json"))

    def test_explicit_native_agent_directory_is_respected(self):
        with patch.dict(os.environ, {"MIMIR_CODING_AGENT_DIR": "/fixture/native"}, clear=True):
            self.assertEqual(shared_trust_path(), Path("/fixture/native/trust.json"))


if __name__ == "__main__":
    unittest.main()
