# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026-present the Unsloth AI Inc. team. All rights reserved.
"""Paired transaction contracts using temporary real Git and fake GitHub.

These are not live GitHub proof. All remote writes go to a stateful in-memory
REST contract or a local bare repository; reviewer/check execution is replaced
only in orchestration tests, and is covered separately by test_verification.
"""
from copy import deepcopy
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from scripts.mimir_ticket_runner import engine, integration, verification
from scripts.mimir_ticket_runner.common import RunnerError, atomic_json, digest, git, read_json
from scripts.mimir_ticket_runner.state import Store


def authority_snapshot():
    """A claimed approved child and its frozen native GitHub scope."""
    return {'parent': {'number': 233, 'body': 'Approved specification'},
            'issues': [{'number': 234, 'title': 'Implement feature', 'body': '- [ ] Implement feature',
                        'state': 'open', 'state_reason': None, 'labels': [{'name': 'ready-for-agent'}],
                        'assignees': [{'login': 'wasimysaid'}]}],
            'comments': {'233': [], '234': []}, 'blockers': {'234': []}}


class ReadContract:
    """Unexpected endpoints or writes fail the test rather than quietly succeed."""
    def __init__(self, repo='wasimysaid/unsloth', responses=None, pages=None):
        self.repo = repo
        self.responses = responses or {}
        self.page_responses = pages or {}
        self.calls = []

    def request(self, endpoint, method='GET', payload=None):
        self.calls.append((method, endpoint, deepcopy(payload)))
        if method != 'GET' or endpoint not in self.responses:
            raise AssertionError(f'Unexpected GitHub request: {method} {endpoint}')
        result = self.responses[endpoint]
        if isinstance(result, Exception):
            raise result
        return deepcopy(result)

    def pages(self, endpoint):
        self.calls.append(('PAGES', endpoint, None))
        if endpoint not in self.page_responses:
            raise AssertionError(f'Unexpected GitHub pages: {endpoint}')
        result = self.page_responses[endpoint]
        if isinstance(result, Exception):
            raise result
        return deepcopy(result)


class CIContractTests(unittest.TestCase):
    def checks(self, statuses=None, runs=None, **changes):
        sha = 'a' * 40
        gh = ReadContract(responses={
            f'repos/wasimysaid/unsloth/commits/{sha}/status': {'statuses': statuses if statuses is not None else []},
            f'repos/wasimysaid/unsloth/commits/{sha}/check-runs?per_page=100': {
                'check_runs': runs if runs is not None else [], 'total_count': len(runs or []), **changes}})
        return gh, sha

    def test_required_contexts_union_classic_and_ruleset_requirements(self):
        gh = ReadContract(responses={
            'repos/wasimysaid/unsloth/branches/mimir-studio': {'protected': True},
            'repos/wasimysaid/unsloth/branches/mimir-studio/protection': {
                'required_status_checks': {'contexts': ['legacy'], 'checks': [{'context': 'build', 'app_id': 7}]}}},
            pages={'repos/wasimysaid/unsloth/rules/branches/mimir-studio': [
                {'type': 'required_status_checks', 'parameters': {
                    'required_status_checks': [{'context': 'ruleset-test', 'integration_id': 8}]}},
                {'type': 'pull_request', 'parameters': {}}]})
        self.assertEqual(integration.required_contexts(gh, 'mimir-studio'), {'legacy', 'build', 'ruleset-test'})

    def test_unprotected_branch_still_reads_rulesets(self):
        gh = ReadContract(responses={'repos/wasimysaid/unsloth/branches/mimir-studio': {'protected': False}},
                          pages={'repos/wasimysaid/unsloth/rules/branches/mimir-studio': [
                              {'type': 'required_status_checks', 'parameters': {
                                  'required_status_checks': [{'context': 'build'}]}}]})
        self.assertEqual(integration.required_contexts(gh, 'mimir-studio'), {'build'})

    def test_protection_or_ruleset_access_error_cannot_mean_no_requirements(self):
        for protected in (False, True):
            with self.subTest(protected=protected):
                gh = ReadContract(responses={
                    'repos/wasimysaid/unsloth/branches/mimir-studio': {'protected': protected},
                    'repos/wasimysaid/unsloth/branches/mimir-studio/protection': RunnerError('403 protection')},
                    pages={'repos/wasimysaid/unsloth/rules/branches/mimir-studio': RunnerError('403 rules')})
                with self.assertRaisesRegex(RunnerError, '403'):
                    integration.required_contexts(gh, 'mimir-studio')

    def test_required_status_and_required_check_must_both_pass(self):
        gh, sha = self.checks([{'context': 'legacy', 'state': 'success'}],
                              [{'name': 'build', 'status': 'completed', 'conclusion': 'success'}])
        self.assertTrue(integration.checks_ready(gh, sha, {'legacy', 'build'}))
        self.assertTrue(all(sha in endpoint for _, endpoint, _ in gh.calls))

    def test_missing_required_ci_is_not_ready(self):
        gh, sha = self.checks()
        with self.assertRaisesRegex(RunnerError, 'Required GitHub checks are absent'):
            integration.checks_ready(gh, sha, {'build'})

    def test_pending_status_or_check_waits(self):
        for statuses, runs in (([{'context': 'build', 'state': 'pending'}], []),
                               ([], [{'name': 'build', 'status': 'in_progress', 'conclusion': None}])):
            with self.subTest(statuses=statuses, runs=runs):
                gh, sha = self.checks(statuses, runs)
                self.assertFalse(integration.checks_ready(gh, sha, {'build'}))

    def test_failed_optional_and_required_ci_blocks_merge(self):
        for state in ('failure', 'error'):
            for required in (set(), {'build'}):
                with self.subTest(state=state, required=required):
                    gh, sha = self.checks([{'context': 'build', 'state': state}])
                    with self.assertRaises(RunnerError):
                        integration.checks_ready(gh, sha, required)
        for conclusion in ('failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale'):
            with self.subTest(conclusion=conclusion):
                gh, sha = self.checks(runs=[{'name': 'build', 'status': 'completed', 'conclusion': conclusion}])
                with self.assertRaises(RunnerError):
                    integration.checks_ready(gh, sha, set())

    def test_skipped_or_neutral_cannot_satisfy_required_checks(self):
        for conclusion in ('skipped', 'neutral'):
            with self.subTest(conclusion=conclusion):
                gh, sha = self.checks(runs=[{'name': 'build', 'status': 'completed', 'conclusion': conclusion}])
                with self.assertRaisesRegex(RunnerError, 'required GitHub check did not pass'):
                    integration.checks_ready(gh, sha, {'build'})

    def test_latest_status_cannot_be_masked_by_older_success(self):
        gh, sha = self.checks([{'context': 'build', 'state': 'failure'},
                              {'context': 'build', 'state': 'success'}])
        with self.assertRaises(RunnerError):
            integration.checks_ready(gh, sha, {'build'})

    def test_missing_or_truncated_check_metadata_fails_closed(self):
        for change in ({'check_runs': None}, {'total_count': 101}):
            with self.subTest(change=change):
                gh, sha = self.checks(**change)
                with self.assertRaisesRegex(RunnerError, 'metadata is missing or exceeds'):
                    integration.checks_ready(gh, sha, set())
        gh, sha = self.checks()
        gh.responses[f'repos/{gh.repo}/commits/{sha}/status'] = {}
        with self.assertRaisesRegex(RunnerError, 'status metadata is missing'):
            integration.checks_ready(gh, sha, set())


