# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026-present the Unsloth AI Inc. team. All rights reserved.
"""Native GitHub snapshot fixtures and fail-closed deterministic frontier tests.

Fixture shape: parent/children are REST issue objects, blocker lists contain full
REST issue objects (not IDs or body-derived links), and comment lists contain
REST comment objects. Dictionary keys for blockers/comments are issue numbers
encoded as strings. CAMPAIGN_* records the graph read from wasimysaid/unsloth
#233 on 2026-10-12; tests never need credentials or network access.
"""

from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))

from mimir_ticket_runner.github import API_TIMEOUT_SECONDS, GitHub, GitHubError
from mimir_ticket_runner.graph import plan

REPO = "wasimysaid/unsloth"
REPO_URL = f"https://api.github.com/repos/{REPO}"
CAMPAIGN_TITLES = {
    234: "Open a coding conversation in a trusted project folder",
    235: "Run and stop a coding request",
    236: "Reopen and reconnect without duplicating work",
    237: "Answer Mimir questions safely",
    238: "Inspect live and historical reported file changes",
    239: "Plan work and explicitly choose implementation",
    240: "Manage autonomous goals",
    241: "Inspect subagent attempts and results",
    242: "Send skill mentions and image attachments",
    243: "Discover commands and inspect current-session context",
    244: "Choose the next-request model and reasoning effort",
    245: "Refresh model choices in an open conversation",
    246: "Run Studio local models with whole-request protection",
    247: "Run independent conversations and warn about project overlap",
    248: "Retire only continuously idle, unviewed conversations",
    249: "Recover from process loss and maintain the runtime safely",
    250: "Save native MCP configuration without losing drafts",
    251: "Apply and reconnect configured MCP servers safely",
    252: "Inspect extensions and perform accurately scoped maintenance",
    253: "Keep long coding conversations readable",
    254: "Verify cross-feature integration and ordinary-chat regressions",
    255: "Complete live workloads and rendered browser acceptance",
    256: "Obtain implemented-UI review and resolve corrections",
}
CAMPAIGN_DEPENDENCIES = {
    234: [], 235: [234], 236: [235], 237: [236], 238: [236],
    239: [236], 240: [236], 241: [236], 242: [235], 243: [236],
    244: [235], 245: [244], 246: [237, 244], 247: [236],
    248: [236], 249: [236], 250: [234], 251: [250, 235],
    252: [235], 253: [238], 254: list(range(234, 254)),
    255: [254], 256: [255],
}


def issue(number: int, **changes) -> dict:
    """Representative full issue fields; extra API fields must be retained."""
    value = {
        "id": 100000 + number,
        "node_id": f"I_{number}",
        "number": number,
        "url": f"{REPO_URL}/issues/{number}",
        "repository_url": REPO_URL,
        "html_url": f"https://github.com/{REPO}/issues/{number}",
        "title": CAMPAIGN_TITLES.get(number, f"Ticket {number}"),
        "body": "Implementation slice. Body links do not define dependencies.",
        "state": "open",
        "state_reason": None,
        "labels": [{"id": 1, "name": "ready-for-agent"}],
        "assignees": [],
        "user": {"login": "ticket-author"},
        "updated_at": "2026-10-12T08:00:00Z",
    }
    value.update(changes)
    return value


def comment(number: int, comment_id: int) -> dict:
    return {
        "id": comment_id,
        "node_id": f"IC_{comment_id}",
        "url": f"{REPO_URL}/issues/comments/{comment_id}",
        "issue_url": f"{REPO_URL}/issues/{number}",
        "user": {"login": "reviewer"},
        "body": f"Full comment {comment_id}",
        "created_at": "2026-10-12T08:00:00Z",
        "reactions": {"total_count": 1, "+1": 1},
    }


def snapshot(children: list[dict], dependencies: dict[int, list[dict]] | None = None) -> dict:
    return {
        "parent": issue(233, title = "Build a polished Mimir coding experience in Studio"),
        "issues": deepcopy(children),
        "blockers": {
            str(child["number"]): deepcopy((dependencies or {}).get(child["number"], []))
            for child in children
        },
        "comments": {str(number): [] for number in [233, *(child["number"] for child in children)]},
    }


