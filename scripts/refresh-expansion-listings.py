#!/usr/bin/env python3
"""Add verified new dealer listings in Lagos, Johannesburg, London and Kampala."""
import argparse
import csv
import hashlib
import importlib.util
import json
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('refresh', ROOT / 'scripts/refresh-marketplace-listings.py')
refresh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(refresh)
availability = refresh.availability
key, clean = availability.source_key, refresh.clean
SOURCES = {
    'lagos': dict(name='Korrect Cars', country='Nigeria', city='Lagos', currency='NGN', code='234', digits=10,
                  catalog='https://www.korrectcars.com/cars', pattern=r'^/cars/(?:19|20)\d{2}-[^/]+/?$'),
    'johannesburg': dict(name='SearchMyRide', country='South Africa', city='Johannesburg', currency='ZAR', code='27', digits=9,
                         catalog='https://searchmyride.co.za/dealer/pre-owned-cars-573/', pattern=r'^/cars/[^/]+/?$'),
    'london': dict(name='Maslen Motors', country='United Kingdom', city='London', currency='GBP', code='44', digits=10,
                   catalog='https://maslenmotors.com/used-cars/', pattern=r'^/vehicle/name/[^/]+/?$'),
    'kampala_ml': dict(name='ML Motors', country='Uganda', city='Kampala', currency='UGX', code='256', digits=9,
                       catalog='https://www.mandelmotors.com/cars?condition=used', pattern=r'^/cars/[^/]+/?$'),
    'kampala_sublime': dict(name='Sublime Motors', country='Uganda', city='Kampala', currency='UGX', code='256', digits=9,
                            catalog='https://sublimemotorcars.com/stock/', pattern=r'^/vehicle/[^/]+/?$'),
}


def phone(value, source):
    digits = re.sub(r'\D', '', str(value or ''))
    if digits.startswith('0'):
        digits = source['code'] + digits[1:]
    return '+' + digits if re.fullmatch(source['code'] + r'\d{' + str(source['digits']) + '}', digits) else ''


