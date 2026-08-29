import tempfile
import unittest
from pathlib import Path

from kijiji_scrape import KijijiListing, merge_listings, normalize_image_url, read_csv, write_csv


def listing(listing_id: str, date: str, *, phone: str = "9055551212", images: str = "https://example.com/car.jpg") -> KijijiListing:
    return KijijiListing(
        id=listing_id,
        title=f"Listing {listing_id}",
        price="CA$ 100.00",
        url=f"https://example.com/{listing_id}",
        city="Hamilton",
        location_name="Hamilton",
        location_address="Hamilton, ON",
        posted_at=date,
        sorting_date=date,
        seller_id="seller",
        phone_numbers=phone,
        image_url=images.split("|")[0] if images else "",
        image_urls=images,
        image_files="",
        description="Public listing",
        category_id="1",
    )


class KijijiMergeTests(unittest.TestCase):
    def test_small_kijiji_thumbnails_are_upgraded(self) -> None:
        small = "https://media.kijiji.ca/api/v1/images/example?rule=kijijica-200-jpg"

        self.assertEqual(
            normalize_image_url(small),
            "https://media.kijiji.ca/api/v1/images/example?rule=kijijica-640-webp",
        )

    def test_merge_keeps_newest_and_deduplicates(self) -> None:
        old = listing("same", "2026-08-01T00:00:00Z")
        fresh = listing("same", "2026-08-04T00:00:00Z")
        other = listing("other", "2026-08-03T00:00:00Z")

        merged = merge_listings([fresh, other], [old], max_records=10)

        self.assertEqual([row.id for row in merged], ["same", "other"])
        self.assertEqual(merged[0].sorting_date, fresh.sorting_date)

    def test_merge_rejects_missing_phone_or_images(self) -> None:
        valid = listing("valid", "2026-08-04T00:00:00Z")
        no_phone = listing("no-phone", "2026-08-04T00:00:00Z", phone="")
        no_image = listing("no-image", "2026-08-04T00:00:00Z", images="")

        merged = merge_listings([valid, no_phone, no_image], [], max_records=10)

        self.assertEqual([row.id for row in merged], ["valid"])

    def test_csv_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "listings.csv"
            expected = [listing("one", "2026-08-04T00:00:00Z")]
            write_csv(expected, path)

            self.assertEqual(read_csv(path), expected)


if __name__ == "__main__":
    unittest.main()
