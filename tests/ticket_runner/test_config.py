import copy
from pathlib import Path
import unittest
from scripts.mimir_ticket_runner.config import Config, DEFAULT_CONFIG
from scripts.mimir_ticket_runner.common import RunnerError


class ConfigTests(unittest.TestCase):
    def setUp(self):
        self.config = Config.load()

    def reject(self, mutate):
        data = copy.deepcopy(self.config.data)
        mutate(data)
        with self.assertRaises(RunnerError):
            Config(DEFAULT_CONFIG, data).validate()

    def test_production_campaign(self):
        self.assertEqual(len(self.config.approved), 23)
        self.assertEqual(self.config.campaign['parent'], 233)
        self.assertTrue(self.config.tickets[256]['human'])
        self.assertEqual(self.config.tickets[246]['resource'], 'gpu')

    def test_refuses_upstream_or_main(self):
        self.reject(lambda d: d['repositories']['studio'].update(github='unslothai/unsloth'))
        self.reject(lambda d: d['repositories']['studio'].update(branch='main'))

    def test_refuses_no_verification_and_unsafe_storage(self):
        self.reject(lambda d: d['tickets']['234'].update(profiles=[]))
        self.reject(lambda d: d['campaign'].update(storage_root='/home/mugi'))

    def test_refuses_silent_model_fallback(self):
        self.reject(lambda d: d['campaign'].update(model='some-other-model'))

    def test_profile_checks_are_nonempty_argv(self):
        self.assertTrue(self.config.check_commands(234))
        self.reject(lambda d: d['profiles']['frontend']['checks'][0].update(argv='echo passed'))