def parse_listing(source_id, body, url, checked, catalog_body=''):
    source = SOURCES[source_id]
    soup = BeautifulSoup(body, 'html.parser')
    canonical = soup.select_one('link[rel="canonical"]')
    if not canonical or key(urljoin(url, canonical.get('href', ''))) != key(url):
        raise ValueError('Exact canonical listing required')
    for node in reversed(soup.select('[class*="related"], [class*="recommend"], [class*="similar"], .featured-vehicles')):
        node.decompose()
    heading = soup.select_one('.vd-header' if source_id == 'london' else 'h1')
    title = clean(heading.get_text(' ', strip=True)) if heading else ''
    if not title or re.search(r'\bsold\b|reserved|deposit taken|not found|access denied', title, re.I):
        raise ValueError('No active primary listing title')
    entities = []
    for script in soup.select('script[type="application/ld+json"]'):
        try:
            entities.extend(availability.entities(json.loads(script.get_text())))
        except (ValueError, TypeError):
            pass
    by_id = {e['@id']: e for e in entities if e.get('@id')}
    def resolve(value):
        return by_id.get(value.get('@id'), value) if isinstance(value, dict) else {}
    def kinds(entity):
        value = entity.get('@type', [])
        return set(value if isinstance(value, list) else [value])
    if source_id == 'kampala_sublime':
        year = soup.select_one('.veh-info .veh-year')
        year = re.match(r'^(?:19|20)\d{2}\b', year.get_text(strip=True)) if year else None
        if not year or not title:
            raise ValueError('Missing exact model and year')
        title = f'{year[0]} {title}'
    cars = [e for e in entities if kinds(e) & {'Car', 'Vehicle', 'Product'}
            and clean(e.get('name')).casefold() == title.casefold()
            and (not (e.get('url') or e.get('@id')) or key(e.get('url') or e['@id']) == key(url))]
    facts, posted = {}, ''
    if source_id == 'london':
        price_node = soup.select_one('#vehicle-details .vd-price')
        price = clean(price_node.get_text()) if price_node else ''
        if not re.fullmatch(r'£[\d,]+(?:\.\d{2})?', price):
            raise ValueError('No unambiguous full vehicle price')
        amount = price.replace('£', '').replace(',', '')
        images = [urljoin(url, n['href']) for n in soup.select('.vd-image a.zoom-photo[href]')]
        seller = source['name']
        phones = [phone(n['href'][4:], source) for n in soup.select('#vehicle-details a[href^="tel:"]')]
        for item in soup.select('.vd-details li'):
            label, value = item.select_one('.vd-detail-name'), item.select_one('.vd-detail-value')
            if label and value:
                facts[clean(label.get_text())] = clean(value.get_text())
        if '876 Lea Bridge Road' not in soup.get_text(' ', strip=True) or 'London' not in soup.get_text(' ', strip=True):
            raise ValueError('Dealer location no longer matches London')
        webpage = next((e for e in entities if 'WebPage' in kinds(e) and key(e.get('url', '')) == key(url)), {})
        posted = webpage.get('datePublished', '')
    else:
        if len(cars) != 1:
            raise ValueError('Unique matching vehicle schema required')
        car = cars[0]
        offer = resolve(car.get('offers'))
        if key(offer.get('url', '')) != key(url) or offer.get('priceCurrency') != source['currency']:
            raise ValueError('Offer does not belong to this vehicle/currency')
        if str(offer.get('availability', '')).rsplit('/', 1)[-1] not in {'InStock', 'LimitedAvailability'}:
            raise ValueError('Vehicle is not explicitly available')
        amount = str(offer.get('price', ''))
        images = car.get('image') or []
        images = images if isinstance(images, list) else [images]
        images = [resolve(i).get('contentUrl') or resolve(i).get('url') if isinstance(i, dict) else i for i in images]
        dealer = resolve(offer.get('seller'))
        seller = source['name'] if source_id == 'lagos' else clean(dealer.get('name'))
        if source['country'] == 'Uganda':
            if str(car.get('itemCondition', '')).rsplit('/', 1)[-1] != 'UsedCondition':
                raise ValueError('Only dealer-confirmed used cars are eligible')
            seller = source['name']
            if source_id == 'kampala_ml':
                business = next((e for e in entities if 'AutomotiveBusiness' in kinds(e)
                                 and e.get('name') == seller
                                 and key(e.get('url', '')) == key(urljoin(source['catalog'], '/'))), {})
                address = business.get('address') or {}
                contact = phone(business.get('telephone'), source)
                public_contacts = {phone(a['href'][4:], source) for a in soup.select('a[href^="tel:"]')}
                if (dealer.get('name') != seller or address.get('addressCountry') != 'UG'
                        or address.get('addressLocality') != 'Kampala, Uganda'
                        or not contact or contact not in public_contacts):
                    raise ValueError('ML Motors Kampala identity or public phone could not be confirmed')
                phones = [contact]
            else:
                location = next((n.b.get_text(' ', strip=True) for n in soup.select('.specs-list li')
                                 if n.span and n.b and n.span.get_text(strip=True) == 'Location'), '')
                if (location != 'Kampala, Uganda'
                        or dealer.get('@id') != 'https://sublimemotorcars.com/#dealer'):
                    raise ValueError('Sublime Motors Kampala identity could not be confirmed')
                phones = [phone(a['href'][4:], source) for a in soup.select('.veh-buy a[href^="tel:"]')]
                total = soup.select_one('.veh-price .vp-in b')
                total = re.fullmatch(r'UGX ([1-9]\d{0,2}(?:,\d{3})+)', total.get_text(' ', strip=True)) if total else None
                if not total:
                    raise ValueError('No published VAT-inclusive UGX price')
                amount = total[1].replace(',', '')
                if int(amount) < 1_000_000:
                    raise ValueError('Source price appears incomplete')
                facts['Price basis'] = 'Dealer-listed price including VAT'
            photo_selector = '.veh-gallery img[src]' if source_id == 'kampala_sublime' else 'img[alt*=" photo "][src]'
            visible_photos = {urljoin(url, n['src']) for n in soup.select(photo_selector)}
            images = [i for i in images if isinstance(i, str) and urljoin(url, i) in visible_photos]
        elif source_id == 'johannesburg':
            address = dealer.get('address') or {}
            if address.get('addressLocality') != source['city'] or address.get('addressCountry') != 'ZA':
                raise ValueError('Seller address does not match Johannesburg')
            phones = [phone(dealer.get('telephone'), source)]
            # Verify the schema contact on the public dealer catalogue as well.
            public = BeautifulSoup(catalog_body, 'html.parser')
            contacts = {phone(n['href'][4:], source) for n in public.select('a[href^="tel:"]')}
            if not phones[0] or phones[0] not in contacts:
                raise ValueError('No matching public dealer contact')
        else:
            if 'Lagos' not in soup.get_text(' ', strip=True) or offer.get('seller', {}).get('@id') != 'https://www.korrectcars.com/#dealer':
                raise ValueError('Lagos dealer identity not confirmed')
            phones = [phone(n['href'][4:], source) for n in soup.select('a[href^="tel:"]')]
        for field, label in [('vehicleModelDate', 'Year'), ('model', 'Model'), ('fuelType', 'Fuel'),
                             ('vehicleTransmission', 'Transmission'), ('color', 'Colour'), ('bodyType', 'Body type')]:
            if car.get(field):
                facts[label] = clean(car[field])
        mileage = car.get('mileageFromOdometer') or {}
        if isinstance(mileage, dict) and mileage.get('value'):
            facts['Mileage'] = f"{mileage['value']} {'miles' if mileage.get('unitCode') == 'SMI' else 'km'}"
        elif isinstance(mileage, str):
            facts['Mileage'] = clean(mileage)
        posted = car.get('datePublished') or offer.get('validFrom') or ''
    phones = list(dict.fromkeys(p for p in phones if p))
    images = list(dict.fromkeys(urljoin(url, i) for i in images if isinstance(i, str) and i
                               and not re.search(r'placeholder|no.image|logo|unsplash', i, re.I)))[:4]
    if not phones or not images or not re.fullmatch(r'\d+(?:\.\d+)?', amount) or float(amount) <= 0:
        raise ValueError('Complete public contact, product gallery and positive price required')
    status, reason = availability.classify({'source_url': url, 'title': title}, 200, str(soup), url)
    if status != 'active':
        raise ValueError(reason)
    proof = {'sourceUrl': url, 'title': title, 'images': images, 'phones': phones,
             'city': source['city'], 'checkedAt': checked}
    attrs = dict(parser='expansion_dealer_v1', sourceKind='dealer', listingIdentity=proof,
                 sourceSpecifications=[{'label': k, 'value': v} for k, v in facts.items()],
                 sourcePostedAt=posted, imageSourceUrl=url, imageVerifiedAt=checked,
                 detailsSourceUrl=url, detailsVerifiedAt=checked)
    description = f"{title}. Listed by {seller} in {source['city']}. " + '; '.join(f'{k}: {v}' for k, v in facts.items())
    return dict(id='dealer-' + hashlib.sha256(url.encode()).hexdigest()[:18], status='published',
                target_surface='marketplace', app_category='vehicles', app_subcategory='cars', title=title,
                description=description[:1000], city=source['city'], country=source['country'],
                seller=seller, phone=phones[0], source_site=source['name'], source_url=url,
                condition='used' if source['country'] == 'Uganda' else '',
                image_urls='|'.join(images), scraped_at=posted or checked, price_value=amount,
                currency=source['currency'], price_text=f"{source['currency']} {float(amount):,.0f}",
                source_availability='active', source_availability_checked_at=checked, source_last_seen_at=checked,
                source_http_status='200', source_resolved_url=url, sync_visibility='visible',
                source_unavailable_reason='', attributes=json.dumps(attrs, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sources', default=','.join(SOURCES))
    parser.add_argument('--limit-per-source', type=int, default=30)
    parser.add_argument('--cache-dir', type=Path)
    parser.add_argument('--report', type=Path, default=Path('output/expansion-listing-refresh-report.json'))
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    checked = datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')
    existing = {key(availability.source_url(r)) for p in availability.FEEDS for r in csv.DictReader((ROOT / p).open())}
    unavailable = json.loads((ROOT / 'data/listing-availability.json').read_text()).get('listings', {})
    if args.cache_dir:
        args.cache_dir.mkdir(parents=True, exist_ok=True)
    def fetch(url, exact=True):
        response = requests.get(url, timeout=25, headers={'User-Agent': availability.USER_AGENT})
        response.raise_for_status()
        if urlsplit(response.url).netloc != urlsplit(url).netloc or (exact and key(response.url) != key(url)):
            raise ValueError('Redirect away from requested source identity')
        if args.cache_dir:
            (args.cache_dir / (hashlib.sha256(url.encode()).hexdigest() + '.html')).write_text(response.text)
        return response.text
    incoming, reports, failures = [], {}, []
    for name in args.sources.split(','):
        source = SOURCES[name]
        try:
            body = fetch(source['catalog'], exact=False)
            pages = [body]
            if name == 'london':
                for page in range(2, 6):
                    pages.append(fetch(source['catalog'] + f'?paged={page}', exact=False))
            links = list(dict.fromkeys(urljoin(source['catalog'], a['href']).split('#')[0]
                                      for html in pages for a in BeautifulSoup(html, 'html.parser').select('a[href]')
                                      if urlsplit(urljoin(source['catalog'], a['href'])).netloc == urlsplit(source['catalog']).netloc
                                      and re.search(source['pattern'], urlsplit(a['href']).path)))
            if not links:
                raise ValueError('No listing links in source catalogue')
            candidates = [u for u in links if key(u) not in existing and key(u) not in unavailable][:args.limit_per_source]
            def load(url):
                try:
                    row = parse_listing(name, fetch(url), url, checked, body)
                    working = []
                    for image in row['image_urls'].split('|'):
                        try:
                            with requests.get(image, stream=True, timeout=15) as response:
                                if refresh.image_response_is_usable(response):
                                    working.append(image)
                        except requests.RequestException:
                            pass
                    if not working:
                        raise ValueError('No responding exact vehicle photos')
                    row['image_urls'] = '|'.join(working)
                    attrs = json.loads(row['attributes']); attrs['listingIdentity']['images'] = working
                    row['attributes'] = json.dumps(attrs, ensure_ascii=False)
                    return row
                except (requests.RequestException, ValueError, TypeError, KeyError) as error:
                    failures.append({'source': name, 'url': url, 'reason': str(error)[:220]})
            with ThreadPoolExecutor(max_workers=3) as pool:
                found = [r for r in pool.map(load, candidates) if r]
            incoming.extend(found)
            reports[name] = {'discovered': len(links), 'candidates': len(candidates), 'new': len(found)}
        except (requests.RequestException, ValueError) as error:
            failures.append({'source': name, 'url': source['catalog'], 'reason': str(error)[:220]})
            reports[name] = {'discovered': 0, 'candidates': 0, 'new': 0}
        print(f"{source['city']}: {reports[name]}", flush=True)
    merged = refresh.merge(ROOT / 'data/scraped-listings.csv', incoming, new_only=True) if incoming and not args.dry_run else {}
    report = {'checkedAt': checked, 'sources': reports, 'merged': merged, 'failures': failures}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))
    if any(not r['discovered'] or (r['candidates'] and not r['new']) for r in reports.values()):
        raise SystemExit('Some expansion sources need a retry; existing listings are unchanged')


if __name__ == '__main__':
    main()
