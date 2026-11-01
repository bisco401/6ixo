import tempfile
import csv
import json
import unittest
from unittest.mock import patch
from pathlib import Path

from ghana_marketplace_sync import GhanaSource, apply_ghana_cap, merge_ghana_listings, normalize_listing, vehicle_source_specifications
from oxglow_scrape import Listing, image_download_candidates, extract_listing_attributes, enrich_from_detail, write_csv


class GhanaMarketplaceSyncTests(unittest.TestCase):
    def undated_listing(self):
        return Listing(
            title="Existing car part", price="GHS 100", url="https://oxglow.com.gh/listing/part",
            image_url="https://oxglow.com.gh/uploads/part.jpg", image_urls="", image_files="",
            description="Car part", location="Accra", published_at="", phone_numbers="0240000000",
        )

    def test_rechecks_keep_first_import_date_but_update_content_and_availability(self):
        source = GhanaSource("auto-parts", "https://oxglow.com.gh/auto-parts-accessories", "vehicles", "vehicles", "auto_parts")
        listing = self.undated_listing()
        first = "2026-05-12T10:00:00Z"
        existing = [normalize_listing(listing, source, first)]
        for checked in ["2026-10-28T20:00:00Z", "2026-11-01T07:00:00Z"]:
            listing.price = "GHS 90"
            incoming = normalize_listing(listing, source, checked)
            merged, _ = merge_ghana_listings(existing, [incoming], Path("."))
            self.assertEqual(merged[0]["scraped_at"], first)
            self.assertEqual(merged[0]["price_text"], "GHS 90")
            self.assertEqual(merged[0]["source_last_seen_at"], checked)
            self.assertEqual(merged[0]["source_availability_checked_at"], checked)
            self.assertEqual(incoming["scraped_at"], checked, "Do not mutate the source candidate")
            existing = merged

        newer = {**incoming, "id": "newer", "source_url": "https://oxglow.com.gh/listing/newer",
                 "scraped_at": "2026-10-31T12:00:00Z", "attributes": '{"sourcePostedAt":"2026-10-31T12:00:00Z"}'}
        merged, _ = merge_ghana_listings(existing, [incoming, newer], Path("."), maximum=1)
        self.assertEqual([r["id"] for r in merged if r["status"] == "published"], ["newer"])

    def test_missing_or_invalid_source_date_does_not_erase_known_posting_date(self):
        source = GhanaSource("auto-parts", "https://oxglow.com.gh/auto-parts-accessories", "vehicles", "vehicles", "auto_parts")
        listing = self.undated_listing()
        listing.published_at = "2026-05-01T10:00:00Z"
        existing = normalize_listing(listing, source, "2026-05-12T10:00:00Z")
        for missing in ["", "not a date"]:
            listing.published_at = missing
            incoming = normalize_listing(listing, source, "2026-11-01T07:00:00Z")
            merged, _ = merge_ghana_listings([existing], [incoming], Path("."))
            self.assertEqual(merged[0]["scraped_at"], "2026-05-01T10:00:00Z")
            self.assertEqual(json.loads(merged[0]["attributes"])["sourcePostedAt"], "2026-05-01T10:00:00Z")

    def test_new_ad_uses_first_import_until_source_supplies_a_date(self):
        source = GhanaSource("auto-parts", "https://oxglow.com.gh/auto-parts-accessories", "vehicles", "vehicles", "auto_parts")
        listing = self.undated_listing()
        incoming = normalize_listing(listing, source, "2026-11-01T07:00:00Z")
        existing, _ = merge_ghana_listings([], [incoming], Path("."))
        self.assertEqual(existing[0]["scraped_at"], "2026-11-01T07:00:00Z")
        listing.published_at = "2026-10-30T10:00:00Z"
        incoming = normalize_listing(listing, source, "2026-11-02T07:00:00Z")
        merged, _ = merge_ghana_listings(existing, [incoming], Path("."))
        self.assertEqual(merged[0]["scraped_at"], listing.published_at)

    def test_legacy_attributes_do_not_prevent_preserving_import_date(self):
        for attributes in ["", "{broken", "null", "[]"]:
            existing = {"source_url": "https://oxglow.com.gh/listing/legacy", "country": "Ghana",
                        "status": "published", "scraped_at": "2026-05-12T10:00:00Z", "attributes": attributes}
            incoming = {**existing, "scraped_at": "2026-11-01T07:00:00Z", "attributes": "{}"}
            merged, _ = merge_ghana_listings([existing], [incoming], Path("."))
            self.assertEqual(merged[0]["scraped_at"], existing["scraped_at"])

    def test_normalizes_current_listing_with_absolute_images_and_source_date(self):
        source = GhanaSource("vehicles", "https://oxglow.com.gh/vehicles", "vehicles", "vehicles", "vehicles")
        listing = Listing(
            title="2024 Toyota Corolla",
            price="GHS 250000",
            url="https://oxglow.com.gh/listing/toyota-corolla-test",
            image_url="/uploads/original/corolla-0-medium.jpg",
            image_urls="/uploads/original/corolla-0-medium.jpg | /uploads/original/corolla-1-medium.jpg",
            image_files="",
            description="Clean automatic sedan",
            location="Accra, Greater Accra",
            published_at="2026-09-04T10:00:00+00:00",
            seller="Test seller",
            phone_numbers="0240000000",
            category="Vehicles",
            sku="123",
        )
        row = normalize_listing(listing, source, "2026-09-04T12:00:00Z")
        self.assertIsNotNone(row)
        self.assertEqual(row["country"], "Ghana")
        self.assertEqual(row["city"], "Accra, Greater Accra")
        self.assertEqual(row["scraped_at"], listing.published_at)
        self.assertTrue(row["image_urls"].startswith("https://oxglow.com.gh/uploads/original/"))
        self.assertIn("-medium.jpg", row["image_urls"])
        self.assertEqual(row["source_availability"], "active")

        listing.attributes = {"Brand": "Toyota", "Model": "Corolla", "Year": "2024", "Condition": "Foreign used", "Type": "Sedan"}
        enriched = normalize_listing(listing, source, "2026-09-04T12:00:00Z")
        self.assertEqual(json.loads(enriched["attributes"])["sourceSpecifications"], [
            {"label": "Make", "value": "Toyota"},
            {"label": "Model", "value": "Corolla"},
            {"label": "Year", "value": "2024"},
            {"label": "Condition", "value": "Foreign used"},
            {"label": "Body type", "value": "Sedan"},
        ])

        listing.image_files = "data/oxglow-vehicles-images/123-1.jpg | data/oxglow-vehicles-images/123-2.jpg"
        localized = normalize_listing(listing, source, "2026-09-04T12:00:00Z")
        self.assertEqual(
            localized["image_urls"],
            "data/oxglow-vehicles-images/123-1.jpg|data/oxglow-vehicles-images/123-2.jpg",
        )

    def test_merge_preserves_other_countries_and_managed_local_images(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            image = root / "data/oxglow-vehicles-images/car.jpg"
            image.parent.mkdir(parents=True)
            image.write_bytes(b"image")
            existing = [
                {
                    "id": "ghana-old",
                    "status": "published",
                    "country": "Ghana",
                    "app_category": "vehicles",
                    "title": "Old title",
                    "image_urls": "data/oxglow-vehicles-images/car.jpg",
                    "source_url": "https://oxglow.com.gh/listing/car",
                    "scraped_at": "2026-08-01T00:00:00Z",
                    "sync_visibility": "visible",
                },
                {
                    "id": "canada-row",
                    "status": "published",
                    "country": "Canada",
                    "app_category": "electronics",
                    "source_url": "https://example.test/canada",
                    "scraped_at": "2026-08-01T00:00:00Z",
                },
            ]
            incoming = [
                {
                    **existing[0],
                    "title": "Current title",
                    "image_urls": "https://oxglow.com.gh/uploads/original/car.jpg",
                    "scraped_at": "2026-09-04T00:00:00Z",
                    "source_availability": "active",
                },
                {
                    "id": "ghana-new",
                    "status": "published",
                    "country": "Ghana",
                    "app_category": "electronics",
                    "title": "New phone",
                    "image_urls": "https://oxglow.com.gh/uploads/original/phone.jpg",
                    "source_url": "https://oxglow.com.gh/listing/phone",
                    "scraped_at": "2026-09-05T00:00:00Z",
                    "sync_visibility": "visible",
                },
            ]
            merged, stats = merge_ghana_listings(existing, incoming, root, maximum=1)

            by_id = {row["id"]: row for row in merged}
            self.assertEqual(by_id["canada-row"]["status"], "published")
            self.assertEqual(by_id["ghana-old"]["title"], "Current title")
            self.assertEqual(by_id["ghana-old"]["image_urls"], "data/oxglow-vehicles-images/car.jpg")
            self.assertEqual(by_id["ghana-new"]["status"], "published")
            self.assertEqual(by_id["ghana-old"]["status"], "rejected")
            self.assertEqual(stats["published"], 1)

    def test_zero_cap_restores_all_eligible_and_preserves_review_holds(self):
        rows = [{"id": str(i), "country": "Ghana", "status": "rejected",
                 "sync_visibility": "capped", "source_availability": "active"}
                for i in range(65)]
        rows.append({"id": "held", "country": "Ghana", "status": "rejected",
                     "sync_visibility": "reviewed_image_mismatch"})
        stats = apply_ghana_cap(rows, 0)
        self.assertEqual(stats["published"], 65)
        self.assertEqual(stats["capped"], 0)
        self.assertEqual(rows[-1]["status"], "rejected")

    def test_cap_does_not_restore_confirmed_unavailable_listing(self):
        rows = [
            {
                "status": "rejected",
                "country": "Ghana",
                "app_category": "vehicles",
                "source_url": "https://example.test/gone",
                "scraped_at": "2026-09-05T00:00:00Z",
                "source_availability": "gone",
                "sync_visibility": "unavailable",
            }
        ]
        stats = apply_ghana_cap(rows, 50)
        self.assertEqual(rows[0]["status"], "rejected")
        self.assertEqual(stats["eligible"], 0)

    def test_oxglow_image_candidates_include_real_medium_variants(self):
        candidates = image_download_candidates(
            "https://oxglow.com.gh/listing/example",
            "/uploads/original/example-123-0.jpg",
        )
        self.assertEqual(candidates[0], "https://oxglow.com.gh/uploads/original/example-123-0.jpg")
        self.assertIn("https://oxglow.com.gh/uploads/medium/example-123-0.jpg", candidates)
        self.assertIn("https://oxglow.com.gh/uploads/medium/example-123-0-medium.jpg", candidates)

    def test_attributes_are_scoped_to_the_current_listing_and_survive_csv_export(self):
        source_html = '''<li><strong>Brand:</strong>Wrong outside item</li>
            <div class="features-area"><h2>Attributes</h2><div>
            <li><strong>Brand:</strong><span>Toyota</span></li>
            <li><strong>Condition:</strong>Foreign used</li>
            <li><strong>Model:</strong>RAV4</li><li><strong>Year:</strong>285000</li>
            </div></div><section><li><strong>Model:</strong>Recommended car</li></section>'''
        expected = {"Brand": "Toyota", "Condition": "Foreign used", "Model": "RAV4", "Year": "285000"}
        self.assertEqual(extract_listing_attributes(source_html), expected)
        listing = Listing("2018 Toyota RAV4 XLE DV", "", "https://oxglow.com.gh/listing/example", "", "", "", "", "", "")
        with patch('oxglow_scrape.fetch_html', return_value=source_html):
            enriched = enrich_from_detail(listing, 0)
        self.assertEqual(enriched.attributes, expected)
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / 'listing.csv'
            write_csv([enriched], destination)
            with destination.open() as handle:
                row = next(csv.DictReader(handle))
            self.assertEqual(json.loads(row['attributes']), expected)

    def test_invalid_year_is_not_displayed_as_a_price_or_guessed(self):
        self.assertEqual(vehicle_source_specifications('2018 Toyota RAV4 XLE DV', {'Year': '285000'}), [
            {'label': 'Year', 'value': '2018'}
        ])
        self.assertEqual(vehicle_source_specifications('Toyota RAV4', {'Year': '285000'}), [])
        self.assertEqual(vehicle_source_specifications('Vehicle', {'Mileage': '15,699 miles'}), [
            {'label': 'Mileage', 'value': '15,699 miles'}
        ])


if __name__ == "__main__":
    unittest.main()
