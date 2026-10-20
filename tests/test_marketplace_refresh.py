import importlib.util
import pathlib
import unittest
import contextlib
import hashlib
import io
import json
import tempfile
from types import SimpleNamespace
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("refresh", pathlib.Path(__file__).resolve().parents[1] / "scripts/refresh-marketplace-listings.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RefreshTest(unittest.TestCase):
    def test_jacars_uses_own_taxonomy_instead_of_discovery_bucket(self):
        url = 'https://www.jacars.net/adv/123_kickers/'
        def crumbs(own_url, path):
            return {'@type': 'BreadcrumbList', 'itemListElement': [
                {'position': 1, 'item': 'https://www.jacars.net/' + path},
                {'position': 2, 'item': own_url}]}
        data = {'@graph': [crumbs('https://www.jacars.net/adv/999_foreign/', 'other/real-estate/houses-and-villas-rent/'),
            crumbs(url, 'other/clothing-shoes-and-accessories/shoes/mens-shoes/'),
            {'@type': 'Product', 'url': url, 'name': 'Brand New Kickers', 'sku': '123',
             'image': ['https://example.com/shoes.jpg'], 'offers': {'availability': 'https://schema.org/InStock',
             'seller': {'name': 'Seller', 'address': {'addressLocality': 'Trelawny'}}}}]}
        body = '<div data-component="SidebarContacts">Call 876-555-0123</div><script type="application/ld+json">' + json.dumps(data) + '</script>'
        row = module.jacars_row(body, url, 'other', 'miscellaneous', 'today')
        self.assertEqual((row['app_category'], row['app_subcategory']), ('clothing', 'shoes'))
        self.assertEqual(json.loads(row['attributes'])['sourceSubcategory'], 'mens-shoes')

    def test_blocked_kijiji_discovery_uses_public_browser_and_keeps_resolved_url(self):
        url = 'https://www.kijiji.ca/b-cars-trucks/testville/c174l1?sort=dateDesc'
        canonical = 'https://www.kijiji.ca/b-cars-trucks/canonical-region/c174l1'
        for status in [403, 429]:
            with self.subTest(status=status), tempfile.TemporaryDirectory() as folder:
                root = pathlib.Path(folder)
                (root / 'data').mkdir()
                (root / 'data/scraped-listings.csv').write_text('id,source_url,status,country\nexisting,https://example.test/existing,published,Canada\n')
                blocked = Mock(status_code=status)
                blocked.raise_for_status.side_effect = module.requests.HTTPError('Blocked')
                rendered = Mock()
                rendered.json.return_value = {'results': [{'url': url, 'redirected_url': canonical,
                    'success': True, 'status_code': 200, 'html': 'Public browser catalogue'}]}
                args = ['refresh', '--sources', 'canada', '--workers', '1', '--new-only',
                        '--cache-dir', str(root / 'cache'), '--report', str(root / 'report.json'),
                        '--crawl4ai-url', 'http://public-renderer.test/crawl']
                with patch.multiple(module, ROOT=root, CANADA=[('Testville', 'testville', '1')],
                                    K_CATEGORIES=[('cars-trucks', '174', 'vehicles', 'vehicles')]), \
                     patch.object(module.requests, 'get', return_value=blocked), \
                     patch.object(module.requests, 'post', return_value=rendered) as browser, \
                     patch.object(module.kijiji, 'extract_state', return_value={}), \
                     patch.object(module.sys, 'argv', args), contextlib.redirect_stdout(io.StringIO()):
                    with self.assertRaisesRegex(SystemExit, 'No qualifying new records'):
                        module.main()
                browser.assert_called_once()
                self.assertEqual(browser.call_args.kwargs['json']['urls'], [url])
                cached = json.loads((root / 'cache' / (hashlib.sha256(url.encode()).hexdigest() + '.json')).read_text())
                self.assertEqual(cached['resolvedUrl'], canonical)
                self.assertEqual(cached['status'], 200)
                report = json.loads((root / 'report.json').read_text())
                self.assertEqual(report['eligible'], 0)
                self.assertEqual(report['failures'], [])

    def test_public_cdn_binary_photos_require_an_image_signature(self):
        response = SimpleNamespace(status_code=200, headers={"Content-Type": "application/octet-stream"}, raw=Mock())
        response.raw.read.return_value = b"RIFF\x20\x00\x00\x00WEBPVP8 "
        self.assertTrue(module.image_response_is_usable(response))
        response.raw.read.return_value = b"<html><title>Access denied</title>"
        self.assertFalse(module.image_response_is_usable(response))
        response.status_code = 404
        response.raw.read.return_value = b"RIFF\x20\x00\x00\x00WEBPVP8 "
        self.assertFalse(module.image_response_is_usable(response))

    def test_post_id_is_not_a_phone(self):
        self.assertEqual(module.public_phone("posting id: 7751234567", "United States"), "")
        self.assertEqual(module.public_phone("Call us about posting id: 7751234567", "United States"), "")
        self.assertEqual(module.public_phone("Call (780) 555-1234", "Canada"), "+17805551234")
        self.assertEqual(module.public_phone("phone +18765256833", "Jamaica"), "+18765256833")
        self.assertEqual(module.public_phone("Call +12125551234", "Jamaica"), "")

    def test_buyer_service_is_not_parts_inventory(self):
        # Actual public-title format returned in the auto-parts search results.
        item = {"url": "https://www.kijiji.ca/v-other-auto-parts-and-accessories/toronto/car-buying/123456",
                "title": "$200-$8000 WE PAY TOP $ FOR ANY CARS ✅CALL NOW!!",
                "description": "Call 416-555-1234", "imageUrls": ["https://example.com/car.jpg"],
                "location": {"name": "Toronto"}, "id": "123456"}
        with self.assertRaises(ValueError):
            module.kijiji_row(item, "Toronto", "2026-10-08")

    def test_missing_phone_is_never_published(self):
        with self.assertRaises(ValueError):
            module.row_base("https://example.com/1", "Car", "Houston", "United States", "", ["https://example.com/car.jpg"], "vehicles", "vehicles", "today", "Example")

    def test_craigslist_hash_links_use_exact_product(self):
        body = '<h1>2014 Toyota Corolla</h1><section id="postingbody">Call 713-555-1234</section><script type="application/ld+json">{"@type":"Product","name":"2014 Toyota Corolla","description":"Call 713-555-1234","image":["https://images.craigslist.org/a_600x450.jpg"],"offers":{"price":"8000","availableAtOrFrom":{"address":{"addressLocality":"Spring"}}}}</script>'
        row = module.craigslist_row(body, "https://www.craigslist.org/view/d/car/hashedId", "Houston", "vehicles", "vehicles", "today")
        self.assertEqual(row["id"], "craigslist-hashedId")
        self.assertEqual(row["city"], "Spring")
        self.assertEqual(row["phone"], "+17135551234")

    def test_craigslist_own_category_outweighs_search_bucket_and_related_links(self):
        body = '<nav class="breadcrumbs-container"><a href="/search/area/houston?cat=ssq">for sale</a><a href="/search/area/houston?cat=ctd">cars+trucks</a></nav><h1>2014 Toyota Corolla</h1><section id="postingbody">Call 713-555-1234</section><aside><a href="/search/area/houston?cat=sss">Related services</a></aside><script type="application/ld+json">{"@type":"Product","name":"2014 Toyota Corolla","image":["https://example.com/car.jpg"],"offers":{"price":"8000","availableAtOrFrom":{"address":{"addressLocality":"Spring"}}}}</script>'
        row = module.craigslist_row(body, 'https://www.craigslist.org/view/d/car/AbC123', 'Houston', 'services', 'other', 'today')
        specs = module.craigslist_source_specifications(module.BeautifulSoup('<div class="attrgroup"><div class="attr"><span class="labl">odometer:</span><span class="valu">143,895</span></div><span class="valu year">2012</span></div>', 'html.parser'))
        self.assertIn({'label': 'odometer', 'value': '143,895'}, specs)
        self.assertIn({'label': 'Year', 'value': '2012'}, specs)
        self.assertEqual((row['app_category'], row['app_subcategory']), ('vehicles', 'vehicles'))
        self.assertEqual(json.loads(row['attributes'])['sourceCategoryCode'], 'ctd')


if __name__ == "__main__":
    unittest.main()
