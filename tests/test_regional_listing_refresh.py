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
    def test_atlanta_primary_contact_price_does_not_inherit_old_or_recommended_prices(self):
        url = URLS["atlanta"]
        title, vin = "2022 Kia Sorento EX", "5XYRH4LF4NG098846"
        vehicle = {"@type": ["Product", "Car"], "url": url, "name": title,
                   "vehicleIdentificationNumber": vin, "vehicleModelDate": 2022,
                   "brand": {"name": "Kia"}, "model": "Sorento",
                   "itemCondition": "https://schema.org/UsedCondition",
                   "mileageFromOdometer": {"value": 85249, "unitCode": "SMI"},
                   "image": ["https://static.overfuel.com/photos/2200/own-vehicle/photo.webp"]}
        dealer = {"@type": ["LocalBusiness", "AutoDealer"], "name": "Atlanta Best Used Cars",
                  "@id": "https://www.atlantabestusedcars.com/#organization",
                  "url": "https://www.atlantabestusedcars.com/", "telephone": "+17708005000",
                  "openingHoursSpecification": [{"dayOfWeek": "Monday", "opens": "09:00", "closes": "20:00"}],
                  "address": {"addressLocality": "Peachtree Corners", "addressRegion": "GA"}}
        def document(vehicle_data=vehicle):
            return (f'<link rel="canonical" href="{url}"><h1>{title}</h1>'
                    f'<script type="application/ld+json">{json.dumps(vehicle_data)}</script>'
                    f'<script type="application/ld+json">{json.dumps(dealer)}</script>'
                    '<span data-cy="header-phone" role="button">(770) 800-5000</span>'
                    '<div class="vdp-costpayment"><span>Call for price</span></div>'
                    '<div class="vdp-details-grid">'
                    f'<div class="vdp-detail"><div class="d-flex"><div><b>VIN</b></div><div>{vin}</div></div></div>'
                    '<div class="vdp-detail"><div class="d-flex"><div><b>Passengers</b></div><div>5</div></div></div>'
                    '<div class="vdp-detail"><div class="d-flex"><div><b>Engine</b></div><div>2.5L gasoline engine</div></div></div>'
                    '</div><div class="dealer-notes">This vehicle has a Branded Title.</div>'
                    '<aside class="related"><span>$999</span></aside>')
        body = document()
        row = module.parse_listing("atlanta", body, url, CHECKED)
        self.assertEqual((row["price_text"], row["price_value"], row["currency"]), ("Call for price", "", ""))
        self.assertEqual((row["seller"], row["city"], row["phone"]),
                         ("Atlanta Best Used Cars", "Peachtree Corners", "+17708005000"))
        self.assertEqual(row.get("mileage_km", ""), "")
        self.assertIn('"label":"Passengers","value":"5"', row["attributes"])
        self.assertIn('"label":"Title information","value":"Branded Title (dealer disclosure)"', row["attributes"])
        self.assertEqual(json.loads(row["attributes"])["contactHours"], "Monday 09:00–20:00")
        offer = {"url": url, "availability": "https://schema.org/InStock", "price": 18378,
                 "priceCurrency": "USD", "seller": {"@id": dealer["@id"]}}
        priced = module.parse_listing("atlanta", document({**vehicle, "offers": offer}).replace(
            "Call for price", "Retail price $18,378"), url, CHECKED)
        self.assertEqual((float(priced["price_value"]), priced["phone"]), (18378, "+17708005000"))
        for invalid in [
                body.replace("Call for price", "Contact dealer"),
                body.replace("(770) 800-5000", "(770) 800-XXXX"),
                body.replace(f'<div>{vin}</div>', '<div>FOREIGN-VIN</div>'),
                body.replace('<link rel="canonical"', '<link rel="unrelated"'),
                body.replace('<div class="vdp-costpayment"><span>Call for price</span></div>',
                             '<aside class="related"><div class="vdp-costpayment">Call for price</div></aside>'),
                body + '<p>This vehicle is sold</p>',
                document({**vehicle, "offers": {**offer, "seller": {"@id": "https://unrelated.example/#organization"}}}),
                document({**vehicle, "offers": {**offer, "url": url + "-other"}}),
                document({**vehicle, "offers": {"availability": "https://schema.org/SoldOut"}})]:
            with self.subTest(invalid=invalid[-100:]), self.assertRaises(ValueError):
                module.parse_listing("atlanta", invalid, url, CHECKED)

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

    def test_condition_is_unspecified_without_a_listing_fact(self):
        row = module.parse_listing("liusedcars", fixture("liusedcars"), URLS["liusedcars"], CHECKED)
        self.assertEqual(row["condition"], "")
        soup = module.BeautifulSoup(fixture("liusedcars"), "html.parser")
        soup.select_one("#attributes").append(module.BeautifulSoup(
            "<li><span>Condition:</span>Used</li>", "html.parser"))
        row = module.parse_listing("liusedcars", str(soup), URLS["liusedcars"], CHECKED)
        self.assertEqual(row["condition"], "used")

    def test_visible_odometer_preserves_zero_and_requires_km(self):
        for value, expected in [("0 km", "0"), ("12,345 km", "12345"), ("12,345", ""), ("12,345 miles", "")]:
            with self.subTest(value=value):
                body = fixture("mekina") + "<dl><div><dt>Mileage</dt><dd>" + value + "</dd></div></dl>"
                row = module.parse_listing("mekina", body, URLS["mekina"], CHECKED)
                self.assertEqual(row.get("mileage_km", ""), expected)

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
