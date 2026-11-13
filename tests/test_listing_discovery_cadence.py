import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('cadence', Path(__file__).resolve().parents[1] / 'scripts/listing-discovery-cadence.py')
cadence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cadence)


class DiscoveryCadenceTest(unittest.TestCase):
    def test_new_searches_record_success_and_keep_prior_success_for_failed_sources(self):
        state = {'sources': {'kenya': {'lastSuccessfulSlot': '2026-11-06T01:17:00Z'}}}
        cadence.record(state, {'ghana': {'outcome': 'success'}, 'kenya': {'outcome': 'failure'}},
                       '2026-11-06T06:17:00Z', '2026-11-06T06:30:00Z')
        self.assertEqual(state['sources']['ghana']['lastSuccessfulSlot'], '2026-11-06T06:17:00Z')
        self.assertEqual(state['sources']['kenya'], {
            'lastSuccessfulSlot': '2026-11-06T01:17:00Z',
            'lastAttemptAt': '2026-11-06T06:30:00Z',
            'outcome': 'failure',
        })

    def test_skipped_runs_preserve_success_checkpoint(self):
        state = {'sources': {'ghana': {'lastSuccessfulSlot': '2026-11-05T06:17:00Z'}}}
        cadence.record(state, {'ghana': {'outcome': 'skipped'}}, 'later', 'later')
        self.assertEqual(state['sources']['ghana']['lastSuccessfulSlot'], '2026-11-05T06:17:00Z')


if __name__ == '__main__':
    unittest.main()
