import copy
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from scripts.mimir_ticket_runner.common import RunnerError, digest
from scripts.mimir_ticket_runner.config import Config
from scripts.mimir_ticket_runner.engine import dispatch, resource_ready, scope, worker_prompt


class EnginePolicyTests(unittest.TestCase):
    def fixture(self):
        return {'parent': {'body': 'Spec'}, 'issues': [{'number': 234, 'title': 'First', 'body': '- [ ] Real criterion'}],
                'comments': {'234': [{'id': 1, 'body': 'User clarification'}, {'id': 2, 'body': '<!-- mimir-runner:test -->'}]},
                'blockers': {'234': []}}

    def test_scope_hash_excludes_only_runner_comments(self):
        snapshot = self.fixture()
        original = digest(scope(snapshot, 234))
        snapshot['comments']['234'][1]['body'] += 'new status'
        self.assertEqual(digest(scope(snapshot, 234)), original)
        snapshot['comments']['234'][0]['body'] += 'changed requirement'
        self.assertNotEqual(digest(scope(snapshot, 234)), original)

    def test_removed_child_cannot_run(self):
        with self.assertRaises(RunnerError):
            scope(self.fixture(), 235)

    def test_mutating_commands_require_apply(self):
        for operation in ('run', 'resume', 'retry', 'approve'):
            with self.subTest(operation=operation), self.assertRaises(RunnerError):
                dispatch(Config.load(), SimpleNamespace(operation=operation, apply=False))

    def test_worker_has_exact_scope_and_host_paths_are_remapped(self):
        config = Config.load()
        snapshot = self.fixture()
        snapshot['parent']['body'] = 'Mimir /home/mugi/code/mimir and Studio /home/mugi/unsloth'
        row = {'scope': scope(snapshot, 234), 'input_sha256': 'expected'}
        workspace = {'directory': '/owned/job', 'paths': {'mimir': '/owned/mimir', 'studio': '/owned/studio'}}
        prompt = worker_prompt(config, snapshot, row, workspace)
        self.assertIn('/owned/mimir', prompt)
        self.assertNotIn('/home/mugi/code/mimir', prompt)
        self.assertIn('Do not commit, push, merge', prompt)
        self.assertIn('ticket-result.json', prompt)
        self.assertIn('Mimir owns application execution/history', prompt)

    def test_gpu_requires_nonexpired_explicit_grant(self):
        config = Config.load()
        with patch('scripts.mimir_ticket_runner.engine.read_json', return_value={}):
            self.assertFalse(resource_ready(config, 246))
            self.assertTrue(resource_ready(config, 234))
        with patch('scripts.mimir_ticket_runner.engine.read_json', return_value={'expires': 1, 'devices': [0]}):
            self.assertFalse(resource_ready(config, 246))
