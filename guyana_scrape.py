#!/usr/bin/env python3
"""Import public Guyana vehicle listings from carsforsale.gy via Crawl4AI.

The source sitemap supplies public listing URLs and image galleries. Crawl4AI
renders each public detail page so this importer can normalize the vehicle,
seller/dealer profile, location, and seller-enabled WhatsApp contact into the
CSV consumed by 6ixo. Private/reveal-phone and account endpoints are never
requested.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import re
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen
from xml.etree import ElementTree as ET

from bs4 import BeautifulSoup


SOURCE_SITE = "carsforsale.gy"
SOURCE_BASE = "https://carsforsale.gy"
SITEMAP_URL = f"{SOURCE_BASE}/sitemap-listings.xml"
DEFAULT_CRAWL4AI_URL = "http://10.0.0.164:11235/crawl"
DEFAULT_CSV = Path("data/scraped-listings.csv")


def clean(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def request_bytes(url: str, *, data: bytes | None = None, content_type: str = "") -> bytes:
    headers = {
        "User-Agent": "6ixo-public-listing-import/1.0 (+https://6ixo.com)",
        "Accept": "application/json,text/html,application/xml;q=0.9,*/*;q=0.8",
    }
    if content_type:
        headers["Content-Type"] = content_type
    request = Request(url, data=data, headers=headers, method="POST" if data is not None else "GET")
    with urlopen(request, timeout=180) as response:
        return response.read()


def fetch_sitemap() -> list[dict[str, Any]]:
    root = ET.fromstring(request_bytes(SITEMAP_URL))
    ns = {
        "s": "http://www.sitemaps.org/schemas/sitemap/0.9",
        "image": "http://www.google.com/schemas/sitemap-image/1.1",
    }
    listings: list[dict[str, Any]] = []
    for node in root.findall("s:url", ns):
        url = clean(node.findtext("s:loc", default="", namespaces=ns))
        match = re.search(r"/listing/(\d+)/", url)
        if not url or not match:
            continue
        images = [
            clean(image.findtext("image:loc", default="", namespaces=ns))
            for image in node.findall("image:image", ns)
        ]
        listings.append(
            {
                "listing_id": match.group(1),
                "url": url,
                "lastmod": clean(node.findtext("s:lastmod", default="", namespaces=ns)),
                "images": list(dict.fromkeys(image for image in images if image)),
            }
        )
    return sorted(listings, key=lambda item: (item["lastmod"], int(item["listing_id"])), reverse=True)


def crawl_pages(endpoint: str, urls: list[str]) -> list[dict[str, Any]]:
    if not urls:
        return []
    payload = {
        "urls": urls,
        "browser_config": {
            "headless": True,
            "viewport": {"width": 1365, "height": 1800},
            "verbose": False,
        },
        "crawler_config": {
            "stream": False,
            "cache_mode": "bypass",
            "wait_until": "load",
            "wait_for": "css:body",
            "page_timeout": 60000,
            "delay_before_return_html": 0.5,
            "scan_full_page": False,
            # The seller contact card is sticky; Crawl4AI's overlay remover
            # otherwise strips the public WhatsApp link with the card.
            "remove_overlay_elements": False,
            "remove_consent_popups": True,
        },
    }
    raw = request_bytes(endpoint, data=json.dumps(payload).encode("utf-8"), content_type="application/json")
    body = json.loads(raw.decode("utf-8"))
    if isinstance(body, list):
        return body
    for key in ("results", "data"):
        if isinstance(body.get(key), list):
            return body[key]
    if isinstance(body.get("body"), dict):
        nested = body["body"]
        return nested.get("results") or nested.get("data") or []
    return []


def json_ld_car(soup: BeautifulSoup) -> dict[str, Any]:
    for script in soup.find_all("script", attrs={"type": "application/ld+json"}):
        try:
            value = json.loads(script.string or script.get_text() or "")
        except (TypeError, json.JSONDecodeError):
            continue
        candidates = value if isinstance(value, list) else [value]
        for candidate in candidates:
            if isinstance(candidate, dict) and candidate.get("@type") in {"Car", "Vehicle"}:
                return candidate
    return {}


def detail_fields(soup: BeautifulSoup) -> dict[str, str]:
    fields: dict[str, str] = {}
    for term in soup.find_all("dt"):
        value = term.find_next_sibling("dd")
        if value:
            fields[clean(term.get_text()).lower()] = clean(value.get_text(" "))
    return fields


def public_whatsapp_phone(soup: BeautifulSoup) -> str:
    anchor = soup.find("a", href=re.compile(r"^https://wa\.me/", re.I))
    if not anchor:
        return ""
    digits = re.sub(r"\D", "", urlparse(anchor.get("href", "")).path)
    return f"+{digits}" if digits else ""


def normalize_condition(value: str) -> str:
    text = clean(value).lower()
    if "new" in text and "used" not in text:
        return "new"
    if "used" in text:
        return "used"
    return ""


def price_text(price: Any, currency: str) -> str:
    try:
        amount = float(str(price))
    except (TypeError, ValueError):
        return ""
    prefix = {"GYD": "G$", "USD": "US$"}.get(currency.upper(), f"{currency.upper()} ")
    return f"{prefix} {amount:,.0f}".replace("$ ", "$ ")


def image_urls_for(listing: dict[str, Any], soup: BeautifulSoup) -> list[str]:
    listing_id = listing["listing_id"]
    images = list(listing.get("images") or [])
    for image in soup.find_all("img", src=True):
        src = clean(image.get("src"))
        if f"media.carsforsale.gy/listings/{listing_id}/" in src and "/thumbs/" not in src:
            images.append(src)
    return list(dict.fromkeys(image for image in images if image))[:12]


def seller_profile(soup: BeautifulSoup, seller: str) -> str:
    for anchor in soup.find_all("a", href=re.compile(r"^/dealers/")):
        if not seller or seller.lower() in clean(anchor.get_text(" ")).lower():
            return urljoin(SOURCE_BASE, anchor.get("href", ""))
    return ""


def normalize_listing(
    listing: dict[str, Any],
    crawl_item: dict[str, Any],
    *,
    status: str,
    local_phones_only: bool,
) -> dict[str, str] | None:
    if not crawl_item.get("success", True):
        return None
    html = crawl_item.get("html") or crawl_item.get("cleaned_html") or ""
    if not html or re.search(r"Just a moment|cf-mitigated|challenges\.cloudflare\.com", html, re.I):
        return None
    soup = BeautifulSoup(html, "html.parser")
    car = json_ld_car(soup)
    if not car:
        return None

    phone = public_whatsapp_phone(soup)
    if not phone or (local_phones_only and not phone.startswith("+592")):
        return None

    images = image_urls_for(listing, soup)
    if not images:
        return None

    offers = car.get("offers") if isinstance(car.get("offers"), dict) else {}
    seller_data = offers.get("seller") if isinstance(offers.get("seller"), dict) else {}
    seller = clean(seller_data.get("name")) or "Private seller"
    fields = detail_fields(soup)
    brand = car.get("brand") if isinstance(car.get("brand"), dict) else {}
    make = clean(brand.get("name"))
    model = clean(car.get("model"))
    year = clean(car.get("vehicleModelDate") or car.get("modelDate"))
    title = clean(" ".join(part for part in (year, make, model) if part)) or clean(car.get("name"))
    source_url = clean(offers.get("url")) or listing["url"]
    currency = clean(offers.get("priceCurrency")).upper()
    raw_price = clean(offers.get("price"))
    location = fields.get("location", "")
    if "·" in location:
        city = clean(location.rsplit("·", 1)[-1])
    else:
        parenthetical_city = re.search(r"\(([^()]+)\)\s*$", location)
        city = clean(parenthetical_city.group(1)) if parenthetical_city else (location or "Georgetown")
    source_condition = fields.get("condition", "") or clean(car.get("itemCondition")).rsplit("/", 1)[-1]
    mileage = car.get("mileageFromOdometer") if isinstance(car.get("mileageFromOdometer"), dict) else {}
    mileage_value = clean(mileage.get("value")) or re.sub(r"\D", "", fields.get("mileage", ""))
    engine = car.get("vehicleEngine") if isinstance(car.get("vehicleEngine"), dict) else {}
    displacement = engine.get("engineDisplacement") if isinstance(engine.get("engineDisplacement"), dict) else {}
    profile_url = seller_profile(soup, seller)
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    attributes = {
        "parser": "crawl4ai_carsforsale_gy",
        "sourceLastModified": listing.get("lastmod", ""),
        "sellerProfileUrl": profile_url,
        "sellerType": clean(seller_data.get("@type")),
        "bodyType": clean(car.get("bodyType")),
        "fuelType": clean(car.get("fuelType")),
        "drivetrain": fields.get("drivetrain", ""),
        "engineCc": clean(displacement.get("value")) or re.sub(r"\D", "", fields.get("engine", "")),
        "sourceCondition": source_condition,
        "contactSource": "public seller-enabled WhatsApp",
    }
    description = clean(car.get("description"))

    row = {
        "id": f"carsforsale-gy-{listing['listing_id']}",
        "status": status,
        "target_surface": "vehicles",
        "app_category": "vehicles",
        "app_subcategory": "vehicles",
        "title": title,
        "price_text": price_text(raw_price, currency),
        "price_value": raw_price,
        "currency": currency,
        "city": city,
        "country": "Guyana",
        "seller": seller,
        "phone": phone,
        "description": description,
        "image_urls": "|".join(images),
        "source_site": SOURCE_SITE,
        "source_url": source_url,
        "scraped_at": now,
        "make": make,
        "model": model,
        "trim": "",
        "year": year,
        "condition": normalize_condition(source_condition),
        "transmission": clean(car.get("vehicleTransmission")) or fields.get("transmission", ""),
        "color": clean(car.get("color")) or fields.get("color", ""),
        "mileage_km": mileage_value,
        "attributes": json.dumps(attributes, ensure_ascii=False, separators=(",", ":")),
        "source_availability": "active",
        "source_availability_checked_at": now,
        "source_http_status": str(crawl_item.get("status_code") or 200),
        "source_unavailable_reason": "",
        "source_last_seen_at": now,
        "source_resolved_url": clean(crawl_item.get("redirected_url")) or source_url,
    }
    required = (row["title"], row["source_url"], row["seller"], row["phone"], row["image_urls"])
    return row if all(required) else None


def merge_csv(
    path: Path,
    new_rows: list[dict[str, str]],
    *,
    dry_run: bool,
    refresh_existing: bool,
) -> tuple[int, int]:
    raw_text = path.read_text(encoding="utf-8-sig")
    with io.StringIO(raw_text, newline="") as handle:
        reader = csv.DictReader(handle)
        headers = list(reader.fieldnames or [])
        rows = list(reader)

    deduplicated_new_rows: dict[str, dict[str, str]] = {}
    for row in new_rows:
        key = clean(row.get("source_url"))
        if not key:
            raise ValueError("Every imported listing must have a source_url")
        if key in deduplicated_new_rows:
            deduplicated_new_rows[key] = {**deduplicated_new_rows[key], **row}
        else:
            deduplicated_new_rows[key] = row
    new_rows = list(deduplicated_new_rows.values())

    original_headers = list(headers)
    for row in new_rows:
        for key in row:
            if key not in headers:
                headers.append(key)

    positions = {clean(row.get("source_url")): index for index, row in enumerate(rows) if clean(row.get("source_url"))}
    inserted = updated = 0
    inserted_rows: list[dict[str, str]] = []
    for new_row in new_rows:
        key = clean(new_row.get("source_url"))
        if key in positions:
            if refresh_existing:
                rows[positions[key]] = {**rows[positions[key]], **new_row}
                updated += 1
        else:
            positions[key] = len(rows)
            rows.append(new_row)
            inserted_rows.append(new_row)
            inserted += 1

    if not dry_run:
        if not inserted and not updated:
            return inserted, updated
        path.parent.mkdir(parents=True, exist_ok=True)
        # The normal backfill path only appends unseen source URLs. Preserve the
        # existing CSV bytes exactly so a small import does not create a large,
        # formatting-only diff across older user data.
        schema_unchanged = headers == original_headers
        if inserted and not updated and not refresh_existing and schema_unchanged:
            buffer = io.StringIO(newline="")
            writer = csv.DictWriter(buffer, fieldnames=headers, extrasaction="ignore", lineterminator="\n")
            for row in inserted_rows:
                writer.writerow({header: row.get(header, "") for header in headers})
            content = raw_text.rstrip("\r\n") + "\n" + buffer.getvalue()
            with tempfile.NamedTemporaryFile("w", newline="", encoding="utf-8", dir=path.parent, delete=False) as handle:
                handle.write(content)
                temporary = Path(handle.name)
            temporary.replace(path)
            return inserted, updated
        with tempfile.NamedTemporaryFile("w", newline="", encoding="utf-8", dir=path.parent, delete=False) as handle:
            writer = csv.DictWriter(handle, fieldnames=headers, extrasaction="ignore")
            writer.writeheader()
            writer.writerows({header: row.get(header, "") for header in headers} for row in rows)
            temporary = Path(handle.name)
        temporary.replace(path)
    return inserted, updated


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--crawl4ai-url", default=DEFAULT_CRAWL4AI_URL)
    parser.add_argument("--csv", type=Path, default=DEFAULT_CSV)
    parser.add_argument("--max-candidates", type=int, default=40)
    parser.add_argument("--max-listings", type=int, default=20)
    parser.add_argument("--batch-size", type=int, default=5)
    parser.add_argument("--status", choices=("pending", "published"), default="published")
    parser.add_argument("--allow-international-phones", action="store_true")
    parser.add_argument("--refresh-existing", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    candidates = fetch_sitemap()[: max(1, args.max_candidates)]
    by_url = {item["url"].rstrip("/"): item for item in candidates}
    normalized: list[dict[str, str]] = []
    for start in range(0, len(candidates), max(1, args.batch_size)):
        batch = candidates[start : start + max(1, args.batch_size)]
        for crawl_item in crawl_pages(args.crawl4ai_url, [item["url"] for item in batch]):
            key = clean(crawl_item.get("url") or crawl_item.get("redirected_url")).rstrip("/")
            listing = by_url.get(key)
            if not listing:
                continue
            row = normalize_listing(
                listing,
                crawl_item,
                status=args.status,
                local_phones_only=not args.allow_international_phones,
            )
            if row:
                normalized.append(row)
        if len(normalized) >= args.max_listings:
            break
        time.sleep(1)

    normalized.sort(key=lambda row: json.loads(row["attributes"]).get("sourceLastModified", ""), reverse=True)
    normalized = normalized[: max(1, args.max_listings)]
    inserted, updated = merge_csv(
        args.csv,
        normalized,
        dry_run=args.dry_run,
        refresh_existing=args.refresh_existing,
    )
    print(
        json.dumps(
            {
                "source": SOURCE_SITE,
                "candidates_checked": min(len(candidates), args.max_candidates),
                "eligible_public_listings": len(normalized),
                "inserted": inserted,
                "updated": updated,
                "status": args.status,
                "dry_run": args.dry_run,
            },
            indent=2,
        )
    )
    return 0 if normalized else 2


if __name__ == "__main__":
    raise SystemExit(main())