def campaign_snapshot(completed: set[int] | None = None) -> dict:
    integrated = set(completed or ())
    children = {
        number: issue(number, **({"state": "closed", "state_reason": "completed"} if number in integrated else {}))
        for number in CAMPAIGN_TITLES
    }
    return snapshot(list(children.values()), {
        number: [children[blocker] for blocker in predecessors]
        for number, predecessors in CAMPAIGN_DEPENDENCIES.items()
    })


def ready_numbers(result: dict) -> list[int]:
    return [item["number"] for item in result["ready"]]


def reasons_for(result: dict, number: int) -> list[str]:
    return next(item["reasons"] for item in result["blocked"] if item["number"] == number)


class GitHubTests(unittest.TestCase):
    def setUp(self):
        self.github = GitHub(REPO)

    @patch("mimir_ticket_runner.github.subprocess.run")
    def test_request_uses_explicit_repo_get_shell_false_and_timeout(self, run):
        expected = issue(234)
        run.return_value = subprocess.CompletedProcess([], 0, json.dumps(expected), "")
        endpoint = f"repos/{REPO}/issues/234"
        self.assertEqual(self.github.request(endpoint), expected)
        args, kwargs = run.call_args
        self.assertEqual(args[0][:3], ["gh", "api", endpoint])
        self.assertIn("GET", args[0])
        self.assertIn("X-GitHub-Api-Version: 2022-11-28", args[0])
        self.assertFalse(kwargs["shell"])
        self.assertTrue(kwargs["check"])
        self.assertEqual(kwargs["timeout"], API_TIMEOUT_SECONDS)
        self.assertIsNone(kwargs["input"])

    @patch("mimir_ticket_runner.github.subprocess.run")
    def test_request_json_payload_has_explicit_method_and_no_interpolation(self, run):
        # Mock-only: this unit test performs no GitHub mutation.
        payload = {"body": "$(touch unsafe); quotes ' and \" remain data"}
        run.return_value = subprocess.CompletedProcess([], 0, '{"id": 1}', "")
        self.assertEqual(self.github.request(f"repos/{REPO}/issues/234/comments", "POST", payload), {"id": 1})
        args, kwargs = run.call_args
        self.assertEqual(args[0][-2:], ["--input", "-"])
        self.assertIn("POST", args[0])
        self.assertEqual(json.loads(kwargs["input"]), payload)
        self.assertFalse(kwargs["shell"])

    @patch("mimir_ticket_runner.github.subprocess.run")
    def test_successful_no_content_request_returns_none(self, run):
        run.return_value = subprocess.CompletedProcess([], 0, "", "")
        self.assertIsNone(self.github.request(f"repos/{REPO}/issues/234", "DELETE"))

    @patch("mimir_ticket_runner.github.subprocess.run")
    def test_pages_flattens_all_concatenated_json_arrays(self, run):
        values = [comment(234, number) for number in range(1, 5)]
        run.return_value = subprocess.CompletedProcess([], 0, " \n" + json.dumps(values[:2]) + json.dumps([]) + "\n" + json.dumps(values[2:]) + " \n", "")
        self.assertEqual(self.github.pages(f"repos/{REPO}/issues/234/comments"), values)
        args = run.call_args.args[0]
        self.assertIn("--paginate", args)
        self.assertEqual(args[2], f"repos/{REPO}/issues/234/comments?per_page=100")
        self.assertIn("GET", args)

    @patch("mimir_ticket_runner.github.subprocess.run")
    def test_pages_preserves_query_and_page_size(self, run):
        run.return_value = subprocess.CompletedProcess([], 0, "[]", "")
        self.assertEqual(self.github.pages(f"repos/{REPO}/issues?state=all&per_page=2"), [])
        self.assertEqual(run.call_args.args[0][2], f"repos/{REPO}/issues?state=all&per_page=2")

    @patch("mimir_ticket_runner.github.subprocess.run")
    def test_malformed_or_missing_pages_fail_closed(self, run):
        for output in ["", " \n", "null", "{}", "[]\n{bad", "[] trailing", "[1]\n{}"]:
            with self.subTest(output = output):
                run.return_value = subprocess.CompletedProcess([], 0, output, "")
                with self.assertRaises(GitHubError):
                    self.github.pages(f"repos/{REPO}/issues/234/comments")

    @patch("mimir_ticket_runner.github.subprocess.run")
    def test_request_invalid_json_is_an_error(self, run):
        run.return_value = subprocess.CompletedProcess([], 0, "not JSON", "")
        with self.assertRaises(GitHubError):
            self.github.request(f"repos/{REPO}/issues/234")

    @patch("mimir_ticket_runner.github.subprocess.run")
    def test_read_errors_never_return_empty_fallback(self, run):
        endpoint = f"repos/{REPO}/issues/234"
        failures = [
            subprocess.CalledProcessError(1, ["gh"], output = "[]", stderr = "HTTP 403"),
            subprocess.TimeoutExpired(["gh"], API_TIMEOUT_SECONDS),
            FileNotFoundError("gh not installed"),
        ]
        for operation in (self.github.request, self.github.pages):
            for failure in failures:
                with self.subTest(operation = operation.__name__, failure = type(failure).__name__):
                    run.reset_mock()
                    run.side_effect = failure
                    with self.assertRaises(GitHubError):
                        operation(endpoint)
                    run.assert_called_once()

    @patch("mimir_ticket_runner.github.subprocess.run")
    def test_uncertain_write_timeout_is_not_retried(self, run):
        run.side_effect = subprocess.TimeoutExpired(["gh"], API_TIMEOUT_SECONDS)
        with self.assertRaisesRegex(GitHubError, "requires reconciliation"):
            self.github.request(f"repos/{REPO}/issues/234/comments", "POST", {"body": "status"})
        run.assert_called_once()

    @patch("mimir_ticket_runner.github.subprocess.run")
    def test_repository_and_endpoint_validation_before_subprocess(self, run):
        for repo in ["unsloth", "", "-R wasimysaid/unsloth", "owner/repo/extra", "owner/repo;echo bad"]:
            with self.subTest(repo = repo), self.assertRaises(ValueError):
                GitHub(repo)
        for endpoint in [
            "issues/234", "/repos/wasimysaid/unsloth/issues/234",
            "repos/unslothai/unsloth/issues/234", "repos/wasimysaid/unsloth-other/issues/234",
            "https://api.github.com/repos/wasimysaid/unsloth/issues/234",
            f"repos/{REPO}/../other/issues/234", f"repos/{REPO}/issues/%2e%2e/234",
            f"repos/{REPO}/issues/234#fragment", "--hostname=example.com",
        ]:
            with self.subTest(endpoint = endpoint), self.assertRaises(ValueError):
                self.github.request(endpoint)
        run.assert_not_called()

    @patch("mimir_ticket_runner.github.subprocess.run")
    def test_snapshot_keeps_full_issues_blockers_and_comments_from_every_page(self, run):
        parent, first, second = issue(233), issue(234), issue(235)
        external = issue(999, repository_url = "https://api.github.com/repos/other/repo")
        base = f"repos/{REPO}/issues"
        output = {
            f"{base}/233": json.dumps(parent),
            f"{base}/233/sub_issues": json.dumps([second]) + "\n" + json.dumps([first]),
            f"{base}/233/comments": json.dumps([comment(233, 1)]) + json.dumps([comment(233, 2)]),
            f"{base}/234/dependencies/blocked_by": "[]",
            f"{base}/234/comments": "[]",
            f"{base}/235/dependencies/blocked_by": json.dumps([first]) + json.dumps([external]),
            f"{base}/235/comments": json.dumps([comment(235, 3)]) + json.dumps([comment(235, 4)]),
        }

        def api(args, **kwargs):
            self.assertIn("GET", args)
            return subprocess.CompletedProcess(args, 0, output[urlsplit(args[2]).path], "")

        run.side_effect = api
        actual = self.github.snapshot(233)
        self.assertEqual(actual, {
            "parent": parent, "issues": [second, first],
            "blockers": {"234": [], "235": [first, external]},
            "comments": {"233": [comment(233, 1), comment(233, 2)], "234": [], "235": [comment(235, 3), comment(235, 4)]},
        })
        self.assertEqual(run.call_count, 7)
        self.assertEqual(actual["comments"]["235"][0]["reactions"], {"total_count": 1, "+1": 1})

    @patch.object(GitHub, "pages")
    @patch.object(GitHub, "request")
    def test_snapshot_propagates_native_dependency_read_failure(self, request, pages):
        request.return_value = issue(233)
        pages.side_effect = [[issue(234)], [], GitHubError("HTTP 403 native dependencies")]
        with self.assertRaisesRegex(GitHubError, "HTTP 403"):
            self.github.snapshot(233)
        self.assertTrue(pages.call_args.args[0].endswith("/dependencies/blocked_by"))

    @patch.object(GitHub, "pages")
    @patch.object(GitHub, "request")
    def test_snapshot_rejects_missing_parent_bad_children_and_other_repositories(self, request, pages):
        request.return_value = None
        with self.assertRaises(GitHubError):
            self.github.snapshot(233)
        pages.assert_not_called()
        request.return_value = issue(233)
        external_without_repository = issue(234, url = "https://api.github.com/repos/other/repo/issues/234")
        del external_without_repository["repository_url"]
        unidentified = issue(234)
        del unidentified["repository_url"]
        del unidentified["url"]
        for children in [
            [{}], [issue(234), issue(234)], [issue(233)],
            [issue(234, repository_url = "https://api.github.com/repos/other/repo")],
            [external_without_repository], [unidentified],
        ]:
            with self.subTest(children = children):
                pages.return_value = children
                with self.assertRaises(GitHubError):
                    self.github.snapshot(233)
        for number in (0, -1, True, "233"):
            with self.subTest(number = number), self.assertRaises(ValueError):
                self.github.snapshot(number)


