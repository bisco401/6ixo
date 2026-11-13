import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('expansion', Path(__file__).resolve().parents[1] / 'scripts/refresh-expansion-listings.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ExpansionSourceTests(unittest.TestCase):
    checked = '2026-11-06T07:00:00Z'

    def lagos(self, state='InStock', offer_url=None):
        url = 'https://www.korrectcars.com/cars/2021-toyota'
        car = {'@type': 'Car', 'name': '2021 Toyota', 'mileageFromOdometer': '103,000 km', 'image': ['https://www.korrectcars.com/uploads/own.jpg'],
               'offers': {'price': 15000000, 'priceCurrency': 'NGN', 'url': offer_url or url,
                          'availability': 'https://schema.org/' + state, 'seller': {'@id': 'https://www.korrectcars.com/#dealer'}}}
        body = f'<link rel="canonical" href="{url}"><h1>2021 Toyota</h1><p>Lagos</p><a href="tel:+2348091397912">Call</a><script type="application/ld+json">{json.dumps(car)}</script>'
        return url, body

    def test_lagos_exact_vehicle_price_phone_and_gallery(self):
        url, body = self.lagos()
        row = module.parse_listing('lagos', body, url, self.checked)
        self.assertEqual((row['city'], row['country'], row['currency'], row['price_value']), ('Lagos', 'Nigeria', 'NGN', '15000000'))
        self.assertEqual(row['phone'], '+2348091397912')
        self.assertEqual(row['image_urls'], 'https://www.korrectcars.com/uploads/own.jpg')

    def test_sold_or_foreign_offer_is_rejected(self):
        for url, body in [self.lagos('SoldOut'), self.lagos(offer_url='https://www.korrectcars.com/cars/other')]:
            with self.assertRaises(ValueError):
                module.parse_listing('lagos', body, url, self.checked)

    def test_johannesburg_resolves_own_offer_and_dealer_contact(self):
        url = 'https://searchmyride.co.za/cars/jeep/'
        graph = [{'@type': 'Vehicle', '@id': url+'#vehicle', 'name': 'Jeep Compass',
                  'image': ['https://searchmyride.co.za/own.jpg'], 'offers': {'@id': url+'#offer'}},
                 {'@type': 'Offer', '@id': url+'#offer', 'url': url, 'price': 74999, 'priceCurrency': 'ZAR',
                  'availability': 'https://schema.org/InStock', 'seller': {'@id': url+'#dealer'}},
                 {'@type': 'AutoDealer', '@id': url+'#dealer', 'name': 'Pre-owned cars', 'telephone': '27687908987',
                  'address': {'addressLocality': 'Johannesburg', 'addressCountry': 'ZA'}}]
        body = f'<title>Jeep Compass</title><link rel="canonical" href="{url}"><h1>Jeep Compass</h1><script type="application/ld+json">{json.dumps({"@graph": graph})}</script>'
        row = module.parse_listing('johannesburg', body, url, self.checked, '<a href="tel:27687908987">Call dealer</a>')
        self.assertEqual(row['seller'], 'Pre-owned cars')
        self.assertEqual(row['phone'], '+27687908987')
        state, _ = module.availability.classify(row, 200, body.replace('InStock', 'SoldOut'), url)
        self.assertEqual(state, 'sold')
        with self.assertRaises(ValueError):
            module.parse_listing('johannesburg', body, url, self.checked, '<a href="tel:27111111111">Other dealer</a>')

    def test_kampala_sublime_uses_vat_inclusive_price_and_primary_sold_status(self):
        url = 'https://sublimemotorcars.com/vehicle/hilux/'
        image = 'https://sublimemotorcars.com/uploads/hilux.jpg'
        car = {'@type': 'Car', 'name': '2023 Toyota Hilux', 'url': url,
               'itemCondition': 'https://schema.org/UsedCondition', 'image': [image],
               'offers': {'url': url, 'price': 100000000, 'priceCurrency': 'UGX',
                          'availability': 'https://schema.org/InStock',
                          'seller': {'@id': 'https://sublimemotorcars.com/#dealer'}}}
        body = f'''<link rel="canonical" href="{url}">
            <div class="veh-info"><span class="veh-year">2023 · Toyota</span><h1>Toyota Hilux</h1></div>
            <div class="veh-gallery"><div class="vg-main"><img src="{image}"></div></div>
            <div class="veh-price"><span class="vp-in"><b>UGX 118,000,000</b></span></div>
            <ul class="specs-list"><li><span>Location</span><b>Kampala, Uganda</b></li></ul>
            <div class="veh-buy"><a href="tel:+256754566777">Call</a></div>
            <article class="rvc"><span class="sold-flag">Sold</span></article>
            <script type="application/ld+json">{json.dumps(car)}</script>'''
        row = module.parse_listing('kampala_sublime', body, url, self.checked)
        self.assertEqual((row['country'], row['city'], row['price_value']), ('Uganda', 'Kampala', '118000000'))
        sold = body.replace('<div class="vg-main">', '<div class="vg-main"><span class="sold-flag">Sold</span>')
        self.assertEqual(module.availability.classify(row, 200, sold, url)[0], 'sold')
        with self.assertRaises(ValueError):
            module.parse_listing('kampala_sublime', sold, url, self.checked)

    def test_kampala_ml_requires_used_stock_and_matching_public_phone(self):
        url = 'https://www.mandelmotors.com/cars/forester'
        image = 'https://mandelmotors.com/storage/forester.jpg'
        car = {'@type': 'Car', 'name': '2016 Subaru Forester', 'image': [image],
               'itemCondition': 'https://schema.org/UsedCondition',
               'offers': {'url': url, 'price': 50000000, 'priceCurrency': 'UGX',
                          'availability': 'https://schema.org/InStock', 'seller': {'name': 'ML Motors'}}}
        business = {'@type': 'AutomotiveBusiness', 'name': 'ML Motors', 'url': 'https://www.mandelmotors.com',
                    'telephone': '+256775636888', 'address': {'addressCountry': 'UG', 'addressLocality': 'Kampala, Uganda'}}
        body = f'''<link rel="canonical" href="{url}"><h1>2016 Subaru Forester</h1>
            <img alt="2016 Subaru Forester photo 1" src="{image}">
            <a href="tel:+256775636888">Call</a>
            <script type="application/ld+json">{json.dumps([car, business])}</script>'''
        row = module.parse_listing('kampala_ml', body, url, self.checked)
        self.assertEqual((row['currency'], row['phone']), ('UGX', '+256775636888'))
        for invalid in (body.replace('tel:+256775636888', 'tel:+256755555555'), body.replace('UsedCondition', 'NewCondition')):
            with self.assertRaises(ValueError):
                module.parse_listing('kampala_ml', invalid, url, self.checked)

    def test_london_ignores_related_sold_car_and_uses_primary_price(self):
        url = 'https://maslenmotors.com/vehicle/name/range-rover/'
        body = f'''<title>Land Rover Range Rover | Maslen Motors</title><link rel="canonical" href="{url}">
            <div id="vehicle-details"><div class="vd-header">Land Rover Range Rover - 2023</div>
            <div class="vd-price">£67,995</div><a href="tel:02085 390 033">Call</a>
            <div class="vd-image"><a class="zoom-photo" href="https://photos.example/own.jpg"></a></div></div>
            <p>876 Lea Bridge Road, London</p><div class="featured-vehicles"><span>SOLD</span><span>£100</span></div>'''
        row = module.parse_listing('london', body, url, self.checked)
        self.assertEqual((row['price_value'], row['currency'], row['phone']), ('67995', 'GBP', '+442085390033'))


if __name__ == '__main__':
    unittest.main()
