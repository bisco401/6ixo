#!/usr/bin/env python3
"""Discover new electronics, appliances, property and vacancies from public primary sources."""
import argparse
import csv
import hashlib
import html
import importlib.util
import json
import re
import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('expansion', ROOT / 'scripts/refresh-expansion-listings.py')
expansion = importlib.util.module_from_spec(spec)
spec.loader.exec_module(expansion)
refresh, availability = expansion.refresh, expansion.availability
key, clean = availability.source_key, refresh.clean
SOURCES = {
    'kris': dict(name='Kris Electronics', country='Nigeria', city='Lagos', currency='NGN', code='234', digits=10,
                 catalogs=['https://kriselectronics.com/shop/'], contact='https://kriselectronics.com/shop/',
                 location='Lagos', phone='+2347086063019', kind='product'),
    'products4u': dict(name='Products4u', country='South Africa', city='Johannesburg', currency='ZAR', code='27', digits=9,
                       catalogs=['https://www.products4u.co.za/shop/', 'https://www.products4u.co.za/product-category/televisions/',
                                 'https://www.products4u.co.za/product-category/monitors/', 'https://www.products4u.co.za/product-category/fridges/',
                                 'https://www.products4u.co.za/product-category/washing-machines/'], contact='https://www.products4u.co.za/contact-us/',
                       location='Johannesburg', phone='+27828884217', kind='product'),
    'justelectronics': dict(name='Just Electronics', country='South Africa', city='Johannesburg', currency='ZAR', code='27', digits=9,
                           catalogs=['https://justelectronics.co.za/product-category/computer/networking/routers/',
                                     'https://justelectronics.co.za/product-category/tv-audio/headphones-microphones/',
                                     'https://justelectronics.co.za/product-category/smart-home/'],
                           contact='https://justelectronics.co.za/contact-us/', location='Johannesburg', phone='+27116800244', kind='product'),
    'centralhome': dict(name='Central Home Appliances', country='United Kingdom', city='London', currency='GBP', code='44', digits=10,
                        catalogs=['https://centralhomeappliances.com/'], contact='https://centralhomeappliances.com/pages/contact',
                        location='Croydon CR0 3BF', phone='+447468333202', kind='product'),
    'fonavia': dict(name='Fonavia', country='United Kingdom', city='London', currency='GBP', code='44', digits=10,
                   catalogs=['https://fonavia.co.uk/collections/all'], contact='https://fonavia.co.uk/pages/contact',
                   location='London W12 8AA', phone='+447951807037', kind='product'),
    'gadgetcraze_kampala': dict(name='Gadget Craze', country='Uganda', city='Kampala', currency='UGX', code='256', digits=9,
                               catalogs=['https://gadgetcraze.ug/shop'],
                               contact='https://gadgetcraze.ug/contact', location='Mabirizi Complex',
                               phone='+256758005360', kind='product', candidates=20,
                               pattern=r'^/shop/[^/]+-\d+/?$'),
    'netcart_kampala': dict(name='netCart', country='Uganda', city='Kampala', currency='UGX', code='256', digits=9,
                            catalogs=['https://net-cart.com/product-category/electronics/phones/smartphones/',
                                      'https://net-cart.com/product-category/electronics/computing/laptops-desktops/business-laptops/'],
                            contact='https://net-cart.com/contact-us/', location='Bunga, Ggaba Road, Kampala',
                            phone='+256752734748', kind='product', candidates=20),
    'juha_rentals': dict(name='Juha Properties', country='Uganda', city='Kampala', code='256', digits=9,
                         catalogs=['https://www.juhaproperties.com/rentals/'],
                         contact='https://www.juhaproperties.com/contact/', location='Kampala',
                         phone='+256772596660', kind='property', transaction='rent', candidates=16),
    'juha_sales': dict(name='Juha Properties', country='Uganda', city='Kampala', code='256', digits=9,
                       catalogs=['https://www.juhaproperties.com/sales/'],
                       contact='https://www.juhaproperties.com/contact/', location='Kampala',
                       phone='+256772596660', kind='property', transaction='sale', candidates=16),
    'tradewind': dict(name='Tradewind Recruitment', country='United Kingdom', city='London', currency='GBP', code='44', digits=10,
                     catalogs=['https://www.twrecruitment.com/contact-us/london'], contact='https://www.twrecruitment.com/contact-us/london',
                     location='High Holborn', phone='+442078455450', kind='job', country_code='GB'),
    'taylored': dict(name='Taylored Appointments', country='South Africa', city='Johannesburg', currency='ZAR', code='27', digits=9,
                    catalogs=['https://tayloredapps.co.za/job-list/'], contact='https://tayloredapps.co.za/job-list/',
                    location='Lonehill', phone='+27114672011', kind='job', country_code='ZA'),
}


