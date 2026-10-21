# SPDX-License-Identifier: AGPL-3.0-only
"""Checks for the refresh driver's evidence assertions, not app/native substitutes."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import struct
import sys
import tempfile
import unittest
import zlib

TOOLS = Path(__file__).resolve().parents[2] / "tools"
sys.path.insert(0, str(TOOLS))
spec = importlib.util.spec_from_file_location("coding_refresh_acceptance", TOOLS / "coding_refresh_acceptance.py")
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


class RefreshEvidenceTests(unittest.TestCase):
    def prompt(self):
        project = Path("/disposable/project")
        text = "é 😀 @refresh-visual @explore Inspect image."
        data = text.encode()
        body = {"text": text, "skill_mentions": [], "subagent_mentions": []}
        for name, key in (("refresh-visual", "skill_mentions"), ("explore", "subagent_mentions")):
            token = ("@" + name).encode()
            start = data.index(token)
            mention = {"name": name, "start": start, "end": start + len(token)}
            if key == "skill_mentions":
                mention["path"] = str(project / ".agents/skills/refresh-visual/SKILL.md")
            body[key].append(mention)
        return body, project

    def test_native_utf8_ranges_and_exact_skill_path(self):
        body, project = self.prompt()
        result = driver.validate_mentions(body, project)
        self.assertEqual(result["skill_mentions"][0]["start"], 8)
        self.assertEqual(result["subagent_mentions"][0]["start"], 24)

    def test_javascript_character_offsets_are_not_accepted_as_bytes(self):
        body, project = self.prompt()
        body["skill_mentions"][0].update(start=5, end=20)
        with self.assertRaises(AssertionError):
            driver.validate_mentions(body, project)

    def test_wrong_skill_identity_is_not_accepted(self):
        body, project = self.prompt()
        body["skill_mentions"][0]["path"] = "/some/other/SKILL.md"
        with self.assertRaises(AssertionError):
            driver.validate_mentions(body, project)

    def test_missing_subagent_is_not_accepted(self):
        body, project = self.prompt()
        body["subagent_mentions"] = []
        with self.assertRaises(AssertionError):
            driver.validate_mentions(body, project)

    def test_network_count_excludes_other_conversations_and_controls(self):
        requests = [{"path": path} for path in (
            "/api/coding/conversations/one/events", "/api/coding/conversations/one/entries",
            "/api/coding/conversations/one/mode", "/api/coding/conversations/two/events",
            "/api/coding/conversations/one/events")]
        self.assertEqual(driver.network_counts(requests, "one"), {"events": 2, "entries": 1})
        self.assertEqual(driver.network_counts(requests, "unknown"), {"events": 0, "entries": 0})

    def test_generated_png_is_valid_and_above_old_limit(self):
        png = driver.large_png()
        self.assertEqual(png, driver.large_png())
        self.assertGreater(len(png), 512 * 1024)
        self.assertLess(len(png), 10 * 1024 * 1024)
        self.assertEqual(png[:8], b"\x89PNG\r\n\x1a\n")
        chunks = {}
        offset = 8
        while offset < len(png):
            length = struct.unpack(">I", png[offset:offset + 4])[0]
            tag = png[offset + 4:offset + 8]
            data = png[offset + 8:offset + 8 + length]
            checksum = struct.unpack(">I", png[offset + 8 + length:offset + 12 + length])[0]
            self.assertEqual(checksum, zlib.crc32(tag + data))
            chunks[tag] = data
            offset += length + 12
        self.assertEqual(struct.unpack(">IIBBBBB", chunks[b"IHDR"]), (470, 470, 8, 2, 0, 0, 0))
        self.assertEqual(len(zlib.decompress(chunks[b"IDAT"])), 470 * (1 + 470 * 3))
        self.assertEqual(chunks[b"IEND"], b"")

    def test_artifact_hash_is_content_based(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "artifact"
            path.write_bytes(b"abc")
            self.assertEqual(driver.sha256(path), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")


if __name__ == "__main__":
    unittest.main()
