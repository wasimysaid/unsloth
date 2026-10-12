"""Retry preparation uses only isolated local Git worktrees, never a model or remote."""
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from scripts.mimir_ticket_runner import workspaces
from scripts.mimir_ticket_runner.common import git, read_json


class RetryWorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'campaign'
        self.config = SimpleNamespace(root=self.root, campaign={'id': 'fixture'},
                                      repositories={'studio': {}, 'mimir': {}})
        self.repositories = {}
        for name in self.config.repositories:
            repo = self.root / 'repositories' / name
            repo.mkdir(parents=True)
            git(repo, 'init', '-q', '-b', 'integration')
            git(repo, 'config', 'user.name', 'Test')
            git(repo, 'config', 'user.email', 'test@example.invalid')
            (repo / 'feature.txt').write_text('first\nsecond\nthird\n')
            (repo / 'deleted.txt').write_text('delete me\n')
            (repo / 'renamed.txt').write_text('rename me\n')
            (repo / '.gitignore').write_text('ignored/\n*.log\n')
            git(repo, 'add', '.')
            git(repo, 'commit', '-qm', 'integration base')
            self.repositories[name] = repo
        repository = patch.object(workspaces, 'repository', side_effect=lambda config, name: self.repositories[name])
        head = patch.object(workspaces, 'head', side_effect=lambda config, name: git(self.repositories[name], 'rev-parse', 'HEAD'))
        repository.start()
        self.addCleanup(repository.stop)
        head.start()
        self.addCleanup(head.stop)
        self.previous = workspaces.prepare(self.config, 234, 1)

    def path(self, name='studio', workspace=None):
        return Path((workspace or self.previous)['paths'][name])

    def advance(self, name='studio', feature=None):
        repo = self.repositories[name]
        (repo / 'integrated.txt').write_text('fresh integration\n')
        if feature is not None:
            (repo / 'feature.txt').write_text(feature)
        git(repo, 'add', '.')
        git(repo, 'commit', '-qm', 'new integration')
        return git(repo, 'rev-parse', 'HEAD')

    def test_carries_committed_staged_dirty_deleted_renamed_and_untracked_files(self):
        old = self.path()
        (old / 'feature.txt').write_text('committed\nsecond\nthird\n')
        (old / 'committed.bin').write_bytes(b'\x00\xffsaved\n')
        (old / 'committed.sh').write_text('#!/bin/sh\nexit 0\n')
        (old / 'committed.sh').chmod(0o755)
        (old / 'committed-link').symlink_to('feature.txt')
        git(old, 'mv', 'renamed.txt', 'new name.txt')
        git(old, 'add', '.')
        git(old, 'commit', '-qm', 'saved candidate')
        saved_head = git(old, 'rev-parse', 'HEAD')
        (old / 'feature.txt').write_text('committed\ndirty\nthird\n')
        (old / 'deleted.txt').unlink()
        (old / 'staged.txt').write_text('staged\n')
        git(old, 'add', 'staged.txt')
        (old / 'staged.txt').write_text('staged then edited\n')
        (old / 'untracked file.txt').write_text('new code\n')
        (old / 'binary.bin').write_bytes(b'\x00\xff\x01\n')
        (old / 'run.sh').write_text('#!/bin/sh\nexit 0\n')
        (old / 'run.sh').chmod(0o755)
        (old / 'link').symlink_to('untracked file.txt')
        old_status = git(old, 'status', '--porcelain')
        base = self.advance()
        # Changes in both repositories are independently retained.
        (self.path('mimir') / 'feature.txt').write_text('private runtime work\n')
        new = workspaces.prepare(self.config, 234, 2, previous=self.previous)
        current = self.path(workspace=new)
        self.assertEqual(new['bases']['studio'], base)
        self.assertEqual(git(current, 'rev-parse', 'HEAD'), base)
        self.assertEqual(git(current, 'branch', '--show-current'), new['branch'])
        self.assertEqual((current / 'integrated.txt').read_text(), 'fresh integration\n')
        self.assertEqual((current / 'feature.txt').read_text(), 'committed\ndirty\nthird\n')
        self.assertEqual((current / 'staged.txt').read_text(), 'staged then edited\n')
        self.assertFalse((current / 'deleted.txt').exists())
        self.assertFalse((current / 'renamed.txt').exists())
        self.assertEqual((current / 'new name.txt').read_text(), 'rename me\n')
        self.assertEqual((current / 'untracked file.txt').read_text(), 'new code\n')
        self.assertEqual((current / 'binary.bin').read_bytes(), b'\x00\xff\x01\n')
        self.assertEqual((current / 'committed.bin').read_bytes(), b'\x00\xffsaved\n')
        self.assertTrue((current / 'committed.sh').stat().st_mode & 0o111)
        self.assertEqual((current / 'committed-link').readlink(), Path('feature.txt'))
        self.assertTrue((current / 'run.sh').stat().st_mode & 0o111)
        self.assertTrue((current / 'link').is_symlink())
        self.assertEqual((current / 'link').readlink(), Path('untracked file.txt'))
        self.assertEqual((self.path('mimir', new) / 'feature.txt').read_text(), 'private runtime work\n')
        self.assertEqual(git(old, 'rev-parse', 'HEAD'), saved_head)
        self.assertEqual(git(old, 'status', '--porcelain'), old_status)
        self.assertEqual(read_json(Path(new['directory']) / 'workspace.json'), new)
        workspaces.validate(self.config, new)

    def test_runtime_settings_ignored_files_and_build_artifacts_are_not_carried(self):
        old = self.path()
        for directory in ['ignored', 'node_modules', 'target', 'build', 'dist', '.venv', 'venv', '__pycache__', '.cache']:
            path = old / directory / 'generated.txt'
            path.parent.mkdir(parents=True)
            path.write_text('do not carry\n')
        (old / 'ignored.log').write_text('ignored\n')
        (old / '.mimir').mkdir()
        (old / '.mimir/settings.json').write_text('{"defaultModel":"old"}\n')
        (old / '.mimir/project.md').write_text('real project guidance\n')
        # Even staged runtime settings and force-added generated files are excluded.
        git(old, 'add', '-f', '.mimir/settings.json', 'node_modules/generated.txt')
        old_status = git(old, 'status', '--porcelain')
        new = workspaces.prepare(self.config, 234, 2, previous=self.previous)
        current = self.path(workspace=new)
        for directory in ['ignored', 'node_modules', 'target', 'build', 'dist', '.venv', 'venv', '__pycache__', '.cache']:
            self.assertFalse((current / directory).exists(), directory)
        self.assertFalse((current / 'ignored.log').exists())
        self.assertFalse((current / '.mimir/settings.json').exists())
        self.assertEqual((current / '.mimir/project.md').read_text(), 'real project guidance\n')
        self.assertEqual(git(old, 'status', '--porcelain'), old_status)

    def test_three_way_replay_preserves_nonoverlapping_integration_edit(self):
        old = self.path()
        lines = ''.join(f'line {i}\n' for i in range(20))
        repo = self.repositories['studio']
        # Establish a shared larger file so edits have disjoint merge contexts.
        (repo / 'feature.txt').write_text(lines)
        git(repo, 'add', '.')
        git(repo, 'commit', '-qm', 'larger base')
        self.previous = workspaces.prepare(self.config, 235, 1)
        old = self.path()
        (old / 'feature.txt').write_text(lines.replace('line 1\n', 'candidate edit\n'))
        base = self.advance(feature=lines.replace('line 18\n', 'integration edit\n'))
        new = workspaces.prepare(self.config, 235, 2, previous=self.previous)
        current = self.path(workspace=new)
        self.assertEqual((current / 'feature.txt').read_text(), lines.replace('line 1\n', 'candidate edit\n').replace('line 18\n', 'integration edit\n'))
        self.assertEqual(new['bases']['studio'], base)
        self.assertFalse(git(current, 'ls-files', '--unmerged'))

    def test_conflicting_replay_retains_saved_code_without_conflict_markers(self):
        old = self.path()
        (old / 'feature.txt').write_text('saved candidate\nsecond\nthird\n')
        (old / 'deleted.txt').unlink()
        (old / 'new file.txt').write_text('still saved\n')
        git(old, 'add', '.')
        git(old, 'commit', '-qm', 'conflicting candidate')
        (old / 'feature.txt').write_text('saved dirty candidate\nsecond\nthird\n')
        saved_head = git(old, 'rev-parse', 'HEAD')
        old_status = git(old, 'status', '--porcelain')
        base = self.advance(feature='conflicting integration\nsecond\nthird\n')
        new = workspaces.prepare(self.config, 234, 2, previous=self.previous)
        current = self.path(workspace=new)
        self.assertEqual((current / 'feature.txt').read_text(), (old / 'feature.txt').read_text())
        self.assertEqual((current / 'new file.txt').read_text(), 'still saved\n')
        self.assertFalse((current / 'deleted.txt').exists())
        self.assertEqual((current / 'integrated.txt').read_text(), 'fresh integration\n')
        self.assertFalse(git(current, 'ls-files', '--unmerged'))
        self.assertEqual(git(current, 'rev-parse', 'HEAD'), base)
        self.assertEqual(new['bases']['studio'], base)
        self.assertEqual(git(old, 'rev-parse', 'HEAD'), saved_head)
        self.assertEqual(git(old, 'status', '--porcelain'), old_status)

    def test_saved_directory_replaces_new_base_file_collision(self):
        old = self.path()
        (old / 'new-directory').mkdir()
        (old / 'new-directory/code.txt').write_text('saved source\n')
        repo = self.repositories['studio']
        (repo / 'new-directory').write_text('new integration file\n')
        base = self.advance()
        new = workspaces.prepare(self.config, 234, 2, previous=self.previous)
        current = self.path(workspace=new)
        self.assertEqual((current / 'new-directory/code.txt').read_text(), 'saved source\n')
        self.assertEqual((current / 'integrated.txt').read_text(), 'fresh integration\n')
        self.assertEqual(git(current, 'rev-parse', 'HEAD'), base)
        self.assertEqual((old / 'new-directory/code.txt').read_text(), 'saved source\n')

    def test_current_base_runtime_settings_are_retained_not_overwritten(self):
        repo = self.repositories['studio']
        (repo / '.mimir').mkdir()
        (repo / '.mimir/settings.json').write_text('{"base":1}\n')
        git(repo, 'add', '.')
        git(repo, 'commit', '-qm', 'tracked project settings')
        self.previous = workspaces.prepare(self.config, 235, 1)
        old = self.path()
        (old / '.mimir/settings.json').write_text('{"oldRuntime":true}\n')
        (old / 'feature.txt').write_text('saved code\n')
        (repo / '.mimir/settings.json').write_text('{"base":2}\n')
        base = self.advance()
        new = workspaces.prepare(self.config, 235, 2, previous=self.previous)
        current = self.path(workspace=new)
        self.assertEqual((current / '.mimir/settings.json').read_text(), '{"base":2}\n')
        self.assertEqual((current / 'feature.txt').read_text(), 'saved code\n')
        self.assertEqual(new['bases']['studio'], base)
        self.assertEqual((old / '.mimir/settings.json').read_text(), '{"oldRuntime":true}\n')

    def test_existing_receipt_does_not_replay_over_new_attempt_edits(self):
        old = self.path()
        (old / 'feature.txt').write_text('saved work\n')
        new = workspaces.prepare(self.config, 234, 2, previous=self.previous)
        current = self.path(workspace=new)
        (current / 'feature.txt').write_text('retry agent progress\n')
        (old / 'feature.txt').write_text('later old change\n')
        self.assertEqual(workspaces.prepare(self.config, 234, 2, previous=self.previous), new)
        self.assertEqual((current / 'feature.txt').read_text(), 'retry agent progress\n')

    def test_without_previous_still_prepares_clean_current_bases(self):
        (self.path() / 'feature.txt').write_text('must not leak\n')
        base = self.advance()
        new = workspaces.prepare(self.config, 234, 2)
        current = self.path(workspace=new)
        self.assertEqual(git(current, 'status', '--porcelain'), '')
        self.assertEqual(new['bases']['studio'], base)
        self.assertEqual((current / 'feature.txt').read_text(), 'first\nsecond\nthird\n')


if __name__ == '__main__':
    unittest.main()