class SkipListing(ValueError):
    """Confirmed unavailable or outside the configured category/location."""


def types(entity):
    value = entity.get('@type', [])
    return set(value if isinstance(value, list) else [value])


def name_tokens(value):
    value = str(value or '')
    for _ in range(3):
        value = html.unescape(value)
    return re.findall(r'\w+', value.casefold())


def page(body, url):
    soup = BeautifulSoup(body, 'html.parser')
    canonical = soup.select_one('link[rel="canonical"]')
    if not canonical or key(urljoin(url, canonical.get('href', ''))) != key(url):
        raise ValueError('Exact canonical listing required')
    for node in reversed(soup.select('[class*="related"], [class*="recommend"], [class*="similar"], [class*="up-sells"], [class*="cross-sells"]')):
        node.decompose()
    entities = []
    for node in soup.select('script[type="application/ld+json"]'):
        try:
            entities.extend(availability.entities(json.loads(node.get_text(), strict=False)))
        except (ValueError, TypeError):
            pass
    by_id = {e['@id']: e for e in entities if e.get('@id')}
    def resolve(value):
        return by_id.get(value.get('@id'), value) if isinstance(value, dict) else {}
    return soup, entities, resolve


def contact(source, body):
    soup = BeautifulSoup(body, 'html.parser')
    text = clean(soup.get_text(' ', strip=True))
    if source['location'].casefold() not in text.casefold():
        raise ValueError('Public business address has not been verified')
    phones = {expansion.phone(n['href'][4:], source) for n in soup.select('a[href^="tel:"]')}
    # Some shops publish their phone as visible text rather than a tel link.
    phones.update(expansion.phone(n[0], source) for n in re.finditer(r'\+?\d[\d ()-]{7,20}\d', text))
    if source['phone'] not in phones:
        raise ValueError('Configured contact is no longer published by the source')
    return source['phone']


def product_category(title):
    if re.search(r'\b(?:washers?|washing machine|front loader|wash.{0,15}dry|dryers?|fridge|refrigerator|freezer|dishwasher|microwave|oven|cooker|cooktop|hob|kettle|blender|toaster|air fryer|air conditioners?|standing ac|split ac|portable ac|vacuum|electric heater|tower fan)\b', title, re.I):
        return 'other', 'appliances'
    if re.search(r'\b(?:television|tv|oled|qled)\b', title, re.I):
        return 'electronics', 'tv_video_home_theatre'
    if re.search(r'headphone|earphone|earbud|speaker|soundbar', title, re.I):
        return 'electronics', 'audio_headphones'
    if re.search(r'\b(?:monitor|laptop|desktop|tablet)\b', title, re.I):
        return 'electronics', 'computers_tablets'
    return 'electronics', 'other'


