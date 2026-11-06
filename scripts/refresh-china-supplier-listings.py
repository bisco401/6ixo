#!/usr/bin/env python3
"""Search existing Chinese suppliers and refresh exact public catalogue items."""
from __future__ import annotations
import argparse
import csv
import hashlib
import importlib.util
import json
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote, urljoin, urlsplit

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('marketplace_refresh', ROOT / 'scripts/refresh-marketplace-listings.py')
refresh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(refresh)
key, clean = refresh.availability.source_key, refresh.clean


def attributes(row):
    try:
        value = json.loads(row.get('attributes') or '{}')
        return value if isinstance(value, dict) else {}
    except (TypeError, ValueError):
        return {}


def phone_from(soup, contact_body, previous):
    bodies = [soup.get_text(' ', strip=True), BeautifulSoup(contact_body, 'html.parser').get_text(' ', strip=True)]
    candidates = []
    for page in [soup, BeautifulSoup(contact_body, 'html.parser')]:
        for node in page.select('a[href^="tel:"],a[href*="wa.me/"]'):
            href = unquote(node['href'])
            value = href[4:] if href.startswith('tel:') else urlsplit(href).path.strip('/')
            digits = re.sub(r'\D', '', value)
            if re.fullmatch(r'86\d{8,12}', digits):
                candidates.append('+' + digits)
    digits = re.sub(r'\D', '', previous)
    if re.fullmatch(r'86\d{8,12}', digits):
        pattern = r'(?<!\d)\+?' + r'[\s().-]*'.join(digits) + r'(?!\d)'
        if any(re.search(pattern, body) for body in bodies):
            return '+' + digits
        if '+' + digits in candidates:
            return '+' + digits
    return candidates[0] if candidates else ''


