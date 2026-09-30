#!/usr/bin/env python3
"""Refresh photo/phone-equipped ads across the site's existing source regions."""
from __future__ import annotations

import argparse
import csv
import hashlib
import importlib.util
import json
import re
import sys
import threading
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import kijiji_scrape as kijiji

spec = importlib.util.spec_from_file_location("availability", ROOT / "scripts/check-listing-availability.py")
availability = importlib.util.module_from_spec(spec)
spec.loader.exec_module(availability)

NANP = re.compile(r"(?<!\d)(?:\+?1[ .-]*)?\(?([2-9]\d{2})\)?[ .-]*([2-9]\d{2})[ .-]*(\d{4})(?!\d)")
CANADA = [
    ("Hamilton", "hamilton", "80014"), ("Toronto", "city-of-toronto", "1700273"),
    ("Brampton", "brampton", "1700276"), ("Mississauga", "mississauga-peel-region", "1700276"),
    ("Scarborough", "scarborough", "1700272"), ("Vaughan", "markham-york-region", "1700274"),
    ("Edmonton", "edmonton", "1700203"), ("Waterloo", "kitchener-waterloo", "1700212"),
    ("Cambridge", "cambridge", "1700210"), ("Ottawa", "ottawa", "1700185"),
    ("Montreal", "ville-de-montreal", "1700281"), ("Windsor", "windsor-area-on", "1700220"),
    ("Winnipeg", "winnipeg", "1700192"),
]
K_CATEGORIES = [("cars-trucks", "174", "vehicles", "vehicles"),
                ("auto-parts-tires", "31", "vehicles", "auto_parts"),
                ("real-estate", "34", "real_estate", "for_sale"),
                ("electronics", "15", "electronics", "other")]
CL_CATEGORIES = [("cta", "vehicles", "vehicles"), ("pta", "vehicles", "auto_parts"),
                 ("rea", "real_estate", "for_sale"), ("apa", "real_estate", "for_rent_long"),
                 ("ele", "electronics", "other")]
JA_CATEGORIES = [("cars/", "vehicles", "vehicles"), ("car-parts/car-parts/", "vehicles", "auto_parts"),
                 ("car-parts/car-accessories/", "vehicles", "auto_parts"), ("car-parts/tyres-and-rims/", "vehicles", "tires_rims"),
                 ("other/real-estate/", "real_estate", "for_sale"), ("other/telephones/", "electronics", "phones_accessories"),
                 ("other/computers-and-games/", "electronics", "computers_tablets"), ("other/electronics-and-appliances/", "electronics", "other")]


