import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

spec = importlib.util.spec_from_file_location('guyana', Path(__file__).resolve().parents[1] / 'guyana_marketplace_scrape.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class GuyanaFailureIsolationTests(unittest.TestCase):
    def test_blocked_property_source_keeps_electronics_and_never_prunes(self):
        row = {'id': 'new', 'source_url': 'https://samtronixguyana.com/new', 'scraped_at': '2026-11-06'}
        with tempfile.TemporaryDirectory() as folder:
            report = Path(folder) / 'report.json'
            with patch('sys.argv', ['guyana', '--prune-missing', '--report', str(report)]), \
                 patch.object(module, 'scrape_samtronix', return_value=[row]), \
                 patch.object(module, 'scrape_home_hub', side_effect=HTTPError('https://source.example', 403, 'Forbidden', {}, None)), \
                 patch.object(module, 'align_rows_to_csv', side_effect=lambda path, rows: rows), \
                 patch.object(module, 'merge_csv', return_value=(1, 0)) as merge, \
                 patch.object(module, 'prune_missing_managed_rows') as prune:
                self.assertEqual(module.main(), 1)
            prune.assert_not_called()
            self.assertEqual(merge.call_args.args[1], [row])
            result = json.loads(report.read_text())
            self.assertEqual(result['inserted'], 1)
            self.assertEqual(result['failures'][0]['source'], 'Guyana Home Hub')


if __name__ == '__main__':
    unittest.main()
