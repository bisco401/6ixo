import copy
import csv
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('preserve', Path(__file__).resolve().parents[1] / 'scripts/preserve-existing-listings.py')
preserve = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preserve)


class AppendOnlyDiscoveryTests(unittest.TestCase):
    def test_enforcement_restores_edited_and_missing_records_before_deletion_checks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'data').mkdir()
            (root / 'output').mkdir()
            feed = root / 'data/feed.csv'
            original = [{'id': 'old', 'source_url': 'https://dealer.example/old', 'price_value': '200'},
                        {'id': 'missing', 'source_url': 'https://dealer.example/missing', 'price_value': '300'}]
            def write(rows):
                with feed.open('w', newline='') as handle:
                    writer = csv.DictWriter(handle, fieldnames=list(original[0]))
                    writer.writeheader(); writer.writerows(rows)
            write(original)
            (root / 'data/listing-availability.json').write_text('{"listings":{}}')
            (root / 'data/listing-integrity-repairs.json').write_text('{"listings":{"old":{"title":"Original"}}}')
            args = ['guard', 'capture', '--snapshot', str(root / 'output/snapshot.json')]
            with patch.object(preserve, 'ROOT', root), patch.object(preserve.availability, 'FEEDS', ['data/feed.csv']):
                with patch('sys.argv', args): preserve.main()
                added = {'id': 'new', 'source_url': 'https://dealer.example/new', 'price_value': '400'}
                write([dict(original[0], price_value='999'), added])
                (root / 'data/listing-integrity-repairs.json').write_text('{"listings":{"old":{"title":"Changed"},"new":{"title":"New"}}}')
                args[1] = 'enforce'
                with patch('sys.argv', args): preserve.main()
            with feed.open() as handle: self.assertEqual(list(csv.DictReader(handle)), original + [added])
            ledger = json.loads((root / 'data/listing-integrity-repairs.json').read_text())
            self.assertEqual(ledger['listings'], {'old': {'title': 'Original'}, 'new': {'title': 'New'}})

    def test_changed_existing_url_or_id_cannot_replace_saved_content(self):
        original = {'id': 'old', 'source_url': 'https://dealer.example/cars/1/', 'title': 'Original',
                    'price_value': '200', 'image_urls': 'original.jpg', 'scraped_at': '2026-01-01'}
        saved = copy.deepcopy(original)
        incoming = [dict(original, price_value='999'), dict(original, id='changed', title='Changed'),
                    dict(original, source_url='https://dealer.example/cars/moved')]
        self.assertEqual(preserve.additions(incoming, preserve.identities(original), {}), [])
        self.assertEqual(original, saved)

    def test_only_new_unique_sources_are_added_and_tombstones_are_respected(self):
        rows = [{'id': 'new', 'source_url': 'https://dealer.example/cars/2'},
                {'id': 'duplicate', 'source_url': 'https://www.dealer.example/cars/2/?ref=search'},
                {'id': 'sold', 'source_url': 'https://dealer.example/cars/3'}]
        self.assertEqual(preserve.additions(rows, set(), {'dealer.example/cars/3': {}}), [rows[0]])

    def test_known_listing_in_another_feed_is_not_reimported(self):
        old = {'id': 'a', 'source_url': 'https://www.jacars.net/adv/123/'}
        candidate = {'id': 'b', 'source_url': '/adv/123/', 'source_site': 'JACars'}
        self.assertEqual(preserve.additions([candidate], preserve.identities(old), {}), [])

    def test_supplier_collection_alias_cannot_duplicate_an_existing_product(self):
        old = {'id': 'old', 'source_url': 'https://www.mccosme.com/collections/all/products/blush'}
        candidate = {'id': 'new', 'source_url': 'https://www.mccosme.com/products/blush'}
        self.assertEqual(preserve.additions([candidate], preserve.identities(old), {}), [])


if __name__ == '__main__':
    unittest.main()
