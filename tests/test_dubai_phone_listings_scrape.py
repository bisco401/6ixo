import json
import unittest
from dubai_phone_listings_scrape import row_from_page

URL = 'https://albacars.ae/buy-used-cars/vehicle/123-test-car'
class DubaiPublicPhoneTests(unittest.TestCase):
    def page(self, phone='+97143772503', availability='InStock', url=URL, seller='Alba Cars'):
        car={'@type':'Car','url':url,'name':'Test Car','productionDate':'2024','brand':{'name':'Test'},'model':'Car',
             'image':['https://storage.albacars.ae/vehicles/drafts/123/1.jpg'], 'mileageFromOdometer':{'value':10000},
             'offers':{'availability':'https://schema.org/'+availability,'price':'95000.000','priceCurrency':'AED','seller':{'name':seller}}}
        return '<a href="tel:'+phone+'">Call seller</a>Alba Cars Dubai Showroom<script type="application/ld+json">'+json.dumps(car)+'</script>'
    def test_accepts_phone_and_full_purchase_price_from_exact_seller_page(self):
        row=row_from_page(self.page(),URL,'2026-09-20T00:00:00Z')
        self.assertEqual(row['phone'],'+97143772503')
        self.assertEqual(row['price_value'],'95000')
        self.assertEqual(json.loads(row['attributes'])['contactSource'],URL)
    def test_refuses_missing_masked_contact_sold_wrong_vehicle_or_seller(self):
        for options in [{'phone':''},{'phone':'05015047XX'},{'availability':'SoldOut'},{'url':URL+'other'},{'seller':'Other Dealer'}]:
            with self.subTest(options=options), self.assertRaises(ValueError):
                row_from_page(self.page(**options),URL,'2026-09-20T00:00:00Z')

if __name__=='__main__':unittest.main()