class AuthorityTests(unittest.TestCase):
    """Exercise the real helper and real scope reconciliation, with no Git needed."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='authority-', dir=Path(__file__).parent)
        self.addCleanup(self.temp.cleanup)
        self.config = SimpleNamespace(root=Path(self.temp.name), fingerprint='authority-policy', data={},
                                      campaign={'id': 'authority', 'repo': 'wasimysaid/unsloth', 'parent': 233},
                                      tickets={234: {}}, approved={234})
        self.snapshot_data = authority_snapshot()
        self.store = Store(self.config)
        self.addCleanup(self.store.db.close)
        item = engine.scope(self.snapshot_data, 234)
        self.store.update(234, 'merging', scope=item, input_sha256=digest(item))
        engine.reconcile_scope(self.config, self.store, self.snapshot_data)
        self.reads = []
        self.read_error = None
        fixture = self
        class SnapshotContract:
            def snapshot(self, parent):
                fixture.reads.append(parent)
                if parent != 233:
                    raise AssertionError('Wrong parent scope requested')
                if fixture.read_error:
                    raise fixture.read_error
                return deepcopy(fixture.snapshot_data)
        self.gh = SnapshotContract()
        patcher = patch.object(integration, 'GitHub', return_value=self.gh)
        self.factory = patcher.start()
        self.addCleanup(patcher.stop)

    def require(self):
        return integration.require_authority(self.config, self.store, 234)

    def test_open_claimed_ready_ticket_retains_authority_and_reads_exact_campaign(self):
        self.require()
        self.factory.assert_called_once_with('wasimysaid/unsloth')
        self.assertEqual(self.reads, [233])
        self.assertEqual(self.store.get(234)['state'], 'merging')

    def test_every_call_refreshes_authority_instead_of_reusing_prior_snapshot(self):
        self.require()
        self.snapshot_data['issues'][0]['assignees'] = [{'login': 'another-owner'}]
        with self.assertRaises(RunnerError):
            self.require()
        self.assertEqual(self.reads, [233, 233])

    def test_ticket_body_title_and_user_comment_changes_invalidate_frozen_scope(self):
        original = deepcopy(self.snapshot_data)
        for change in ('body', 'title', 'comment'):
            with self.subTest(change=change):
                self.snapshot_data = deepcopy(original)
                if change == 'comment':
                    self.snapshot_data['comments']['234'].append({'id': 9, 'body': 'New user requirement'})
                else:
                    self.snapshot_data['issues'][0][change] += ' changed'
                with self.assertRaises(RunnerError):
                    self.require()

    def test_parent_body_and_clarification_changes_reconcile_whole_campaign(self):
        original = deepcopy(self.snapshot_data)
        for change in ('body', 'comment'):
            with self.subTest(change=change):
                self.snapshot_data = deepcopy(original)
                if change == 'body':
                    self.snapshot_data['parent']['body'] += ' changed'
                else:
                    self.snapshot_data['comments']['233'].append({'id': 4, 'body': 'New specification'})
                with self.assertRaises(RunnerError):
                    self.require()

    def test_added_removed_and_retargeted_native_blockers_invalidate_scope(self):
        blocker = {'number': 235, 'repository_url': 'https://api.github.com/repos/wasimysaid/unsloth',
                   'state': 'closed', 'state_reason': 'completed'}
        self.snapshot_data['blockers']['234'] = [blocker]
        item = engine.scope(self.snapshot_data, 234)
        self.store.update(234, 'merging', scope=item, input_sha256=digest(item))
        self.store.set_meta('approved_scope', None)
        engine.reconcile_scope(self.config, self.store, self.snapshot_data)
        original = deepcopy(self.snapshot_data)
        for change in ('added', 'removed', 'repository'):
            with self.subTest(change=change):
                self.snapshot_data = deepcopy(original)
                blockers = self.snapshot_data['blockers']['234']
                if change == 'added':
                    blockers.append({**blocker, 'number': 236})
                elif change == 'removed':
                    blockers.clear()
                else:
                    blockers[0]['repository_url'] = 'https://api.github.com/repos/other/repo'
                with self.assertRaises(RunnerError):
                    self.require()

    def test_row_input_must_match_even_when_campaign_scope_still_matches(self):
        self.store.update(234, 'merging', input_sha256='obsolete-input')
        with self.assertRaises(RunnerError):
            self.require()

    def test_removed_child_cannot_retain_authority(self):
        self.snapshot_data['issues'] = []
        with self.assertRaises(RunnerError):
            self.require()

    def test_sibling_scope_change_does_not_block_unchanged_current_ticket(self):
        sibling = {**deepcopy(self.snapshot_data['issues'][0]), 'number': 235, 'title': 'Sibling'}
        self.snapshot_data['issues'].append(sibling)
        self.snapshot_data['blockers']['235'] = []
        self.snapshot_data['comments']['235'] = []
        self.config.approved.add(235)
        self.config.tickets[235] = {}
        self.store.set_meta('approved_scope', None)
        engine.reconcile_scope(self.config, self.store, self.snapshot_data)
        before = self.store.meta('approved_scope')['235']
        sibling['body'] += ' changed'
        self.require()
        self.assertNotEqual(self.store.meta('approved_scope')['235'], before)
        self.assertFalse(self.store.get(234).get('scope_stale'))

    def test_claim_is_exactly_the_authorized_owner_not_empty_foreign_or_shared(self):
        for owners in ([], [{'login': 'another-owner'}],
                       [{'login': 'wasimysaid'}, {'login': 'another-owner'}]):
            with self.subTest(owners=owners):
                self.snapshot_data['issues'][0]['assignees'] = owners
                with self.assertRaises(RunnerError):
                    self.require()

    def test_ready_label_must_remain_even_when_scope_hash_is_unchanged(self):
        for labels in ([], [{'name': 'not-ready'}]):
            with self.subTest(labels=labels):
                self.snapshot_data['issues'][0]['labels'] = labels
                with self.assertRaises(RunnerError):
                    self.require()

    def test_closed_cancelled_or_unverified_completed_ticket_loses_authority(self):
        for reason in (None, 'not_planned', 'completed'):
            with self.subTest(reason=reason):
                self.snapshot_data['issues'][0].update(state='closed', state_reason=reason)
                with self.assertRaises(RunnerError):
                    self.require()
        self.store.update(234, 'merging', final_verification={'pair': {'studio': 'a', 'mimir': 'b'}})
        with self.assertRaises(RunnerError):
            self.require()

    def test_closed_completed_is_recoverable_only_with_integrated_verification(self):
        self.snapshot_data['issues'][0].update(state='closed', state_reason='completed')
        self.store.update(234, 'merging', integrated_verification={'pair': {'studio': 'a', 'mimir': 'b'}})
        self.require()
        self.snapshot_data['issues'][0]['state_reason'] = 'not_planned'
        with self.assertRaises(RunnerError):
            self.require()

    def test_human_policy_allows_unassigned_ticket_but_not_scope_or_label_changes(self):
        self.config.tickets[234]['human'] = True
        self.snapshot_data['issues'][0]['assignees'] = []
        self.require()
        self.snapshot_data['issues'][0]['labels'] = []
        with self.assertRaises(RunnerError):
            self.require()
        self.snapshot_data['issues'][0]['labels'] = [{'name': 'ready-for-agent'}]
        self.snapshot_data['issues'][0]['body'] += ' changed'
        with self.assertRaises(RunnerError):
            self.require()

    def test_runner_receipt_comments_are_not_new_user_scope(self):
        self.snapshot_data['comments']['234'].append({'id': 1, 'body': '<!-- mimir-runner:authority:234:completed -->'})
        self.snapshot_data['comments']['233'].append({'id': 2, 'body': '<!-- mimir-runner:authority:status -->'})
        self.require()

    def test_snapshot_access_error_is_not_empty_or_cached_authority(self):
        self.require()
        self.read_error = RunnerError('403 authority snapshot unavailable')
        with self.assertRaisesRegex(RunnerError, '403'):
            self.require()

    def test_stop_arriving_while_authority_snapshot_is_read_prevents_side_effects(self):
        snapshot = self.gh.snapshot
        def stopping(parent):
            value = snapshot(parent)
            (self.config.root / 'stop.json').write_text('{}')
            return value
        with patch.object(self.gh, 'snapshot', side_effect=stopping):
            with self.assertRaisesRegex(RunnerError, 'Stop requested'):
                self.require()
        self.assertEqual(self.store.get(234)['state'], 'merging')


class GitFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='integration-', dir=Path(__file__).parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'campaign'
        self.root.mkdir()
        self.config = SimpleNamespace(root=self.root, fingerprint='contract-policy', data={'contract': True},
                                      tickets={234: {}}, approved={234},
                                      campaign={'id': 'contract', 'repo': 'wasimysaid/unsloth',
                                                'parent': 233, 'review_timeout': 1},
                                      repositories={name: {'github': repo, 'branch': 'mimir-studio'}
                                                    for name, repo in (('mimir', 'wasimysaid/mimir'),
                                                                       ('studio', 'wasimysaid/unsloth'))})
        self.repositories = {}
        self.workspace = {'directory': str(self.root / 'attempts/234/1'), 'branch': 'ticket-234',
                          'paths': {}, 'bases': {}, 'number': 234}
        for name in ('mimir', 'studio'):
            root = self.root / 'repositories' / name
            root.mkdir(parents=True)
            git(root, 'init', '-q', '-b', 'mimir-studio')
            git(root, 'config', 'user.name', 'Contract Test')
            git(root, 'config', 'user.email', 'contract@example.invalid')
            (root / 'feature.txt').write_text('base\n')
            if name == 'studio':
                atomic_json(root / 'studio/mimir-runtime.lock.json', {
                    'version': 1, 'mimir': {'repository': 'wasimysaid/mimir',
                                          'revision': self.workspace['bases']['mimir']}, 'preserve': 'yes'})
            git(root, 'add', '.')
            git(root, 'commit', '-qm', 'base')
            remote = self.root / 'remotes' / name
            remote.mkdir(parents=True)
            git(remote, 'init', '--bare', '-q')
            git(root, 'remote', 'add', 'origin', str(remote))
            path = Path(self.workspace['directory']) / name
            git(root, 'worktree', 'add', '-q', '-b', self.workspace['branch'], str(path))
            self.repositories[name] = root
            self.workspace['paths'][name] = str(path)
            self.workspace['bases'][name] = git(path, 'rev-parse', 'HEAD')
        self.store = Store(self.config)
        self.addCleanup(lambda: self.store.db.close())
        self.snapshot_data = authority_snapshot()
        item = engine.scope(self.snapshot_data, 234)
        self.row = {'workspace': self.workspace, 'scope': item,
                    'input_sha256': digest(item), 'job': str(self.root / 'worker')}
        self.store.update(234, 'candidate', **self.row)
        engine.reconcile_scope(self.config, self.store, self.snapshot_data)
        atomic_json(Path(self.row['job']) / 'ticket-result.json', {
            'issue': 234, 'input_sha256': self.row['input_sha256'], 'outcome': 'candidate',
            'criteria': [{'criterion': 'Implement feature', 'evidence': 'local file and test'}],
            'checks': [{'repo': 'studio', 'argv': ['python3', '-m', 'unittest'], 'timeout': 60}]})

    def change(self, name, text='implemented\n'):
        (Path(self.workspace['paths'][name]) / 'feature.txt').write_text(text)

    def head(self, name):
        return git(self.repositories[name], 'rev-parse', 'mimir-studio')

    def reopen_store(self):
        self.store.db.close()
        self.store = Store(self.config)


class CommitTests(GitFixture):
    def test_commit_has_durable_receipt_and_ignores_runtime_settings(self):
        self.change('studio')
        path = self.workspace['paths']['studio']
        atomic_json(Path(path) / '.mimir/settings.json', {'model': 'fixture'})
        sha = integration.commit(self.config, self.store, 234, 'studio', 'candidate')
        receipt = self.store.get(234)['commit_intents']['studio:candidate']
        self.assertEqual(receipt['sha'], sha)
        self.assertEqual(receipt['parent'], self.workspace['bases']['studio'])
        self.assertEqual(git(path, 'rev-parse', 'HEAD'), sha)
        self.assertNotIn('.mimir/settings.json', git(path, 'ls-tree', '-r', '--name-only', sha).splitlines())
        self.assertEqual(git(path, 'diff', 'HEAD'), '')
        self.assertEqual(integration.commit(self.config, self.store, 234, 'studio', 'candidate'), sha)
        self.assertEqual(git(path, 'rev-list', '--count', 'HEAD'), '2')

    def test_commit_receipt_recovers_crash_before_ref_move_without_duplicate_commit(self):
        self.change('studio')
        actual_git = integration.git
        def interrupted(path, *args):
            if args[:2] == ('update-ref', 'HEAD'):
                raise RunnerError('simulated crash before ref update')
            return actual_git(path, *args)
        with patch.object(integration, 'git', side_effect=interrupted):
            with self.assertRaisesRegex(RunnerError, 'simulated crash'):
                integration.commit(self.config, self.store, 234, 'studio', 'candidate')
        receipt = self.store.get(234)['commit_intents']['studio:candidate']
        path = self.workspace['paths']['studio']
        self.assertEqual(git(path, 'rev-parse', 'HEAD'), receipt['parent'])
        self.assertEqual(git(path, 'cat-file', '-t', receipt['sha']), 'commit')
        self.reopen_store()
        recovered = integration.commit(self.config, self.store, 234, 'studio', 'candidate')
        self.assertEqual(recovered, receipt['sha'])
        self.assertEqual(git(path, 'rev-list', '--count', 'HEAD'), '2')
        self.assertEqual(git(path, 'diff', 'HEAD'), '')

    def test_commit_receipt_recovers_crash_after_ref_move(self):
        self.change('mimir')
        actual_git = integration.git
        def interrupted(path, *args):
            value = actual_git(path, *args)
            if args[:2] == ('update-ref', 'HEAD'):
                raise RunnerError('simulated lost ref response')
            return value
        with patch.object(integration, 'git', side_effect=interrupted):
            with self.assertRaises(RunnerError):
                integration.commit(self.config, self.store, 234, 'mimir', 'candidate')
        receipt = self.store.get(234)['commit_intents']['mimir:candidate']
        self.reopen_store()
        self.assertEqual(integration.commit(self.config, self.store, 234, 'mimir', 'candidate'), receipt['sha'])
        self.assertEqual(git(self.workspace['paths']['mimir'], 'rev-list', '--count', 'HEAD'), '2')

    def test_receipted_commit_conflicting_with_new_head_fails_closed(self):
        self.change('studio')
        integration.commit(self.config, self.store, 234, 'studio', 'candidate')
        path = self.workspace['paths']['studio']
        git(path, 'commit', '--allow-empty', '-qm', 'unexpected worker commit')
        head = git(path, 'rev-parse', 'HEAD')
        with self.assertRaisesRegex(RunnerError, 'conflicts with the current branch'):
            integration.commit(self.config, self.store, 234, 'studio', 'candidate')
        self.assertEqual(git(path, 'rev-parse', 'HEAD'), head)

    def test_protected_policy_implementation_and_tests_cannot_be_committed(self):
        for relative in ('scripts/mimir_ticket_runner/policy.py', 'tests/ticket_runner/test_any.py',
                         'docs/agents/mimir-ticket-runner.toml'):
            with self.subTest(path=relative):
                path = Path(self.workspace['paths']['studio']) / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('tampered')
                with self.assertRaisesRegex(RunnerError, 'protected runner'):
                    integration.commit(self.config, self.store, 234, 'studio', 'candidate')
                self.assertNotIn('commit_intents', self.store.get(234))
                path.unlink()

    def test_no_changes_does_not_create_empty_commit_or_intent(self):
        self.assertEqual(integration.commit(self.config, self.store, 234, 'mimir', 'candidate'),
                         self.workspace['bases']['mimir'])
        self.assertNotIn('commit_intents', self.store.get(234))

    def test_runtime_pin_uses_private_merge_revision_and_preserves_other_keys(self):
        runtime = 'f' * 40
        sha = integration.pin(self.config, self.store, 234, runtime)
        path = Path(self.workspace['paths']['studio'])
        lock = read_json(path / 'studio/mimir-runtime.lock.json')
        self.assertEqual(lock['mimir']['revision'], runtime)
        self.assertEqual(lock['preserve'], 'yes')
        self.assertEqual(integration.pin(self.config, self.store, 234, runtime), sha)
        self.assertIn('studio:runtime-pin-' + runtime, self.store.get(234)['commit_intents'])

    def test_runtime_pin_rejects_missing_or_wrong_private_repository(self):
        path = Path(self.workspace['paths']['studio']) / 'studio/mimir-runtime.lock.json'
        for value in ({}, {'mimir': {'repository': 'public/other'}}, []):
            with self.subTest(value=value):
                atomic_json(path, value)
                with self.assertRaisesRegex(RunnerError, 'versioned private runtime lock'):
                    integration.pin(self.config, self.store, 234, 'f' * 40)


class TransactionGitHub:
    """Small explicit REST contract, with merges realized in local Git objects."""
    def __init__(self, fixture, name, events):
        self.fixture, self.name, self.events = fixture, name, events
        self.repo = fixture.config.repositories[name]['github']
        self.prefix = f'repos/{self.repo}'
        self.pulls = {}
        self.comments = []
        self.issue = {'state': 'open', 'state_reason': None}
        self.calls = []
        self.fail_merge_response = False
        self.fail_comment_response = False
        self.fail_close_response = False
        self.required = ['build']
        self.statuses = [{'context': 'build', 'state': 'success'}]
        self.runs = []

    def snapshot(self, parent):
        if self.name != 'studio' or parent != self.fixture.config.campaign['parent']:
            raise AssertionError('Authority must read the exact campaign repository and parent')
        self.calls.append(('SNAPSHOT', parent, None))
        self.events.append(('authority', self.name, None))
        value = deepcopy(self.fixture.snapshot_data)
        value['issues'][0].update(self.issue)
        value['comments']['234'].extend(deepcopy(self.comments))
        return value

    def pages(self, endpoint):
        self.calls.append(('PAGES', endpoint, None))
        parts = urlsplit(endpoint)
        if parts.path == self.prefix + '/pulls':
            branch = parse_qs(parts.query)['head'][0].split(':', 1)[1]
            return deepcopy([p for p in self.pulls.values() if p['head']['ref'] == branch])
        if endpoint == self.prefix + '/rules/branches/mimir-studio':
            return []
        if endpoint == self.prefix + '/issues/234/comments':
            return deepcopy(self.comments)
        raise AssertionError(f'Unexpected paginated endpoint {endpoint}')

    def request(self, endpoint, method='GET', payload=None):
        self.calls.append((method, endpoint, deepcopy(payload)))
        if endpoint == self.prefix + '/pulls' and method == 'POST':
            head = git(self.fixture.repositories[self.name], 'rev-parse', payload['head'])
            number = len(self.pulls) + 1
            value = {'number': number, 'html_url': f'https://github.com/{self.repo}/pull/{number}',
                     'head': {'ref': payload['head'], 'sha': head},
                     'base': {'ref': payload['base'], 'sha': self.fixture.head(self.name),
                              'repo': {'full_name': self.repo}},
                     'state': 'open', 'merged': False, 'merge_commit_sha': None,
                     'mergeable': True, 'mergeable_state': 'clean'}
            self.pulls[number] = value
            self.events.append(('publish', self.name, head))
            return deepcopy(value)
        if endpoint.startswith(self.prefix + '/pulls/'):
            rest = endpoint[len(self.prefix + '/pulls/'):].split('/')
            value = self.pulls[int(rest[0])]
            if len(rest) == 1 and method == 'GET':
                return deepcopy(value)
            if rest[1:] == ['merge'] and method == 'PUT':
                if value['merged']:
                    raise AssertionError('An already merged PR must not be merged twice')
                if payload != {'sha': value['head']['sha'], 'merge_method': 'merge'}:
                    raise AssertionError('Merge must use the exact reviewed head without admin bypass')
                root = self.fixture.repositories[self.name]
                base, head = self.fixture.head(self.name), value['head']['sha']
                tree = git(root, 'rev-parse', head + '^{tree}')
                args = ['commit-tree', tree, '-p', base]
                if base != head:
                    args += ['-p', head]
                sha = git(root, *args, '-m', 'contract merge')
                git(root, 'update-ref', 'refs/heads/mimir-studio', sha, base)
                value.update(merged=True, state='closed', merge_commit_sha=sha)
                self.events.append(('merge', self.name, sha))
                if self.fail_merge_response:
                    self.fail_merge_response = False
                    raise RunnerError('transport lost after durable merge')
                return {'merged': True, 'sha': sha}
        if method == 'GET' and endpoint == self.prefix + '/branches/mimir-studio':
            return {'protected': True}
        if method == 'GET' and endpoint == self.prefix + '/branches/mimir-studio/protection':
            return {'required_status_checks': {'contexts': self.required}}
        if method == 'GET' and '/commits/' in endpoint and endpoint.endswith('/status'):
            return {'statuses': deepcopy(self.statuses)}
        if method == 'GET' and '/commits/' in endpoint and endpoint.endswith('/check-runs?per_page=100'):
            return {'total_count': len(self.runs), 'check_runs': deepcopy(self.runs)}
        if endpoint == self.prefix + '/issues/234/comments' and method == 'POST':
            self.comments.append({'id': len(self.comments) + 1, **payload})
            self.events.append(('comment', self.name, None))
            if self.fail_comment_response:
                self.fail_comment_response = False
                raise RunnerError('transport lost after durable comment')
            return deepcopy(self.comments[-1])
        if endpoint == self.prefix + '/issues/234':
            if method == 'GET':
                return deepcopy(self.issue)
            if method == 'PATCH':
                self.issue.update(payload)
                self.events.append(('close', self.name, None))
                if self.fail_close_response:
                    self.fail_close_response = False
                    raise RunnerError('transport lost after durable closure')
                return deepcopy(self.issue)
        raise AssertionError(f'Unexpected GitHub request {method} {endpoint}')


class IntegrationTests(GitFixture):
    def setUp(self):
        super().setUp()
        self.events = []
        self.servers = {name: TransactionGitHub(self, name, self.events) for name in ('mimir', 'studio')}
        self.github = patch.object(integration, 'GitHub', side_effect=lambda repo: next(
            server for server in self.servers.values() if server.repo == repo))
        self.github.start()
        self.addCleanup(self.github.stop)
        for target, side_effect in ((integration.workspaces.head, lambda config, name: self.head(name)),
                                    (integration.workspaces.repository, lambda config, name: self.repositories[name])):
            patcher = patch.object(integration.workspaces, target.__name__, side_effect=side_effect)
            patcher.start()
            self.addCleanup(patcher.stop)

    def run_integration(self, fail_stage=None):
        def verify(config, row, stage):
            pair = verification.pair(row['workspace'])
            verification.assert_clean(row['workspace'], pair)
            self.events.append(('verify', stage, pair))
            if stage == fail_stage:
                raise RunnerError('verification deliberately interrupted at ' + stage)
            return {'pair': pair, 'stage': stage, 'policy': config.fingerprint, 'input': row['input_sha256']}
        def review(config, row, verified, stage):
            verification.assert_clean(row['workspace'], verified['pair'])
            self.events.append(('review', stage, verified['pair']))
            return {'pair': verified['pair'], 'verdict': {'verdict': 'pass'}}
        with patch.object(integration.verification, 'verify', side_effect=verify), \
                patch.object(integration.verification, 'review', side_effect=review):
            integration.integrate(self.config, self.store, 234, {})

    def candidate_pr(self, name='studio'):
        self.change(name)
        sha = integration.commit(self.config, self.store, 234, name, 'candidate')
        self.store.update(234, 'merging', integration={'merged': {}})
        value = integration.publish(self.config, self.store, 234, name)
        return value, sha

    def writes(self, name='studio', method=None):
        return [call for call in self.servers[name].calls if call[0] not in ('GET', 'PAGES', 'SNAPSHOT')
                and (method is None or call[0] == method)]

    def test_private_merges_before_public_pin_and_public_merge(self):
        self.change('mimir')
        self.change('studio')
        self.run_integration()
        row = self.store.get(234)
        self.assertEqual(row['state'], 'completed')
        pair = row['completed_pair']
        self.assertEqual(pair, {name: self.head(name) for name in ('mimir', 'studio')})
        merge_events = [x for x in self.events if x[0] == 'merge']
        self.assertEqual([x[1] for x in merge_events], ['mimir', 'studio'])
        self.assertNotEqual(pair['mimir'], row['integration']['candidate']['mimir'])
        lock = read_json(Path(self.workspace['paths']['studio']) / 'studio/mimir-runtime.lock.json')
        self.assertEqual(lock['mimir']['revision'], pair['mimir'])
        self.assertEqual(row['final_review']['pair']['mimir'], pair['mimir'])
        self.assertEqual([x[1] for x in self.events if x[0] == 'verify'], ['candidate', 'pinned', 'integrated'])
        self.assertEqual([x[1] for x in self.events if x[0] == 'review'], ['candidate', 'pinned'])
        self.assertEqual(self.servers['studio'].issue, {'state': 'closed', 'state_reason': 'completed'})
        self.assertEqual(len(self.servers['studio'].comments), 1)
        self.assertNotIn('private', self.servers['studio'].comments[0]['body'].lower().split('no private traces')[0])
        self.assertEqual(row['integrated_verification']['pair'], pair)

    def test_unchanged_private_repo_needs_no_private_pr(self):
        self.change('studio')
        self.run_integration()
        self.assertEqual(self.store.get(234)['completed_pair']['mimir'], self.workspace['bases']['mimir'])
        self.assertEqual(self.servers['mimir'].pulls, {})
        self.assertEqual([x[1] for x in self.events if x[0] == 'merge'], ['studio'])

    def test_duplicate_matching_prs_are_ambiguous_not_arbitrarily_chosen(self):
        value, sha = self.candidate_pr()
        duplicate = deepcopy(value)
        duplicate['number'] = 2
        self.servers['studio'].pulls[2] = duplicate
        before = len(self.writes())
        with self.assertRaisesRegex(RunnerError, 'Multiple PRs'):
            integration.pr(self.config, 'studio', 234, self.workspace['branch'], sha)
        self.assertEqual(len(self.writes()), before)

    def test_pr_discovery_reconciles_existing_branch_without_second_post(self):
        value, sha = self.candidate_pr()
        recovered = integration.pr(self.config, 'studio', 234, self.workspace['branch'], sha)
        self.assertEqual(recovered['number'], value['number'])
        self.assertEqual(len(self.writes(method='POST')), 1)

    def test_pr_discovery_rejects_wrong_head_and_closed_unmerged_pr(self):
        value, sha = self.candidate_pr()
        stored = self.servers['studio'].pulls[value['number']]
        stored['head']['sha'] = 'f' * 40
        with self.assertRaisesRegex(RunnerError, 'Remote PR head differs'):
            integration.pr(self.config, 'studio', 234, self.workspace['branch'], sha)
        stored['head']['sha'] = sha
        stored['state'] = 'closed'
        with self.assertRaisesRegex(RunnerError, 'closed without merging'):
            integration.pr(self.config, 'studio', 234, self.workspace['branch'], sha)

    def test_merge_rejects_changed_head_base_branch_or_repository_before_write(self):
        value, _ = self.candidate_pr()
        stored = self.servers['studio'].pulls[value['number']]
        original = deepcopy(stored)
        for change in ('head', 'base-ref', 'base-repo'):
            with self.subTest(change=change):
                stored.clear()
                stored.update(deepcopy(original))
                if change == 'head':
                    stored['head']['sha'] = 'f' * 40
                elif change == 'base-ref':
                    stored['base']['ref'] = 'main'
                else:
                    stored['base']['repo']['full_name'] = 'other/repo'
                with self.assertRaisesRegex(RunnerError, 'identity/head/base changed'):
                    integration.merge(self.config, self.store, 234, 'studio')
        self.assertEqual(self.writes(method='PUT'), [])

    def test_advanced_base_requires_refresh_and_reverification_before_merge(self):
        self.candidate_pr()
        root = self.repositories['studio']
        (root / 'another-feature.txt').write_text('concurrent base work')
        git(root, 'add', '.')
        git(root, 'commit', '-qm', 'base advanced')
        with self.assertRaisesRegex(RunnerError, 'base moved; refresh/reverify'):
            integration.merge(self.config, self.store, 234, 'studio')
        self.assertEqual(self.writes(method='PUT'), [])

    def test_merge_rechecks_scope_ownership_labels_and_state_after_ci_before_put(self):
        self.candidate_pr()
        server = self.servers['studio']
        original_request = server.request
        original_snapshot = deepcopy(self.snapshot_data)
        for change in ('body', 'blockers', 'assignees', 'labels', 'state'):
            with self.subTest(change=change):
                self.snapshot_data = deepcopy(original_snapshot)
                server.issue.update(state='open', state_reason=None)
                def revoke(endpoint, method='GET', payload=None):
                    result = original_request(endpoint, method, payload)
                    if method == 'GET' and '/check-runs?' in endpoint:
                        issue = self.snapshot_data['issues'][0]
                        if change == 'body':
                            issue['body'] += ' new acceptance requirement'
                        elif change == 'blockers':
                            self.snapshot_data['blockers']['234'].append({
                                'number': 235, 'repository_url': 'https://api.github.com/repos/wasimysaid/unsloth'})
                        elif change == 'assignees':
                            issue['assignees'] = [{'login': 'another-owner'}]
                        elif change == 'labels':
                            issue['labels'] = []
                        else:
                            server.issue.update(state='closed', state_reason='not_planned')
                    return result
                with patch.object(server, 'request', side_effect=revoke):
                    with self.assertRaises(RunnerError):
                        integration.merge(self.config, self.store, 234, 'studio')
                self.assertEqual(self.writes(method='PUT'), [])
                self.assertEqual(self.store.get(234)['integration']['merged'], {})

    def test_publish_rechecks_authority_before_local_remote_push_and_pr_creation(self):
        self.change('studio')
        integration.commit(self.config, self.store, 234, 'studio', 'candidate')
        self.snapshot_data['issues'][0]['assignees'] = [{'login': 'another-owner'}]
        with patch.object(integration, 'git', wraps=integration.git) as actual_git:
            with self.assertRaises(RunnerError):
                integration.publish(self.config, self.store, 234, 'studio')
        self.assertFalse(any('push' in call.args[1:] for call in actual_git.call_args_list))
        self.assertEqual(self.writes('studio', 'POST'), [])
        self.assertEqual(self.servers['studio'].pulls, {})
        self.assertEqual(git(self.root / 'remotes/studio', 'for-each-ref', '--format=%(refname)', 'refs/heads'), '')

    def test_private_merge_authority_reads_public_campaign_not_private_repository(self):
        self.candidate_pr('mimir')
        private = self.servers['mimir']
        request = private.request
        def revoke(endpoint, method='GET', payload=None):
            result = request(endpoint, method, payload)
            if method == 'GET' and '/check-runs?' in endpoint:
                self.snapshot_data['issues'][0]['assignees'] = []
            return result
        with patch.object(private, 'request', side_effect=revoke):
            with self.assertRaises(RunnerError):
                integration.merge(self.config, self.store, 234, 'mimir')
        self.assertEqual(self.writes('mimir', 'PUT'), [])
        self.assertTrue(any(call[0] == 'SNAPSHOT' for call in self.servers['studio'].calls))
        self.assertFalse(any(call[0] == 'SNAPSHOT' for call in private.calls))

    def test_finish_rechecks_changed_scope_or_claim_before_closure(self):
        pair = {name: self.head(name) for name in ('mimir', 'studio')}
        self.store.update(234, 'merging', integrated_verification={'pair': pair})
        original = deepcopy(self.snapshot_data)
        for change in ('body', 'blockers', 'assignees', 'labels', 'cancelled'):
            with self.subTest(change=change):
                self.snapshot_data = deepcopy(original)
                issue = self.snapshot_data['issues'][0]
                server = self.servers['studio']
                server.issue.update(state='open', state_reason=None)
                if change == 'body':
                    issue['body'] += ' changed'
                elif change == 'blockers':
                    self.snapshot_data['blockers']['234'].append({'number': 235, 'repository_url': 'other/repo'})
                elif change == 'assignees':
                    issue['assignees'] = []
                elif change == 'labels':
                    issue['labels'] = []
                else:
                    server.issue.update(state='closed', state_reason='not_planned')
                with self.assertRaises(RunnerError):
                    integration.finish(self.config, self.store, 234, pair)
                self.assertEqual(self.writes(method='PATCH'), [])
                self.assertNotEqual(self.store.get(234)['state'], 'completed')

    def test_authority_revoked_during_completion_comment_prevents_issue_patch(self):
        pair = {name: self.head(name) for name in ('mimir', 'studio')}
        self.store.update(234, 'merging', integrated_verification={'pair': pair})
        server = self.servers['studio']
        request = server.request
        def revoke(endpoint, method='GET', payload=None):
            result = request(endpoint, method, payload)
            if method == 'POST' and endpoint.endswith('/comments'):
                self.snapshot_data['issues'][0]['assignees'] = [{'login': 'another-owner'}]
            return result
        with patch.object(server, 'request', side_effect=revoke):
            with self.assertRaises(RunnerError):
                integration.finish(self.config, self.store, 234, pair)
        self.assertEqual(len(server.comments), 1)
        self.assertEqual(self.writes(method='PATCH'), [])
        self.assertNotEqual(self.store.get(234)['state'], 'completed')

    def test_required_missing_and_failed_ci_prevent_merge_writes(self):
        self.candidate_pr()
        server = self.servers['studio']
        for statuses in ([], [{'context': 'build', 'state': 'failure'}]):
            with self.subTest(statuses=statuses):
                server.statuses = statuses
                with self.assertRaises(RunnerError):
                    integration.merge(self.config, self.store, 234, 'studio')
        self.assertEqual(self.writes(method='PUT'), [])

    def test_pending_ci_can_resume_but_is_not_merged(self):
        self.candidate_pr()
        self.servers['studio'].statuses = [{'context': 'build', 'state': 'pending'}]
        with patch.object(integration.time, 'monotonic', side_effect=[0, 2]):
            with self.assertRaisesRegex(RunnerError, 'still pending'):
                integration.merge(self.config, self.store, 234, 'studio')
        self.assertEqual(self.writes(method='PUT'), [])
        self.servers['studio'].statuses = [{'context': 'build', 'state': 'success'}]
        sha = integration.merge(self.config, self.store, 234, 'studio')
        self.assertEqual(sha, self.head('studio'))

    def test_merged_pr_needs_authoritative_revision(self):
        value, _ = self.candidate_pr()
        stored = self.servers['studio'].pulls[value['number']]
        stored.update(merged=True, state='closed')
        for sha in (None, 'not-a-sha', 'a' * 39, 'A' * 40):
            with self.subTest(sha=sha):
                stored['merge_commit_sha'] = sha
                with self.assertRaisesRegex(RunnerError, 'no authoritative merge revision'):
                    integration.merge(self.config, self.store, 234, 'studio')
        self.assertEqual(self.writes(method='PUT'), [])

    def test_private_merge_lost_response_recovers_without_duplicate_pr_or_merge(self):
        self.change('mimir')
        self.change('studio')
        self.servers['mimir'].fail_merge_response = True
        with self.assertRaisesRegex(RunnerError, 'transport lost after durable merge'):
            self.run_integration()
        self.assertNotIn('mimir', self.store.get(234)['integration']['merged'])
        self.assertEqual(self.servers['studio'].pulls, {})
        self.reopen_store()
        self.run_integration()
        self.assertEqual(self.store.get(234)['state'], 'completed')
        self.assertEqual(len(self.writes('mimir', 'POST')), 1)
        self.assertEqual(len(self.writes('mimir', 'PUT')), 1)
        self.assertEqual(len(self.writes('studio', 'PUT')), 1)

    def test_public_merge_lost_response_recovers_without_repin_or_republish(self):
        self.change('mimir')
        self.change('studio')
        self.servers['studio'].fail_merge_response = True
        with self.assertRaisesRegex(RunnerError, 'transport lost after durable merge'):
            self.run_integration()
        before = deepcopy(self.store.get(234)['commit_intents'])
        self.assertNotIn('studio', self.store.get(234)['integration']['merged'])
        self.reopen_store()
        self.run_integration()
        self.assertEqual(self.store.get(234)['state'], 'completed')
        self.assertEqual(self.store.get(234)['commit_intents'], before)
        self.assertEqual(len(self.writes('studio', 'PUT')), 1)
        self.assertEqual([x[1] for x in self.events if x[0] == 'review'], ['candidate', 'pinned'])

    def test_candidate_refresh_survives_interruption_before_transaction_receipt(self):
        self.change('mimir')
        self.change('studio')
        root = self.repositories['studio']
        (root / 'concurrent.txt').write_text('independent base change\n')
        git(root, 'add', '.')
        git(root, 'commit', '-qm', 'concurrent integration')
        with self.assertRaisesRegex(RunnerError, 'interrupted at candidate'):
            self.run_integration(fail_stage='candidate')
        row = self.store.get(234)
        self.assertNotIn('integration', row)
        self.assertIn('refresh_intent', row)
        refreshed = git(self.workspace['paths']['studio'], 'rev-parse', 'HEAD')
        self.assertNotEqual(refreshed, row['commit_intents']['studio:candidate']['sha'])
        self.reopen_store()
        self.run_integration()
        self.assertEqual(self.store.get(234)['state'], 'completed')
        self.assertEqual((Path(self.workspace['paths']['studio']) / 'concurrent.txt').read_text(),
                         'independent base change\n')
        self.assertEqual(len(self.writes('studio', 'PUT')), 1)

    def test_changed_local_candidate_after_transaction_receipt_cannot_merge_unreviewed_head(self):
        self.change('mimir')
        self.change('studio')
        with patch.object(integration, 'publish', side_effect=RunnerError('paused before publish')):
            with self.assertRaisesRegex(RunnerError, 'paused before publish'):
                self.run_integration()
        reviewed = self.store.get(234)['integration']['candidate']['mimir']
        path = self.workspace['paths']['mimir']
        self.change('mimir', 'unreviewed code introduced after verification\n')
        git(path, 'add', '.')
        git(path, 'commit', '-qm', 'unexpected new candidate')
        self.assertNotEqual(git(path, 'rev-parse', 'HEAD'), reviewed)
        self.reopen_store()
        with self.assertRaises(RunnerError):
            self.run_integration()
        self.assertEqual(self.writes('mimir'), [])
        self.assertEqual(self.servers['studio'].issue['state'], 'open')

    def test_failure_after_private_merge_retains_partial_transaction_for_resume(self):
        self.change('mimir')
        self.change('studio')
        with self.assertRaisesRegex(RunnerError, 'interrupted at pinned'):
            self.run_integration(fail_stage='pinned')
        self.assertEqual(set(self.store.get(234)['integration']['merged']), {'mimir'})
        self.assertEqual(self.servers['studio'].issue['state'], 'open')
        self.assertEqual(self.servers['studio'].pulls, {})
        self.reopen_store()
        self.run_integration()
        self.assertEqual(self.store.get(234)['state'], 'completed')
        self.assertEqual(len(self.writes('mimir', 'PUT')), 1)
        self.assertEqual(len(self.writes('studio', 'PUT')), 1)

    def test_pinned_partial_transaction_refreshes_new_public_base_before_resume(self):
        self.change('mimir')
        self.change('studio')
        with self.assertRaisesRegex(RunnerError, 'interrupted at pinned'):
            self.run_integration(fail_stage='pinned')
        runtime = self.store.get(234)['integration']['merged']['mimir']
        root = self.repositories['studio']
        (root / 'concurrent-after-pin.txt').write_text('another approved integration\n')
        git(root, 'add', '.')
        git(root, 'commit', '-qm', 'public base advanced after interrupted pin')
        self.reopen_store()
        self.run_integration()
        self.assertEqual(self.store.get(234)['state'], 'completed')
        path = Path(self.workspace['paths']['studio'])
        self.assertEqual((path / 'concurrent-after-pin.txt').read_text(), 'another approved integration\n')
        self.assertEqual(read_json(path / 'studio/mimir-runtime.lock.json')['mimir']['revision'], runtime)
        self.assertEqual(len(self.writes('mimir', 'PUT')), 1)
        self.assertEqual(len(self.writes('studio', 'PUT')), 1)

    def test_stop_request_prevents_even_ready_pr_merge_writes(self):
        self.candidate_pr()
        (self.config.root / 'stop.json').write_text('{}')
        with self.assertRaises(RunnerError):
            integration.merge(self.config, self.store, 234, 'studio')
        self.assertEqual(self.writes(method='PUT'), [])
        self.assertEqual(self.store.get(234)['integration']['merged'], {})

    def test_failure_after_both_merges_does_not_close_issue_until_final_check(self):
        self.change('mimir')
        self.change('studio')
        with self.assertRaisesRegex(RunnerError, 'interrupted at integrated'):
            self.run_integration(fail_stage='integrated')
        self.assertEqual(set(self.store.get(234)['integration']['merged']), {'mimir', 'studio'})
        self.assertEqual(self.servers['studio'].issue['state'], 'open')
        self.assertEqual(self.servers['studio'].comments, [])
        self.reopen_store()
        self.run_integration()
        self.assertEqual(self.store.get(234)['state'], 'completed')
        self.assertEqual(len(self.writes('mimir', 'PUT')), 1)
        self.assertEqual(len(self.writes('studio', 'PUT')), 1)

    def test_integrated_tree_must_equal_independently_reviewed_tree(self):
        self.change('studio')
        with self.assertRaises(RunnerError):
            self.run_integration(fail_stage='integrated')
        row = self.store.get(234)
        review = deepcopy(row['final_review'])
        review['pair']['studio'] = self.workspace['bases']['studio']
        self.store.update(234, 'merging', final_review=review)
        with self.assertRaisesRegex(RunnerError, 'tree differs from the independently reviewed'):
            self.run_integration()
        self.assertEqual(self.servers['studio'].issue['state'], 'open')

    def test_private_base_advancing_after_partial_merge_prevents_public_integration(self):
        self.change('mimir')
        self.change('studio')
        with self.assertRaises(RunnerError):
            self.run_integration(fail_stage='pinned')
        root = self.repositories['mimir']
        git(root, 'commit', '--allow-empty', '-qm', 'another integration')
        with self.assertRaisesRegex(RunnerError, 'Private integration advanced'):
            self.run_integration()
        self.assertEqual(self.servers['studio'].pulls, {})
        self.assertEqual(self.servers['studio'].issue['state'], 'open')

    def test_commit_history_changed_by_worker_is_not_accepted(self):
        path = self.workspace['paths']['studio']
        git(path, 'commit', '--allow-empty', '-qm', 'worker unauthorized commit')
        with self.assertRaisesRegex(RunnerError, 'Worker changed its branch history'):
            self.run_integration()
        self.assertEqual(self.servers['mimir'].pulls, {})
        self.assertEqual(self.servers['studio'].pulls, {})

    def test_comment_response_loss_reconciles_marker_without_duplicate_comment(self):
        pair = {name: self.head(name) for name in ('mimir', 'studio')}
        self.servers['studio'].fail_comment_response = True
        with self.assertRaisesRegex(RunnerError, 'durable comment'):
            integration.finish(self.config, self.store, 234, pair)
        self.assertNotEqual(self.store.get(234)['state'], 'completed')
        self.reopen_store()
        integration.finish(self.config, self.store, 234, pair)
        self.assertEqual(len(self.servers['studio'].comments), 1)
        self.assertEqual(self.store.get(234)['completed_pair'], pair)

    def test_issue_closure_response_loss_reconciles_without_duplicate_patch(self):
        self.change('studio')
        self.servers['studio'].fail_close_response = True
        with self.assertRaisesRegex(RunnerError, 'durable closure'):
            self.run_integration()
        self.assertNotEqual(self.store.get(234)['state'], 'completed')
        self.assertEqual(self.servers['studio'].issue['state'], 'closed')
        self.reopen_store()
        self.run_integration()
        self.assertEqual(self.store.get(234)['state'], 'completed')
        self.assertEqual(len(self.writes('studio', 'PATCH')), 1)
        self.assertEqual(len(self.servers['studio'].comments), 1)
        self.assertEqual(len(self.writes('studio', 'PUT')), 1)

    def test_issue_closure_must_be_confirmed_before_completed_receipt(self):
        pair = {name: self.head(name) for name in ('mimir', 'studio')}
        server = self.servers['studio']
        original = server.request
        def refuse_close(endpoint, method='GET', payload=None):
            if method == 'PATCH':
                return {'state': 'open', 'state_reason': None}
            return original(endpoint, method, payload)
        with patch.object(server, 'request', side_effect=refuse_close):
            with self.assertRaisesRegex(RunnerError, 'Issue closure not confirmed'):
                integration.finish(self.config, self.store, 234, pair)
        self.assertNotEqual(self.store.get(234)['state'], 'completed')


if __name__ == '__main__':
    unittest.main()
