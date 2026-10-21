# SPDX-License-Identifier: AGPL-3.0-only
"""Driver-level checks only. Production-native validation is the separate CLI run."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

TOOLS = Path(__file__).resolve().parents[2] / "tools"
sys.path.insert(0, str(TOOLS))
spec = importlib.util.spec_from_file_location("coding_interaction_acceptance", TOOLS / "coding_interaction_acceptance.py")
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


class InteractionDriverTests(unittest.TestCase):
    def body(self):
        selected = [{"path": "notes/é report.txt", "kind": "file"}, {"path": "notes", "kind": "directory"}]
        text = 'é 😀 @"notes/é report.txt" @notes/ Inspect.'
        encoded = text.encode()
        mentions = []
        for item, token in zip(selected, ('@"notes/é report.txt"', "@notes/"), strict=True):
            start = encoded.index(token.encode())
            mentions.append({**item, "start": start, "end": start + len(token.encode())})
        return {"text": text, "file_mentions": mentions}, selected

    def test_file_and_directory_tokens(self):
        self.assertEqual(driver.file_token("notes/é report.txt", "file"), '@"notes/é report.txt"')
        self.assertEqual(driver.file_token("notes", "directory"), "@notes/")
        self.assertEqual(driver.file_token("notes/", "directory"), "@notes/")
        self.assertEqual(driver.file_token("source files", "directory"), '@"source files/"')

    def test_utf8_selected_reference_identity(self):
        body, selected = self.body()
        driver.assert_file_mentions(body, selected)
        self.assertEqual(body["file_mentions"][0]["start"], 8)
        self.assertEqual(body["file_mentions"][0]["end"], 30)

    def test_javascript_offsets_cannot_substitute_for_native_bytes(self):
        body, selected = self.body()
        body["file_mentions"][0]["start"] = 5
        with self.assertRaises(AssertionError):
            driver.assert_file_mentions(body, selected)

    def test_plain_text_is_not_typed_file_reference(self):
        body, selected = self.body()
        body["file_mentions"] = []
        with self.assertRaises(AssertionError):
            driver.assert_file_mentions(body, selected)

    def test_changed_native_reference_identity_fails(self):
        body, selected = self.body()
        body["file_mentions"][1]["kind"] = "file"
        with self.assertRaises(AssertionError):
            driver.assert_file_mentions(body, selected)

    def test_provider_frame_separates_readable_and_opaque_reasoning(self):
        frame = driver.thinking_frame("Readable explanation.", "opaque-test-value")
        self.assertTrue(frame.startswith(b"data: ") and frame.endswith(b"\n\n"))
        delta = json.loads(frame[6:])["choices"][0]["delta"]
        self.assertEqual(delta["reasoning_content"], "Readable explanation.")
        self.assertEqual(delta["reasoning_details"], [{"type": "reasoning.encrypted", "data": "opaque-test-value"}])

    def test_rich_draft_requires_latest_text_and_exact_image(self):
        expected = {"text": "Latest é 😀 draft", "images": [{"filename": "landing.png", "sha256": "abc123"}]}
        driver.assert_rich_draft(json.loads(json.dumps(expected)), expected, 1)
        mutations = [
            {"text": "Earlier draft", "images": expected["images"]},
            {"text": expected["text"], "images": []},
            {"text": expected["text"], "images": [{"filename": "landing.png", "sha256": "different"}]},
            {"text": expected["text"], "images": [{"filename": "other.png", "sha256": "abc123"}]},
            {"text": expected["text"], "images": expected["images"] * 2},
        ]
        for actual in mutations:
            with self.subTest(actual=actual), self.assertRaises(AssertionError):
                driver.assert_rich_draft(actual, expected, 1)
        for count in (0, 2):
            with self.subTest(create_count=count), self.assertRaises(AssertionError):
                driver.assert_rich_draft(expected, expected, count)

    def test_create_gate_only_holds_post_and_forwards_original_201(self):
        page, listing, creation = Mock(), Mock(), Mock()
        listing.request.method = "GET"
        creation.request.method = "POST"
        creation.fetch.return_value = SimpleNamespace(ok=True, status=201)
        evidence = []
        with driver.ResponseGate(page, "http://127.0.0.1/conversations", evidence, method="POST") as gate:
            gate.hold(listing)
            listing.continue_.assert_called_once()
            listing.fetch.assert_not_called()
            self.assertEqual(evidence[0]["state"], "armed")
            gate.hold(creation)
            creation.fulfill.assert_not_called()
            self.assertEqual(evidence[0]["backend_status"], 201)
        creation.fulfill.assert_called_once_with(response=creation.fetch.return_value)
        self.assertEqual(evidence[0]["state"], "released")

    def test_response_gate_holds_then_forwards_same_response(self):
        page, route = Mock(), Mock()
        response = SimpleNamespace(ok=True, status=200)
        route.fetch.return_value = response
        evidence = []
        with driver.ResponseGate(page, "http://127.0.0.1/example", evidence) as gate:
            gate.hold(route)
            route.fulfill.assert_not_called()
            self.assertEqual(evidence[0]["state"], "held")
        route.fulfill.assert_called_once_with(response=response)
        self.assertEqual(evidence[0]["state"], "released")
        page.unroute.assert_called_once()

    def test_recovery_gate_does_not_hold_earlier_checkpoint(self):
        page, early, later = Mock(), Mock(), Mock()
        ready = False
        evidence = []
        later.fetch.return_value = SimpleNamespace(ok=True, status=200)
        with driver.ResponseGate(page, "http://127.0.0.1/entries", evidence, ready=lambda: ready) as gate:
            gate.hold(early)
            early.continue_.assert_called_once()
            early.fetch.assert_not_called()
            self.assertEqual(evidence[0]["state"], "armed")
            ready = True
            gate.hold(later)
            self.assertEqual(evidence[0]["state"], "held")
        later.fulfill.assert_called_once_with(response=later.fetch.return_value)

    def test_response_gate_releases_after_assertion_failure(self):
        page, route = Mock(), Mock()
        route.fetch.return_value = SimpleNamespace(ok=True, status=200)
        evidence = []
        with self.assertRaisesRegex(AssertionError, "scenario failed"):
            with driver.ResponseGate(page, "http://127.0.0.1/open", evidence) as gate:
                gate.hold(route)
                raise AssertionError("scenario failed")
        route.fulfill.assert_called_once_with(response=route.fetch.return_value)
        self.assertEqual(evidence[0]["state"], "released")


if __name__ == "__main__":
    unittest.main()