def parse_product(source_id, body, url, checked):
    source = SOURCES[source_id]
    soup, entities, resolve = page(body, url)
    heading = soup.select_one('h1.product_title, h1')
    title = clean(heading.get_text(' ', strip=True)) if heading else ''
    products = [e for e in entities if types(e) & {'Product', 'ProductGroup'}
                and key(urljoin(url, e.get('url') or e.get('@id') or '')) == key(url)]
    # Products4u uses an exact WooCommerce product container instead of Product schema.
    if source_id == 'products4u':
        primary = soup.select_one('[data-elementor-type="product"].type-product')
        if not primary or not primary.select_one('h1.product_title'):
            raise ValueError('No primary WooCommerce product')
        if 'outofstock' in primary.get('class', []):
            raise SkipListing('Product out of stock')
        if 'instock' not in primary.get('class', []):
            raise ValueError('No explicit stock state')
        prices = primary.select('.elementor-widget-woocommerce-product-price .price ins .amount') or primary.select('.elementor-widget-woocommerce-product-price .price .amount')
        if not prices:
            raise SkipListing('No advertised product price')
        if len(prices) != 1 or not clean(prices[0].get_text()).startswith('R'):
            raise ValueError('Ambiguous current product price')
        amount = re.sub(r'[^\d.]', '', prices[0].get_text())
        images = [a['href'] for a in primary.select('.woocommerce-product-gallery__image > a[href]')]
        condition = ''  # Mixed new/demo stock: never infer condition from the shop name.
    else:
        if len(products) != 1:
            raise ValueError('Unique primary Product schema required')
        product = products[0]
        if not title or name_tokens(product.get('name'))[:len(name_tokens(title))] != name_tokens(title):
            raise ValueError('Product name does not match the primary heading')
        variants = product.get('hasVariant') or [product]
        offers = []
        images = []
        for variant in variants:
            offer_list = variant.get('offers') or []
            for offer in offer_list if isinstance(offer_list, list) else [offer_list]:
                offer = resolve(offer)
                offer_url = offer.get('url')
                if source_id == 'gadgetcraze_kampala':
                    offer_url = offer_url or variant.get('url')
                if (source_id == 'gadgetcraze_kampala' and not offer_url) or key(urljoin(url, offer_url or '')) != key(url):
                    raise ValueError('Offer belongs to a different item')
                if offer.get('priceCurrency') != source['currency']:
                    raise ValueError('Unexpected currency')
                if str(offer.get('availability', '')).rsplit('/', 1)[-1] in {'InStock', 'LimitedAvailability'}:
                    offers.append(offer)
                    gallery = variant.get('image') or product.get('image') or []
                    images.extend(gallery if isinstance(gallery, list) else [gallery])
        if not offers:
            raise SkipListing('No available product offers')
        amounts = {str(o.get('price', '')) for o in offers}
        if len(amounts) != 1:
            if source_id == 'gadgetcraze_kampala':
                raise SkipListing('Variants have different advertised prices')
            raise ValueError('Variants have different prices; no exact single price')
        amount = amounts.pop()
        condition = str(offers[0].get('itemCondition', '')).rsplit('/', 1)[-1]
        condition = {'NewCondition': 'new', 'UsedCondition': 'used', 'RefurbishedCondition': 'refurbished'}.get(condition, '')
        images = [resolve(i).get('contentUrl') or resolve(i).get('url') if isinstance(i, dict) else i for i in images]
    if not title or not re.fullmatch(r'\d+(?:\.\d+)?', amount) or float(amount) <= 0:
        raise ValueError('Exact positive current price required')
    posted = next((e.get('datePublished', '') for e in entities if types(e) & {'WebPage', 'ItemPage'}
                   and key(urljoin(url, e.get('url') or e.get('@id') or '')) == key(url)), '')
    category, subcategory = product_category(title)
    if source_id == 'netcart_kampala':
        stock = soup.select_one('.nc-pdp__stock--ok')
        if not stock or not clean(stock.get_text(' ', strip=True)).casefold().startswith('in stock'):
            raise SkipListing('Exact product is not stocked locally')
    if source_id == 'gadgetcraze_kampala':
        breadcrumb_urls = [item.get('item', '') for e in entities if 'BreadcrumbList' in types(e)
                           for item in e.get('itemListElement', []) if isinstance(item.get('item'), str)]
        if any('/shop/category/phones-' in link for link in breadcrumb_urls):
            category, subcategory = 'electronics', 'phones_accessories'
        elif re.search(r'\b(?:macbook|laptop|ideapad|thinkpad|vivobook|elitebook|probook)\b', title, re.I):
            category, subcategory = 'electronics', 'computers_tablets'
        else:
            raise SkipListing('Product is outside the Kampala phone and laptop categories')
    if source_id == 'netcart_kampala':
        product_type = ' '.join(name_tokens(product.get('category')))
        if re.search(r'\b(?:phone|phones|smartphone|smartphones)\b', product_type):
            category, subcategory = 'electronics', 'phones_accessories'
        elif re.search(r'\b(?:laptop|laptops)\b', product_type):
            category, subcategory = 'electronics', 'computers_tablets'
        else:
            raise SkipListing('Product is outside the Kampala phone and laptop categories')
    attrs = {'condition': condition} if condition else {}
    return make_row(source, url, title, images, checked, posted, category, subcategory, amount,
                    f"{source['currency']} {float(amount):,.2f}", attrs)



