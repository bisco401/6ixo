import importlib.util
from pathlib import Path
from datetime import datetime, timezone
import unittest

spec = importlib.util.spec_from_file_location('cadence', Path(__file__).resolve().parents[1] / 'scripts/listing-discovery-cadence.py')
cadence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cadence)


class DiscoveryCadenceTest(unittest.TestCase):
    def test_48_hours_across_month_and_year_boundary(self):
        state = {'sources': {'ghana': {'lastSuccessfulSlot': '2026-12-31T06:17:00Z'}}}
        self.assertFalse(cadence.due(state, 'ghana', datetime(2027, 1, 2, 6, 16, 59, tzinfo=timezone.utc)))
        self.assertTrue(cadence.due(state, 'ghana', datetime(2027, 1, 2, 6, 17, tzinfo=timezone.utc)))

    def test_failed_source_retries_without_repeating_successful_sources(self):
        now = datetime(2026, 11, 6, 12, 17, tzinfo=timezone.utc)
        state = cadence.record({}, {'ghana': {'outcome': 'success'}, 'kenya': {'outcome': 'failure'}},
                               '2026-11-06T06:17:00Z', '2026-11-06T06:30:00Z')
        self.assertFalse(cadence.due(state, 'ghana', now))
        self.assertTrue(cadence.due(state, 'kenya', now))
        self.assertTrue(cadence.due(state, 'ghana', now, force=True))
        self.assertEqual(state['sources']['kenya']['outcome'], 'failure')

    def test_skipped_runs_preserve_success_checkpoint(self):
        state = {'sources': {'ghana': {'lastSuccessfulSlot': '2026-11-05T06:17:00Z'}}}
        cadence.record(state, {'ghana': {'outcome': 'skipped'}}, 'later', 'later')
        self.assertEqual(state['sources']['ghana']['lastSuccessfulSlot'], '2026-11-05T06:17:00Z')


if __name__ == '__main__':
    unittest.main()
