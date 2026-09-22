#!/usr/bin/env python3
"""Import public Dubai retail stock and apartment rentals with source phones/photos."""
import argparse
import csv
import hashlib
import html
import json
import re
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin

from dubai_phone_listings_scrape import Page, fetch
from opensooq_dubai_scrape import CSV_FIELDS, normalize_uae_phone

HGC = 'https://shop.hgctechdxb.com/'
STOCK = 'https://hgc-order-manager.onrender.com/api/public/catalogue'
APPLIANCES = 'https://usedappliancesuae.com/shop/'
RENTALS = 'https://www.allsoppandallsopp.com/dubai/properties/residential/lettings'

def entities(source):
    return [item for schema in Page(source).schemas for item in schema.get('@graph', [schema])]

def next_data(source):
    match = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', source, re.S)
    if not match: raise ValueError('Missing public property data')
    return json.loads(match[1])['props']['pageProps']['data']['data']

def first(fields, key, default=''):
    return (fields.get(key) or [default])[0]

def base_row(ident, title, price, category, subcategory, seller, phone, url, images, checked, attrs=None):
    phone = normalize_uae_phone(phone)
    if not phone: raise ValueError('Missing complete public UAE phone')
    if not images or not all(i.startswith('https://') for i in images): raise ValueError('Missing source images')
    if float(price) <= 0: raise ValueError('Missing price')
    attributes = dict(attrs or {})
    attributes.update(contactSource=url, phoneVerifiedAt=checked, imageSourceUrl=url,
                      imageVerifiedAt=checked, imageIntegrityVersion='2026-09-16.1')
    row = dict.fromkeys(CSV_FIELDS, '')
    row.update(id=ident, status='published', target_surface='marketplace', app_category=category,
               app_subcategory=subcategory, title=title, price_text=f'AED {float(price):,.0f}',
               price_value=str(price), currency='AED', city='Dubai', country='United Arab Emirates',
               seller=seller, phone=phone, image_urls='|'.join(dict.fromkeys(images)), source_url=url,
               scraped_at=checked, attributes=json.dumps(attributes, separators=(',', ':')),
               source_availability='active', source_availability_checked_at=checked,
               source_http_status='200', source_last_seen_at=checked, source_resolved_url=url,
               source_miss_count='0', sync_visibility='visible')
    return row

def electronics_row(item, shop, checked):
    if 'Al Raffa' not in shop or 'Bur Dubai' not in shop: raise ValueError('Store location mismatch')
    phone = next((h[4:] for h in Page(shop).links if h.startswith('tel:') and normalize_uae_phone(h[4:])), '')
    if item.get('qty', 0) <= 0: raise ValueError('Out of stock')
    # Configurable products have a different displayed starting price; skip rather than guess a variant.
    if any(item.get(k) for k in ('variants', 'ramOptions', 'storageOptions')): raise ValueError('Configurable stock')
    code = item['code']
    price = item['priceRetail']
    if item.get('dealOfDay') and 0 < (item.get('dealPrice') or 0) < price: price = item['dealPrice']
    if item.get('category') not in ('Laptop', 'Desktop', 'Monitor', 'MacBook'): raise ValueError('Unsupported electronics category')
    row = base_row('hgc-dubai-' + hashlib.sha256(code.encode()).hexdigest()[:16], code, price,
                   'electronics', 'computers_tablets', 'HGC Technologies LLC', phone, HGC,
                   [item.get('imageUrl', '')], checked,
                   {'parser':'hgc_public_catalogue', 'catalogItemId':code, 'stockSourceUrl':STOCK,
                    'sourceCategory':item['category'], 'stockQuantity':item['qty']})
    row.update(source_site='HGC Technologies', condition=item.get('condition') or '',
               description=f"{item['description'].strip()}. Condition: {item.get('condition', 'ask seller')}. "
                           f"Stock code: {code}. Seller: HGC Technologies LLC, Al Raffa Street, Bur Dubai. "
                           'Price and stock from the public retail catalogue; contact the store for availability.')
    return row