def parse_property(source_id, body, url, checked):
    source = SOURCES[source_id]
    soup, entities, resolve = page(body, url)
    heading = soup.select_one('h1')
    title = clean(heading.get_text(' ', strip=True)) if heading else ''
    products = [e for e in entities if 'Product' in types(e) and e.get('category') == 'Real Estate'
                and title and name_tokens(e.get('name')) == name_tokens(title)]
    if not products:
        raise SkipListing('No exact property schema')
    if len(products) != 1:
        raise ValueError('Ambiguous property schema')
    product = products[0]
    offer = resolve(product.get('offers'))
    if key(offer.get('url', '')) != key(url) or (offer.get('seller') or {}).get('name') != source['name']:
        raise ValueError('Offer does not match the property and agency')
    if str(offer.get('availability', '')).rsplit('/', 1)[-1] != 'InStock':
        raise SkipListing('Property is not marked available')
    rent = source['transaction'] == 'rent'
    breadcrumb_urls = {key(item.get('item', '')) for e in entities if 'BreadcrumbList' in types(e)
                       for item in e.get('itemListElement', []) if isinstance(item.get('item'), str)}
    if key(source['catalogs'][0]) not in breadcrumb_urls or not re.search(r'\bfor ' + source['transaction'] + r'\b', title, re.I):
        raise SkipListing('Property transaction could not be confirmed')
    property_type = ('apartment' if re.search(r'\b(?:apartments?|penthouse|condo)\b', title, re.I)
                     else 'house' if re.search(r'\b(?:house|townhouse|villa|bungalow|mansion)\b', title, re.I) else '')
    if not property_type:
        raise SkipListing('Only residential apartments and houses are included')
    overview = soup.select_one('.semantic-description')
    details = clean(overview.get_text(' ', strip=True)) if overview else ''
    if not re.search(r'\bKampala\b', f'{title} {details}', re.I):
        raise SkipListing('Property location does not explicitly identify Kampala')
    price = soup.select_one('#mainPriceDisplay')
    shown = re.fullmatch(r'(\$|UGX\s*)([\d,]+(?:\.\d+)?)', clean(price.get_text(' ', strip=True))) if price else None
    amount = shown[2].replace(',', '') if shown else ''
    currency = 'USD' if shown and shown[1] == '$' else 'UGX'
    if not amount or offer.get('priceCurrency') != currency or float(amount) <= 0 or float(amount) != float(offer.get('price') or 0):
        raise ValueError('Property does not have a matching advertised price')
    if rent and not re.search(r'(?:/\s*(?:mo(?:nth)?|pcm)\b|\bper month\b|\bmonthly\b)', f"{title} {product.get('description', '')} {details}", re.I):
        raise SkipListing('Rental period is unconfirmed')
    images = [urljoin(url, a['href']) for a in soup.select('.gallery-container .swiper-main a[data-fancybox="property-gallery"][href]')
              if urlsplit(urljoin(url, a['href'])).netloc == urlsplit(url).netloc
              and urlsplit(urljoin(url, a['href'])).path.startswith('/uploads/properties/')]
    if product.get('image') not in images:
        raise SkipListing('Property cover does not match the source gallery')
    attrs = {'propertyType': property_type, 'priceTerm': 'per_month' if rent else 'total'}
    for icon, field in (('fa-bed', 'bedrooms'), ('fa-bath', 'bathrooms'), ('fa-vector-square', 'area')):
        node = soup.select_one(f'li .{icon}')
        value = re.match(r'^([1-9]\d*)\b', node.parent.get_text(' ', strip=True)) if node else None
        if value:
            attrs[field] = int(value[1])
    price_text = f'{currency} {float(amount):,.0f}' + (' / month' if rent else '')
    row = make_row({**source, 'currency': currency}, url, title, images, checked, '', 'real_estate',
                   'for_rent_long' if rent else 'for_sale', amount, price_text, attrs)
    row['description'] = f"{title}. Listed by {source['name']} in Kampala. Advertised price: {price_text}. See the source for property details and viewings."
    return row

