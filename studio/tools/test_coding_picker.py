# SPDX-License-Identifier: AGPL-3.0-only
"""CPU/helper tests, not a substitute for executing rendered picker acceptance.

Run (from studio/tools): python -m pytest -q test_coding_picker.py
"""
from __future__ import annotations

import json
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.request

from coding_picker_scenarios import assert_provider_selection, assert_viewport_box, effort_label, trigger_label
from coding_provider_fixture import (
    PICKER_API_A, PICKER_API_B, PICKER_API_PLAIN, PICKER_LEVELS_A,
    PICKER_LEVELS_B, PICKER_MODEL, PICKER_PLAIN_MODEL, PICKER_PROVIDER_A,
    PICKER_PROVIDER_B, ProviderFixture, ProviderRequest, picker_providers,
    text_completion,
)


class PickerCatalogTests(unittest.TestCase):
    def test_colliding_labels_and_local_ids_preserve_distinct_native_and_api_ids(self):
        catalog = picker_providers("http://127.0.0.1:1/v1")
        self.assertEqual(set(catalog), {PICKER_PROVIDER_A, PICKER_PROVIDER_B})
        first, second = catalog[PICKER_PROVIDER_A], catalog[PICKER_PROVIDER_B]
        self.assertEqual(first["name"], second["name"])
        self.assertEqual(first["models"][PICKER_MODEL]["name"], second["models"][PICKER_MODEL]["name"])
        self.assertEqual(first["models"][PICKER_MODEL]["apiModel"], PICKER_API_A)
        self.assertEqual(second["models"][PICKER_MODEL]["apiModel"], PICKER_API_B)
        self.assertNotEqual(PICKER_API_A, PICKER_API_B)
        self.assertEqual(first["models"][PICKER_MODEL]["thinkingLevelMap"], {level: level for level in PICKER_LEVELS_A})
        self.assertEqual(second["models"][PICKER_MODEL]["thinkingLevelMap"], {level: level for level in PICKER_LEVELS_B})
        self.assertIn("high", PICKER_LEVELS_A)
        self.assertIn("high", PICKER_LEVELS_B)
        self.assertNotEqual(PICKER_LEVELS_A, PICKER_LEVELS_B)
        plain = second["models"][PICKER_PLAIN_MODEL]
        self.assertEqual(plain["apiModel"], PICKER_API_PLAIN)
        self.assertFalse(plain["reasoning"])
        self.assertNotIn("thinkingLevelMap", plain)
        self.assertEqual(len(first["models"]), 33)
        self.assertIn("scroll-31", first["models"])
        for provider in catalog.values():
            self.assertEqual(provider["baseUrl"], "http://127.0.0.1:1/v1")
            self.assertEqual(provider["auth"], "none")
            self.assertEqual(provider["defaultModel"], PICKER_MODEL)

    def test_configure_picker_only_writes_isolated_native_settings_and_models(self):
        fixture = ProviderFixture()
        try:
            with tempfile.TemporaryDirectory() as directory:
                native = Path(directory)
                fixture.configure(native, picker=True)
                self.assertEqual({path.name for path in native.iterdir()}, {"settings.json", "models.json"})
                settings = json.loads((native / "settings.json").read_text())
                self.assertEqual(settings, {"defaultProvider": PICKER_PROVIDER_A, "defaultModel": PICKER_MODEL,
                                            "model": {"thinkingEffort": "high"}})
                self.assertEqual(json.loads((native / "models.json").read_text()), {"providers": picker_providers(fixture.base_url)})
        finally:
            fixture.close()

    def test_default_fixture_remains_ticket_235_inventory(self):
        fixture = ProviderFixture()
        try:
            with tempfile.TemporaryDirectory() as directory:
                native = Path(directory)
                fixture.configure(native)
                providers = json.loads((native / "models.json").read_text())["providers"]
                self.assertEqual(set(providers), {"coding-acceptance"})
                self.assertEqual(set(providers["coding-acceptance"]["models"]), {"offline"})
                settings = json.loads((native / "settings.json").read_text())
                self.assertEqual((settings["defaultProvider"], settings["defaultModel"]), ("coding-acceptance", "offline"))
        finally:
            fixture.close()