def parse_product(body, url, base, checked, contact_body=''):
    soup = BeautifulSoup(body, 'html.parser')
    canonical = soup.select_one('link[rel="canonical"]')
    host = urlsplit(url).netloc.removeprefix('www.')
    if canonical and key(urljoin(url, canonical.get('href', ''))) != key(url):
        raise ValueError('Canonical product identity mismatch')
    # Yanxi has no canonical tag; its exact response URL and dedicated product
    # gallery are required. Other templates must provide a matching canonical.
    if not canonical and host != 'yanxicosmetics.com':
        raise ValueError('No exact canonical product identity')
    for node in reversed(soup.select('[class*="related"], [class*="recommend"], [class*="similar"], [class*="up-sells"], [class*="cross-sells"]')):
        node.decompose()
    headings = list(dict.fromkeys(clean(h.get_text(' ', strip=True)) for h in soup.select('h1')))
    if len(headings) != 1 or re.search(r'not found|access denied|just a moment|forbidden', headings[0], re.I):
        raise ValueError('Unique primary product heading required')
    title = headings[0]
    entities = []
    for script in soup.select('script[type="application/ld+json"]'):
        try:
            entities.extend(refresh.availability.entities(json.loads(script.get_text(), strict=False)))
        except (ValueError, TypeError):
            pass
    products = []
    for entity in entities:
        kinds = entity.get('@type') or []
        kinds = kinds if isinstance(kinds, list) else [kinds]
        if not set(kinds) & {'Product', 'Car', 'Vehicle'}:
            continue
        own = entity.get('url') or entity.get('@id') or ''
        if own and key(urljoin(url, own)) != key(url):
            continue
        if own or clean(entity.get('name')).casefold() == title.casefold():
            products.append(entity)
    if len(products) > 1:
        raise ValueError('Ambiguous primary product schemas')
    product = products[0] if products else {}
    images = product.get('image') or []
    images = images if isinstance(images, list) else [images]
    images = [i.get('url') or i.get('contentUrl', '') if isinstance(i, dict) else i for i in images]
    selectors = {
        'sinovcleglobal.com': '.pro-zoom img',
        'letcos.com': '.woocommerce-product-gallery img',
        'sidicasual.com': '.woocommerce-product-gallery img',
        'yanxicosmetics.com': 'a.example-image-link',
    }
    if host in selectors:
        gallery = [n.get('data-large_image') or n.get('data-large') or n.get('href') or n.get('src') for n in soup.select(selectors[host])]
        if gallery:
            images = gallery
    images = list(dict.fromkeys(urljoin(url, i) for i in images if isinstance(i, str) and i
                               and not re.search(r'logo|placeholder|no.image|\.svg(?:\?|$)', i, re.I)))[:4]
    if not images or (not product and host not in selectors):
        raise ValueError('Exact primary product gallery required')
    phone = phone_from(soup, contact_body, base.get('phone', ''))
    if not phone:
        raise ValueError('No complete public supplier business contact')
    status, reason = refresh.availability.classify({'title': title, 'source_url': url}, 200, body, url)
    if status != 'active':
        raise ValueError(reason)
    offers = product.get('offers') or []
    offers = offers if isinstance(offers, list) else [offers]
    offers = [o for o in offers if isinstance(o, dict) and (not o.get('url') or key(o['url']) == key(url))]
    prices = {(str(o.get('price') or ''), str(o.get('priceCurrency') or '')) for o in offers}
    amount, currency = next(iter(prices)) if len(prices) == 1 else ('', '')
    if not re.fullmatch(r'\d+(?:\.\d+)?', amount) or not re.fullmatch(r'[A-Z]{3}', currency):
        amount, currency = '', ''
    facts = [{'label': p.get('name'), 'value': clean(p.get('value'))} for p in product.get('additionalProperty', [])
             if isinstance(p, dict) and p.get('name') and p.get('value') is not None]
    if product.get('sku'):
        facts.append({'label': 'SKU', 'value': str(product['sku'])})
    description = soup.select_one('.woocommerce-product-details__short-description, .pro-description, .product-description')
    description = clean(description.get_text(' ', strip=True) if description else BeautifulSoup(str(product.get('description') or ''), 'html.parser').get_text())
    if not description:
        description = f"{title}. Supplier catalogue from {base.get('seller') or base['source_site']}, China. Contact the supplier for current availability and a quotation."
    proof = {'sourceUrl': url, 'title': title, 'images': images, 'phones': [phone], 'city': base.get('city', ''), 'checkedAt': checked}
    old_attrs = attributes(base)
    attrs = {k: old_attrs[k] for k in ['supplierContactUrl', 'province'] if old_attrs.get(k)}
    attrs.update(parser='china_public_supplier_sync', supplierWebsite=True, stockStatus='supplier_catalogue',
                 contactSource=old_attrs.get('supplierContactUrl') or url, detailsSourceUrl=url, detailsVerifiedAt=checked,
                 sourceSpecifications=facts, imageSourceUrl=url, imageVerifiedAt=checked, listingIdentity=proof,
                 sourcePostedAt=product.get('datePublished') or '')
    return dict(id='supplier-' + hashlib.sha256(url.encode()).hexdigest()[:18], status='published',
                target_surface=base.get('target_surface', 'marketplace'), app_category=base['app_category'],
                app_subcategory=base['app_subcategory'], title=title, description=description[:1000],
                city=base.get('city', ''), country='China', seller=base.get('seller') or base['source_site'],
                phone=phone, source_site=base['source_site'], source_url=url, image_urls='|'.join(images),
                scraped_at=checked, price_value=amount, currency=currency,
                price_text=f'{currency} {amount}' if amount else 'Contact supplier for price',
                source_availability='active', source_availability_checked_at=checked, source_last_seen_at=checked,
                source_http_status='200', source_resolved_url=url, sync_visibility='visible', sync_visibility_reason='',
                source_miss_count='0', source_miss_recorded_at='', source_unavailable_reason='', attributes=json.dumps(attrs, ensure_ascii=False))


