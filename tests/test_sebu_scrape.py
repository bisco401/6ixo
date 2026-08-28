import json
import unittest

import sebu_scrape


class SebuScrapeTests(unittest.TestCase):
    def test_extracts_public_ad_payload_and_decodes_escapes(self):
        payload = {
            "id": "251",
            "category": "fashion",
            "title": "Casio's Watch",
            "description": "First line\\nSecond line",
        }
        serialized = json.dumps(payload).replace("\\", "\\\\").replace("'", "\\'")
        parsed = sebu_scrape.extract_ad_json(f"<script>const ad = JSON.parse('{serialized}')</script>")
        self.assertEqual(parsed["id"], "251")
        self.assertEqual(parsed["title"], "Casio's Watch")
        self.assertEqual(parsed["description"], "First line\\nSecond line")

    def test_parses_listing_sitemap_media(self):
        source = """<?xml version="1.0"?>
        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
          xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
          <url><loc>https://sebu.co.ke/item-1</loc><lastmod>2026-08-28</lastmod>
          <image:image><image:loc>https://pictures.sebu.co.ke/item.webp</image:loc>
          <image:title>Item</image:title></image:image></url>
        </urlset>"""
        refs = sebu_scrape.parse_listing_sitemap(source)
        self.assertEqual(refs, [{
            "url": "https://sebu.co.ke/item-1",
            "lastmod": "2026-08-28",
            "image": "https://pictures.sebu.co.ke/item.webp",
            "title": "Item",
        }])

    def test_balanced_selection_keeps_multiple_source_categories(self):
        candidates = [
            {"url": "https://sebu.co.ke/a", "category": "services", "created_at": "2026-08-28"},
            {"url": "https://sebu.co.ke/b", "category": "services", "created_at": "2026-08-27"},
            {"url": "https://sebu.co.ke/c", "category": "gigs-and-freelance", "created_at": "2026-08-26"},
            {"url": "https://sebu.co.ke/d", "category": "travel-and-tourism", "created_at": "2026-08-25"},
        ]
        selected = sebu_scrape.select_balanced(candidates, 3)
        self.assertEqual(
            {item["category"] for item in selected},
            {"services", "gigs-and-freelance", "travel-and-tourism"},
        )

    def test_csv_mapping_omits_phone_and_keeps_source_url(self):
        candidate = {
            "id": "251", "url": "https://sebu.co.ke/casio-watches-4915n",
            "lastmod": "2026-08-27", "title": "Casio Watches", "amount": 1000,
            "category": "fashion", "subcategory": "watches-and-jewelry",
            "region_name": "Nairobi", "area_name": "Nairobi CBD",
            "images": ["https://pictures.sebu.co.ke/watch.webp"], "dynamic": {},
            "seller": "Sebu seller", "created_at": "2026-08-27T17:34:05Z",
        }
        row = sebu_scrape.candidate_to_csv(candidate, "2026-08-28T07:00:00Z")
        self.assertEqual(row["app_category"], "clothing")
        self.assertEqual(row["phone"], "")
        self.assertEqual(row["source_url"], candidate["url"])
        self.assertEqual(row["image_urls"], candidate["images"][0])

    def test_redacts_contact_details_from_cached_description(self):
        cleaned = sebu_scrape.redact_contact_details(
            "Call 0742 513 681 or see www.example.co.ke for details"
        )
        self.assertNotIn("0742", cleaned)
        self.assertNotIn("www.", cleaned)
        self.assertIn("original listing", cleaned)


if __name__ == "__main__":
    unittest.main()
