"""Frontier-wide scheduling and the operator-selected session/delegation policy."""
from contextlib import nullcontext
from copy import deepcopy
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import tomllib
from unittest import TestCase
from unittest.mock import Mock, patch

from scripts.mimir_ticket_runner import cli, engine, integration, supervisor, workspaces
from scripts.mimir_ticket_runner.common import RunnerError
from scripts.mimir_ticket_runner.config import Config, DEFAULT_CONFIG


class RunnerPolicy(TestCase):
    def setUp(self):
        self.data = tomllib.loads(DEFAULT_CONFIG.read_text())
        self.data['campaign'].update(model='gpt-6-astra', reasoning_effort='medium',
                                     review_model='gpt-6.1-sol', worker_timeout=0,
                                     review_timeout=0, budget_seconds=0)
        self.data['campaign'].pop('max_workers', None)
        self.config = Config(DEFAULT_CONFIG, self.data)

    def test_shipped_policy_has_no_concurrency_cap_and_uses_astra_medium(self):
        campaign = tomllib.loads(DEFAULT_CONFIG.read_text())['campaign']
        self.assertNotIn('max_workers', campaign)
        self.assertEqual(campaign['model'], 'gpt-6-astra')
        self.assertEqual(campaign['reasoning_effort'], 'medium')
        self.assertEqual(campaign['review_model'], 'gpt-6.1-sol')
        for key in ('worker_timeout', 'review_timeout', 'budget_seconds'):
            self.assertEqual(campaign[key], 0)

    def test_unlimited_campaign_does_not_start_a_timer(self):
        with patch.object(engine.threading, 'Timer') as timer:
            with engine.invocation_budget(self.config):
                timer.assert_not_called()

    def test_uncapped_and_explicit_large_caps_validate(self):
        with patch('scripts.mimir_ticket_runner.config.shutil.which', return_value='/native/mimir'):
            self.config.validate()
            for count in (1, 2, 10, 23):
                self.data['campaign']['max_workers'] = count
                self.config.validate()
            for invalid in (0, -1, True, 'all'):
                self.data['campaign']['max_workers'] = invalid
                with self.assertRaises(RunnerError):
                    self.config.validate()

    def selected_wave(self, recovered=False):
        numbers = list(range(234, 244))
        snapshot = {'issues': [{'number': n} for n in self.config.approved]}
        store = Mock()
        store.wave.return_value = None
        store.tickets.return_value = {n: {'state': 'candidate'} for n in reversed(numbers)} if recovered else {}
        store.completed.return_value = set()
        class Selected(Exception):
            pass
        store.begin_wave.side_effect = Selected
        with patch.object(engine, 'campaign_lock', return_value=nullcontext()), patch.object(
                engine, 'invocation_budget', return_value=nullcontext()), patch.object(
                engine, 'Store', return_value=nullcontext(store)), patch.object(
                engine, 'active_login', return_value='wasimysaid'), patch.object(
                engine.GitHub, 'snapshot', return_value=snapshot), patch.object(
                engine, 'reconcile_scope'), patch.object(engine, 'atomic_json'), patch.object(
                engine, 'reconcile_candidates'), patch.object(integration, 'reconcile_completed'), patch.object(
                engine, 'plan', return_value={'ready': [{'number': n} for n in numbers]}), patch.object(
                engine, 'resource_ready', return_value=True):
            with self.assertRaises(Selected):
                engine.run(self.config)
        return store.begin_wave.call_args.args[0]

    def test_all_ten_ready_tickets_enter_one_wave(self):
        self.assertEqual(self.selected_wave(), list(range(234, 244)))

    def test_recovered_candidates_are_not_capped_and_keep_sorted_order(self):
        self.assertEqual(self.selected_wave(recovered=True), list(range(234, 244)))

    def test_explicit_operator_cap_still_works(self):
        self.data['campaign']['max_workers'] = 6
        self.assertEqual(self.selected_wave(), list(range(234, 240)))

    def test_native_jobs_write_astra_medium_and_independent_sol_high(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            data = deepcopy(self.data)
            data['campaign']['storage_root'] = str(root)
            config = Config(DEFAULT_CONFIG, data)
            workspace = {'directory': str(root / 'attempt'), 'number': 234,
                         'paths': {'studio': str(root / 'studio'), 'mimir': str(root / 'mimir')}}
            settings = root / 'studio/.mimir/settings.json'
            settings.parent.mkdir(parents=True)
            settings.write_text(json.dumps({'unrelated': True}))
            with patch.object(workspaces, 'freeze_binary', return_value=Path('/native/mimir')), patch.object(
                    supervisor, 'launch') as launch:
                for kind, model, effort in [('worker', 'gpt-6-astra', 'medium'),
                                             ('review', 'gpt-6.1-sol', 'high')]:
                    workspaces.native_job(config, workspace, 'test prompt', kind=kind)
                    self.assertIsNone(launch.call_args.kwargs['timeout'])
                    self.assertNotIn('--run-timeout-seconds', launch.call_args.args[1])
                    saved = json.loads(settings.read_text())
                    self.assertEqual(saved['defaultProvider'], 'chatgpt')
                    self.assertEqual(saved['defaultModel'], model)
                    self.assertEqual(saved['model']['thinkingEffort'], effort)
                    self.assertTrue(saved['unrelated'])

    def test_completed_worker_is_checked_against_medium(self):
        store = Mock()
        store.tickets.return_value = {234: {'state': 'running', 'job': '/owned/worker'}}
        with patch.object(supervisor, 'inspect', return_value={'status': 'completed'}), patch.object(
                workspaces, 'assert_native_selection') as check:
            engine.reconcile_candidates(self.config, store, {})
        self.assertEqual(check.call_args.args[2], 'medium')
        self.assertEqual(store.update.call_args.args, (234, 'candidate'))

    def test_prompt_explicitly_selects_sol_high_for_delegation(self):
        prompt = engine.worker_prompt(self.config, {'parent': {}, 'comments': {}},
            {'scope': {'number': 234}, 'input_sha256': 'scope'},
            {'directory': '/owned/attempt', 'paths': {'studio': '/owned/studio', 'mimir': '/owned/mimir'}})
        self.assertIn('model="chatgpt/gpt-6.1-sol"', prompt)
        self.assertIn('reasoning_level="high"', prompt)
        self.assertIn('including implementation', prompt)

    def test_doctor_reports_configured_model_not_old_hardcoded_value(self):
        with patch.object(cli.GitHub, 'request', return_value={'permissions': {'push': True},
                'private': True, 'default_branch': 'main'}), patch.object(cli, 'git', return_value='sha'), patch.object(
                cli, 'command', return_value='--output --trace-dir --run-timeout-seconds'), patch.object(
                cli.shutil, 'which', return_value='/bin/tool'):
            result = cli.doctor(self.config)
        self.assertEqual(result['model'], 'chatgpt/gpt-6-astra')
        self.assertEqual(result['reasoning_effort'], 'medium')