def appliance_row(source, url, checked):
    # Visual review: this older offer reuses the pre-owned offer's exact cooker photo
    # but quotes a conflicting price. Keep the explicit pre-owned offer only.
    if url == 'https://usedappliancesuae.com/product/bosch-series-8-full-gas-cooker/':
        raise ValueError('Duplicate cooker offer; use the explicit pre-owned product page')
    product = next((p for p in entities(source) if p.get('@type') == 'Product' and p.get('offers', {}).get('url') == url), None)
    if not product: raise ValueError('No exact product schema')
    offer = product['offers']
    if not offer.get('availability', '').endswith('/InStock') or offer.get('priceCurrency') != 'AED': raise ValueError('Not available in AED')
    if offer.get('seller', {}).get('name') != 'Used Appliances UAE': raise ValueError('Seller mismatch')
    phone = next((h[4:] for h in Page(source).links if h.startswith('tel:') and normalize_uae_phone(h[4:])), '')
    title = html.unescape(product['name']).removesuffix(' - Used Appliances UAE').strip(' |')
    if not re.search(r'cooker|washer|dryer|dishwasher|refrigerator|washing|freezer', title, re.I): raise ValueError('Not a home appliance')
    images = [i.get('url', '') if isinstance(i, dict) else i for i in product.get('image', [])]
    images += re.findall(r'data-large_image="([^"]+)"', source)
    row = base_row('uae-appliance-' + url.rstrip('/').rsplit('/', 1)[1], title, offer['price'],
                   'other', 'appliances', 'Al Makkai Used Home Appliances Trader LLC', phone,
                   url, images[:4], checked, {'parser':'uae_appliance_product_schema', 'sourceCategory':'home appliances'})
    panel = re.search(r'id="tab-description"[^>]*>(.*?)</div>', source, re.S)
    panel = panel[1] if panel else ''
    plain = lambda s: re.sub(r'\s+', ' ', html.unescape(re.sub('<[^>]+>', ' ', s))).strip()
    specifications = []
    for tr in re.findall(r'<tr\b[^>]*>(.*?)</tr>', panel, re.S):
        cells = [plain(c) for c in re.findall(r'<t[dh]\b[^>]*>(.*?)</t[dh]>', tr, re.S)]
        if len(cells) >= 2 and cells[0].lower() not in ('feature', 'specification', 'specifications'):
            specifications.append({'label':cells[0], 'value':' / '.join(cells[1:])})
    specifications = specifications[:8]
    attributes = json.loads(row['attributes'])
    attributes['sourceSpecifications'] = specifications
    row['attributes'] = json.dumps(attributes, separators=(',', ':'))
    details = ' '.join(s['label']+': '+s['value']+'.' for s in specifications)
    # Ignore generic NewCondition schema when the visible description establishes pre-owned stock.
    condition = 'used' if re.search(r'\bpre.?owned\b|\bused\b', title+' '+plain(panel), re.I) else 'Ask seller'
    row.update(source_site='Used Appliances UAE', condition=condition,
               description=f'{title}. {details} Listed by Al Makkai Used Home Appliances Trader LLC, Baniyas Road, Naif, Dubai. '
                           f"Advertised price: {row['price_text']}. Call the seller to confirm condition, dimensions, delivery and current availability.")
    return row

def rental_row(source, url, checked):
    fields = next_data(source)['listingDetails']['hits']['hits'][0]['fields']
    get = lambda key, default='': first(fields, key, default)
    ident = get('pba__broker_s_listing_id__c')
    if not url.endswith('/'+ident): raise ValueError('Property ID mismatch')
    if get('property_type_website__c') != 'Apartment' or get('pba__listingtype__c') != 'Rent': raise ValueError('Not an apartment rental')
    if get('pba__status__c') != 'To Let - Live' or get('isdeleted', False) or get('pba_archived__c', False): raise ValueError('Rental unavailable')
    if get('pba__city_pb__c') != 'Dubai' or not re.search(r'Per Annum', source, re.I): raise ValueError('Missing Dubai/yearly rental evidence')
    product = next((p for p in entities(source) if p.get('@type') == 'Product' and p.get('url') == url), None)
    if not product: raise ValueError('Missing matching rental schema')
    offer = product['offers']
    if offer.get('priceCurrency') != 'AED' or float(offer['price']) != float(get('pba__listingprice_pb__c')): raise ValueError('Rental price mismatch')
    image = product['image']
    if isinstance(image, list): image = image[0]
    if isinstance(image, dict): image = image['url']
    main = get('pba__main_website_image__c')
    if not image.endswith(main) or get('pba__property__c') not in image: raise ValueError('Gallery property mismatch')
    images = [image] + [image[:-len(main)] + f for f in fields.get('images', [])[:4]]
    beds, baths, sqft = get('pba__bedrooms_pb__c'), get('pba__fullbathrooms_pb__c'), get('pba__totalarea_pb__c')
    area = get('listing_area').strip(' ,.')
    desc = get('pba__description_pb__c')
    furnished = bool(re.search(r'\bfurnished\b', desc, re.I)) and not bool(re.search(r'\bunfurnished\b', desc, re.I))
    amenities = [name for pattern, name in [(r'\bbalcony\b', 'Balcony'), (r'\bpool\b', 'Pool'), (r'\bgym\b', 'Gym'), (r'\bparking\b', 'Parking')] if re.search(pattern, desc, re.I)]
    attrs = {'parser':'allsopp_public_rental', 'sourceCategory':'apartments for rent', 'propertyType':'apartment',
             'bedrooms':beds, 'bathrooms':baths, 'sqft':sqft, 'priceTerm':'per_year', 'furnished':furnished,
             'parking':'Parking' in amenities, 'amenities':', '.join(amenities), 'address':get('pba__address_pb__c'),
             'neighborhood':area, 'agentName':get('listing_agent_name')}
    title = f"{'Studio' if beds == 0 else str(beds)+'-bedroom'} apartment for rent — {area}"
    row = base_row('allsopp-dubai-'+ident.lower(), title, offer['price'], 'real_estate', 'for_rent_long',
                   'Allsopp & Allsopp — '+get('listing_agent_name'), get('listing_agent_mobile'), url,
                   images[:4], checked, attrs)
    row['price_text'] += '/year'
    furnishing = 'Unfurnished. ' if re.search(r'\bunfurnished\b', desc, re.I) else ('Furnished. ' if furnished else '')
    row.update(source_site='Allsopp & Allsopp', condition='Ask agent',
               description=f"{title}. {baths} bathroom(s), {sqft:,.2f} sq ft. {furnishing}"
                           f"{', '.join(amenities)}. Annual rent: {row['price_text']}. "
                           f"Property reference: {ident}. Contact {get('listing_agent_name')} at Allsopp & Allsopp for a viewing and rental terms.")
    return row

