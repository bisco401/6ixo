import csv
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('kenya', Path(__file__).resolve().parents[1] / 'scripts/refresh-kenya-public-listings.py')
kenya = importlib.util.module_from_spec(spec)
spec.loader.exec_module(kenya)


class KenyaPublicTest(unittest.TestCase):
    url = 'https://samtechautoparts.com/products/123'

    def page(self, stock='InStock', own_url=None, phone='+254701799603'):
        product = {'@type': 'Product', 'url': own_url or self.url, 'name': 'Toyota brake pads',
                   'image': ['https://samtechautoparts.com/photos/123.jpg'],
                   'offers': {'price': '2500', 'priceCurrency': 'KES', 'availability': 'https://schema.org/' + stock}}
        return f'<link rel="canonical" href="{self.url}"><h1>Toyota brake pads</h1><a href="tel:{phone}">Call seller</a><p>Kirinyaga Road, Nairobi</p><script type="application/ld+json">{json.dumps(product)}</script>'

    def test_public_seller_stock_and_exact_gallery_are_bound_together(self):
        row = kenya.parse_listing('samtech', self.page(), self.url, '2026-11-06T06:17:00Z')
        self.assertEqual(row['status'], 'published')
        self.assertEqual(row['phone'], '+254701799603')
        proof = json.loads(row['attributes'])['listingIdentity']
        self.assertEqual(proof['sourceUrl'], self.url)
        self.assertEqual(proof['images'], row['image_urls'].split('|'))
        self.assertEqual(row['country'], 'Kenya')

    def test_foreign_product_sold_stock_and_missing_public_contact_are_held(self):
        for page in [self.page(stock='SoldOut'), self.page(own_url='https://samtechautoparts.com/products/999'), self.page(phone='')]:
            with self.assertRaises(ValueError):
                kenya.parse_listing('samtech', page, self.url, '2026-11-06T06:17:00Z')

    def test_computer_seo_title_can_differ_when_exact_itempage_matches(self):
        url = 'https://laptopsinkenya.com/product/hp-14/'
        objects = [
            {'@type': 'ComputerStore', 'name': 'Laptops in Kenya', 'telephone': '+254714303840', 'address': {'addressLocality': 'Nairobi'}},
            {'@type': 'ItemPage', 'url': url, 'datePublished': '2026-10-03T12:00:00+03:00'},
            {'@type': 'Product', '@id': url + '#richSnippet', 'name': 'HP 14 laptop – Buy in Kenya',
             'offers': {'price': '55000', 'priceCurrency': 'KES', 'availability': 'https://schema.org/InStock'}}]
        body = f'<link rel="canonical" href="{url}"><h1>HP 14 laptop with 16GB RAM</h1><div class="woocommerce-product-gallery"><img src="https://laptopsinkenya.com/own.jpg"></div><div class="related"><img src="https://laptopsinkenya.com/foreign.jpg"></div><script type="application/ld+json">{json.dumps({"@graph": objects})}</script>'
        row = kenya.parse_listing('laptops', body, url, '2026-11-06T06:17:00Z')
        self.assertEqual(row['image_urls'], 'https://laptopsinkenya.com/own.jpg')
        self.assertEqual(row['scraped_at'], '2026-10-03T12:00:00+03:00')
        with self.assertRaises(ValueError):
            kenya.parse_listing('laptops', body.replace(url + '#richSnippet', 'https://laptopsinkenya.com/product/foreign/#richSnippet'), url, 'now')

    def test_rechecks_preserve_first_seen_dates_and_review_holds(self):
        row = kenya.parse_listing('samtech', self.page(), self.url, '2026-10-01T10:00:00Z')
        held = {**row, 'id': 'held', 'source_url': 'https://samtechautoparts.com/products/999', 'sync_visibility': 'foreign_gallery', 'status': 'rejected'}
        other = {**row, 'id': 'other', 'source_url': 'https://example.com/other', 'country': 'Ghana'}
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'feed.csv'
            with path.open('w') as handle:
                writer = csv.DictWriter(handle, fieldnames=list(row))
                writer.writeheader(); writer.writerows([row, held, other])
            fresh = {**row, 'scraped_at': '2026-11-06T06:17:00Z', 'price_value': '2300', 'source_last_seen_at': '2026-11-06T06:17:00Z'}
            kenya.refresh.merge(path, [fresh, {**held, 'sync_visibility': 'visible', 'status': 'published'}])
            with path.open() as handle:
                rows = list(csv.DictReader(handle))
            self.assertEqual(rows[0]['scraped_at'], '2026-10-01T10:00:00Z')
            self.assertEqual(rows[0]['price_value'], '2300')
            self.assertEqual(rows[0]['source_last_seen_at'], '2026-11-06T06:17:00Z')
            self.assertEqual(rows[1]['status'], 'rejected')
            self.assertEqual(rows[2], other)


if __name__ == '__main__':
    unittest.main()
