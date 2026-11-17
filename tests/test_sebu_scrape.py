import json
import csv
import tempfile
import unittest
from pathlib import Path

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

    def test_csv_mapping_keeps_missing_contact_pending_and_source_url(self):
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
        self.assertEqual(row["status"], "pending")
        self.assertEqual(row["sync_visibility"], "no_phone")
        self.assertEqual(row["condition"], "")
        self.assertEqual(row["source_url"], candidate["url"])
        self.assertEqual(row["image_urls"], candidate["images"][0])

    def test_sync_preserves_review_hold_for_same_source(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "feed.csv"
            held = {"id": "sebu-251", "source_site": "Sebu", "source_url": "https://sebu.co.ke/watch", "status": "rejected", "sync_visibility": "foreign_gallery", "sync_visibility_reason": "Reviewed source photo mismatch"}
            with path.open("w", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=list(held))
                writer.writeheader(); writer.writerow(held)
            incoming = {**held, "status": "pending", "sync_visibility": "no_phone", "sync_visibility_reason": "Public seller phone required"}
            sebu_scrape.merge_csv(path, [incoming], False)
            with path.open() as handle:
                saved = next(csv.DictReader(handle))
            self.assertEqual(saved["status"], "rejected")
            self.assertEqual(saved["sync_visibility"], "foreign_gallery")
            self.assertEqual(saved["sync_visibility_reason"], held["sync_visibility_reason"])

    def test_public_contact_is_bound_to_primary_listing_and_seller(self):
        ref = {"url": "https://sebu.co.ke/watch.html"}
        ad = {"id": "251", "userid": 81, "titleid": "watch.html", "title": "Casio Watch",
              "category": "fashion", "images": [{"url": "https://pictures.sebu.co.ke/watch.webp"}],
              "seller": {"userid": "81", "name": "Alice", "phone": "+254 712 345 678", "private_token": "excluded"}}
        candidate = sebu_scrape.sanitize_ad(ad, ref)
        row = sebu_scrape.candidate_to_csv(candidate, "2026-11-17T21:00:00Z")
        self.assertEqual(row["phone"], "+254 712 345 678")
        self.assertEqual(row["status"], "pending")
        self.assertEqual(row["sync_visibility"], "source_identity_unverified")
        self.assertEqual(json.loads(row["attributes"])["sellerId"], "81")
        self.assertNotIn("private_token", json.dumps(candidate))
        for changed in ({**ad, "userid": 82}, {**ad, "titleid": "another-watch.html"},
                        {**ad, "seller": {"userid": "81", "phone": "07xx xxx xxx"}},
                        {**ad, "seller": {"userid": "81"}, "support_phone": "0712345678"}):
            with self.subTest(changed=changed):
                self.assertEqual(sebu_scrape.sanitize_ad(changed, ref)["seller_phone"], "")

    def test_mileage_units_are_not_inferred_and_other_specs_are_retained(self):
        candidate = {"id": "1", "url": "https://sebu.co.ke/car", "title": "Toyota Probox",
                     "category": "vehicles", "images": ["https://pictures.sebu.co.ke/car.jpg"],
                     "dynamic": {"mileage": "323280", "engine_size": "1500", "fuel_type": "Petrol"}}
        row = sebu_scrape.candidate_to_csv(candidate, "2026-11-17T21:00:00Z")
        self.assertEqual(row["mileage_km"], "")
        self.assertIn({"label": "Mileage (source units)", "value": "323280"}, json.loads(row["attributes"])["details"])
        self.assertIn({"label": "Fuel type", "value": "Petrol"}, json.loads(row["attributes"])["details"])
        candidate["dynamic"]["mileage_km"] = "120000"
        self.assertEqual(sebu_scrape.candidate_to_csv(candidate, "2026-11-17T21:00:00Z")["mileage_km"], "120000")

    def test_regulated_nicotine_inventory_is_not_imported(self):
        self.assertIsNone(sebu_scrape.sanitize_ad({"title": "Selling Vapes And Velo", "category": "business-and-industrial",
                                                 "images": [{"url": "https://pictures.sebu.co.ke/item.jpg"}]},
                                                {"url": "https://sebu.co.ke/item"}))

    def test_service_types_use_supported_profile_filter_categories(self):
        for title, expected in (("Poster Design", "other"), ("Taekwondo Training", "fitness"),
                                ("Event Decoration", "events_services"), ("Photographer", "entertainment")):
            with self.subTest(title=title):
                self.assertEqual(sebu_scrape.infer_subcategory({"title": title}, "services"), expected)

    def test_redacts_contact_details_from_cached_description(self):
        cleaned = sebu_scrape.redact_contact_details(
            "Call 0742 513 681 or see www.example.co.ke for details"
        )
        self.assertNotIn("0742", cleaned)
        self.assertNotIn("www.", cleaned)
        self.assertIn("original listing", cleaned)


if __name__ == "__main__":
    unittest.main()