def working_images(row):
    images = []
    for url in row['image_urls'].split('|'):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, method='HEAD'), timeout=20) as r:
                if r.status == 200 and r.headers.get('Content-Type', '').startswith('image/'): images.append(url)
        except OSError: pass
    if not images: raise ValueError('No working source images')
    row['image_urls'] = '|'.join(images)
    return row

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, default=Path('data/dubai-listings.csv'))
    parser.add_argument('--audit-dir', type=Path, required=True)
    parser.add_argument('--limit', type=int, default=12, help='Maximum per category')
    args = parser.parse_args()
    if args.limit < 1: parser.error('limit must be positive')
    args.audit_dir.mkdir(parents=True, exist_ok=True)
    checked = datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')
    def download(url, name):
        source = fetch(url)
        (args.audit_dir/name).write_text(source)
        return source
    shop = download(HGC, 'electronics-shop.html')
    stock = json.loads(download(STOCK, 'electronics-stock.json'))
    appliances = download(APPLIANCES, 'appliances-shop.html')
    rentals = download(RENTALS, 'rental-inventory.html')
    tasks = []
    for item in stock['items']:
        try: row = electronics_row(item, shop, checked)
        except (ValueError, KeyError, TypeError): continue
        tasks.append(('electronics', row))
        if len(tasks) >= args.limit: break
    urls = list(dict.fromkeys(urljoin(APPLIANCES, h) for h in Page(appliances).links if '/product/' in h))
    urls = [u for u in urls if re.search('cooker|washer|dryer|dishwasher|refrigerator|washing|freezer', u)]
    tasks += [('appliances', u) for u in urls[:args.limit]]
    apartments = [h['fields'] for h in next_data(rentals)['hits'] if first(h['fields'], 'property_type_website__c') == 'Apartment']
    tasks += [('apartments', 'https://www.allsoppandallsopp.com/dubai/property/lettings/'+first(f, 'pba__broker_s_listing_id__c')) for f in apartments[:args.limit]]
    def load(task):
        category, value = task
        try:
            if category == 'electronics': row = value
            else:
                source = download(value, category+'-'+value.rstrip('/').rsplit('/', 1)[1]+'.html')
                row = (appliance_row if category == 'appliances' else rental_row)(source, value, checked)
            return working_images(row), None
        except (OSError, ValueError, KeyError, TypeError) as error:
            return None, {'source':value if isinstance(value, str) else value['id'], 'reason':str(error)}
    with ThreadPoolExecutor(max_workers=3) as pool: results = list(pool.map(load, tasks))
    rows = [row for row, error in results if row]
    report = {'checkedAt':checked, 'imported':len(rows), 'categories':dict(Counter(r['app_category']+'/'+r['app_subcategory'] for r in rows)),
              'ids':[r['id'] for r in rows], 'skipped':[error for row, error in results if error]}
    (args.audit_dir/'report.json').write_text(json.dumps(report, indent=2))
    if not rows: raise RuntimeError('No verified listings; feed unchanged')
    existing = list(csv.DictReader(args.output.open())) if args.output.exists() else []
    merged = {r['id']:r for r in existing}
    merged.update({r['id']:r for r in rows})
    headers = list(dict.fromkeys([*CSV_FIELDS, *(k for r in existing for k in r)]))
    tmp = args.output.with_suffix('.tmp')
    with tmp.open('w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=headers, lineterminator='\n')
        writer.writeheader(); writer.writerows(merged.values())
    tmp.replace(args.output)
    print(json.dumps(report))

if __name__ == '__main__': main()
