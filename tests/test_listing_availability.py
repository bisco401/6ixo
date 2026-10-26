import importlib.util
import pathlib
import csv
import hashlib
import json
import tempfile
from types import SimpleNamespace
from unittest.mock import patch
import unittest

spec = importlib.util.spec_from_file_location("availability", pathlib.Path(__file__).resolve().parents[1] / "scripts/check-listing-availability.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class AvailabilityTest(unittest.TestCase):
    def setUp(self):
        self.row = {"title": "Toyota Corolla 2022", "source_url": "https://example.com/car/1", "status": "published"}

    def test_cache_retains_exact_response_for_detail_comparison(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            feed = root / "feed.csv"
            with feed.open("w", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=list(self.row))
                writer.writeheader(); writer.writerow(self.row)
            body = '<title>Toyota Corolla 2022</title><h1>Toyota Corolla 2022</h1>\n<p>Source specifications</p>'
            args = ["check", "--files", str(feed), "--cache-dir", str(root / "cache"), "--report", str(root / "report.json"), "--dry-run"]
            with patch("sys.argv", args), patch.object(module.requests, "get", return_value=SimpleNamespace(status_code=200, text=body, url=self.row["source_url"])):
                module.main()
            cached = root / "cache" / (hashlib.sha256(self.row["source_url"].encode()).hexdigest() + ".html")
            self.assertEqual(cached.read_text(), body)
            with patch("sys.argv", args), patch.object(module.requests, "get", side_effect=AssertionError("Cached status must not refetch")):
                module.main()
            self.assertEqual(cached.read_text(), body)

    def test_errors_are_not_removals(self):
        for code in (0, 403, 429, 500):
            self.assertEqual(module.classify(self.row, code, "Sold out")[0], "unknown")
        self.assertEqual(module.classify(self.row, 404, "<title>Just a moment</title>")[0], "unknown")
        for title in ["Robot Challenge Screen", "Bot Verification", "Verifying your browser"]:
            self.assertEqual(module.classify(self.row, 404, '<title>'+title+'</title>')[0], 'unknown')

    def test_exact_property_state_outranks_stale_available_offer(self):
        row = {**self.row, "source_url": "https://www.allsoppandallsopp.com/dubai/property/lettings/L-123"}
        offer = '<h1>Toyota Corolla 2022</h1><script type="application/ld+json">' + json.dumps({"@type": "Product", "url": row["source_url"], "offers": {"availability": "https://schema.org/InStock"}}) + '</script>'
        def body(state, reference="L-123", deleted=False):
            fields = {"pba__broker_s_listing_id__c": [reference], "pba__status__c": [state], "isdeleted": [deleted]}
            data = {"props": {"pageProps": {"data": {"data": {"listingDetails": {"hits": {"hits": [{"fields": fields}]}}}}}}}
            return offer + '<script id="__NEXT_DATA__">' + json.dumps(data) + '</script>'
        self.assertEqual(module.classify(row, 200, body("To Let - Off-Market"))[0], "unavailable")
        self.assertEqual(module.classify(row, 200, body("Sold"))[0], "sold")
        self.assertEqual(module.classify(row, 200, body("To Let - Live", deleted=True))[0], "unavailable")
        self.assertEqual(module.classify(row, 200, body("Offered"))[0], "unknown")
        self.assertEqual(module.classify(row, 200, body("To Let - Live"))[0], "active")
        self.assertEqual(module.classify(row, 200, body("To Let - Off-Market", reference="L-OTHER"))[0], "active")
        self.assertEqual(module.classify(row, 200, body("To Let - Live", deleted="false"))[0], "active")

    def test_exact_404_hides_without_deleting(self):
        availability, reason = module.classify(self.row, 404, "Missing")
        module.apply_result(self.row, dict(availability=availability, reason=reason, status=404, resolved_url=self.row["source_url"]), "2026-09-30T12:00:00Z")
        self.assertEqual(self.row["status"], "rejected")
        self.assertEqual(self.row["source_miss_count"], "1")
        self.assertIn("title", self.row)

    def test_percent_escape_case_is_not_a_different_source_path(self):
        self.row['source_url']='https://example.com/product/%e2%81%a0own-part/'
        self.assertEqual(module.classify(self.row,404,'<title>Page Not Found</title>','https://example.com/product/%E2%81%A0own-part/')[0],'gone')
        self.assertEqual(module.classify(self.row,404,'<title>Page Not Found</title>','https://example.com/product/another-part/')[0],'unknown')

    def test_recommendation_sold_does_not_hide_available_item(self):
        body = '<h1>Toyota Corolla 2022</h1><div class="related"><span>Sold out</span></div>'
        self.assertEqual(module.classify(self.row, 200, body)[0], "active")
        body += '<script type="application/ld+json">{"@type":"Product","name":"Honda Civic","url":"https://example.com/car/2","offers":{"availability":"https://schema.org/SoldOut"}}</script>'
        self.assertEqual(module.classify(self.row, 200, body)[0], "active")

    def test_own_sold_badge(self):
        self.assertEqual(module.classify(self.row, 200, '<h1>Toyota Corolla 2022</h1><span>Item already sold</span>')[0], "sold")

    def test_sold_title_requires_exact_item(self):
        self.assertEqual(module.classify(self.row, 200, '<h1><span id="titletextonly">SOLD**Toyota Corolla 2022</span></h1>')[0], "sold")
        self.assertEqual(module.classify(self.row, 200, '<h1>Toyota Corolla 2022 | SOLD | SOLD |</h1>')[0], "sold")
        self.assertEqual(module.classify(self.row, 200, '<h1>Toyota Corolla 2022</h1><div class="related"><h1>SOLD**Toyota Corolla 2022</h1></div>')[0], "active")
        self.assertNotEqual(module.classify(self.row, 200, '<h1>SOLD**Toyota Corolla 2025</h1>')[0], "sold")

    def test_same_model_recommendation_offer_is_not_own_stock(self):
        body = '<h1>Toyota Corolla 2022</h1><script type="application/ld+json">{"@type":"Product","name":"Toyota Corolla 2022","url":"https://example.com/car/2","offers":{"availability":"https://schema.org/SoldOut"}}</script>'
        self.assertEqual(module.classify(self.row, 200, body)[0], "active")
        self.assertEqual(module.classify(self.row, 200, '<h1>Toyota Corolla 2022</h1><div class="up-sells"><span>Out of stock</span></div>')[0], "active")
        self.assertEqual(module.classify(self.row, 200, '<h1>Toyota Corolla 2022</h1><span>Out of stock</span>')[0], "unavailable")

    def test_stock_with_available_variant(self):
        body = '<h1>Toyota Corolla 2022</h1><script type="application/ld+json">{"@type":"Product","url":"https://example.com/car/1","offers":[{"availability":"https://schema.org/SoldOut"},{"availability":"https://schema.org/InStock"}]}</script>'
        self.assertEqual(module.classify(self.row, 200, body)[0], "active")

    def test_stock_schema_with_literal_description_newline(self):
        body = '<h1>Toyota Corolla 2022</h1><script type="application/ld+json">{"@type":"Product","name":"Toyota Corolla 2022","description":"Actual description\nwith a newline","url":"https://example.com/car/1","offers":{"availability":"https://schema.org/OutOfStock"}}</script>'
        self.assertEqual(module.classify(self.row, 200, body)[0], "unavailable")

    def test_removed_kijiji_redirect(self):
        row = {**self.row, "source_url": "https://www.kijiji.ca/v-cars-trucks/hamilton/car/123"}
        self.assertEqual(module.classify(row, 200, "Search results", "https://www.kijiji.ca/b-hamilton/l80014?adRemoved=true")[0], "unavailable")
        self.assertEqual(module.classify(row, 200, "Search results", "https://www.kijiji.ca/b-hamilton/l80014?adRemoved=123")[0], "unavailable")
        self.assertEqual(module.classify(row, 200, "Search results", "https://www.kijiji.ca/b-hamilton/l80014?adRemoved=456")[0], "unknown")
        self.assertEqual(module.classify(row, 200, "Search results", "https://example.com/?adRemoved=true")[0], "unknown")

    def test_foreign_error_response_is_not_exact_removal(self):
        self.assertEqual(module.classify(self.row, 404, "Missing", "https://different.example/car/1")[0], "unknown")
        self.assertEqual(module.classify(self.row, 404, "<h1>Security check</h1>", self.row["source_url"])[0], "unknown")

    def test_search_redirect_is_not_matching_active_ad(self):
        self.assertEqual(module.classify(self.row, 200, '<h1>Toyota Corolla 2022 search results</h1>', 'https://example.com/search')[0], "unknown")

    def test_unknown_does_not_restore_confirmed_sold(self):
        self.row.update(source_availability="sold", status="rejected", sync_visibility="unavailable")
        module.apply_result(self.row, dict(availability="unknown", reason="Blocked", status=403, resolved_url=self.row["source_url"]), "2026-09-30T12:00:00Z")
        self.assertEqual(self.row["source_availability"], "sold")
        self.assertEqual(self.row["status"], "rejected")


if __name__ == "__main__":
    unittest.main()
