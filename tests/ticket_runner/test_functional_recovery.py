"""Small regressions for functional review findings; check subprocesses are real."""
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from test_integration import GitFixture
from scripts.mimir_ticket_runner import engine, integration, launcher, verification
from scripts.mimir_ticket_runner.common import RunnerError, atomic_json, git


class FunctionalRecovery(GitFixture):
    def setUp(self):
        super().setUp()
        self.config.approved = {234, 235, 256}
        self.config.tickets.update({235: {}, 256: {'human': True}})
        self.config.campaign['max_attempts'] = 2

    def test_positive_human_approval_dispatch(self):
        args = SimpleNamespace(operation='approve', issue=256, apply=True, evidence_url='https://example.invalid/review')
        with patch.object(integration, 'approve', return_value={'approved': True}) as approve:
            self.assertEqual(engine.dispatch(self.config, args), {'approved': True})
            self.assertEqual(approve.call_args.args[2:], (256, args.evidence_url))

    def test_retry_selection_that_was_blocked_before_claim(self):
        self.store.update(235, 'blocked', reason='Authorization label temporarily removed')
        engine.dispatch(self.config, SimpleNamespace(operation='retry', issue=235, apply=True))
        row = self.store.get(235)
        self.assertEqual((row['state'], row['attempt']), ('claimed', 1))
        self.assertNotIn('workspace', row)

    def test_explicit_phase_retry_preserves_merges_and_reruns_settled_check(self):
        studio = Path(self.workspace['paths']['studio'])
        (studio / 'test_feature.py').write_text('import unittest\nfrom pathlib import Path\nclass FeatureTest(unittest.TestCase):\n    def test_file(self):\n        self.assertEqual(Path("feature.txt").read_text(), "base\\n")\n')
        (studio / '.gitignore').write_text('__pycache__/\n')
        git(studio, 'add', 'test_feature.py', '.gitignore')
        git(studio, 'commit', '-qm', 'fixture with one genuine unittest')
        self.workspace['bases']['studio'] = git(studio, 'rev-parse', 'HEAD')
        self.store.update(234, 'candidate', workspace=self.workspace)
        marker = self.root / 'available'
        command = {'repo': 'studio', 'argv': ['python3', '-c', f'from pathlib import Path; assert Path({str(marker)!r}).exists()'], 'timeout': 10}
        self.config.check_commands = lambda _: [command]
        transaction = {'merged': {'mimir': self.head('mimir')}}
        self.store.update(234, 'merging', integration=transaction, attempt=1)
        with self.assertRaises(RunnerError):
            verification.verify(self.config, self.store.get(234), 'pinned')
        old = set((Path(self.workspace['directory']) / 'verification').iterdir())
        # The worker receipt is a fixture; the failed verification subprocess above
        # is real and already settled. No native model is exercised by this test.
        with patch.object(engine.supervisor if hasattr(engine, 'supervisor') else verification.supervisor,
                          'inspect', return_value={'status': 'failed'}):
            engine.dispatch(self.config, SimpleNamespace(operation='retry', issue=234, apply=True))
        row = self.store.get(234)
        self.assertEqual(row['integration'], transaction)
        self.assertEqual(row['attempt'], 1)
        self.assertEqual(row['phase_attempt'], 1)
        marker.write_text('available')
        try:
            verified = verification.verify(self.config, row, 'pinned')
        except RunnerError:
            self.fail('\n'.join(p.read_text() for p in Path(self.workspace['directory']).rglob('stderr.log')))
        self.assertTrue(all(x['result']['status'] == 'completed' for x in verified['checks']))
        self.assertEqual(len(set((Path(self.workspace['directory']) / 'verification').iterdir()) - old), 1)

    def test_reopened_completed_prerequisite_revokes_authority(self):
        self.store.update(235, 'completed', completed_scope='prior', completed_pair=self.workspace['bases'])
        snapshot = {'issues': [{'number': 235, 'state': 'open'}]}
        with patch.object(integration.GitHub, 'snapshot', return_value=snapshot), patch.object(
                engine, 'reconcile_scope'), patch.object(integration.workspaces, 'head', side_effect=lambda c, name: self.head(name)):
            with self.assertRaisesRegex(RunnerError, 'reopened/cancelled'):
                integration.require_authority(self.config, self.store, 234)

    def test_launcher_uses_integrated_revision_not_original_checkout(self):
        original = self.head('studio')
        feature = self.workspace['paths']['studio']
        (Path(feature) / 'integrated.txt').write_text('new integrated feature')
        git(feature, 'add', '.')
        git(feature, 'commit', '-qm', 'feature integration')
        revision = git(feature, 'rev-parse', 'HEAD')
        self.config.repositories['studio']['source'] = str(self.repositories['studio'])
        with patch.object(integration.workspaces, 'head', return_value=revision), patch.object(
                integration.workspaces, 'repository', return_value=self.repositories['studio']), patch.object(
                launcher, '_launch_checkout', return_value={'ok': True}) as launch:
            self.assertEqual(launcher.launch(self.config, 8899), {'ok': True})
            selected = Path(launch.call_args.args[0].repositories['studio']['source'])
        self.assertEqual(git(selected, 'rev-parse', 'HEAD'), revision)
        self.assertEqual(git(self.repositories['studio'], 'rev-parse', 'HEAD'), original)
        self.assertEqual((selected / 'integrated.txt').read_text(), 'new integrated feature')
