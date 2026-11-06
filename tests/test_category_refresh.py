import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('categories', Path(__file__).resolve().parents[1] / 'scripts/refresh-category-listings.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CategorySourceTests(unittest.TestCase):
    checked = '2026-11-06T09:00:00Z'

    def product(self, state='InStock', foreign=False):
        url = 'https://kriselectronics.com/product/hisense-refrigerator/'
        product = {'@type': 'Product', '@id': url + '#product', 'name': 'Hisense Refrigerator',
                   'image': [{'url': 'https://kriselectronics.com/own.jpg'}],
                   'offers': {'url': url + ('other/' if foreign else ''), 'price': 355000,
                              'priceCurrency': 'NGN', 'availability': 'https://schema.org/' + state}}
        return url, f'<link rel="canonical" href="{url}"><h1>Hisense Refrigerator</h1><script type="application/ld+json">{json.dumps(product)}</script><div class="related"><img src="other.jpg"></div>'

    def job(self, closing='2026-12-01', location='London', salary=True, foreign=False):
        url = 'https://www.twrecruitment.com/jobs/123-science-technician'
        job = {'@type': 'JobPosting', 'url': url + ('other' if foreign else ''), 'title': 'Science Technician',
               'validThrough': closing, 'datePosted': '2026-11-05T12:00:00Z', 'employmentType': 'TEMPORARY',
               'jobLocation': {'address': {'addressCountry': 'GB', 'addressLocality': location}},
               'hiringOrganization': {'name': 'Tradewind Recruitment', 'logo': 'https://www.twrecruitment.com/own-logo.jpg'}}
        if salary:
            job['baseSalary'] = {'currency': 'GBP', 'value': {'minValue': 95, 'maxValue': 110, 'unitText': 'DAY'}}
        return url, f'<link rel="canonical" href="{url}"><h1>Science Technician</h1><script type="application/ld+json">{json.dumps(job)}</script>'

    def test_exact_product_and_appliance_routing(self):
        url, body = self.product()
        row = module.parse_product('kris', body, url, self.checked)
        self.assertEqual((row['app_category'], row['app_subcategory']), ('other', 'appliances'))
        self.assertEqual(row['image_urls'], 'https://kriselectronics.com/own.jpg')
        self.assertEqual((row['price_value'], row['currency']), ('355000', 'NGN'))
        self.assertEqual(module.product_category('Hisense 43 inch TV'), ('electronics', 'tv_video_home_theatre'))
        self.assertEqual(module.product_category('Hisense 1.5HP Inverter Split Air Conditioner'), ('other', 'appliances'))

    def test_rejects_sold_and_foreign_offers(self):
        for url, body in [self.product('SoldOut'), self.product(foreign=True)]:
            with self.assertRaises(ValueError):
                module.parse_product('kris', body, url, self.checked)

    def test_product_name_normalizes_quotes_and_repeated_html_entities(self):
        self.assertEqual(module.name_tokens('Hisense 43” TV'), module.name_tokens("Hisense 43'' TV"))
        self.assertEqual(module.name_tokens('Headset &amp;amp; Mic'), module.name_tokens('Headset & Mic'))

    def test_variant_availability_uses_only_this_product(self):
        url = 'https://fonavia.co.uk/products/charger'
        product = {'@type': 'ProductGroup', '@id': url+'#product', 'name': 'USB Charger', 'hasVariant': [
            {'offers': {'url': url+'?variant=1', 'availability': 'https://schema.org/OutOfStock'}},
            {'offers': {'url': url+'?variant=2', 'availability': 'https://schema.org/InStock'}}]}
        body = f'<h1>USB Charger</h1><script type="application/ld+json">{json.dumps(product)}</script>'
        row = {'source_url': url, 'title': 'USB Charger'}
        self.assertEqual(module.availability.classify(row, 200, body, url)[0], 'active')
        self.assertEqual(module.availability.classify(row, 200, body.replace('InStock', 'OutOfStock'), url)[0], 'unavailable')

    def test_current_sale_price_and_own_woocommerce_gallery(self):
        url = 'https://www.products4u.co.za/product/washer/'
        body = f'''<link rel="canonical" href="{url}"><div data-elementor-type="product" class="type-product instock">
            <h1 class="product_title">Samsung Washer</h1><div class="elementor-widget-woocommerce-product-price"><p class="price">
            <del><span class="amount">R6,799.00</span></del><ins><span class="amount">R4,999.00</span></ins></p></div>
            <div class="woocommerce-product-gallery__image"><a href="https://www.products4u.co.za/own.jpg"></a></div></div>
            <div class="related"><span class="price">R99</span><img src="other.jpg"></div>'''
        row = module.parse_product('products4u', body, url, self.checked)
        self.assertEqual(row['price_value'], '4999.00')
        self.assertEqual(row['image_urls'], 'https://www.products4u.co.za/own.jpg')
        state, _ = module.availability.classify(row, 200, body.replace('instock', 'outofstock'), url)
        self.assertEqual(state, 'unavailable')

    def test_job_keeps_real_pay_unit_dates_and_recruiter(self):
        url, body = self.job()
        row = module.parse_job('tradewind', body, url, self.checked)
        attrs = json.loads(row['attributes'])
        self.assertEqual((row['currency'], attrs['payUnit'], attrs['employmentType']), ('GBP', 'day', 'temporary'))
        self.assertEqual(attrs['applicationUrl'], url)
        self.assertEqual(row['scraped_at'], '2026-11-05T12:00:00Z')
        self.assertEqual(attrs['experienceLevel'], '')
        self.assertEqual(row['image_urls'], 'https://www.twrecruitment.com/own-logo.jpg')

    def test_missing_salary_is_not_invented(self):
        url, body = self.job(salary=False)
        row = module.parse_job('tradewind', body, url, self.checked)
        self.assertEqual(row['price_value'], '')
        self.assertEqual(row['price_text'], 'Pay not specified')
        self.assertNotIn('payMin', json.loads(row['attributes']))

    def test_job_location_uses_role_overview_instead_of_office_footer(self):
        url, body = self.job(salary=False)
        body = body.replace('Tradewind Recruitment', 'Taylored Appointments').replace('London', 'field_123')
        body += '<dl class="taylored-job-single__facts"><div><dt>Location</dt><dd>Johannesburg, Gauteng, ZA</dd></div></dl>'
        row = module.parse_job('taylored', body, url, self.checked)
        self.assertEqual(row['city'], 'Johannesburg')
        self.assertEqual(row['app_subcategory'], 'business_office')
        with self.assertRaises(module.SkipListing):
            module.parse_job('taylored', body.replace('Johannesburg, Gauteng, ZA', 'Cape Town, Western Cape, ZA')+'<footer>Johannesburg</footer>', url, self.checked)

    def test_closed_unrelated_and_wrong_city_jobs_are_not_imported(self):
        for url, body in [self.job(closing='2020-01-01'), self.job(location='Manchester'), self.job(foreign=True)]:
            with self.assertRaises(ValueError):
                module.parse_job('tradewind', body, url, self.checked)

    def test_job_expiry_checks_only_own_role_and_keeps_blocked_requests(self):
        url, body = self.job(closing='2020-01-01')
        row = {'source_url': url, 'title': 'Science Technician', 'app_category': 'jobs'}
        self.assertEqual(module.availability.classify(row, 200, body, url)[0], 'unavailable')
        self.assertEqual(module.availability.classify(row, 403, body, url)[0], 'unknown')
        _, foreign = self.job(closing='2020-01-01', foreign=True)
        self.assertEqual(module.availability.classify(row, 200, foreign, url)[0], 'active')
        self.assertEqual(module.availability.classify(row, 200, '<h1>Science Technician</h1><p>Applications closed</p>', url)[0], 'unavailable')

    def test_date_only_expiry_includes_whole_day(self):
        self.assertEqual(module.availability.job_expiry('2026-11-06'), datetime(2026, 11, 7, tzinfo=timezone.utc))
        self.assertIsNone(module.availability.job_expiry('not provided'))

    def test_phone_requires_public_contact_and_location(self):
        source = module.SOURCES['kris']
        self.assertEqual(module.contact(source, '<p>Lagos</p><a href="tel:07086063019">Call</a>'), '+2347086063019')
        for body in ['<p>Lagos</p><a href="tel:07081111111">Other</a>', '<a href="tel:07086063019">No address</a>']:
            with self.assertRaises(ValueError):
                module.contact(source, body)


if __name__ == '__main__':
    unittest.main()