def clean(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def public_phone(text, country):
    if country in {"Canada", "United States", "Jamaica"}:
        matches = []
        for m in NANP.finditer(text):
            # A Craigslist posting ID or a bare model/SKU is never a phone.
            if re.search(r"(?:posting\s*(?:id|#)|sku|stock\s*(?:#|number))\s*[:#]?\s*$", text[max(0, m.start()-25):m.start()], re.I):
                continue
            context = text[max(0, m.start()-60):m.end()+25]
            if not re.search(r"call|text|phone|contact|whatsapp|tel|cell|\+1|\(\d{3}\)", context, re.I):
                continue
            digits = "".join(m.groups())
            if country == "Jamaica" and digits[:3] not in {"876", "658"}:
                continue
            matches.append("+1" + digits)
        return " | ".join(dict.fromkeys(matches))
    return ""


def row_base(url, title, city, country, phone, images, category, subcategory, checked, source, ident=""):
    if not all((url, title, city, phone, images)):
        raise ValueError("Missing source title, city, public phone, or gallery")
    images = [i for i in images if i.startswith("https://") and not re.search("placeholder|logo|no.image", i, re.I)][:4]
    if not images:
        raise ValueError("No source gallery")
    return dict(id=ident or f"import-{hashlib.sha256(url.encode()).hexdigest()[:18]}", status="published",
                target_surface="vehicles" if category == "vehicles" else "marketplace", app_category=category,
                app_subcategory=subcategory, title=title, city=city, country=country, phone=phone,
                image_urls="|".join(images), source_site=source, source_url=url, scraped_at=checked,
                source_availability="active", source_availability_checked_at=checked, source_last_seen_at=checked,
                source_http_status="200", source_resolved_url=url, source_miss_count="0", source_miss_recorded_at="",
                source_unavailable_reason="", sync_visibility="visible", sync_visibility_reason="",
                attributes=json.dumps({"parser": "public_marketplace_refresh", "contactSource": url, "phoneVerifiedAt": checked,
                                       "imageSourceUrl": url, "imageVerifiedAt": checked, "imageIntegrityVersion": "2026-09-16.1"}, separators=(",", ":")))


def product_schema(body):
    soup = BeautifulSoup(body, "html.parser")
    for script in soup.select('script[type="application/ld+json"]'):
        try:
            value = json.loads(script.string or script.get_text())
        except (ValueError, TypeError):
            continue
        for entity in availability.entities(value):
            kinds = entity.get("@type", [])
            kinds = kinds if isinstance(kinds, list) else [kinds]
            if set(kinds) & {"Product", "Car", "Vehicle", "Apartment", "House", "SingleFamilyResidence", "RealEstateListing"}:
                return soup, entity
    return soup, {}


def craigslist_row(body, url, region, category, subcategory, checked):
    soup, product = product_schema(body)
    post = soup.select_one("#postingbody")
    if not post or not product:
        raise ValueError("No exact posting body/product")
    description = clean(post.get_text(" ", strip=True))
    phone = public_phone(description, "United States")
    offers = product.get("offers") or {}
    address = offers.get("availableAtOrFrom", {}).get("address", {}) or product.get("address", {})
    city = clean(address.get("addressLocality") or region)
    images = product.get("image", []) or [img.get("src", "") for img in soup.select('.gallery img, .slide img')]
    images = images if isinstance(images, list) else [images]
    images = [re.sub(r"_\d+x\d+(?=\.)", "_1200x900", i) for i in images]
    row = row_base(url, clean(product.get("name")), city, "United States", phone, images, category, subcategory, checked, "Craigslist", "craigslist-" + url.rstrip("/").rsplit("/", 1)[-1])
    row.update(description=description, price_value=str(offers.get("price") or ""), currency="USD",
               price_text=f"US$ {float(offers['price']):,.0f}" if offers.get("price") else "Contact seller",
               seller="", year=(re.search(r"\b(?:19|20)\d{2}\b", row["title"])[0] if category == "vehicles" and subcategory == "vehicles" and re.search(r"\b(?:19|20)\d{2}\b", row["title"]) else ""))
    attrs = json.loads(row["attributes"])
    attrs.update(sourceRegion=region, sourceCategory=subcategory if category == "vehicles" else category, sourcePostedAt=(soup.select_one("time[datetime]") or {}).get("datetime", ""))
    # Keep the genuine town; metro records enable searching the existing region.
    attrs["metro"] = region
    row["attributes"] = json.dumps(attrs, separators=(",", ":"))
    return row


def jacars_row(body, url, category, subcategory, checked):
    soup, product = product_schema(body)
    contact = soup.select_one('[data-component="SidebarContacts"]')
    phone = public_phone("phone " + (contact.get_text(" ", strip=True) if contact else ""), "Jamaica")
    offer = product.get("offers") or {}
    if offer.get("availability", "").rsplit("/", 1)[-1] != "InStock":
        raise ValueError("Listing is not in stock")
    seller = offer.get("seller") or {}
    city = clean(seller.get("address", {}).get("addressLocality"))
    if not city:
        raise ValueError("Missing advertised city")
    ident = str(product.get("sku") or re.search(r"/adv/(\d+)", url)[1])
    row = row_base(url, clean(product.get("name")), city, "Jamaica", phone, product.get("image", []), category, subcategory, checked, "JACars", "jacars-" + ident)
    row.update(description=clean(product.get("description")), seller=clean(seller.get("name")), price_value=str(offer.get("price") or ""),
               currency=offer.get("priceCurrency") or "JMD", price_text=f"JA$ {float(offer['price']):,.0f}" if offer.get("price") else "Contact seller",
               year=str(product.get("productionDate") or ""), transmission=product.get("vehicleTransmission") or "",
               mileage_km=str(product.get("mileageFromOdometer", {}).get("value") or ""))
    return row


def kijiji_row(item, fallback_city, checked):
    url, title = item.get("url", ""), clean(item.get("title"))
    location = item.get("location") or {}
    description = clean(item.get("description"))
    phone = public_phone(description + " " + title, "Canada")
    category, subcategory = "electronics", "other"
    slug = (re.search(r"/v-([^/]+)/", url) or [None, ""])[1]
    if re.search("parts|tires|rims|engine|transmission", slug):
        category, subcategory = "vehicles", "auto_parts"
    elif slug in {"cars-trucks", "motorcycles", "boats", "atv", "rv-motorhome"}:
        category, subcategory = "vehicles", "vehicles"
    elif re.search("rent|sale|apartments|commercial|room-rental|land", slug):
        category, subcategory = "real_estate", "for_sale" if "sale" in slug else "for_rent_long"
    elif not re.search("electronic|phone|computer|laptop|tablet|tv|camera|speaker|headphone|video-game|stereo|audio", slug):
        raise ValueError("Outside focus categories")
    city = clean(location.get("name") or fallback_city)
    row = row_base(url, title, city, "Canada", phone, [kijiji.normalize_image_url(i) for i in item.get("imageUrls", [])], category, subcategory, checked, "Kijiji", "kijiji-" + str(item["id"]))
    price = item.get("price") or {}
    row.update(description=description, price_value=str(float(price["amount"]) / 100) if isinstance(price.get("amount"), (int, float)) else "", currency="CAD",
               price_text=kijiji.format_price(price), seller="", scraped_at=item.get("activationDate") or checked)
    attrs = json.loads(row["attributes"])
    attrs.update(locationAddress=location.get("address"), sourcePostedAt=item.get("activationDate"), sourceLocationId=location.get("id"))
    row["attributes"] = json.dumps(attrs, separators=(",", ":"))
    for attribute in (item.get("attributes") or {}).get("all", []):
        key = attribute.get("canonicalName")
        value = ", ".join(attribute.get("values") or [])
        if key in {"carmake", "carmodel", "caryear", "cartransmission", "carmileage", "carcolor"}:
            field = {"carmake": "make", "carmodel": "model", "caryear": "year", "cartransmission": "transmission", "carmileage": "mileage_km", "carcolor": "color"}[key]
            row[field] = value
    return row


def kenya_retail_row(body, url, checked):
    soup, product = product_schema(body)
    organization = None
    for script in soup.select('script[type="application/ld+json"]'):
        try:
            for entity in availability.entities(json.loads(script.string or script.get_text())):
                if entity.get("@type") == "ComputerStore" and entity.get("name") == "Laptops in Kenya":
                    organization = entity
        except (ValueError, TypeError):
            pass
    if not organization or organization.get("address", {}).get("addressLocality") != "Nairobi":
        raise ValueError("Store identity/location not verified")
    phone = str(organization.get("telephone") or "").replace(" ", "")
    if not re.fullmatch(r"\+254[17]\d{8}", phone):
        raise ValueError("Missing complete public Kenyan store phone")
    offers = product.get("offers") or {}
    offers = offers if isinstance(offers, list) else [offers]
    offer = next((o for o in offers if o.get("availability", "").endswith("/InStock") and o.get("priceCurrency") == "KES"), None)
    if not offer:
        raise ValueError("No verified in-stock KES offer")
    heading = soup.select_one("h1")
    title = clean(heading.get_text(" ", strip=True)) if heading else clean(product.get("name"))
    images = product.get("image") or []
    images = images if isinstance(images, list) else [images]
    images = [i.get("url") if isinstance(i, dict) else i for i in images]
    row = row_base(url, title, "Nairobi", "Kenya", phone, images, "electronics", "computers_tablets", checked, "Laptops in Kenya", "kenya-retail-" + hashlib.sha256(url.encode()).hexdigest()[:16])
    description = soup.select_one(".woocommerce-product-details__short-description")
    row.update(seller="Laptops in Kenya", currency="KES", price_value=str(offer.get("price") or ""),
               price_text=f"KSh {float(offer['price']):,.0f}", description=clean(description.get_text(" ", strip=True)) if description else clean(product.get("description")))
    attrs = json.loads(row["attributes"])
    attrs.update(contactSource="public ComputerStore schema on exact product page", stockStatus="in_stock")
    row["attributes"] = json.dumps(attrs, separators=(",", ":"))
    return row


def merge(path, incoming):
    with path.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        headers, existing = list(reader.fieldnames or []), list(reader)
    # Match by URL as well as ID so a changed importer cannot create duplicate ads.
    by_url = {availability.source_url(row).rstrip("/"): row for row in existing if availability.source_url(row)}
    new, updated = 0, 0
    for row in incoming:
        old = by_url.get(row["source_url"].rstrip("/"))
        if old:
            # Source refresh never clears an explicit image-review hold.
            if old.get("sync_visibility") in {"reviewed_image_mismatch", "foreign_gallery"}:
                continue
            row["id"] = old["id"]
            old.update(row)
            updated += 1
        else:
            existing.append(row)
            by_url[row["source_url"].rstrip("/")] = row
            new += 1
    headers = list(dict.fromkeys(headers + [key for row in existing for key in row]))
    temporary = path.with_suffix(".refresh.tmp")
    with temporary.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=headers, lineterminator="\n")
        writer.writeheader(); writer.writerows(existing)
    temporary.replace(path)
    return {"new": new, "updated": updated}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sources", default="canada,craigslist,jamaica,kenya")
    parser.add_argument("--limit-per-region-category", type=int, default=5)
    parser.add_argument("--candidate-limit", type=int, default=24)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--crawl4ai-url", default="")
    parser.add_argument("--cache-dir", type=Path)
    parser.add_argument("--report", type=Path, default=Path("output/marketplace-refresh-report.json"))
    args = parser.parse_args()
    checked = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    sources = set(args.sources.split(","))
    rows = list(csv.DictReader((ROOT / "data/scraped-listings.csv").open()))
    countries = {r.get("country") for r in rows}
    locks = defaultdict(lambda: threading.Semaphore(3))
    failures = []
    if args.cache_dir:
        args.cache_dir.mkdir(parents=True, exist_ok=True)
    def fetch(url):
        path = args.cache_dir / (hashlib.sha256(url.encode()).hexdigest() + ".html") if args.cache_dir else None
        if path and path.exists():
            return path.read_text()
        with locks[urlsplit(url).netloc]:
            r = requests.get(url, headers={"User-Agent": availability.USER_AGENT}, timeout=30)
        r.raise_for_status()
        if path:
            path.write_text(r.text)
        return r.text
    def image_ok(row):
        image = row["image_urls"].split("|")[0]
        try:
            with requests.get(image, headers={"User-Agent": availability.USER_AGENT}, stream=True, timeout=20) as r:
                return r.status_code == 200 and r.headers.get("Content-Type", "").startswith("image/")
        except requests.RequestException:
            return False
    def crawl(urls, phone=False, cl_contact=False):
        if not args.crawl4ai_url:
            return {}
        params = {"stream": False, "cache_mode": "bypass", "page_timeout": 30000}
        if phone:
            params["js_code"] = 'await new Promise(r=>setTimeout(r,1000)); const b=document.querySelector(\'button[data-marker^="advert-cta_call-advert:"]\'); if(b){ b.click(); await new Promise(r=>setTimeout(r,1600)); }'
        if cl_contact:
            params["js_code"] = 'await new Promise(r=>setTimeout(r,500)); const b=document.querySelector("#postingbody a.show-contact"); if(b){ b.click(); await new Promise(r=>setTimeout(r,1200)); }'
        r = requests.post(args.crawl4ai_url, json={"urls": urls, "browser_config": {"type": "BrowserConfig", "params": {"headless": True}}, "crawler_config": {"type": "CrawlerRunConfig", "params": params}}, timeout=180)
        r.raise_for_status()
        return {item["url"]: item.get("html") or "" for item in r.json().get("results", []) if item.get("success") and int(item.get("status_code") or 0) < 400}
    incoming = []
    if "canada" in sources and "Canada" in countries:
        tasks = [(city, slug, loc, cat) for city, slug, loc in CANADA for cat in K_CATEGORIES]
        def load_canada(task):
            city, slug, loc, (cat_slug, cat_id, category, subcategory) = task
            url = f"https://www.kijiji.ca/b-{cat_slug}/{slug}/c{cat_id}l{loc}?sort=dateDesc"
            found = []
            try:
                state = kijiji.extract_state(fetch(url))
                items = [item for item in state.values() if isinstance(item, dict) and item.get("title") and item.get("imageUrls") and item.get("url")]
                items.sort(key=lambda item: str(item.get("activationDate") or ""), reverse=True)
                for item in items[:args.candidate_limit]:
                    try:
                        # Search previews truncate descriptions before the contact number.
                        if not public_phone(clean(item.get("description")), "Canada"):
                            detail_state = kijiji.extract_state(fetch(item["url"]))
                            detail = next((value for value in detail_state.values() if isinstance(value, dict)
                                and str(value.get("id")) == str(item["id"]) and value.get("title") and value.get("imageUrls")), None)
                            if detail:
                                item = detail
                        row = kijiji_row(item, city, checked)
                        if row["app_category"] != category:
                            continue
                        if image_ok(row): found.append(row)
                    except (requests.RequestException, ValueError, KeyError, TypeError):
                        pass
                    if len(found) >= args.limit_per_region_category:
                        break
            except (requests.RequestException, ValueError) as error:
                failures.append({"url": url, "reason": type(error).__name__})
            print(f"Canada {city}/{category}/{subcategory}: {len(found)}", flush=True)
            return found
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            incoming.extend(row for group in pool.map(load_canada, tasks) for row in group)
    if "craigslist" in sources and "United States" in countries:
        regions = {}
        for row in rows:
            host = urlsplit(row.get("source_url") or "").netloc
            if host.endswith(".craigslist.org") and host not in {"www.craigslist.org"}:
                regions.setdefault(host.split(".")[0], row["city"])
        regions.update(houston="Houston / Surrounding", atlanta="Atlanta / Metro", newyork="New York City")
        tasks = [(region, city, cat) for region, city in regions.items() for cat in CL_CATEGORIES]
        def load_cl(task):
            region, city, (cat, category, subcategory) = task
            url = f"https://www.craigslist.org/search/area/{region}?cat={cat}&sort=date&query=call"
            found = []
            try:
                soup = BeautifulSoup(fetch(url), "html.parser")
                links = list(dict.fromkeys(a["href"] for a in soup.select('a[href]') if '/view/d/' in a["href"] or re.search(r'/d/[^/]+/\d+\.html', a["href"])))
                crawled = crawl(links[:args.candidate_limit], cl_contact=True) if category == "real_estate" and args.crawl4ai_url else {}
                for link in links[:args.candidate_limit]:
                    try:
                        row = craigslist_row(crawled.get(link) or fetch(link), link, city, category, subcategory, checked)
                        if image_ok(row): found.append(row)
                    except (requests.RequestException, ValueError, KeyError, TypeError):
                        pass
                    if len(found) >= args.limit_per_region_category:
                        break
            except requests.RequestException as error:
                failures.append({"url": url, "reason": type(error).__name__})
            print(f"Craigslist {city}/{cat}: {len(found)}", flush=True)
            return found
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            incoming.extend(row for group in pool.map(load_cl, tasks) for row in group)
    if "jamaica" in sources and "Jamaica" in countries:
        tasks = [("https://www.jacars.net/" + path, category, subcategory) for path, category, subcategory in JA_CATEGORIES]
        pages = crawl([url for url, _, _ in tasks]) if args.crawl4ai_url else {}
        for url, category, subcategory in tasks:
            try:
                soup = BeautifulSoup(pages.get(url) or fetch(url), "html.parser")
                links = list(dict.fromkeys(urljoin(url, a["href"]) for a in soup.select('a[href]') if "/adv/" in a["href"]))[:args.candidate_limit]
                found = []
                for start in range(0, len(links), 12):
                    details = crawl(links[start:start+12], phone=True)
                    for link in links[start:start+12]:
                        try:
                            row = jacars_row(details.get(link) or fetch(link), link, category, subcategory, checked)
                            if image_ok(row): found.append(row)
                        except (requests.RequestException, ValueError, KeyError, TypeError):
                            pass
                incoming.extend(found)
                print(f"Jamaica {category}/{subcategory}: {len(found)}", flush=True)
            except (requests.RequestException, ValueError) as error:
                failures.append({"url": url, "reason": type(error).__name__})
    if "kenya" in sources and "Kenya" in countries:
        home = "https://laptopsinkenya.com/"
        try:
            soup = BeautifulSoup(fetch(home), "html.parser")
            links = list(dict.fromkeys(a["href"] for a in soup.select('a[href]') if a["href"].startswith(home + "product/")))[:args.candidate_limit]
            def load_kenya(link):
                try:
                    row = kenya_retail_row(fetch(link), link, checked)
                    return row if image_ok(row) else None
                except (requests.RequestException, ValueError, KeyError, TypeError):
                    return None
            with ThreadPoolExecutor(max_workers=args.workers) as pool:
                incoming.extend(row for row in pool.map(load_kenya, links) if row)
        except requests.RequestException as error:
            failures.append({"url": home, "reason": type(error).__name__})
    incoming = list({row["source_url"]: row for row in incoming}.values())
    destinations = {ROOT / "data/scraped-listings.csv": incoming}
    ja = [row for row in incoming if row["country"] == "Jamaica"]
    if ja:
        destinations[ROOT / "data/jamaica-listings.csv"] = ja
    ke = [row for row in incoming if row["country"] == "Kenya"]
    if ke:
        destinations[ROOT / "data/kenya-listings.csv"] = ke
    merged = {str(path.relative_to(ROOT)): merge(path, batch) for path, batch in destinations.items()}
    report = {"checkedAt": checked, "eligible": len(incoming), "countries": dict(Counter(r["country"] for r in incoming)),
              "categories": dict(Counter(r["app_category"] + "/" + r["app_subcategory"] for r in incoming)),
              "cities": dict(Counter(r["city"] + ", " + r["country"] for r in incoming)), "merged": merged,
              "failures": failures, "ids": [r["id"] for r in incoming]}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2))
    print(json.dumps({k: v for k, v in report.items() if k not in {"ids", "cities", "failures"}}, indent=2))
    if not incoming:
        raise SystemExit("No qualifying new records; existing records preserved")


if __name__ == "__main__":
    main()