class PickerEvidenceTests(unittest.TestCase):
    def test_viewport_accepts_subpixel_rounding_but_rejects_all_clipped_edges(self):
        assert_viewport_box({"x": 16, "y": 16, "width": 352, "height": 600}, 390, 844, label="test")
        assert_viewport_box({"x": -0.5, "y": 0, "width": 391, "height": 844.5}, 390, 844, label="test")
        for box in (None, {"x": 0, "y": 0, "width": 0, "height": 10},
                    {"x": -2, "y": 0, "width": 10, "height": 10},
                    {"x": 0, "y": -2, "width": 10, "height": 10},
                    {"x": 380, "y": 0, "width": 12, "height": 10},
                    {"x": 0, "y": 840, "width": 10, "height": 6}):
            with self.subTest(box=box), self.assertRaises(AssertionError):
                assert_viewport_box(box, 390, 844, label="test")

    def test_effort_and_trigger_labels_mirror_the_rendered_picker(self):
        # model-configuration-popover.tsx effortLabel and the trigger's aria-label.
        for level, label in (("low", "Low"), ("minimal", "Minimal"), ("medium", "Medium"),
                             ("high", "High"), ("xhigh", "X-High"), ("very_high", "Very High")):
            with self.subTest(level=level):
                self.assertEqual(effort_label(level), label)
        self.assertEqual(trigger_label("Shared coding model", "minimal"), "Model: Shared coding model \u00b7 Minimal")
        self.assertEqual(trigger_label("No reasoning control", None), "Model: No reasoning control")
        self.assertEqual({effort_label(level) for level in PICKER_LEVELS_A + PICKER_LEVELS_B},
                         {"Low", "Medium", "High", "Minimal"})

    def test_routing_evidence_rejects_local_id_or_wrong_effort(self):
        assert_provider_selection(ProviderRequest({"model": PICKER_API_A, "reasoning_effort": "high"}), PICKER_API_A, "high")
        for body in ({"model": PICKER_MODEL, "reasoning_effort": "high"},
                     {"model": PICKER_API_B, "reasoning_effort": "high"},
                     {"model": PICKER_API_A, "reasoning_effort": "low"},
                     {"model": PICKER_API_A}):
            with self.subTest(body=body), self.assertRaises(AssertionError):
                assert_provider_selection(ProviderRequest(body), PICKER_API_A, "high")

    def test_external_http_call_can_be_held_while_other_selection_call_is_observed(self):
        # This tests fixture mechanics only, not Studio/native scheduling. The
        # browser scenario performs the actual held-run/next-config integration.
        fixture = ProviderFixture()
        responses, failures = {}, []
        completed = {name: threading.Event() for name in ("first", "second")}

        def external_client(name, api_model, effort):
            try:
                body = json.dumps({"model": api_model, "reasoning_effort": effort, "messages": [], "stream": True}).encode()
                request = urllib.request.Request(fixture.base_url + "/chat/completions", data=body, headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(request, timeout=10) as response:
                    responses[name] = (response.status, response.read())
            except Exception as exc:
                failures.append(exc)
            finally:
                completed[name].set()

        first = threading.Thread(target=external_client, args=("first", PICKER_API_A, "high"))
        second = threading.Thread(target=external_client, args=("second", PICKER_API_B, "minimal"))
        try:
            first.start()
            held = fixture.request(timeout=5)
            assert_provider_selection(held, PICKER_API_A, "high")
            self.assertTrue(held.response.empty())
            self.assertFalse(completed["first"].is_set())
            second.start()
            next_request = fixture.request(timeout=5)
            assert_provider_selection(next_request, PICKER_API_B, "minimal")
            next_request.text("NEXT")
            self.assertTrue(completed["second"].wait(timeout=5))
            self.assertFalse(completed["first"].is_set())
            self.assertEqual(held.body["model"], PICKER_API_A)
            held.text("HELD")
            self.assertTrue(completed["first"].wait(timeout=5))
            self.assertEqual(responses, {"first": (200, text_completion("HELD")), "second": (200, text_completion("NEXT"))})
            self.assertFalse(failures)
            fixture.assert_no_request()
        finally:
            fixture.close()
            first.join(timeout=10)
            if second.ident is not None:
                second.join(timeout=10)
            self.assertFalse(first.is_alive())
            self.assertFalse(second.is_alive())


if __name__ == "__main__":
    unittest.main()