def product_url(url, host, known_paths):
    path = urlsplit(url).path
    explicit = bool(re.search(r'/(?:product|products|wdk-listing)/[^/]+/?$', path))
    root_template = bool(known_paths) and all(p.strip('/').count('/') == 0 for p in known_paths)
    root_item = root_template and path.strip('/').count('/') == 0 and path.count('-') >= 3 and not re.search(r'contact|about|privacy|blog|category', path)
    return urlsplit(url).netloc == host and (explicit or root_item)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--new-per-supplier', type=int, default=12)
    parser.add_argument('--workers', type=int, default=4)
    parser.add_argument('--cache-dir', type=Path)
    parser.add_argument('--report', type=Path, default=Path('output/china-supplier-refresh-report.json'))
    parser.add_argument('--new-only', action='store_true')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    with (ROOT / 'data/scraped-listings.csv').open() as handle:
        rows = [r for r in csv.DictReader(handle) if r.get('country') == 'China']
    suppliers = json.loads((ROOT / 'scripts/china-suppliers.json').read_text())
    # Keep discovering suppliers even after their last old item is removed.
    groups = {host: [] for host in suppliers}
    for row in rows:
        groups.setdefault(urlsplit(row['source_url']).netloc, []).append(row)
    checked = datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')
    if args.cache_dir:
        args.cache_dir.mkdir(parents=True, exist_ok=True)

    def fetch(url, exact=True):
        response = requests.get(url, timeout=20, headers={'User-Agent': refresh.availability.USER_AGENT})
        response.raise_for_status()
        if urlsplit(response.url).netloc != urlsplit(url).netloc or (exact and key(response.url) != key(url)):
            raise ValueError('Source redirected away from requested identity')
        if args.cache_dir:
            (args.cache_dir / (hashlib.sha256(url.encode()).hexdigest() + '.html')).write_text(response.text)
        return response.text

    def process(entry):
        host, records = entry
        base = records[0] if records else suppliers[host]
        home = 'https://' + host + '/'
        failures, incoming, links = [], [], set()
        bodies = []
        contact = attributes(base).get('supplierContactUrl')
        urls = [home] + ([contact] if contact and urlsplit(contact).netloc == host else [])
        for url in dict.fromkeys(urls):
            try:
                body = fetch(url, exact=False)
                bodies.append(body)
                links.update(urljoin(url, a['href']).split('#')[0] for a in BeautifulSoup(body, 'html.parser').select('a[href]'))
            except (requests.RequestException, ValueError) as error:
                failures.append({'url': url, 'reason': str(error)[:180]})
        paths = [urlsplit(r['source_url']).path for r in records] or [urlsplit(base['source_url']).path]
        def is_product(url):
            return product_url(url, host, paths)
        catalogs = sorted(u for u in links if urlsplit(u).netloc == host and not is_product(u)
                          and re.search(r'/(?:shop|products?|collections|all-products)(?:/|$)', urlsplit(u).path))[:3]
        for url in catalogs:
            try:
                body = fetch(url, exact=False)
                links.update(urljoin(url, a['href']).split('#')[0] for a in BeautifulSoup(body, 'html.parser').select('a[href]'))
            except (requests.RequestException, ValueError) as error:
                failures.append({'url': url, 'reason': str(error)[:180]})
        existing = {key(r['source_url']): r for r in records}
        candidates = [r['source_url'] for r in records] + sorted(u for u in links if is_product(u) and key(u) not in existing)[:args.new_per_supplier]
        if args.new_only:
            candidates = [u for u in candidates if key(u) not in existing]
        for url in dict.fromkeys(candidates):
            try:
                row = parse_product(fetch(url), url, existing.get(key(url), base), checked, '\n'.join(bodies))
                images = []
                for image in row['image_urls'].split('|'):
                    try:
                        with requests.get(image, stream=True, timeout=12) as response:
                            if refresh.image_response_is_usable(response):
                                images.append(image)
                    except requests.RequestException:
                        pass
                if not images:
                    raise ValueError('No working exact product photo')
                row['image_urls'] = '|'.join(images)
                attrs = attributes(row); attrs['listingIdentity']['images'] = images
                row['attributes'] = json.dumps(attrs, ensure_ascii=False)
                incoming.append(row)
            except (requests.RequestException, ValueError, TypeError, KeyError) as error:
                failures.append({'url': url, 'reason': str(error)[:180]})
        report = {'source': base['source_site'], 'host': host, 'discovered': sum(is_product(u) for u in links),
                  'candidates': len(set(candidates)), 'verified': len(incoming), 'failures': failures}
        print(f"{base['source_site']}: {len(incoming)} verified; {len(failures)} deferred", flush=True)
        return report, incoming

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        completed = list(pool.map(process, groups.items()))
    incoming = [r for _, batch in completed for r in batch]
    merged = refresh.merge(ROOT / 'data/scraped-listings.csv', incoming, new_only=args.new_only) if incoming and not args.dry_run else {}
    report = {'checkedAt': checked, 'sources': [r for r, _ in completed], 'eligible': len(incoming), 'merged': merged}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'eligible': len(incoming), 'merged': merged}, indent=2))
    if any(not r['verified'] and (r['candidates'] or not r['discovered'] or not args.new_only) for r, _ in completed):
        raise SystemExit('Some suppliers could not be verified; existing records retained for the next daily retry')


if __name__ == '__main__':
    main()