def parse_job(source_id, body, url, checked):
    source = SOURCES[source_id]
    soup, entities, resolve = page(body, url)
    jobs = [e for e in entities if 'JobPosting' in types(e)
            and (not (e.get('url') or e.get('@id')) or key(urljoin(url, e.get('url') or e['@id'])) == key(url))]
    if len(jobs) != 1:
        raise ValueError('One exact JobPosting required')
    job = jobs[0]
    title = clean(job.get('title'))
    # Some recruiters render the role in the document title rather than an H1.
    heading = clean(' '.join(n.get_text(' ', strip=True) for n in soup.select('h1,title')))
    if not title or title.casefold() not in heading.casefold():
        raise ValueError('Job identity not confirmed')
    closes = str(job.get('validThrough') or '')
    expires = availability.job_expiry(closes)
    if not expires:
        raise ValueError('Explicit job closing date required')
    if expires <= datetime.fromisoformat(checked.replace('Z', '+00:00')):
        raise SkipListing('Vacancy has closed')
    locations = job.get('jobLocation') or []
    locations = locations if isinstance(locations, list) else [locations]
    addresses = [l.get('address', {}) for l in locations if isinstance(l, dict)]
    if source_id == 'taylored':
        # Their JSON-LD currently contains CMS field IDs instead of the address.
        # Read the labelled location from this role's overview, never the office footer.
        location = next((n.find_next_sibling('dd') for n in soup.select('.taylored-job-single__facts dt')
                         if clean(n.get_text()) == 'Location'), None)
        local = clean(location.get_text()) if location else ''
        if local.endswith(', ZA'):
            addresses = [{'addressCountry': 'ZA', 'addressLocality': local}]
    addresses = [a for a in addresses if isinstance(a, dict) and a.get('addressCountry') == source['country_code']
                 and source['city'].casefold() in clean(a.get('addressLocality')).casefold()]
    if not addresses:
        raise SkipListing('Job is outside the configured city')
    organization = resolve(job.get('hiringOrganization'))
    if clean(organization.get('name')).casefold() != source['name'].casefold():
        raise ValueError('Recruiter identity does not match the public contact')
    logo = organization.get('logo')
    logo = resolve(logo).get('url') if isinstance(logo, dict) else logo
    salary = job.get('baseSalary') or {}
    value = salary.get('value') or {}
    unit = str(value.get('unitText', '')).lower() if isinstance(value, dict) else ''
    amount, pay_text, attrs = '', 'Pay not specified', {}
    if salary and isinstance(value, dict) and unit in {'hour', 'day', 'week', 'month', 'year'}:
        low, high = value.get('minValue', value.get('value')), value.get('maxValue', value.get('value'))
        if salary.get('currency') != source['currency']:
            raise ValueError('Unexpected salary currency')
        if low is not None and high is not None and 0 < float(low) <= float(high):
            amount = str(low)
            pay_text = f"{source['currency']} {float(low):,.2f}" + (f"–{float(high):,.2f}" if high != low else '') + f'/{unit}'
            attrs.update(payMin=float(low), payMax=float(high), payUnit=unit)
    employment = job.get('employmentType') or ''
    employment = employment[0] if isinstance(employment, list) and employment else employment
    employment = {'FULL_TIME': 'full_time', 'PART_TIME': 'part_time', 'CONTRACTOR': 'contract',
                  'TEMPORARY': 'temporary', 'INTERN': 'internship'}.get(str(employment), '')
    local = clean(addresses[0].get('addressLocality'))
    attrs.update(employmentType=employment, experienceLevel='', jobStatus='Open role', jobPayText=pay_text,
                 validThrough=closes, applicationUrl=url,
                 sourceSpecifications=[{'label': 'Work location', 'value': local}, {'label': 'Pay', 'value': pay_text},
                                       {'label': 'Applications close', 'value': closes[:10]}])
    category = 'childcare_education' if source_id == 'tradewind' else 'business_office'
    row = make_row(source, url, title, [logo], checked, job.get('datePosted', ''), 'jobs', category, amount, pay_text, attrs)
    row['description'] = (f"{title}. Recruitment managed by {source['name']}. Work location: {local}. "
                          f"{pay_text}. Applications close {closes[:10]}. "
                          'See the original vacancy for qualifications, responsibilities and the application form.')
    return row


