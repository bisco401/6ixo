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

    def test_redacts_source_contact_placeholders_and_phone_numbers(self):
        cleaned = scraper.redact_contact_details("Call {phone_key_0} or 00971 050 123 4567")
        self.assertNotIn("phone_key", cleaned)
        self.assertNotIn("050", cleaned)
        self.assertIn("OpenSooq listing", cleaned)


if __name__ == "__main__":
    unittest.main()
