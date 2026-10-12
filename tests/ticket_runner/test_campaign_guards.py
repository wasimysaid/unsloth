import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from scripts.mimir_ticket_runner.common import RunnerError
from scripts.mimir_ticket_runner.engine import reconcile_scope, resource_ready, invocation_budget
from scripts.mimir_ticket_runner.workspaces import assert_native_selection, freeze_binary


class CampaignGuards(unittest.TestCase):
    def test_host_wrapper_freezes_the_actual_native_executable(self):
        import shutil
        with TemporaryDirectory() as directory:
            root = Path(directory)
            native = Path(shutil.which('true')).resolve()
            wrapper = root / 'mimir'
            wrapper.write_text('#!/bin/sh\n# mimir-pstack launcher; normal invocations pass through.\nexec python3 launch.py --mimir ' + str(native) + ' -- "$@"\n')
            wrapper.chmod(0o700)
            config = SimpleNamespace(root=root / 'campaign', campaign={'mimir': str(wrapper)})
            frozen = freeze_binary(config)
            self.assertEqual(frozen.read_bytes(), native.read_bytes())
            self.assertEqual(freeze_binary(config), frozen)

    def test_ticket_and_parent_edits_refresh_the_recorded_scope(self):
        config = SimpleNamespace(approved={1, 2}, campaign={'parent': 3})
        snapshot = {'parent': {'body': 'spec'}, 'issues': [
            {'number': 1, 'body': 'one', 'title': 'first'}, {'number': 2, 'body': 'two', 'title': 'second'}],
            'comments': {}, 'blockers': {'1': [], '2': []}}
        store = Mock()
        store.tickets.return_value = {}
        store.meta.return_value = None
        reconcile_scope(config, store, snapshot)
        frozen = store.set_meta.call_args.args[1]
        store.meta.return_value = frozen
        reconcile_scope(config, store, snapshot)
        snapshot['issues'][1]['body'] = 'edited before it was dispatched'
        reconcile_scope(config, store, snapshot)
        self.assertNotEqual(store.set_meta.call_args.args[1]['2'], frozen['2'])
        snapshot['issues'][1]['body'] = 'two'
        snapshot['parent']['body'] = 'new parent policy'
        reconcile_scope(config, store, snapshot)
        self.assertNotEqual(store.set_meta.call_args.args[1]['parent'], frozen['parent'])

    def test_gpu_requires_coordinated_peak_and_never_device_seven(self):
        config = SimpleNamespace(root=Path('/owned'), tickets={1: {'resource': 'gpu'}}, campaign={'worker_timeout': 60})
        grant = {'devices': [0], 'expires': 1000, 'coordinated_by': 'wasimysaid', 'peak_memory_mib': 1024}
        with patch('scripts.mimir_ticket_runner.engine.time.time', return_value=100), patch(
                'scripts.mimir_ticket_runner.engine.read_json', return_value=grant):
            self.assertTrue(resource_ready(config, 1))
            for devices in ([7], [0, 0], [], [-1], ['0']):
                grant['devices'] = devices
                self.assertFalse(resource_ready(config, 1))
            grant['devices'] = [0]
            grant['peak_memory_mib'] = 0
            self.assertFalse(resource_ready(config, 1))

    def test_native_model_and_effort_are_verified_not_assumed(self):
        config = SimpleNamespace(campaign={'model': 'gpt-6.1-sol'})
        with TemporaryDirectory() as directory:
            path = Path(directory) / 'stdout.jsonl'
            record = {'event': 'model_request_start', 'model': 'gpt-6.1-sol', 'reasoning_effort': 'xhigh'}
            path.write_text(json.dumps(record) + '\n')
            assert_native_selection(config, directory, 'xhigh')
            record['model'] = 'chatgpt/gpt-6.1-sol'
            path.write_text(json.dumps(record) + '\n')
            assert_native_selection(config, directory, 'xhigh')
            with self.assertRaises(RunnerError):
                assert_native_selection(config, directory, 'high')
            record['model'] = 'fallback-model'
            path.write_text(json.dumps(record) + '\n')
            with self.assertRaises(RunnerError):
                assert_native_selection(config, directory, 'xhigh')
            path.write_text('{}\n')
            with self.assertRaises(RunnerError):
                assert_native_selection(config, directory, 'xhigh')

    def test_invocation_budget_also_covers_verification(self):
        config = SimpleNamespace(campaign={'budget_seconds': 60}, root=Path('/owned'))
        with patch('scripts.mimir_ticket_runner.engine.threading.Timer') as timer, patch(
                'scripts.mimir_ticket_runner.engine.atomic_json') as write:
            with invocation_budget(config):
                self.assertEqual(timer.call_args.args[0], 60)
                timer.call_args.args[1]()
                self.assertEqual(write.call_args.args[0], Path('/owned/stop.json'))
            timer.return_value.start.assert_called_once()
            timer.return_value.cancel.assert_called_once()
