#!/usr/bin/env python3
"""Refresh Kenya sources with exact product photos and public business contacts."""
from __future__ import annotations

import argparse
import csv
import hashlib
import html
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
spec = importlib.util.spec_from_file_location("marketplace_refresh", ROOT / "scripts/refresh-marketplace-listings.py")
refresh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(refresh)
clean = refresh.clean
key = refresh.availability.source_key
SOURCES = {
    "samtech": ("SamTech Auto Parts", [f"https://samtechautoparts.com/products?page={p}" for p in range(1, 9)], r"/products/\d+$", "samtechautoparts.com"),
    "autostore": ("Autostore EA", ["https://autostore.co.ke/shop/?orderby=date"] + [f"https://autostore.co.ke/shop/page/{p}/?orderby=date" for p in range(2, 4)], r"/product/[^/?]+/?$", "autostore.co.ke"),
    "kai": ("Kai & Karo", ["https://kaiandkaro.com/"], r"/store/kaikaro/vehicle/[^/?]+$", "motifiti.co.ke"),
    "laptops": ("Laptops in Kenya", ["https://laptopsinkenya.com/", "https://laptopsinkenya.com/shop/?orderby=date"], r"/product/[^/?]+/?$", "laptopsinkenya.com"),
}


def schemas(soup):
    result = []
    for script in soup.select('script[type="application/ld+json"]'):
        try:
            result.extend(refresh.availability.entities(json.loads(script.get_text(), strict=False)))
        except (ValueError, TypeError):
            pass
    return result


