# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026-present the Unsloth AI Inc. team. All rights reserved.
"""Controller verification contracts; local Git only, never a model or GPU run."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from scripts.mimir_ticket_runner import verification
from scripts.mimir_ticket_runner.common import RunnerError, atomic_json, git, read_json


class VerificationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='verification-', dir=Path(__file__).parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.workspace = {'directory': str(self.root / 'attempt'), 'paths': {}, 'bases': {}}
        for name in ('mimir', 'studio'):
            path = self.root / name
            path.mkdir()
            git(path, 'init', '-q')
            git(path, 'config', 'user.name', 'Contract Test')
            git(path, 'config', 'user.email', 'contract@example.invalid')
            (path / 'candidate.txt').write_text('initial\n')
            git(path, 'add', '.')
            git(path, 'commit', '-qm', 'base')
            self.workspace['paths'][name] = str(path)
            self.workspace['bases'][name] = git(path, 'rev-parse', 'HEAD')
        self.required = {'repo': 'studio', 'argv': ['python3', '-m', 'unittest'], 'timeout': 60}
        self.config = SimpleNamespace(root=self.root / 'campaign', fingerprint='policy-a',
                                      tickets={234: {}}, campaign={'model': 'gpt-6-astra', 'review_model': 'gpt-6.1-sol'},
                                      check_commands=lambda number: [deepcopy(self.required)])
        self.row = {'workspace': self.workspace, 'job': str(self.root / 'worker'),
                    'scope': {'number': 234, 'body': '- [ ] First criterion\n- [x] Second criterion'},
                    'input_sha256': 'scope-a'}
        self.evidence = {'issue': 234, 'input_sha256': 'scope-a', 'outcome': 'candidate',
                         'criteria': [{'criterion': 'First criterion', 'evidence': 'file:12'},
                                      {'criterion': 'Second criterion', 'evidence': 'receipt:34'}],
                         'checks': [{'repo': 'mimir', 'argv': ['python3', '-m', 'unittest'], 'timeout': 90}]}
        self.write_report()

    def test_checkbox_markers_do_not_change_exact_criterion_coverage(self):
        for item in self.evidence['criteria']:
            item['criterion'] = '- [ ] ' + item['criterion']
        self.write_report()
        self.assertEqual(len(verification.report(self.row)['criteria']), 2)
        self.evidence['criteria'][0]['criterion'] += ' changed requirement'
        self.write_report()
        with self.assertRaises(RunnerError):
            verification.report(self.row)

    def write_report(self, value=None):
        atomic_json(Path(self.row['job']) / 'ticket-result.json', self.evidence if value is None else value)

    def advance(self, name):
        path = Path(self.workspace['paths'][name])
        (path / 'candidate.txt').write_text('changed\n')
        git(path, 'add', '.')
        git(path, 'commit', '-qm', 'next candidate')
        return git(path, 'rev-parse', 'HEAD')

    def verify(self, stage='candidate', launch_effect=None):
        with patch.object(verification.supervisor, 'launch', side_effect=launch_effect) as launch, \
                patch.object(verification, 'wait', return_value={'status': 'completed', 'exit_code': 0}):
            value = verification.verify(self.config, self.row, stage)
        return value, launch

    def review(self, verified, verdict=None, raw=None, mutate=None):
        def native(config, workspace, prompt, kind, suffix):
            directory = Path(workspace['directory']) / (kind + suffix)
            directory.mkdir(parents=True, exist_ok=True)
            response = verdict if verdict is not None else {
                'verdict': 'pass', 'pair': verified['pair'], 'findings': [], 'acceptance_verified': True}
            text = raw if raw is not None else json.dumps(response)
            records = [{'event': 'model_request_start', 'model': config.campaign['review_model'],
                        'reasoning_effort': 'high'}, {'event': 'run_finished', 'output_text': text}]
            (directory / 'stdout.jsonl').write_text(''.join(json.dumps(record) + '\n' for record in records))
            if mutate:
                mutate()
            return directory
        with patch.object(verification.workspaces, 'native_job', side_effect=native) as job, \
                patch.object(verification, 'wait', return_value={'status': 'completed', 'exit_code': 0}):
            result = verification.review(self.config, self.row, verified, 'candidate')
        return result, job

    def test_criteria_preserves_exact_text_and_accepts_checked_items(self):
        self.assertEqual(verification.criteria(self.row['scope']['body']), ['First criterion', 'Second criterion'])
        self.assertEqual(verification.report(self.row), {**self.evidence, 'artifact_sha256': {}})

    def test_criterion_order_does_not_change_coverage(self):
        self.evidence['criteria'].reverse()
        self.write_report()
        self.assertEqual(verification.report(self.row)['criteria'], self.evidence['criteria'])

    def test_missing_mismatched_or_non_candidate_report_is_rejected(self):
        for value in (None, [], {}, {**self.evidence, 'issue': 235},
                      {**self.evidence, 'input_sha256': 'old'}, {**self.evidence, 'outcome': 'needs-human'}):
            with self.subTest(value=value):
                path = Path(self.row['job']) / 'ticket-result.json'
                if value is None:
                    path.unlink(missing_ok=True)
                else:
                    self.write_report(value)
                with self.assertRaises(RunnerError):
                    verification.report(self.row)

    def test_every_exact_criterion_must_appear_once(self):
        entries = self.evidence['criteria']
        for criteria in ([], entries[:1], entries + entries[:1], [entries[0], entries[0]],
                         [entries[0], {'criterion': 'Second criterion ', 'evidence': 'not exact'}], 'text'):
            with self.subTest(criteria=criteria):
                self.write_report({**self.evidence, 'criteria': criteria})
                with self.assertRaisesRegex(RunnerError, 'every exact acceptance criterion once'):
                    verification.report(self.row)

    def test_no_acceptance_criteria_is_not_vacuous_success(self):
        self.row['scope']['body'] = 'No checklist exists.'
        self.write_report({**self.evidence, 'criteria': []})
        with self.assertRaises(RunnerError):
            verification.report(self.row)

    def test_evidence_must_be_nonempty_text(self):
        for value in ('', ' \n', None, 10, []):
            with self.subTest(evidence=value):
                evidence = deepcopy(self.evidence)
                evidence['criteria'][0]['evidence'] = value
                self.write_report(evidence)
                with self.assertRaisesRegex(RunnerError, 'evidence is missing'):
                    verification.report(self.row)

    def test_malformed_criterion_entries_raise_actionable_runner_error(self):
        for entry in (None, 'criterion', [], 3, {'criterion': ['First criterion'], 'evidence': 'x'}):
            with self.subTest(entry=entry):
                self.write_report({**self.evidence, 'criteria': [entry, self.evidence['criteria'][1]]})
                with self.assertRaises(RunnerError):
                    verification.report(self.row)

    def test_additional_scoped_check_is_mandatory(self):
        for checks in (None, [], {}, 'python3'):
            with self.subTest(checks=checks):
                self.write_report({**self.evidence, 'checks': checks})
                with self.assertRaises(RunnerError):
                    verification.report(self.row)

    def test_invalid_scoped_commands_are_rejected(self):
        valid = self.evidence['checks'][0]
        for change in ({'repo': 'other'}, {'argv': []}, {'argv': 'python3'}, {'argv': ['']},
                       {'argv': ['python3', 1]}, {'timeout': 0}, {'timeout': -1}, {'timeout': 3601},
                       {'timeout': True}, {'timeout': 1.5}, {'timeout': '60'}):
            with self.subTest(change=change):
                self.write_report({**self.evidence, 'checks': [{**valid, **change}]})
                with self.assertRaisesRegex(RunnerError, 'Invalid scoped verification command'):
                    verification.report(self.row)

    def test_malformed_check_entries_raise_actionable_runner_error(self):
        for check in (None, 'python3', [], 1):
            with self.subTest(check=check):
                self.write_report({**self.evidence, 'checks': [check]})
                with self.assertRaises(RunnerError):
                    verification.report(self.row)

    def test_valid_timeout_boundary_and_default(self):
        for timeout in (1, 3600, None):
            with self.subTest(timeout=timeout):
                check = deepcopy(self.evidence['checks'][0])
                if timeout is None:
                    check.pop('timeout')
                else:
                    check['timeout'] = timeout
                self.write_report({**self.evidence, 'checks': [check]})
                self.assertEqual(verification.report(self.row)['checks'], [check])

    def typed_evidence(self):
        self.config.tickets[234]['evidence_types'] = ['automated', 'browser', 'live']
        artifact = Path(self.workspace['directory']) / 'artifacts/browser-and-live.txt'
        artifact.parent.mkdir(parents=True)
        artifact.write_text('fixture artifact, NOT live execution proof')
        evidence = deepcopy(self.evidence)
        evidence['criteria'][0].update(kinds=['automated', 'browser'], checks=[0], artifacts=[str(artifact)])
        evidence['criteria'][1].update(kinds=['live'], checks=[0], artifacts=[str(artifact)], workload_ids=['fixture-run'])
        return evidence, artifact

    def test_required_typed_evidence_covers_categories_and_hashes_artifacts(self):
        evidence, artifact = self.typed_evidence()
        self.write_report(evidence)
        value = verification.report(self.row, self.config)
        self.assertEqual(value['artifact_sha256'], {str(artifact): hashlib.sha256(artifact.read_bytes()).hexdigest()})

    def test_required_typed_evidence_rejects_untyped_worker_claims(self):
        self.config.tickets[234]['evidence_types'] = ['automated']
        with self.assertRaisesRegex(RunnerError, 'typed evidence'):
            verification.report(self.row, self.config)

    def test_typed_evidence_command_indexes_are_bounded_integers(self):
        evidence, _ = self.typed_evidence()
        for indexes in ([], [-1], [1], [True], ['0'], None):
            with self.subTest(indexes=indexes):
                value = deepcopy(evidence)
                value['criteria'][0]['checks'] = indexes
                self.write_report(value)
                with self.assertRaisesRegex(RunnerError, 'command indexes'):
                    verification.report(self.row, self.config)

    def test_missing_required_browser_or_live_category_is_not_automated_success(self):
        evidence, _ = self.typed_evidence()
        for missing in ('browser', 'live'):
            with self.subTest(missing=missing):
                value = deepcopy(evidence)
                for entry in value['criteria']:
                    entry['kinds'] = [kind for kind in entry['kinds'] if kind != missing] or ['automated']
                self.write_report(value)
                with self.assertRaisesRegex(RunnerError, 'Required evidence categories are missing'):
                    verification.report(self.row, self.config)

    def test_browser_requires_artifact_and_live_requires_workload_id(self):
        evidence, _ = self.typed_evidence()
        for index, field in ((0, 'artifacts'), (1, 'workload_ids')):
            with self.subTest(index=index, field=field):
                value = deepcopy(evidence)
                value['criteria'][index].pop(field)
                self.write_report(value)
                with self.assertRaisesRegex(RunnerError, 'Browser/live criteria need artifacts'):
                    verification.report(self.row, self.config)

    def test_artifacts_must_exist_inside_owned_attempt_and_not_escape_by_symlink(self):
        evidence, _ = self.typed_evidence()
        outside = self.root / 'outside.txt'
        outside.write_text('out of attempt')
        symlink = Path(self.workspace['directory']) / 'artifacts/escape.txt'
        symlink.symlink_to(outside)
        for artifact in (str(outside), str(symlink), str(symlink.parent / 'missing.txt')):
            with self.subTest(artifact=artifact):
                value = deepcopy(evidence)
                value['criteria'][0]['artifacts'] = [artifact]
                self.write_report(value)
                with self.assertRaises(RunnerError):
                    verification.report(self.row, self.config)

    def test_changed_artifact_invalidates_command_evidence_at_unchanged_git_pair(self):
        evidence, artifact = self.typed_evidence()
        self.write_report(evidence)
        before, _ = self.verify()
        artifact.write_text('new fixture evidence')
        after, launch = self.verify()
        self.assertEqual(after['pair'], before['pair'])
        self.assertNotEqual(after['evidence'], before['evidence'])
        self.assertEqual(launch.call_count, 2)

    def test_controller_commands_precede_worker_checks_and_disable_gpu(self):
        value, launch = self.verify()
        self.assertEqual(value['pair'], verification.pair(self.workspace))
        self.assertEqual(value['policy'], self.config.fingerprint)
        self.assertEqual(value['input'], self.row['input_sha256'])
        self.assertEqual([x['check'] for x in value['checks']], [self.required, *self.evidence['checks']])
        self.assertEqual(launch.call_count, 2)
        for call, check in zip(launch.call_args_list, [self.required, *self.evidence['checks']]):
            self.assertEqual(call.args[1], check['argv'])
            self.assertEqual(call.args[2], Path(self.workspace['paths'][check['repo']]))
            self.assertEqual(call.kwargs['timeout'], check['timeout'])
            self.assertEqual(call.kwargs['protocol'], 'command')
            self.assertEqual(call.kwargs['env_overrides']['CUDA_VISIBLE_DEVICES'], '')
            self.assertTrue(Path(call.kwargs['env_overrides']['TMPDIR']).is_dir())

    def test_exact_same_receipt_reuses_checks(self):
        original, _ = self.verify()
        reused, launch = self.verify()
        self.assertEqual(reused, original)
        launch.assert_not_called()

    def test_changing_either_revision_invalidates_command_receipts(self):
        previous, _ = self.verify()
        for name in ('studio', 'mimir'):
            with self.subTest(repo=name):
                self.advance(name)
                current, launch = self.verify()
                self.assertEqual(launch.call_count, 2)
                self.assertNotEqual(current['pair'], previous['pair'])
                previous = current

    def test_input_policy_command_and_report_each_invalidate_receipts(self):
        self.verify()
        self.row['input_sha256'] = self.evidence['input_sha256'] = 'scope-b'
        self.write_report()
        _, launch = self.verify()
        self.assertEqual(launch.call_count, 2)
        self.config.fingerprint = 'policy-b'
        _, launch = self.verify()
        self.assertEqual(launch.call_count, 2)
        self.required['argv'].append('-v')
        _, launch = self.verify()
        self.assertEqual(launch.call_count, 2)
        self.evidence['criteria'][0]['evidence'] = 'changed claim at same pair'
        self.write_report()
        _, launch = self.verify()
        self.assertEqual(launch.call_count, 2)

    def test_noop_phase_change_reuses_the_same_exact_revision_evidence(self):
        original, _ = self.verify()
        reused, launch = self.verify(stage='pinned')
        self.assertEqual(reused, original)
        launch.assert_not_called()

    def test_cached_command_receipt_must_match_its_exact_identity(self):
        self.verify()
        receipt = next((Path(self.workspace['directory']) / 'verification').glob('*/verified.json'))
        original = read_json(receipt)
        for field, stale in (('pair', {'studio': '0' * 40, 'mimir': '1' * 40}),
                             ('policy', 'obsolete'), ('input', 'old-scope'), ('evidence', 'old-evidence')):
            with self.subTest(field=field):
                value = deepcopy(original)
                value[field] = stale
                atomic_json(receipt, value)
                with self.assertRaises(RunnerError):
                    self.verify()

    def test_tracked_untracked_and_staged_changes_fail_cleanliness(self):
        expected = verification.pair(self.workspace)
        path = Path(self.workspace['paths']['studio'])
        candidate = path / 'candidate.txt'
        candidate.write_text('dirty\n')
        with self.assertRaisesRegex(RunnerError, 'tracked candidate files'):
            verification.assert_clean(self.workspace, expected)
        git(path, 'add', 'candidate.txt')
        with self.assertRaises(RunnerError):
            verification.assert_clean(self.workspace, expected)
        candidate.write_text('initial\n')
        git(path, 'add', 'candidate.txt')
        (path / 'extra.txt').write_text('untracked\n')
        with self.assertRaisesRegex(RunnerError, 'untracked candidate files'):
            verification.assert_clean(self.workspace, expected)

    def test_runtime_only_settings_are_allowed_but_other_untracked_files_are_not(self):
        expected = verification.pair(self.workspace)
        path = Path(self.workspace['paths']['studio'])
        atomic_json(path / '.mimir/settings.json', {'model': 'test'})
        verification.assert_clean(self.workspace, expected)
        (path / '.mimir/other.txt').write_text('not exempt')
        with self.assertRaises(RunnerError):
            verification.assert_clean(self.workspace, expected)

    def test_head_change_during_check_cannot_produce_verified_receipt(self):
        def mutate(*args, **kwargs):
            self.advance('studio')
        with self.assertRaisesRegex(RunnerError, 'revisions changed'):
            self.verify(launch_effect=mutate)
        self.assertEqual(list((Path(self.workspace['directory']) / 'verification').glob('*/verified.json')), [])

    def test_untracked_check_output_cannot_produce_verified_receipt(self):
        def mutate(*args, **kwargs):
            (Path(self.workspace['paths']['mimir']) / 'check-output.txt').write_text('oops')
        with self.assertRaisesRegex(RunnerError, 'untracked'):
            self.verify(launch_effect=mutate)

    def test_failed_check_never_receipts_success_or_runs_later_checks(self):
        with patch.object(verification.supervisor, 'launch') as launch, \
                patch.object(verification.supervisor, 'inspect', return_value={'status': 'failed', 'reason': 'exit 1'}):
            with self.assertRaisesRegex(RunnerError, 'did not complete successfully'):
                verification.verify(self.config, self.row, 'candidate')
        self.assertEqual(launch.call_count, 1)
        self.assertEqual(list((Path(self.workspace['directory']) / 'verification').glob('*/verified.json')), [])

    def test_stop_request_stops_running_check_and_is_not_success(self):
        self.config.root.mkdir()
        (self.config.root / 'stop.json').write_text('{}')
        with patch.object(verification.supervisor, 'inspect', return_value={'status': 'running'}), \
                patch.object(verification.supervisor, 'stop') as stop:
            directory = self.root / 'job'
            with self.assertRaisesRegex(RunnerError, 'Stop requested'):
                verification.wait(self.config, directory)
            stop.assert_called_once_with(directory)

    def test_review_requires_exact_pair_no_findings_and_explicit_acceptance(self):
        verified = {'pair': verification.pair(self.workspace)}
        good = {'verdict': 'pass', 'pair': verified['pair'], 'findings': [], 'acceptance_verified': True}
        for change in ({'verdict': 'changes-requested'}, {'pair': {'studio': 'wrong', 'mimir': 'wrong'}},
                       {'findings': ['Missing live evidence']}, {'acceptance_verified': False},
                       {'acceptance_verified': 1}, {'findings': None}):
            with self.subTest(change=change):
                with self.assertRaisesRegex(RunnerError, 'did not approve every criterion'):
                    self.review(verified, verdict={**good, **change})
        result, job = self.review(verified)
        self.assertEqual(result['pair'], verified['pair'])
        prompt = job.call_args.args[2]
        self.assertIn('read-only', prompt)
        self.assertIn('A fixture is not a live workload', prompt)
        self.assertIn('No human approval can be manufactured', prompt)

    def test_malformed_review_json_is_rejected(self):
        with self.assertRaisesRegex(RunnerError, 'structured verdict'):
            self.review({'pair': verification.pair(self.workspace)}, raw='Not JSON')

    def test_non_object_review_verdict_is_actionable_runner_error(self):
        for raw in ('null', '[]', '"pass"', 'true'):
            with self.subTest(raw=raw), self.assertRaises(RunnerError):
                self.review({'pair': verification.pair(self.workspace)}, raw=raw)

    def test_review_receipt_reuses_only_same_pair(self):
        verified = {'pair': verification.pair(self.workspace)}
        first, _ = self.review(verified)
        second, job = self.review(verified)
        self.assertEqual(second, first)
        job.assert_not_called()
        self.advance('mimir')
        updated, job = self.review({'pair': verification.pair(self.workspace)})
        self.assertNotEqual(updated['pair'], first['pair'])
        self.assertEqual(job.call_count, 1)

    def test_cached_review_receipt_must_not_accept_a_stale_pair(self):
        verified = {'pair': verification.pair(self.workspace)}
        result, _ = self.review(verified)
        receipt = Path(result['directory']) / 'reviewed.json'
        value = read_json(receipt)
        value['pair']['studio'] = '0' * 40
        value['verdict']['pair']['studio'] = '0' * 40
        atomic_json(receipt, value)
        with self.assertRaises(RunnerError):
            self.review(verified)

    def test_reviewer_modification_never_receipts_success(self):
        def mutate():
            (Path(self.workspace['paths']['studio']) / 'candidate.txt').write_text('reviewer wrote this')
        with self.assertRaisesRegex(RunnerError, 'tracked candidate files'):
            self.review({'pair': verification.pair(self.workspace)}, mutate=mutate)
        self.assertEqual(list(Path(self.workspace['directory']).glob('review-*/reviewed.json')), [])


if __name__ == '__main__':
    unittest.main()