class GraphTests(unittest.TestCase):
    def test_actual_initial_campaign_frontier_is_only_root(self):
        result = plan(campaign_snapshot(), set(CAMPAIGN_TITLES))
        self.assertEqual(ready_numbers(result), [234])
        self.assertEqual(result["ready"][0]["title"], CAMPAIGN_TITLES[234])
        self.assertEqual([item["number"] for item in result["blocked"]], list(range(235, 257)))
        self.assertEqual(result["cycles"], [])
        self.assertEqual(result["unapproved"], [])

    def test_actual_next_campaign_frontier_requires_root_integration_receipt(self):
        snap = campaign_snapshot({234})
        approved = set(CAMPAIGN_TITLES)
        self.assertEqual(ready_numbers(plan(snap, approved)), [])
        result = plan(snap, approved, completed = {234})
        self.assertEqual(ready_numbers(result), [235, 250])
        self.assertNotIn(234, [item["number"] for item in result["blocked"]])

    def test_frontier_and_reasons_are_deterministic_and_input_is_unchanged(self):
        snap = snapshot([issue(240), issue(239), issue(238), issue(234), issue(235)], {
            240: [issue(239), issue(235)], 239: [issue(235), issue(234)],
        })
        approved = {234, 235, 238, 239, 240}
        before = deepcopy(snap)
        expected = plan(snap, approved)
        self.assertEqual(ready_numbers(expected), [234, 235, 238])
        self.assertEqual([item["number"] for item in expected["blocked"]], [239, 240])
        self.assertEqual(snap, before)
        snap["issues"].reverse()
        for entries in snap["blockers"].values():
            entries.reverse()
        self.assertEqual(plan(snap, approved), expected)
        self.assertEqual(approved, {234, 235, 238, 239, 240})

    def test_native_dependencies_not_body_links_are_authoritative(self):
        snap = snapshot([issue(234, body = "Blocked by #235"), issue(235, body = "Blocked by: None")], {235: [issue(234)]})
        result = plan(snap, {234, 235})
        self.assertEqual(ready_numbers(result), [234])
        self.assertTrue(any("blocker #234" in reason for reason in reasons_for(result, 235)))

    def test_assigned_tickets_require_owned_ticket_id(self):
        snap = snapshot([issue(234, assignees = [{"login": "someone-else"}]), issue(235)])
        self.assertEqual(ready_numbers(plan(snap, {234, 235})), [235])
        self.assertEqual(ready_numbers(plan(snap, {234, 235}, owned = {234})), [234, 235])
        self.assertIn("assigned to another owner", reasons_for(plan(snap, {234, 235}), 234))

    def test_missing_assignee_data_does_not_mean_unassigned(self):
        child = issue(234)
        del child["assignees"]
        result = plan(snapshot([child]), {234})
        self.assertEqual(result["ready"], [])
        self.assertIn("assignee data missing or invalid", reasons_for(result, 234))

    def test_human_ticket_is_blocked_even_if_ready_and_owned(self):
        result = plan(snapshot([issue(234)]), {234}, owned = {234}, human = {234})
        self.assertEqual(result["ready"], [])
        self.assertIn("human review", reasons_for(result, 234))

    def test_labels_exclude_not_ready_and_wayfinder_issues(self):
        snap = snapshot([
            issue(234, labels = []),
            issue(235, labels = [{"name": "ready-for-agent"}, {"name": "wayfinder:decision"}]),
            issue(236, labels = ["ready-for-agent", "wayfinder:resolved"]),
            issue(237, labels = ["ready-for-agent"]),
        ])
        result = plan(snap, {234, 235, 236, 237})
        self.assertEqual(ready_numbers(result), [237])
        self.assertIn("missing ready-for-agent label", reasons_for(result, 234))
        for number in (235, 236):
            self.assertIn("wayfinder decision issue", reasons_for(result, number))

    def test_unapproved_additions_never_expand_ready_frontier(self):
        result = plan(snapshot([issue(240), issue(234), issue(239)]), {234})
        self.assertEqual(ready_numbers(result), [234])
        self.assertEqual(result["unapproved"], [239, 240])
        self.assertEqual(result["blocked"], [])

    def test_unapproved_prerequisite_blocks_even_with_integration_receipt(self):
        integrated = issue(234, state = "closed", state_reason = "completed")
        result = plan(snapshot([integrated, issue(235)], {235: [integrated]}), {235}, completed = {234})
        self.assertEqual(result["ready"], [])
        self.assertEqual(result["unapproved"], [234])
        self.assertIn("blocker #234 outside approved direct-child scope", reasons_for(result, 235))

    def test_cycles_sorted_including_self_cycle_and_unapproved_nodes(self):
        children = [issue(number) for number in [241, 240, 239, 238, 237, 236, 235, 234]]
        snap = snapshot(children, {
            234: [issue(235)], 235: [issue(236)], 236: [issue(234)],
            238: [issue(238)], 239: [issue(240)], 240: [issue(239)],
            241: [issue(234)],
        })
        result = plan(snap, set(range(234, 242)) - {240})
        self.assertEqual(result["cycles"], [[234, 235, 236], [238], [239, 240]])
        self.assertEqual(ready_numbers(result), [237])
        for number in [234, 235, 236, 238, 239]:
            self.assertIn("dependency cycle", reasons_for(result, number))
        self.assertEqual(result["unapproved"], [240])

    def test_closed_ticket_without_receipt_is_blocked_not_complete(self):
        result = plan(snapshot([issue(234, state = "closed", state_reason = "completed")]), {234})
        self.assertEqual(result["ready"], [])
        self.assertIn("closed issue has no integration receipt", reasons_for(result, 234))

    def test_closed_completed_receipted_ticket_is_omitted(self):
        result = plan(snapshot([issue(234, state = "closed", state_reason = "completed")]), {234}, completed = {234})
        self.assertEqual(result, {"ready": [], "blocked": [], "cycles": [], "unapproved": []})

    def test_prerequisites_require_both_native_completed_closure_and_receipt(self):
        cases = [
            ("open", None, set(), False),
            ("open", None, {234}, False),
            ("closed", "completed", set(), False),
            ("closed", None, {234}, False),
            ("closed", "not_planned", set(), False),
            ("closed", "not_planned", {234}, False),
            ("closed", "cancelled", {234}, False),
            ("closed", "completed", {234}, True),
        ]
        for state, state_reason, receipts, eligible in cases:
            with self.subTest(state = state, state_reason = state_reason, receipts = receipts):
                prerequisite = issue(234, state = state, state_reason = state_reason)
                snap = snapshot([prerequisite, issue(235)], {235: [prerequisite]})
                result = plan(snap, {234, 235}, completed = receipts)
                self.assertEqual(235 in ready_numbers(result), eligible)
                if state_reason in {"cancelled", "not_planned"}:
                    self.assertIn("blocker #234 cancelled", reasons_for(result, 235))

    def test_external_or_removed_prerequisites_block_despite_closed_receipts(self):
        for number, repo in [(999, REPO_URL), (234, "https://api.github.com/repos/other/repo")]:
            with self.subTest(number = number, repo = repo):
                prerequisite = issue(number, state = "closed", state_reason = "completed", repository_url = repo)
                children = [issue(235)]
                if number == 234:
                    children.append(issue(234, state = "closed", state_reason = "completed"))
                result = plan(snapshot(children, {235: [prerequisite]}), {234, 235}, completed = {number})
                self.assertEqual(result["ready"], [])
                self.assertTrue(any("outside" in reason for reason in reasons_for(result, 235)))

    def test_child_repository_mismatch_cannot_supply_integrated_prerequisite(self):
        external_child = issue(234, state = "closed", state_reason = "completed", repository_url = "https://api.github.com/repos/other/repo")
        native_blocker = issue(234, state = "closed", state_reason = "completed")
        result = plan(snapshot([external_child, issue(235)], {235: [native_blocker]}), {234, 235}, completed = {234})
        self.assertEqual(result["ready"], [])
        self.assertTrue(any("repository" in reason for reason in reasons_for(result, 235)))

    def test_missing_blocker_data_and_metadata_block(self):
        snap = snapshot([issue(234), issue(235)], {235: [{}]})
        del snap["blockers"]["234"]
        result = plan(snap, {234, 235})
        self.assertEqual(result["ready"], [])
        self.assertIn("native blocker data missing", reasons_for(result, 234))
        self.assertIn("blocker issue metadata missing", reasons_for(result, 235))

    def test_inconsistent_child_and_native_blocker_states_do_not_unlock(self):
        closed = issue(234, state = "closed", state_reason = "completed")
        for child, blocker in [(issue(234), closed), (closed, issue(234))]:
            with self.subTest(child_state = child["state"]):
                result = plan(snapshot([child, issue(235)], {235: [blocker]}), {234, 235}, completed = {234})
                self.assertNotIn(235, ready_numbers(result))
                self.assertTrue(any("inconsistent metadata" in reason for reason in reasons_for(result, 235)))

    def test_open_ticket_with_existing_receipt_requires_reconciliation(self):
        result = plan(snapshot([issue(234)]), {234}, completed = {234})
        self.assertEqual(result["ready"], [])
        self.assertIn("integration receipt conflicts with open issue state", reasons_for(result, 234))

    def test_all_blockers_must_be_integrated(self):
        first = issue(234, state = "closed", state_reason = "completed")
        second = issue(235, state = "closed", state_reason = "completed")
        snap = snapshot([first, second, issue(236)], {236: [second, first]})
        self.assertEqual(ready_numbers(plan(snap, {234, 235, 236}, completed = {234})), [])
        self.assertEqual(ready_numbers(plan(snap, {234, 235, 236}, completed = {234, 235})), [236])

    def test_malformed_snapshot_fails_closed(self):
        valid = snapshot([issue(234)])
        malformed = [
            {}, {**valid, "issues": None}, {**valid, "blockers": []},
            {**valid, "issues": [issue(234), issue(234)]},
            {**valid, "issues": [issue(233)]},
            {**valid, "issues": [issue(True)]},
            {**valid, "blockers": {"234": "unknown"}},
            {**valid, "blockers": {"234": [234]}},
        ]
        for snap in malformed:
            with self.subTest(snapshot = snap), self.assertRaises(ValueError):
                plan(snap, {234})


if __name__ == "__main__":
    unittest.main()
