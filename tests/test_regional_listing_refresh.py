import importlib.util
import json
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("regional", ROOT / "scripts/refresh-regional-listings.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
region_spec = importlib.util.spec_from_file_location("regions", ROOT / "scripts/backfill-listing-regions.py")
regions = importlib.util.module_from_spec(region_spec)
region_spec.loader.exec_module(regions)
CHECKED = "2026-10-25T21:00:00Z"
URLS = {
    "liusedcars": "https://www.liusedcars.com/for-sale/2008-volkswagen-jetta-4dr-automatic-se-172374",
    "atlanta": "https://www.atlantabestusedcars.com/inventory/used-2022-kia-sorento-ex-5xyrh4lf4ng098846-in-peachtree-corners-ga",
    "florida": "https://www.turnpikemotorsflorida.com/details/used-2014-buick-encore/127787544",
    "texas": "https://www.lexoinc.com/Inventory/Details/4210f234-605d-43fd-a111-053ff5882cb8",
    "mekina": "https://mekinashowroom.com/cars/2025-byd-song-plus-a948dd",
    "betoch": "https://betoch.et/properties/3-bedroom-apartment-for-sale-in-22-mazoria-addis-ababa-betochet",
}


def fixture(source):
    return (ROOT / "tests/fixtures/regional-sources" / f"{source}.html").read_text()


class RegionalSourceTests(unittest.TestCase):
    def test_real_source_fixtures_keep_price_contact_state_and_exact_images(self):
        expected = {
            "liusedcars": (1900, "USD", "New York", "+19145331895"),
            "atlanta": (18378, "USD", "Georgia", "+17708005000"),
            "florida": (6995, "USD", "Florida", "+19549416452"),
            "texas": (11900, "USD", "Texas", "+18322063054"),
            "mekina": (7000000, "ETB", "", "+251997457702"),
            "betoch": (40000000, "ETB", "Addis Ababa", "+251911084039"),
        }
        for source, (price, currency, state, phone) in expected.items():
            with self.subTest(source=source):
                row = module.parse_listing(source, fixture(source), URLS[source], CHECKED)
                attrs = json.loads(row["attributes"])
                self.assertEqual((float(row["price_value"]), row["currency"], attrs["region"], row["phone"]),
                                 (price, currency, state, phone))
                self.assertLessEqual(len(row["image_urls"].split("|")), 4)
                self.assertEqual(attrs["imageSourceUrl"], URLS[source])
                self.assertLessEqual(len(row["description"]), 1000)
                self.assertEqual(row.get("mileage_km", ""), "", "US miles must not become kilometres")
                if source in {"atlanta", "texas", "liusedcars"}:
                    self.assertIn("miles", row["attributes"])

    def test_recommended_product_cannot_replace_primary_listing(self):
        for source in ["atlanta", "mekina", "betoch", "texas"]:
            with self.subTest(source=source), self.assertRaises(ValueError):
                module.parse_listing(source, fixture(source).replace(URLS[source], URLS[source] + "-unrelated"), URLS[source], CHECKED)
        with self.assertRaises(ValueError):
            module.parse_listing("liusedcars", fixture("liusedcars").replace('value="172374"', 'value="999999"'), URLS["liusedcars"], CHECKED)

    def test_public_phone_required_and_sold_offer_held(self):
        for phone in ["", "0911XXXXXX", "0911", "+15555555555"]:
            self.assertEqual(module.phone_number(phone, "Ethiopia"), "")
        with self.assertRaises(ValueError):
            module.parse_listing("mekina", fixture("mekina").replace("+251997457702", ""), URLS["mekina"], CHECKED)
        for source in ["atlanta", "mekina", "texas"]:
            with self.subTest(source=source), self.assertRaises(ValueError):
                module.parse_listing(source, fixture(source).replace("InStock", "SoldOut"), URLS[source], CHECKED)

    def test_gallery_price_and_dealer_mismatches_are_held(self):
        body = fixture("florida")
        with self.assertRaises(ValueError):
            module.parse_listing("florida", body.replace("$6,995", "$5,995"), URLS["florida"], CHECKED)
        with self.assertRaises(ValueError):
            module.parse_listing("florida", body.replace('"Turnpike Motors"', '"Unrelated Dealer"', 1), URLS["florida"], CHECKED)
        with self.assertRaises(ValueError):
            module.parse_listing("florida", body.replace('"image": "https://cdn05.carsforsale.com/383c204fa91632adee8a278ab74ee0d7/', '"image": "https://cdn05.carsforsale.com/other/'), URLS["florida"], CHECKED)

    def test_electric_vehicle_does_not_publish_conflicting_engine(self):
        row = module.parse_listing("mekina", fixture("mekina"), URLS["mekina"], CHECKED)
        self.assertNotIn("1600", row["attributes"])
        self.assertNotIn("Engine", row["description"])

    def test_property_requires_listing_agent_not_site_footer_phone(self):
        body = fixture("betoch").replace('href="tel:0911084039"', 'href="/contact"')
        body += '<footer><a href="tel:0911084039">Call site</a></footer>'
        with self.assertRaises(ValueError):
            module.parse_listing("betoch", body, URLS["betoch"], CHECKED)
        with self.assertRaises(ValueError):
            module.parse_listing("betoch", fixture("betoch").replace("2026-10-25", "2024-10-25"), URLS["betoch"], CHECKED)
        with self.assertRaisesRegex(ValueError, "price is incomplete"):
            module.parse_listing("betoch", fixture("betoch").replace('"price": 40000000', '"price": 14'), URLS["betoch"], CHECKED)

    def test_discovery_reads_case_sensitive_texas_paths_without_leaving_site(self):
        url = URLS["texas"]
        body = '<a href="' + url + '">Car</a><a href="https://other.test' + module.urlsplit(url).path + '">Foreign</a>'
        body += '<script type="application/ld+json">' + json.dumps({"@type": "Car", "url": url}) + '</script>'
        self.assertEqual(module.discovery_links(body, module.SOURCES["texas"][1], module.SOURCES["texas"][2]), [url])
        catalogue = module.SOURCES["atlanta"][1]
        body = '<a href="' + catalogue + '/page/2">2</a><a href="https://other.test/page/3">3</a><a href="/contact">Contact</a>'
        self.assertEqual(module.catalogue_pages(body, catalogue), [catalogue + "/page/2"])

    def test_cross_post_address_outweighs_discovery_region(self):
        url = "https://www.craigslist.org/view/d/largo-car/exactId"
        product = {"@type": "Product", "name": "2000 Plymouth Prowler", "image": ["https://example.test/car.jpg"],
                   "offers": {"price": "26875", "availableAtOrFrom": {"address": {"addressLocality": "Largo", "addressRegion": "FL"}}}}
        body = '<h1>2000 Plymouth Prowler</h1><section id="postingbody">Call 727-619-1993</section><script type="application/ld+json">' + json.dumps(product) + '</script>'
        row = module.refresh.craigslist_row(body, url, "San Antonio", "vehicles", "vehicles", CHECKED)
        self.assertEqual(json.loads(row["attributes"])["region"], "Florida")
        self.assertEqual(regions.verified_region(row, body, url), "Florida")
        with self.assertRaises(ValueError):
            regions.verified_region(row, body, url + "-redirected")
        self.assertTrue({"miami", "tampa", "orlando", "jacksonville", "dallas", "austin", "sanantonio"} <= module.refresh.CL_REGIONS.keys())


if __name__ == "__main__":
    unittest.main()
