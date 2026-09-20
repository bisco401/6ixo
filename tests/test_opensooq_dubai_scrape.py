import json
import unittest

import opensooq_dubai_scrape as scraper


class OpenSooqDubaiScrapeTests(unittest.TestCase):
    def test_extracts_structured_search_items(self):
        payload = {
            "@context": "https://schema.org",
            "@graph": [{
                "@type": "ItemList",
                "itemListElement": [{
                    "@type": "ListItem",
                    "item": {"@type": "Product", "url": "https://ae.opensooq.com/en/search/123"},
                }],
            }],
        }
        source = f'<script type="application/ld+json">{json.dumps(payload)}</script>'
        self.assertEqual(scraper.extract_item_list(source)[0]["url"], "https://ae.opensooq.com/en/search/123")

    def test_upgrades_preloaded_gallery_images(self):
        source = """
        <head>
          <link rel="preload" as="image" href="https://opensooq-imagesv2.os-cdn.com/previews/400x0/aa/bb/photo.jpg.webp">
          <link rel="preload" as="image" href="https://opensooqui2.os-cdn.com/logo.svg">
        </head>
        """
        self.assertEqual(
            scraper.extract_preloaded_listing_images(source),
            ["https://opensooq-imagesv2.os-cdn.com/previews/2048x0/aa/bb/photo.jpg.webp"],
        )

    def test_uae_contact_requires_complete_number(self):
        for value in ["", "05015047XX", "97154 X577777", "AED 199", "2026-09-20"]:
            self.assertEqual(scraper.normalize_uae_phone(value), "")
        self.assertEqual(scraper.normalize_uae_phone("+971 4 377 2503"), "+97143772503")
        self.assertEqual(scraper.normalize_uae_phone("050 123 4567"), "+971501234567")

    def test_row_without_public_phone_is_not_imported(self):
        item = {"url": "https://ae.opensooq.com/en/search/123"}
        self.assertIsNone(scraper.row_from_listing(item, scraper.SOURCE_CONFIGS[0], {}, "2026-09-20T00:00:00Z"))

    def test_reads_phone_only_from_exact_listing_seller(self):
        url = "https://ae.opensooq.com/en/search/123"
        data = {"@type":"Product", "url":url, "name":"Chair", "seller":{"telephone":"0501234567"}}
        page = '<script type="application/ld+json">' + json.dumps(data) + '</script>'
        self.assertEqual(scraper.extract_detail_listing(page, url)["phone"], "+971501234567")
        self.assertEqual(scraper.extract_detail_listing(page, url + "4")["phone"], "")

    def test_redacts_source_contact_placeholders_and_phone_numbers(self):
        cleaned = scraper.redact_contact_details("Call {phone_key_0} or 00971 050 123 4567")
        self.assertNotIn("phone_key", cleaned)
        self.assertNotIn("050", cleaned)
        self.assertIn("OpenSooq listing", cleaned)


if __name__ == "__main__":
    unittest.main()
