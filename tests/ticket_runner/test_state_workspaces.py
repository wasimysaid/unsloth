from contextlib import contextmanager
import copy
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace

from scripts.mimir_ticket_runner.common import RunnerError, command, git
from scripts.mimir_ticket_runner.config import Config
from scripts.mimir_ticket_runner.state import Store, campaign_lock
from scripts.mimir_ticket_runner import workspaces


class StateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / 'campaign'
        self.config = SimpleNamespace(root=self.root, fingerprint='policy1', data={'test': True},
                                      campaign={'repo': 'fixture/test', 'parent': 9})

    def tearDown(self):
        self.temp.cleanup()

    def test_reopen_receipts_and_wave_order(self):
        with Store(self.config) as store:
            store.begin_wave([3, 7])
            store.update(3, 'running', attempt=1)
            store.update(3, 'completed', integration={'sha': 'abc'})
        with Store(self.config, readonly=True) as store:
            self.assertEqual(store.completed(), {3})
            self.assertEqual(store.wave()['numbers'], [3, 7])
            self.assertEqual(store.get(3)['attempt'], 1)

    def test_cannot_overwrite_policy_or_completion(self):
        with Store(self.config) as store:
            store.update(3, 'completed')
            with self.assertRaises(RunnerError):
                store.update(3, 'running')
        self.config.fingerprint = 'changed'
        with self.assertRaises(RunnerError):
            Store(self.config)

    def test_lock_is_per_queue_not_campaign_name(self):
        other = copy.copy(self.config)
        other.root = self.root.parent / 'alias'
        with campaign_lock(self.config):
            with self.assertRaises(RunnerError):
                with campaign_lock(other):
                    pass

    def test_waves_are_persisted_and_cannot_overlap(self):
        with Store(self.config) as store:
            with self.assertRaises(RunnerError):
                store.begin_wave([7, 3])
            store.begin_wave([3, 7])
            with self.assertRaises(RunnerError):
                store.begin_wave([8])
            store.finish_wave()
            self.assertIsNone(store.wave())

    def test_path_and_worktree_identity(self):
        repo = self.root / 'repositories/studio'
        repo.mkdir(parents=True)
        git(repo, 'init', '-q')
        git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'base')
        path = self.root / 'attempts/1/1/studio'
        git(repo, 'worktree', 'add', '-b', 'ticket', str(path))
        workspace = {'paths': {'studio': str(path)}, 'branch': 'ticket'}
        workspaces.validate(self.config, workspace)
        workspace['branch'] = 'another'
        with self.assertRaises(RunnerError):
            workspaces.validate(self.config, workspace)
