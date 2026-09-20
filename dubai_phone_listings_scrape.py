#!/usr/bin/env python3
"""Merge public Dubai dealer inventory with complete seller phones into the Dubai feed."""
import argparse
import csv
import html
import json
import re
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin

from opensooq_dubai_scrape import CSV_FIELDS, normalize_uae_phone

INVENTORY = 'https://albacars.ae/buy-used-cars-uae'

class Page(HTMLParser):
    def __init__(self, source):
        super().__init__()
        self.links, self.schemas, self.in_schema, self.raw = [], [], False, ''
        self.feed(source)
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == 'a' and a.get('href'): self.links.append(a['href'])
        if tag == 'script':
            self.in_schema = a.get('type') == 'application/ld+json'
            self.raw = ''
    def handle_data(self, data):
        if self.in_schema: self.raw += data
    def handle_endtag(self, tag):
        if tag == 'script' and self.in_schema:
            try: self.schemas.append(json.loads(self.raw))
            except ValueError: pass
            self.in_schema = False

def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent':'6ixo-public-listing-import/1.0 (+https://6ixo.com)'})
    with urllib.request.urlopen(req, timeout=30) as r:
        if r.status != 200: raise ValueError(f'Source HTTP {r.status}')
        return r.read().decode('utf-8')

def row_from_page(source, url, checked):
    page = Page(source)
    car = next((s for s in page.schemas if isinstance(s,dict) and s.get('@type') == 'Car' and s.get('url') == url), None)
    if not car: raise ValueError('No exact vehicle schema')
    offer = car.get('offers', {})
    if offer.get('availability') != 'https://schema.org/InStock': raise ValueError('Vehicle is not in stock')
    if offer.get('seller',{}).get('name') != 'Alba Cars' or 'Alba Cars Dubai Showroom' not in source: raise ValueError('Seller/location mismatch')
    phone = next((normalize_uae_phone(h[4:]) for h in page.links if h.startswith('tel:') and normalize_uae_phone(h[4:])), '')
    if not phone: raise ValueError('No complete public seller phone')
    ident = re.search(r'/vehicle/(\d+)-', url).group(1)
    images = [i for i in car.get('image') or [] if isinstance(i,str) and i.startswith('https://storage.albacars.ae/vehicles/')]
    decoded = html.unescape(source).replace('\\/', '/')
    # The exact vehicle schema establishes gallery ownership, including legacy UUID paths.
    folders = {i.rsplit('/',1)[0]+'/' for i in images}
    for folder in folders:
        images += re.findall(re.escape(folder)+r'[^"<>\\\s?]+\.(?:jpg|jpeg|png|webp)',decoded)
    images = list(dict.fromkeys(images))[:4]
    if not images: raise ValueError('No exact vehicle photos')
    # Use the image format parameter present on the dealer's rendered gallery URLs.
    images = [i.split('?')[0] + '?format=auto' for i in images]
    price = str(int(float(offer['price'])))
    if int(price) <= 0 or offer.get('priceCurrency') != 'AED': raise ValueError('Invalid purchase price')
    year = str(car.get('productionDate',''))
    mileage = str(car.get('mileageFromOdometer',{}).get('value',''))
    row = {k:'' for k in CSV_FIELDS}
    attrs = {'parser':'alba_public_vehicle_schema','sourceCategory':'vehicles','contactSource':url,'phoneVerifiedAt':checked,
             'imageSourceUrl':url,'imageVerifiedAt':checked,'imageIntegrityVersion':'2026-09-16.1',
             'bodyType':car.get('bodyType',''),'fuelType':car.get('fuelType',''),'engine':car.get('vehicleEngine',{}),
             'sourceSpecifications':[{'label':p['name'],'value':str(p['value'])} for p in car.get('additionalProperty',[]) if p.get('name') and p.get('value') is not None]}
    row.update(id=f'alba-dubai-{ident}',status='published',target_surface='vehicles',app_category='vehicles',app_subcategory='vehicles',
        title=f"{year} {car['name']}",price_text=f'AED {int(price):,}',price_value=price,currency='AED',city='Dubai',country='United Arab Emirates',
        seller='Alba Cars',phone=phone,description=f"{year} {car['name']}. {int(mileage):,} km. {car.get('vehicleTransmission','')}. {car.get('color','')}. Seller: Alba Cars, Al Quoz, Dubai.",
        image_urls='|'.join(images),source_site='Alba Cars',source_url=url,scraped_at=checked,make=car.get('brand',{}).get('name',''),model=car.get('model',''),
        year=year,condition='used',transmission=car.get('vehicleTransmission',''),color=car.get('color',''),mileage_km=mileage,
        attributes=json.dumps(attrs,separators=(',',':')),source_availability='active',source_availability_checked_at=checked,source_http_status='200',
        source_last_seen_at=checked,source_resolved_url=url,source_miss_count='0',sync_visibility='visible')
    return row

def main():
    p=argparse.ArgumentParser()
    p.add_argument('--output',type=Path,default=Path('data/dubai-listings.csv'))
    p.add_argument('--limit',type=int,default=20)
    p.add_argument('--audit-dir',type=Path,required=True)
    args=p.parse_args()
    if args.limit < 1: p.error('--limit must be positive')
    args.audit_dir.mkdir(parents=True,exist_ok=True)
    inventory=fetch(INVENTORY)
    (args.audit_dir/'inventory.html').write_text(inventory)
    links=list(dict.fromkeys(urljoin(INVENTORY,h) for h in Page(inventory).links if re.match(r'^/buy-used-cars/vehicle/\d+-',h)))[:args.limit]
    if not links: raise RuntimeError('No current vehicles found; feed unchanged')
    checked=datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00','Z')
    def load(url):
        source=fetch(url)
        ident=re.search(r'/vehicle/(\d+)-',url).group(1)
        (args.audit_dir/f'{ident}.html').write_text(source)
        row=row_from_page(source,url,checked)
        # Retain only working images from this exact listing's gallery.
        working = []
        for image in row['image_urls'].split('|'):
            try:
                req=urllib.request.Request(image,method='HEAD')
                with urllib.request.urlopen(req,timeout=30) as response:
                    if response.status==200 and response.headers.get('Content-Type','').startswith('image/'):
                        working.append(image)
            except (OSError, ValueError):
                continue
        if not working: raise ValueError('No working source gallery photos')
        row['image_urls']='|'.join(working)
        return row
    def checked_load(url):
        try: return load(url), None
        except (OSError, ValueError) as error: return None, {'url':url,'reason':str(error)}
    with ThreadPoolExecutor(max_workers=3) as pool: results=list(pool.map(checked_load,links))
    incoming=[r for r,e in results if r]
    skipped=[e for r,e in results if e]
    if not incoming: raise RuntimeError('No verified phone-equipped inventory; feed unchanged: '+json.dumps(skipped))
    existing=list(csv.DictReader(args.output.open())) if args.output.exists() else []
    merged={r['id']:r for r in existing}
    for r in incoming: merged[r['id']]=r
    headers=list(dict.fromkeys([*CSV_FIELDS,*(k for r in existing for k in r)]))
    tmp=args.output.with_suffix('.tmp')
    with tmp.open('w',newline='') as f:
        w=csv.DictWriter(f,fieldnames=headers, lineterminator="\n");w.writeheader();w.writerows(merged.values())
    tmp.replace(args.output)
    report={'imported':len(incoming),'phoneRequired':True,'checkedAt':checked,'source':INVENTORY,'skipped':skipped,'ids':[r['id'] for r in incoming]}
    (args.audit_dir/'report.json').write_text(json.dumps(report,indent=2))
    print(json.dumps(report))

if __name__=='__main__': main()
