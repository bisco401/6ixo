import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location("refresh", pathlib.Path(__file__).resolve().parents[1] / "scripts/refresh-marketplace-listings.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RefreshTest(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
