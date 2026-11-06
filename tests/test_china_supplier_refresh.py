import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('china', Path(__file__).resolve().parents[1] / 'scripts/refresh-china-supplier-listings.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ChinaSupplierTests(unittest.TestCase):
    url = 'https://supplier.example/product/office-desk/'
    base = {'source_site': 'Supplier', 'seller': 'Furniture Supplier', 'city': 'Foshan',
            'phone': '+8675728827856', 'app_category': 'other', 'app_subcategory': 'furniture_home_decor',
            'attributes': '{"supplierWhatsapp":"+8611111111111"}'}

    def page(self, product_url=None, stock='InStock', contact=True):
        entity = {'@type': 'Product', 'name': 'Office desk', 'url': product_url or self.url,
                  'image': ['https://supplier.example/media/own.jpg'],
                  'offers': {'availability': 'https://schema.org/' + stock}}
        return '<link rel="canonical" href="'+self.url+'"><h1>Office desk</h1>' + (
            '<a href="tel:+8675728827856">Call our office</a>' if contact else '') + (
            '<script type="application/ld+json">'+json.dumps(entity)+'</script><div class="related"><img src="https://supplier.example/foreign.jpg"></div>')

    def test_discovery_excludes_articles_before_limiting_new_products(self):
        host = 'www.sinovcleglobal.com'
        paths = ['/product/verified-vehicle']
        self.assertTrue(module.product_url('https://' + host + '/product/new-vehicle', host, paths))
        self.assertFalse(module.product_url('https://' + host + '/press-release/our-new-car-factory-news', host, paths))
        self.assertFalse(module.product_url('https://' + host + '/official-partner-brands-trusted-car-export-partnerships', host, paths))
        self.assertTrue(module.product_url('https://www.oneday-global.com/new-magnetic-power-bank.html', 'www.oneday-global.com', ['/existing-power-bank.html']))

    def test_exact_product_contact_gallery_and_quote_are_verified(self):
        row = module.parse_product(self.page(), self.url, self.base, '2026-11-06T06:00:00Z')
        self.assertEqual(row['country'], 'China')
        self.assertEqual(row['image_urls'], 'https://supplier.example/media/own.jpg')
        self.assertEqual(row['phone'], self.base['phone'])
        self.assertEqual(row['price_value'], '')
        self.assertEqual(row['price_text'], 'Contact supplier for price')
        self.assertNotIn('supplierWhatsapp', json.loads(row['attributes']))

    def test_sold_foreign_and_uncontactable_products_do_not_publish(self):
        for page in [self.page(stock='SoldOut'), self.page(product_url='https://supplier.example/product/other/'), self.page(contact=False)]:
            with self.assertRaises(ValueError):
                module.parse_product(page, self.url, self.base, '2026-11-06T06:00:00Z')

    def test_public_contact_page_can_verify_the_supplier_phone(self):
        row = module.parse_product(self.page(contact=False), self.url, self.base, '2026-11-06T06:00:00Z',
                                   '<p>Business phone: +86 757 2882 7856</p>')
        self.assertEqual(row['phone'], self.base['phone'])


if __name__ == '__main__':
    unittest.main()