def make_row(source, url, title, images, checked, posted, category, subcategory, amount, price_text, attrs):
    images = list(dict.fromkeys(urljoin(url, i) for i in images if isinstance(i, str) and i
                               and not re.search(r'placeholder|no.image|unsplash', i, re.I)))[:4]
    if not images:
        raise SkipListing('Source-owned product photos or recruiter logo missing')
    attrs.update(parser='category_sources_v1', sourceKind={'jobs': 'recruiter', 'real_estate': 'agency'}.get(category, 'retailer'),
                 contactSourceUrl=source['contact'], sourcePostedAt=posted, imageSourceUrl=url, imageVerifiedAt=checked,
                 detailsSourceUrl=url, detailsVerifiedAt=checked,
                 listingIdentity=dict(sourceUrl=url, title=title, images=images, phones=[source['phone']], city=source['city'], checkedAt=checked))
    return dict(id='category-' + hashlib.sha256(url.encode()).hexdigest()[:18], status='published',
                target_surface='marketplace', app_category=category, app_subcategory=subcategory, title=title,
                description=f"{title}. Listed by {source['name']} in {source['city']}. Current advertised price: {price_text}. See the source for full specifications and ordering details.",
                city=source['city'], country=source['country'], seller=source['name'], phone=source['phone'],
                source_site=source['name'], source_url=url, image_urls='|'.join(images), scraped_at=posted or checked,
                price_value=amount, currency=source['currency'], price_text=price_text, source_availability='active',
                source_availability_checked_at=checked, source_last_seen_at=checked, source_http_status='200',
                source_resolved_url=url, sync_visibility='visible', source_unavailable_reason='', attributes=json.dumps(attrs, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sources', default=','.join(SOURCES))
    parser.add_argument('--kind', choices=['product', 'job', 'property'])
    parser.add_argument('--limit-per-source', type=int, default=40)
    parser.add_argument('--candidate-limit', type=int, default=100)
    parser.add_argument('--cache-dir', type=Path)
    parser.add_argument('--report', type=Path, default=Path('output/category-listing-refresh-report.json'))
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    checked = datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')
    existing = {key(availability.source_url(r)) for p in availability.FEEDS for r in csv.DictReader((ROOT / p).open())}
    existing.update(json.loads((ROOT / 'data/listing-availability.json').read_text()).get('listings', {}))
    if args.cache_dir:
        args.cache_dir.mkdir(parents=True, exist_ok=True)
    request_lock, paused_hosts, last_request = threading.Lock(), set(), {}
    def fetch(url):
        host = urlsplit(url).netloc
        with request_lock:
            if host in paused_hosts:
                raise ValueError('Source rate limited; deferred until the next scheduled attempt')
            time.sleep(max(0, 1.0 - (time.monotonic() - last_request.get(host, 0))))
            last_request[host] = time.monotonic()
        response = requests.get(url, timeout=25, headers={'User-Agent': availability.USER_AGENT})
        if response.status_code == 429:
            with request_lock:
                paused_hosts.add(host)
        response.raise_for_status()
        if key(response.url) != key(url):
            raise ValueError('Redirect away from requested source')
        if args.cache_dir:
            (args.cache_dir / (hashlib.sha256(url.encode()).hexdigest() + '.html')).write_text(response.text)
        return response.text
    incoming, reports, failures = [], {}, []
    for name in args.sources.split(','):
        source = SOURCES[name]
        if args.kind and args.kind != source['kind']:
            continue
        report = reports[name] = {'discovered': 0, 'candidates': 0, 'new': 0, 'skipped': {}, 'errors': 0}
        try:
            contact_body = fetch(source['contact'])
            contact(source, contact_body)
            links = []
            pattern = {'job': r'^/jobs?/[^/]+/?$', 'product': r'^/products?/[^/]+/?$',
                       'property': r'^/property/[^/]+/?$'}[source['kind']]
            for catalog in source['catalogs']:
                body = contact_body if catalog == source['contact'] else fetch(catalog)
                soup = BeautifulSoup(body, 'html.parser')
                anchors = soup.select('a[href]')
                if name == 'netcart_kampala':
                    anchors = [a for card in soup.select('.nc-card:has(.nc-card__stock--ok)')
                               for a in card.select('a.nc-card__name[href]')]
                links.extend(urljoin(catalog, a['href']).split('?')[0].split('#')[0] for a in anchors
                             if urlsplit(urljoin(catalog, a['href'])).netloc == urlsplit(catalog).netloc
                             and re.fullmatch(source.get('pattern', pattern), urlsplit(a['href']).path))
            links = list(dict.fromkeys(links))
            report['discovered'] = len(links)
            if not links:
                raise ValueError('No source listing links found')
            candidates = [u for u in links if key(u) not in existing][:min(args.candidate_limit, source.get('candidates', args.candidate_limit))]
            report['candidates'] = len(candidates)
            parse = {'job': parse_job, 'product': parse_product, 'property': parse_property}[source['kind']]
            def load(url):
                try:
                    body = fetch(url)
                    row = parse(name, body, url, checked)
                    state, reason = availability.classify(row, 200, body, url)
                    if state in availability.UNAVAILABLE:
                        raise SkipListing(reason)
                    if state != 'active':
                        raise ValueError(reason)
                    working = []
                    for image in row['image_urls'].split('|'):
                        try:
                            with requests.get(image, stream=True, timeout=15) as response:
                                if refresh.image_response_is_usable(response):
                                    working.append(image)
                        except requests.RequestException:
                            continue
                    if not working:
                        raise ValueError('No responding source photos/logo')
                    row['image_urls'] = '|'.join(working)
                    attrs = json.loads(row['attributes']); attrs['listingIdentity']['images'] = working
                    row['attributes'] = json.dumps(attrs, ensure_ascii=False)
                    return row, '', ''
                except SkipListing as error:
                    return None, str(error), ''
                except (requests.RequestException, ValueError, TypeError, KeyError) as error:
                    return None, '', str(error)[:240]
            with ThreadPoolExecutor(max_workers=2) as pool:
                results = list(pool.map(load, candidates))
            report['skipped'] = dict(Counter(skip for _, skip, _ in results if skip))
            for url, (_, _, error) in zip(candidates, results):
                if error:
                    failures.append({'source': name, 'url': url, 'reason': error})
                    report['errors'] += 1
            found = [row for row, _, _ in results if row][:args.limit_per_source]
            incoming.extend(found)
            existing.update(key(r['source_url']) for r in found)
            report['new'] = len(found)
            report['categories'] = dict(Counter(r['app_subcategory'] if r['app_category'] == 'other' else r['app_category'] for r in found))
        except (requests.RequestException, ValueError) as error:
            failures.append({'source': name, 'reason': str(error)[:240]})
            report['errors'] += 1
        print(f'{name}: {report}', flush=True)
    merged = refresh.merge(ROOT / 'data/scraped-listings.csv', incoming, new_only=True) if incoming and not args.dry_run else {}
    report = {'checkedAt': checked, 'sources': reports, 'merged': merged, 'failures': failures}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + '\n')
    if any(r['errors'] for r in reports.values()):
        raise SystemExit('Some category sources need a retry; existing content is unchanged')


if __name__ == '__main__':
    main()
