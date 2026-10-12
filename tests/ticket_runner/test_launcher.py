"""Offline launcher checks: real local Git/ports/backend fixture; mocked build/API boundaries."""
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from scripts.mimir_ticket_runner import launcher
from scripts.mimir_ticket_runner.common import RunnerError, command
from scripts.mimir_ticket_runner.github import GitHubError


INITIAL_PIN = 'fe821251db6d8327fb59fde5f5a2cad9de0c231c'
MANIFEST = ('manifest_version = 1\nid = "test.actual-frontend"\nversion = "0.1.0"\n'
            'artifact = "plugin.wasm"\nlifetime = "runtime"\nfrontends = ["headless"]\n')
WASM = b'\x00asm\x0d\x00\x01\x00offline-artifact-fixture'
PRIVATE_INFO = {'full_name': 'wasimysaid/mimir', 'private': True, 'permissions': {'pull': True}}


def sha(value):
    return hashlib.sha256(value).hexdigest()


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(value if isinstance(value, bytes) else value.encode())


def git(path, *args):
    return command(['git', '-c', 'core.hooksPath=/dev/null', '-C', path, *args])


def snapshot_commit(path):
    git(path, 'add', '.')
    git(path, '-c', 'user.name=Launcher Fixture', '-c', 'user.email=fixture@example.invalid',
        'commit', '--quiet', '-m', 'offline fixture snapshot')
    return git(path, 'rev-parse', 'HEAD')


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='mimir-launcher-test-')
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.studio = self.directory / 'source-studio'
        self.mimir = self.directory / 'source-mimir'
        for root, repo in ((self.studio, 'wasimysaid/unsloth'), (self.mimir, 'wasimysaid/mimir')):
            root.mkdir()
            command(['git', 'init', '--quiet', root])
            git(root, 'remote', 'add', 'origin', f'https://github.com/{repo}.git')
        write(self.mimir / 'Cargo.toml', '# Offline repository fixture; no native build is executed.\n')
        self.pin = snapshot_commit(self.mimir)
        self.frontend = {
            'plugin_id': 'test.actual-frontend',
            'build': [{'repo': 'studio', 'cwd': '.', 'argv': ['fixture-build', '{mimir_sdk}', '{plugin_package}'], 'timeout': 300}],
            'package': {'repo': 'studio', 'path': 'studio/plugin-package'},
            'artifacts': {'mimir-plugin.toml': sha(MANIFEST.encode()), 'plugin.wasm': sha(WASM)},
            'environment': {'UNSLOTH_TEST_MIMIR_BINARY': '{mimir_binary}', 'UNSLOTH_TEST_PLUGIN_PACKAGE': '{plugin_package}'},
        }
        self.lock = {'version': 1, 'mimir': {'repository': 'wasimysaid/mimir', 'revision': self.pin},
                     'frontend': self.frontend}
        self.lock_path = self.studio / launcher.LOCK_PATH
        write(self.lock_path, json.dumps(self.lock, indent=2) + '\n')
        write(self.studio / 'studio/frontend/package.json', '{"scripts":{"build":"fixture"}}\n')
        write(self.studio / 'studio/frontend/package-lock.json', '{}\n')
        write(self.studio / 'studio/backend/run.py',
              'import json, os, pathlib, sys\n'
              'pathlib.Path("backend-observed.json").write_text(json.dumps({"argv":sys.argv[1:],'
              '"binary":os.environ["UNSLOTH_TEST_MIMIR_BINARY"],'
              '"package":os.environ["UNSLOTH_TEST_PLUGIN_PACKAGE"],'
              '"mimir_state":os.environ.get("MIMIR_CODING_AGENT_DIR"),'
              '"gpu":os.environ["CUDA_VISIBLE_DEVICES"]}))\n')
        self.studio_pin = snapshot_commit(self.studio)
        self.config = SimpleNamespace(root=self.directory / 'campaign', repositories={
            'studio': {'github': 'wasimysaid/unsloth', 'source': str(self.studio)},
            'mimir': {'github': 'wasimysaid/mimir', 'source': str(self.mimir)}})
        self.config.root.mkdir()
        self.api = patch.object(launcher.GitHub, 'request', return_value=PRIVATE_INFO)
        self.api.start()
        self.addCleanup(self.api.stop)
        self.commands = []

    def port(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind(('127.0.0.1', 0))
            return probe.getsockname()[1]

    def update_lock(self, commit=False):
        write(self.lock_path, json.dumps(self.lock, indent=2) + '\n')
        if commit:
            self.studio_pin = snapshot_commit(self.studio)

    def build_boundary(self, argv, **kwargs):
        self.commands.append((list(map(str, argv)), kwargs))
        if argv[0] == 'cargo':
            binary = Path(kwargs['env']['CARGO_TARGET_DIR']) / 'release/mimir'
            write(binary, '#!/bin/sh\nexit 0\n')
            binary.chmod(0o700)
            return ''
        if argv[0] == 'fixture-build':
            package = Path(argv[2])
            write(package / 'mimir-plugin.toml', MANIFEST)
            write(package / 'plugin.wasm', WASM)
            return ''
        if argv[0] == 'npm':
            if argv[1:] == ['run', 'build']:
                write(Path(kwargs['cwd']) / 'dist/index.html', '<html>Offline Studio build fixture</html>\n')
            return ''
        return command(argv, **kwargs)

    def run_fixture(self, port=None):
        with patch.object(launcher, 'command', side_effect=self.build_boundary):
            return launcher.launch(self.config, port or self.port())

    def test_initial_lock_is_honestly_unimplemented(self):
        initial = json.loads((Path(launcher.__file__).resolve().parents[2] / launcher.LOCK_PATH).read_text())
        self.assertEqual(initial, {'version': 1, 'mimir': {'repository': 'wasimysaid/mimir', 'revision': INITIAL_PIN}, 'frontend': None})
        self.lock['frontend'] = None
        self.update_lock()
        with patch.object(launcher, 'command') as commands:
            with self.assertRaisesRegex(RunnerError, 'not implemented.*ticket #234'):
                launcher.launch(self.config, self.port())
        commands.assert_not_called()
        self.assertFalse((self.config.root / 'launch').exists())

    def test_cli_null_frontend_refuses_with_exit_two(self):
        from scripts.mimir_ticket_runner import cli
        self.lock['frontend'] = None
        self.update_lock()
        error = io.StringIO()
        with patch.object(cli.Config, 'load', return_value=self.config), patch.object(cli.sys, 'stderr', error):
            self.assertEqual(cli.main(['launch', '--port', str(self.port())]), 2)
        self.assertIn('not implemented', error.getvalue())
        self.assertIn('ticket #234', error.getvalue())
        self.assertFalse((self.config.root / 'launch').exists())

    def test_absent_descriptor_refuses_before_side_effects(self):
        self.lock_path.unlink()
        with patch.object(launcher, 'command') as commands:
            with self.assertRaisesRegex(RunnerError, 'Missing runtime lock.*not implemented'):
                launcher.launch(self.config, self.port())
        commands.assert_not_called()

    def test_requires_exact_pin_and_private_repository(self):
        for invalid in ('mimir-studio', 'main', self.pin[:12], 'A' * 40, None):
            with self.subTest(invalid=invalid):
                self.lock['mimir']['revision'] = invalid
                self.update_lock()
                with self.assertRaisesRegex(RunnerError, 'exact lowercase 40-character'):
                    launcher.descriptor(self.config)
        self.lock['mimir']['revision'] = self.pin
        self.lock['mimir']['repository'] = 'unslothai/mimir'
        self.update_lock()
        with self.assertRaisesRegex(RunnerError, 'private wasimysaid/mimir'):
            launcher.descriptor(self.config)

    def test_pin_resolution_does_not_use_or_switch_source_head(self):
        write(self.mimir / 'newer.txt', 'source tip must stay here\n')
        source_tip = snapshot_commit(self.mimir)
        source_status = git(self.mimir, 'status', '--porcelain')
        destination = self.config.root / 'pinned'
        launcher.pinned_clone(self.config, 'mimir', destination, self.pin, os.environ.copy())
        self.assertEqual(git(destination, 'rev-parse', 'HEAD'), self.pin)
        self.assertEqual(git(destination, 'branch', '--show-current'), '')
        self.assertFalse((destination / '.git/objects/info/alternates').exists())
        self.assertEqual(git(self.mimir, 'rev-parse', 'HEAD'), source_tip)
        self.assertEqual(git(self.mimir, 'status', '--porcelain'), source_status)

    def test_unavailable_pin_never_falls_back_to_branch(self):
        actual_git = launcher._git
        calls = []
        def deny_fetch(path, *args, **kwargs):
            calls.append(args)
            if 'fetch' in args:
                raise RunnerError('offline simulated private fetch failure')
            return actual_git(path, *args, **kwargs)
        with patch.object(launcher, '_git', side_effect=deny_fetch):
            with self.assertRaisesRegex(RunnerError, 'Cannot resolve exact mimir pin.*No branch fallback'):
                launcher.pinned_clone(self.config, 'mimir', self.config.root / 'missing-pin', 'f' * 40, os.environ.copy())
        self.assertEqual(git(self.mimir, 'rev-parse', 'HEAD'), self.pin)
        self.assertFalse(any('checkout' in args for args in calls))

    def test_unavailable_private_access_and_public_fallback_refuse(self):
        with patch.object(launcher.GitHub, 'request', side_effect=GitHubError('offline access denied')):
            with patch.object(launcher, 'pinned_clone') as clone:
                with self.assertRaisesRegex(RunnerError, 'Private Mimir access unavailable.*gh auth status'):
                    launcher.launch(self.config, self.port())
                clone.assert_not_called()
        for info in ({**PRIVATE_INFO, 'private': False}, {**PRIVATE_INFO, 'full_name': 'other/mimir'},
                     {**PRIVATE_INFO, 'permissions': {'pull': False}}):
            with self.subTest(info=info), patch.object(launcher.GitHub, 'request', return_value=info):
                with self.assertRaisesRegex(RunnerError, 'Private Mimir access unavailable'):
                    launcher.private_access(self.config)
        git(self.mimir, 'remote', 'set-url', 'origin', 'https://github.com/other/mimir.git')
        with self.assertRaisesRegex(RunnerError, 'source origin must identify wasimysaid/mimir'):
            launcher.private_access(self.config)

    def test_occupied_localhost_port_refuses_before_private_access_or_build(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as occupied:
            occupied.bind(('127.0.0.1', 0))
            occupied.listen()
            with patch.object(launcher, 'private_access') as access:
                with self.assertRaisesRegex(RunnerError, 'Localhost port .* unavailable'):
                    launcher.launch(self.config, occupied.getsockname()[1])
                access.assert_not_called()
        for port in (0, -1, 65536, True, '8899'):
            with self.subTest(port=port), self.assertRaises(RunnerError):
                launcher._port_available(port)

    def test_descriptor_paths_templates_and_host_overrides_fail_closed(self):
        for path in ('../outside', '/tmp/outside', 'C:/outside', 'a/../outside', 'a\\outside', './package', ''):
            with self.subTest(path=path):
                self.lock['frontend'] = copy.deepcopy(self.frontend)
                self.lock['frontend']['package']['path'] = path
                self.update_lock()
                with self.assertRaises(RunnerError):
                    launcher.descriptor(self.config)
        self.lock['frontend'] = copy.deepcopy(self.frontend)
        self.lock['frontend']['artifacts']['../evil.wasm'] = '0' * 64
        self.update_lock()
        with self.assertRaises(RunnerError):
            launcher.descriptor(self.config)
        self.lock['frontend'] = copy.deepcopy(self.frontend)
        self.lock['frontend']['environment']['MIMIR_CODING_AGENT_DIR'] = '/tmp/alternate-state'
        self.update_lock()
        with self.assertRaisesRegex(RunnerError, 'shared configuration'):
            launcher.descriptor(self.config)
        self.lock['frontend'] = copy.deepcopy(self.frontend)
        self.lock['frontend']['build'][0]['argv'].append('{unknown_source}')
        self.update_lock()
        with self.assertRaisesRegex(RunnerError, 'Unknown descriptor template'):
            launcher.descriptor(self.config)

    def test_real_backend_fixture_uses_verified_binary_package_and_loopback_flags(self):
        port = self.port()
        result = self.run_fixture(port)
        base = Path(result['runtime'])
        observed = json.loads((base / 'studio/backend-observed.json').read_text())
        self.assertEqual(observed['argv'], ['--host', '127.0.0.1', '--port', str(port), '--no-cloudflare'])
        self.assertEqual(observed['binary'], str(base / 'target/release/mimir'))
        self.assertEqual(observed['package'], str(base / 'studio/studio/plugin-package'))
        self.assertEqual(observed['gpu'], '')
        self.assertEqual(result['mimir_revision'], self.pin)
        self.assertEqual(result['studio_revision'], self.studio_pin)
        self.assertEqual(result['status'], 'stopped')
        self.assertEqual(result['exit_code'], 0)
        self.assertTrue(any(argv == ['cargo', 'build', '--locked', '--release', '-p', 'mimir-cli', '--bin', 'mimir'] for argv, _ in self.commands))
        self.assertTrue(any(argv == ['npm', 'run', 'build'] for argv, _ in self.commands))
        for argv, kwargs in self.commands:
            if argv[0] in {'cargo', 'npm', 'fixture-build'}:
                self.assertTrue(Path(kwargs['cwd']).is_relative_to(self.config.root))
                for key in ('CARGO_TARGET_DIR', 'CARGO_HOME', 'npm_config_cache', 'HF_HOME', 'TMPDIR', 'MIMIR_CODING_AGENT_DIR'):
                    self.assertTrue(Path(kwargs['env'][key]).is_relative_to(self.config.root))

    def test_malformed_descriptor_values_fail_with_runner_error(self):
        mutations = [lambda d: d['package'].update(repo=[]),
                     lambda d: d['build'][0].update(repo=[]),
                     lambda d: d['build'][0].update(timeout=True),
                     lambda d: d['build'][0].update(argv='shell text'),
                     lambda d: d['environment'].update(MIMIR_TEST=True),
                     lambda d: d['artifacts'].update({'plugin.wasm': 'not-a-hash'})]
        for mutate in mutations:
            self.lock['frontend'] = copy.deepcopy(self.frontend)
            mutate(self.lock['frontend'])
            self.update_lock()
            with self.assertRaises(RunnerError):
                launcher.descriptor(self.config)

    def test_newly_occupied_port_after_build_refuses_backend(self):
        occupied = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.addCleanup(occupied.close)
        port = self.port()
        def take_port(argv, **kwargs):
            output = self.build_boundary(argv, **kwargs)
            if argv == ['npm', 'run', 'build']:
                occupied.bind(('127.0.0.1', port))
                occupied.listen()
            return output
        with patch.object(launcher, 'command', side_effect=take_port):
            with self.assertRaisesRegex(RunnerError, 'Localhost port .* unavailable'):
                launcher.launch(self.config, port)
        self.assertFalse(list((self.config.root / 'launch').rglob('backend-observed.json')))

    def test_runtime_lock_excludes_simultaneous_builds(self):
        identity = {'lock_sha256': launcher.digest(self.lock), 'mimir_revision': self.pin,
                    'studio_revision': self.studio_pin}
        base = self.config.root / 'launch' / launcher.digest(identity)
        base.mkdir(parents=True)
        with (base / '.lock').open('a') as guard:
            launcher.fcntl.flock(guard, launcher.fcntl.LOCK_EX | launcher.fcntl.LOCK_NB)
            with self.assertRaisesRegex(RunnerError, 'already being built or served'):
                self.run_fixture()
        self.assertFalse((base / 'build-intent.json').exists())

    def test_ambient_git_plumbing_cannot_retarget_checkout(self):
        with patch.dict(os.environ, {'GIT_DIR': str(self.mimir / '.git'), 'GIT_WORK_TREE': str(self.mimir)}):
            result = self.run_fixture()
        self.assertEqual(result['studio_revision'], self.studio_pin)
        self.assertEqual(git(self.mimir, 'rev-parse', 'HEAD'), self.pin)
        for _, kwargs in self.commands:
            self.assertNotIn('GIT_DIR', kwargs['env'])
            self.assertNotIn('GIT_WORK_TREE', kwargs['env'])

    def test_unlisted_package_files_fail_closed(self):
        def extra_file(argv, **kwargs):
            output = self.build_boundary(argv, **kwargs)
            if argv[0] == 'fixture-build':
                write(Path(argv[2]) / 'unlisted-asset.json', '{}\n')
            return output
        with patch.object(launcher, 'command', side_effect=extra_file):
            with self.assertRaisesRegex(RunnerError, 'unlisted/missing package files'):
                launcher.launch(self.config, self.port())

    def test_frontend_artifact_mismatch_never_starts_backend(self):
        def corrupt(argv, **kwargs):
            output = self.build_boundary(argv, **kwargs)
            if argv[0] == 'fixture-build':
                write(Path(argv[2]) / 'plugin.wasm', b'changed fixture artifact')
            return output
        with patch.object(launcher, 'command', side_effect=corrupt):
            with self.assertRaisesRegex(RunnerError, 'artifact SHA-256 mismatch'):
                launcher.launch(self.config, self.port())
        self.assertFalse(list((self.config.root / 'launch').rglob('backend-observed.json')))

    def test_receipted_binary_and_dist_tampering_refuse_reuse(self):
        for artifact in ('target/release/mimir', 'studio/studio/frontend/dist/index.html'):
            with self.subTest(artifact=artifact):
                result = self.run_fixture()
                path = Path(result['runtime']) / artifact
                original = path.read_bytes()
                path.write_bytes(original + b'tampered')
                self.commands.clear()
                with self.assertRaisesRegex(RunnerError, 'artifact receipt mismatch'):
                    self.run_fixture()
                self.assertFalse(any(argv[0] in {'cargo', 'npm', 'fixture-build'} for argv, _ in self.commands))
                path.write_bytes(original)

    def test_uncommitted_descriptor_and_changed_clone_source_refuse(self):
        self.lock['frontend']['plugin_id'] = 'changed.plugin'
        self.update_lock()
        with self.assertRaisesRegex(RunnerError, 'uncommitted changes'):
            launcher.launch(self.config, self.port())
        self.lock['frontend']['plugin_id'] = 'test.actual-frontend'
        self.update_lock()
        result = self.run_fixture()
        write(Path(result['runtime']) / 'mimir/Cargo.toml', 'changed pinned source\n')
        with self.assertRaisesRegex(RunnerError, 'tracked source was changed'):
            self.run_fixture()

    def test_symlink_package_refuses(self):
        def symlink(argv, **kwargs):
            output = self.build_boundary(argv, **kwargs)
            if argv[0] == 'fixture-build':
                path = Path(argv[2]) / 'plugin.wasm'
                path.unlink()
                path.symlink_to(self.lock_path)
            return output
        with patch.object(launcher, 'command', side_effect=symlink):
            with self.assertRaisesRegex(RunnerError, 'symlink'):
                launcher.launch(self.config, self.port())

    def test_subprocess_build_start_and_backend_failures_are_actionable(self):
        def fail_build(argv, **kwargs):
            if argv[0] == 'cargo':
                raise RunnerError('Command exited 17: cargo')
            return self.build_boundary(argv, **kwargs)
        with patch.object(launcher, 'command', side_effect=fail_build):
            with self.assertRaisesRegex(RunnerError, 'Command exited 17: cargo'):
                launcher.launch(self.config, self.port())
        with self.assertRaisesRegex(RunnerError, 'Incomplete unreceipted runtime build'):
            self.run_fixture()
        self.config.root = self.directory / 'fresh-campaign'
        self.config.root.mkdir()
        result = self.run_fixture()
        real_run = subprocess.run
        def fail_backend(argv, **kwargs):
            if str(argv[0]) == str(launcher.sys.executable):
                return SimpleNamespace(returncode=23)
            return real_run(argv, **kwargs)
        with patch.object(launcher.subprocess, 'run', side_effect=fail_backend):
            with self.assertRaisesRegex(RunnerError, 'Studio backend exited 23'):
                self.run_fixture()
        def missing_backend(argv, **kwargs):
            if str(argv[0]) == str(launcher.sys.executable):
                raise OSError('offline executable unavailable')
            return real_run(argv, **kwargs)
        with patch.object(launcher.subprocess, 'run', side_effect=missing_backend):
            with self.assertRaisesRegex(RunnerError, 'Cannot start Studio backend'):
                self.run_fixture()
        self.assertTrue(Path(result['runtime']).is_relative_to(self.config.root))

    def test_launch_leaves_original_checkouts_and_global_configuration_unchanged(self):
        home = self.directory / 'home'
        write(home / '.mimir/settings.json', '{"defaultProvider":"do-not-change","plugins":{}}\n')
        write(home / '.gitconfig', '[user]\n\tname = Preserved Fixture\n')
        write(self.studio / '.mimir/settings.json', '{"fixture":"preserved source"}\n')
        preserved = {path: path.read_bytes() for path in (home / '.mimir/settings.json', home / '.gitconfig',
                     self.studio / '.mimir/settings.json', self.studio / '.git/config', self.mimir / '.git/config')}
        heads = {path: git(path, 'rev-parse', 'HEAD') for path in (self.studio, self.mimir)}
        states = {path: git(path, 'status', '--porcelain') for path in (self.studio, self.mimir)}
        with patch.dict(os.environ, {'HOME': str(home), 'CUDA_VISIBLE_DEVICES': 'fixture-not-a-gpu',
                                     'MIMIR_CODING_AGENT_DIR': str(home / '.mimir')}):
            result = self.run_fixture()
            observed = json.loads((Path(result['runtime']) / 'studio/backend-observed.json').read_text())
            self.assertEqual(observed['mimir_state'], str(home / '.mimir'))
            self.assertEqual(os.environ['HOME'], str(home))
            self.assertEqual(os.environ['CUDA_VISIBLE_DEVICES'], 'fixture-not-a-gpu')
        for path, contents in preserved.items():
            self.assertEqual(path.read_bytes(), contents)
        for path in heads:
            self.assertEqual(git(path, 'rev-parse', 'HEAD'), heads[path])
            self.assertEqual(git(path, 'status', '--porcelain'), states[path])


if __name__ == '__main__':
    unittest.main()
