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
