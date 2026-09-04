import tempfile
import unittest
from pathlib import Path

from ghana_marketplace_sync import GhanaSource, apply_ghana_cap, merge_ghana_listings, normalize_listing
from oxglow_scrape import Listing, image_download_candidates


class GhanaMarketplaceSyncTests(unittest.TestCase):
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
        self.assertEqual(row["scraped_at"], listing.published_at)
        self.assertTrue(row["image_urls"].startswith("https://oxglow.com.gh/uploads/original/"))
        self.assertIn("-medium.jpg", row["image_urls"])
        self.assertEqual(row["source_availability"], "active")

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


if __name__ == "__main__":
    unittest.main()