def parse_listing(source, body, url, checked):
    soup = BeautifulSoup(body, "html.parser")
    canonical = soup.select_one('link[rel="canonical"]')
    if not canonical or key(urljoin(url, canonical.get("href", ""))) != key(url):
        raise ValueError("Exact canonical source URL required")
    heading = soup.select_one("h1.product_title,h1")
    title = clean(heading.get_text(" ", strip=True)) if heading else ""
    objects = schemas(soup)
    products = []
    for entity in objects:
        if not set([entity.get("@type")] if isinstance(entity.get("@type"), str) else entity.get("@type", [])) & {"Product", "Car"}:
            continue
        offer_values = entity.get("offers") or []
        offer_values = offer_values if isinstance(offer_values, list) else [offer_values]
        main_entity = entity.get("mainEntityOfPage") or {}
        own = str(entity.get("url") or entity.get("@id") or (main_entity.get("@id") if isinstance(main_entity, dict) else main_entity)
                  or next((o.get("url") for o in offer_values if o.get("url")), "")).split("#")[0]
        if own and key(urljoin(url, own)) != key(url):
            continue
        entity_title = html.unescape(re.sub(r"\\u([0-9a-fA-F]{4})", lambda m: chr(int(m[1], 16)), clean(entity.get("name"))))
        if source == "laptops":
            entity_title = re.sub(r"\s*[–—-]\s*Best Price in Kenya$", "", entity_title, flags=re.I)
        # This store uses a shorter SEO title in Product while the primary H1
        # includes the full configuration. Its exact ItemPage/@id binds both.
        if entity_title.casefold() == title.casefold() or (source == "laptops" and title and own and key(urljoin(url, own)) == key(url)):
            products.append(entity)
    product = products[0] if len(products) == 1 else {}
    if source == "laptops":
        if not product:
            raise ValueError("Exact primary product required")
        org = next((e for e in objects if e.get("@type") == "ComputerStore" and e.get("name") == "Laptops in Kenya"), {})
        phone = re.sub(r"\s+", "", org.get("telephone", ""))
        if org.get("address", {}).get("addressLocality") != "Nairobi" or not re.fullmatch(r"\+254[17]\d{8}", phone):
            raise ValueError("Public computer store identity/contact not confirmed")
        offers = product.get("offers") or []
        offers = offers if isinstance(offers, list) else [offers]
        offer = next((o for o in offers if o.get("availability", "").endswith("/InStock") and o.get("priceCurrency") == "KES"), {})
        if not offer or float(offer.get("price") or 0) <= 0:
            raise ValueError("No in-stock KES computer offer")
        gallery = [i.get("data-large_image") or i.get("src") for i in soup.select('.woocommerce-product-gallery img')]
        images = product.get("image") or []
        images = images if isinstance(images, list) else [images]
        images = gallery or [i.get("url") or i.get("contentUrl", "") if isinstance(i, dict) else i for i in images]
        row = refresh.row_base(url, title, "Nairobi", "Kenya", phone, [urljoin(url, i) for i in images if i],
                               "electronics", "computers_tablets", checked, "Laptops in Kenya",
                               "kenya-retail-" + hashlib.sha256(url.encode()).hexdigest()[:16])
        row.update(seller="Laptops in Kenya", currency="KES", price_value=str(offer["price"]),
                   price_text=f"KSh {float(offer['price']):,.0f}",
                   description=clean(BeautifulSoup(str(product.get("description") or title), "html.parser").get_text())[:1000])
    else:
        images = product.get("image") or []
        images = images if isinstance(images, list) else [images]
        images = [urljoin(url, i.get("url") or i.get("contentUrl", "") if isinstance(i, dict) else i) for i in images if i]
        offers = product.get("offers") or []
        offers = offers if isinstance(offers, list) else [offers]
        offer = next((o for o in offers if o.get("availability", "").endswith("/InStock") and o.get("priceCurrency") == "KES"), {})
        public_phones = [a["href"][4:] for a in soup.select('a[href^="tel:"]')]
        phone = next((re.sub(r"\s+", "", p) for p in public_phones if re.fullmatch(r"\+254[17]\d{8}", re.sub(r"\s+", "", p))), "")
        name = SOURCES[source][0]
        if source == "samtech":
            if phone != "+254701799603" or "Kirinyaga Road, Nairobi" not in soup.get_text():
                raise ValueError("Public seller contact/address changed")
        elif source == "autostore":
            org = next((e for e in objects if e.get("@type") == "Organization" and e.get("name") == name), {})
            contacts = org.get("contactPoint") or []
            contacts = contacts if isinstance(contacts, list) else [contacts]
            phone = next((re.sub(r"\s+", "", c.get("telephone", "")) for c in contacts if c.get("contactType") == "sales"), "")
            if org.get("address", {}).get("addressLocality") != "Nairobi":
                raise ValueError("Public store address not confirmed")
            gallery = [i.get("data-large_image") or i.get("src") for i in soup.select('.woocommerce-product-gallery img')]
            if gallery:
                images = [urljoin(url, i) for i in gallery if i]
            if not product:
                stock = soup.select_one(".summary .stock")
                price = soup.select_one(".summary .price ins") or soup.select_one(".summary .price")
                if not stock or clean(stock.get_text()).lower() != "in stock" or not price:
                    raise ValueError("Exact product stock/price required")
                amount = re.search(r"[0-9][0-9,.]*", price.get_text())
                if amount:
                    offer = {"price": amount[0].replace(",", ""), "priceCurrency": "KES"}
        elif source == "kai":
            if "/vehicle/kaikaro/" not in urlsplit(url).path or "Nairobi" not in soup.get_text():
                raise ValueError("Public dealer location not confirmed")
        if not title or not offer or not re.fullmatch(r"\+254[17]\d{8}", phone):
            raise ValueError("Public contact and in-stock KES offer required")
        amount = float(offer.get("price") or 0)
        if amount <= 0:
            raise ValueError("Source price is missing")
        row = refresh.row_base(url, title, "Nairobi", "Kenya", phone, images, "vehicles",
                               "vehicles" if source == "kai" else "auto_parts", checked, name,
                               "dealer-" + hashlib.sha256(url.encode()).hexdigest()[:18])
        description = soup.select_one(".woocommerce-product-details__short-description")
        row.update(seller=name, currency="KES", price_value=str(amount), price_text=f"KSh {amount:,.0f}",
                   description=clean(description.get_text(" ", strip=True) if description else BeautifulSoup(str(product.get("description") or title), "html.parser").get_text())[:1000])
        if source == "kai":
            row = refresh.retain_vehicle_schema_fields(row, product)
    attrs = json.loads(row["attributes"])
    page_entity = next((e for e in objects if e.get("@type") == "ItemPage" and key(e.get("url", "")) == key(url)), {})
    posted = product.get("datePublished") or product.get("datePosted") or page_entity.get("datePublished") or ""
    from ghana_marketplace_sync import parse_timestamp
    posted = posted if parse_timestamp(posted) else ""
    if posted:
        row["scraped_at"] = posted
    attrs.update(parser="kenya_public_sources_v1", sourcePostedAt=posted,
                 listingIdentity={"sourceUrl": url, "title": row["title"], "images": row["image_urls"].split("|"),
                                  "phones": [row["phone"]], "city": row["city"], "checkedAt": checked})
    row["attributes"] = json.dumps(attrs, ensure_ascii=False)
    return row


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sources", default=",".join(SOURCES))
    parser.add_argument("--candidate-limit", type=int, default=120)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--report", type=Path, default=Path("output/kenya-public-refresh-report.json"))
    parser.add_argument("--cache-dir", type=Path)
    parser.add_argument("--new-only", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    checked = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    feeds = [ROOT / "data/scraped-listings.csv", ROOT / "data/kenya-listings.csv"]
    known = {}
    for feed in feeds:
        with feed.open() as handle:
            for row in csv.DictReader(handle):
                known[key(row.get("source_url", ""))] = row
    failures, incoming, reports = [], [], {}
    if args.cache_dir:
        args.cache_dir.mkdir(parents=True, exist_ok=True)

    def fetch(url, exact=True):
        response = requests.get(url, headers={"User-Agent": refresh.availability.USER_AGENT}, timeout=25)
        response.raise_for_status()
        if (exact and key(response.url) != key(url)) or urlsplit(response.url).netloc != urlsplit(url).netloc:
            raise ValueError("Source redirected away from requested URL")
        if args.cache_dir:
            (args.cache_dir / (hashlib.sha256(url.encode()).hexdigest() + ".html")).write_text(response.text)
        return response.text

    def load(task):
        source, url = task
        try:
            row = parse_listing(source, fetch(url), url, checked)
            images = []
            for image in row["image_urls"].split("|"):
                try:
                    with requests.get(image, stream=True, timeout=15) as response:
                        if refresh.image_response_is_usable(response):
                            images.append(image)
                except requests.RequestException:
                    pass
            if not images:
                raise ValueError("No working exact product photo")
            row["image_urls"] = "|".join(images)
            attrs = json.loads(row["attributes"])
            attrs["listingIdentity"]["images"] = images
            row["attributes"] = json.dumps(attrs, ensure_ascii=False)
            return row
        except (requests.RequestException, ValueError, KeyError, TypeError) as error:
            failures.append({"source": source, "url": url, "reason": str(error)[:220]})

    for source in args.sources.split(","):
        name, catalogs, pattern, host = SOURCES[source]
        links, fetched = [], 0
        for catalog in catalogs:
            try:
                soup = BeautifulSoup(fetch(catalog, exact=False), "html.parser")
                for a in soup.select("a[href]"):
                    url = urljoin(catalog, a["href"]).split("#")[0]
                    if not re.search(pattern, urlsplit(url).path):
                        continue
                    if source == "kai":
                        url = "https://motifiti.co.ke/vehicle/kaikaro/" + url.rstrip("/").rsplit("/", 1)[-1]
                    if urlsplit(url).netloc.removeprefix("www.") == host:
                        links.append(url)
                fetched += 1
            except (requests.RequestException, ValueError) as error:
                failures.append({"source": source, "url": catalog, "reason": str(error)[:220]})
        links = list(dict.fromkeys(links))
        links.sort(key=lambda u: key(u) in known)  # New inventory before routine checks.
        candidates = list(dict.fromkeys(links[:args.candidate_limit] + [r["source_url"] for r in known.values() if r.get("source_site") == name]))
        if args.new_only:
            candidates = [u for u in candidates if key(u) not in known]
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            found = [r for r in pool.map(load, [(source, u) for u in candidates]) if r]
        incoming.extend(found)
        reports[source] = {"catalogsFetched": fetched, "discovered": len(links), "checked": len(candidates), "verified": len(found)}
        print(f"{name}: {len(links)} discovered, {len(found)} verified", flush=True)
    merged = {str(f.relative_to(ROOT)): refresh.merge(f, incoming, new_only=args.new_only) for f in feeds} if incoming and not args.dry_run else {}
    report = {"checkedAt": checked, "sources": reports, "eligible": len(incoming), "merged": merged, "failures": failures}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({k: v for k, v in report.items() if k != "failures"}, indent=2))
    if any(not r["discovered"] or (not r["verified"] and (r["checked"] or not args.new_only)) for r in reports.values()):
        raise SystemExit("Incomplete source coverage; existing inventory retained and failed sources require retry")


if __name__ == "__main__":
    main()
