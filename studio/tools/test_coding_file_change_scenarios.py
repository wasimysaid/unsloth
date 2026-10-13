# SPDX-License-Identifier: AGPL-3.0-only
"""CPU-only acceptance-oracle tests; these are not browser/native execution claims."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import unittest

from coding_file_change_scenarios import (
    EDITED, FILE_PATH, FINAL, INITIAL, inject_synthetic_history,
    supplied_lines, synthetic_history_rows, verify_transition,
)


def line(kind, content, old=None, new=None):
    return {"kind": kind, "content": content, "old_line": old, "new_line": new}


def profile(lines, *, created=False):
    return {"path": FILE_PATH, "status": "created" if created else "updated",
            "additions": sum(value["kind"] == "added" for value in lines),
            "deletions": sum(value["kind"] == "removed" for value in lines),
            "binary": False, "partial": False, "truncated": False,
            "unavailable": False, "hunks": [{"lines": lines}]}


class NativeTransitionOracleTests(unittest.TestCase):
    def setUp(self):
        self.write = profile([line("added", text, new=index + 1)
                              for index, text in enumerate(INITIAL.splitlines(keepends=True))], created=True)
        self.edit_one = profile([
            line("context", "FILE_CHANGE_HEADER\n", 1, 1),
            line("removed", "phase=one\n", 2), line("added", "phase=two\n", new=2),
            line("context", "FILE_CHANGE_FOOTER\n", 3, 3)])
        self.edit_two = profile([
            line("context", "FILE_CHANGE_HEADER\n", 1, 1),
            line("context", "phase=two\n", 2, 2),
            line("removed", "FILE_CHANGE_FOOTER\n", 3),
            line("added", "FILE_CHANGE_FOOTER_FINAL\n", new=3)])

    def test_three_independent_operations_match_real_native_line_endings(self):
        verify_transition(self.write, "", INITIAL)
        verify_transition(self.edit_one, INITIAL, EDITED)
        verify_transition(self.edit_two, EDITED, FINAL)
        self.assertEqual(supplied_lines(self.edit_one), [
            " FILE_CHANGE_HEADER", "-phase=one", "+phase=two", " FILE_CHANGE_FOOTER"])

    def test_second_edit_cannot_be_substituted_with_cumulative_change(self):
        cumulative = copy.deepcopy(self.edit_two)
        cumulative["hunks"][0]["lines"][1:2] = [
            line("removed", "phase=one\n", 2), line("added", "phase=two\n", new=2)]
        cumulative.update(additions=2, deletions=2)
        with self.assertRaises(AssertionError):
            verify_transition(cumulative, EDITED, FINAL)

    def test_missing_or_invented_counts_fail_native_primary(self):
        for key, value in (("additions", None), ("deletions", 0), ("additions", 10)):
            wrong = copy.deepcopy(self.edit_one)
            wrong[key] = value
            with self.subTest(key=key, value=value), self.assertRaises(AssertionError):
                verify_transition(wrong, INITIAL, EDITED)

    def test_wrong_path_and_partial_unavailable_or_binary_are_not_complete_proof(self):
        for key, value in (("path", "different.txt"), ("binary", True),
                           ("partial", True), ("truncated", True), ("unavailable", True)):
            wrong = copy.deepcopy(self.edit_one)
            wrong[key] = value
            with self.subTest(key=key), self.assertRaises(AssertionError):
                verify_transition(wrong, INITIAL, EDITED)

    def test_prefixes_preserve_spaces_and_only_remove_native_line_endings(self):
        value = profile([line("removed", "  old  \r\n"), line("added", "  new  \n")])
        self.assertEqual(supplied_lines(value), ["-  old  ", "+  new  "])


class SyntheticRenderedHistoryTests(unittest.TestCase):
    def test_fixtures_explicitly_labelled_and_unique(self):
        rows = synthetic_history_rows("real-last-entry")
        self.assertEqual(len(rows), 4)
        self.assertEqual(len({row["tool"]["invocation_id"] for row in rows}), 4)
        self.assertEqual(len({row["tool"]["call_id"] for row in rows}), 4)
        for row in rows:
            self.assertEqual(row["entry_id"], "real-last-entry")
            self.assertTrue(row["historical"])
            self.assertIn("SYNTHETIC", row["tool"]["title"])
            self.assertIn("not native execution", row["tool"]["output"])
            value = row["tool"]["output_profile"]["files"][0]
            for key in ("binary", "partial", "truncated", "unavailable"):
                self.assertIsInstance(value[key], bool)

    def test_unknown_counts_binary_and_unavailable_never_invent_text(self):
        files = [row["tool"]["output_profile"]["files"][0] for row in synthetic_history_rows("entry")]
        for value in files[:3]:
            self.assertIsNone(value["additions"])
            self.assertIsNone(value["deletions"])
        self.assertTrue(files[0]["binary"])
        self.assertEqual(files[0]["hunks"], [])
        self.assertTrue(files[2]["unavailable"])
        self.assertEqual(files[2]["hunks"], [])
        self.assertTrue(files[1]["partial"])
        self.assertIsNone(files[1]["hunks"][0]["lines"][0]["old_line"])

    def test_large_fixture_exceeds_renderer_but_not_bounded_history_budget(self):
        large = synthetic_history_rows("entry")[-1]["tool"]["output_profile"]
        self.assertTrue(large["truncated"])
        value = large["files"][0]
        self.assertTrue(value["partial"])
        self.assertGreater(len(value["hunks"][0]["lines"]), 400)
        self.assertGreater(sum(len(text) for text in supplied_lines(value)), 16 * 1024)
        self.assertLess(len(json.dumps(large).encode()), 128 * 1024)

    def test_interception_preserves_cut_pagination_and_original_without_mutation(self):
        native = {"cut": {"journal": "root", "leaf": "immutable-real-cut"},
                  "rows": [{"id": "real-row", "kind": "assistant", "text": "actual public output"}],
                  "older": False, "newer": False, "first_id": "real-first", "last_id": "real-last"}
        unchanged = copy.deepcopy(native)
        injected = inject_synthetic_history(native)
        self.assertEqual(native, unchanged)
        for key in ("cut", "older", "newer", "first_id", "last_id"):
            self.assertEqual(injected[key], native[key])
        self.assertEqual(injected["rows"][0], native["rows"][0])
        self.assertEqual(len(injected["rows"]), 5)
        self.assertLess(len(json.dumps(injected).encode()), 128 * 1024)

    def test_fixture_refuses_missing_native_page_identity_or_over_budget(self):
        with self.assertRaises(AssertionError):
            inject_synthetic_history({"rows": [], "last_id": None})
        with self.assertRaisesRegex(AssertionError, "page budget"):
            inject_synthetic_history({"rows": [{"text": "x" * (128 * 1024)}], "last_id": "real"})


class DriverWiringTests(unittest.TestCase):
    def test_cli_exposes_both_workloads_without_starting_application(self):
        driver = Path(__file__).with_name("coding_browser_acceptance.py")
        result = subprocess.run([sys.executable, str(driver), "--help"], capture_output=True,
                                text=True, timeout=15, check=True)
        self.assertIn("file-changes", result.stdout)
        self.assertIn("file-changes-live", result.stdout)


if __name__ == "__main__":
    unittest.main()
