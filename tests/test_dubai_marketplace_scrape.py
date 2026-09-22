import json
import unittest
from dubai_marketplace_scrape import electronics_row, appliance_row

CHECKED = '2026-09-21T00:00:00Z'
SHOP = '<a href="tel:+97143864334">Call</a> Al Raffa Street, Bur Dubai'

class DubaiMarketplaceTests(unittest.TestCase):
    def test_retail_stock_uses_exact_sku_image_and_advertised_deal(self):
        product = dict(code='ASUS-123', description='ASUS laptop 8GB RAM', category='Laptop',
                       qty=1, priceRetail=2000, dealOfDay=True, dealPrice=1900,
                       imageUrl='https://example.com/asus-123.jpg', condition='new')
        row = electronics_row(product, SHOP, CHECKED)
        self.assertEqual(row['price_value'], '1900')
        self.assertEqual(row['phone'], '+97143864334')
        self.assertEqual(json.loads(row['attributes'])['catalogItemId'], product['code'])
        for change in ({'qty':0}, {'imageUrl':''}, {'variants':[{'price':1000}]}, {'priceRetail':0, 'dealPrice':None}):
            with self.assertRaises(ValueError): electronics_row(dict(product, **change), SHOP, CHECKED)
        with self.assertRaises(ValueError): electronics_row(product, SHOP.replace('+97143864334','04XXX'), CHECKED)

    def test_appliance_requires_exact_url_and_available_aed_offer(self):
        url = 'https://usedappliancesuae.com/product/dishwasher/'
        offer = dict(url=url, price='2100', priceCurrency='AED', availability='https://schema.org/InStock', seller={'name':'Used Appliances UAE'})
        product = {'@type':'Product','name':'Bosch Dishwasher','offers':offer,'image':[{'url':'https://example.com/dishwasher.jpg'}]}
        def page(): return '<a href="tel:+971556807573">Call</a><script type="application/ld+json">'+json.dumps(product)+'</script>'
        self.assertEqual(appliance_row(page(),url,CHECKED)['app_subcategory'],'appliances')
        with self.assertRaises(ValueError): appliance_row(page(),url+'wrong',CHECKED)
        offer['availability']='https://schema.org/OutOfStock'
        with self.assertRaises(ValueError): appliance_row(page(),url,CHECKED)

if __name__ == '__main__': unittest.main()
