#!/usr/bin/env python3
"""Import current public Guyana electronics and property listings.

Sources:
* Samtronix Guyana's public Shopify catalog for in-stock electronics.
* Guyana Home Hub's public verified property pages for sale and rent.

Only listings with a public Guyana phone number and at least one image are
eligible. The importer never signs in, opens private dashboards, or uses
transactional endpoints.
"""

from __future__ import annotations

import argparse
import csv
import html
import io
import json
import re
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urljoin
from urllib.request import Request, urlopen

from bs4 import BeautifulSoup

from guyana_scrape import DEFAULT_CSV, clean, merge_csv


SAMTRONIX_BASE = "https://samtronixguyana.com"
SAMTRONIX_CATALOG = f"{SAMTRONIX_BASE}/products.json?limit=250"
SAMTRONIX_PHONE = "+5927000279"
HOME_HUB_BASE = "https://www.guyanahomehub.com"
HOME_HUB_PAGES = {
    "for_sale": f"{HOME_HUB_BASE}/properties/buy",
    "for_rent": f"{HOME_HUB_BASE}/properties/rent",
}
USER_AGENT = "6ixo-public-listing-import/1.0 (+https://6ixo.com)"
MANAGED_SOURCES = {"Samtronix Guyana", "Guyana Home Hub"}


def request_text(url: str, timeout: int = 60) -> str:
    request = Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/json,text/html;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        },
    )
    with urlopen(request, timeout=timeout) as response:
        return response.read().decode(response.headers.get_content_charset() or "utf-8", errors="replace")


def utc_iso(value: str | datetime | None = None) -> str:
    if isinstance(value, datetime):
        parsed = value
    elif value:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    else:
        parsed = datetime.now(timezone.utc)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def normalized_phone(value: Any) -> str:
    digits = re.sub(r"\D", "", str(value or ""))
    if len(digits) == 7:
        digits = f"592{digits}"
    return f"+{digits}" if len(digits) == 10 and digits.startswith("592") else ""


def format_gyd(value: Any, suffix: str = "") -> str:
    try:
        amount = float(str(value))
    except (TypeError, ValueError):
        return ""
    return f"G$ {amount:,.0f}{suffix}"


def electronics_subcategory(product_type: str, title: str) -> str:
    text = f"{product_type} {title}".lower()
    if re.search(r"phone|iphone|samsung galaxy|xiaomi|redmi|tecno|smartwatch|wearable|accessor", text):
        return "phones_accessories"
    if re.search(r"laptop|computer|tablet|ipad|printer|monitor|ssd|hard drive", text):
        return "computers_tablets"
    if re.search(r"gaming|console|playstation|xbox|controller", text):
        return "gaming"
    if re.search(r"television|smart tv|speaker|headphone|earbud|sound|audio|projector", text):
        return "tv_audio"
    if re.search(r"camera|drone", text):
        return "cameras"
    return "other"


def normalize_samtronix_product(product: dict[str, Any], *, status: str) -> dict[str, str] | None:
    available_variants = [variant for variant in product.get("variants") or [] if variant.get("available") is True]
    images = [clean(image.get("src")) for image in product.get("images") or [] if clean(image.get("src"))][:4]
    if not available_variants or not images:
        return None
    variant = min(available_variants, key=lambda item: float(item.get("price") or 0) or float("inf"))
    price = clean(variant.get("price"))
    title = clean(product.get("title"))
    handle = clean(product.get("handle"))
    source_url = f"{SAMTRONIX_BASE}/products/{handle}"
    published_at = utc_iso(product.get("published_at"))
    description = clean(BeautifulSoup(product.get("body_html") or "", "html.parser").get_text(" "))
    product_type = clean(product.get("product_type"))
    attributes = {
        "parser": "shopify_samtronix_guyana",
        "sourcePublishedAt": published_at,
        "sourceUpdatedAt": utc_iso(product.get("updated_at")) if product.get("updated_at") else "",
        "productType": product_type,
        "vendor": clean(product.get("vendor")),
        "tags": product.get("tags") if isinstance(product.get("tags"), list) else [],
        "variantId": str(variant.get("id") or ""),
        "contactSource": "public Samtronix Guyana store phone",
        "stockStatus": "in_stock",
    }
    row = {
        "id": f"samtronix-gy-{product.get('id')}",
        "status": status,
        "target_surface": "marketplace",
        "app_category": "electronics",
        "app_subcategory": electronics_subcategory(product_type, title),
        "title": title,
        "price_text": format_gyd(price),
        "price_value": price,
        "currency": "GYD",
        "city": "Georgetown",
        "country": "Guyana",
        "seller": "Samtronix Guyana",
        "phone": SAMTRONIX_PHONE,
        "description": description or f"In-stock {product_type or 'electronics'} product from Samtronix Guyana.",
        "image_urls": "|".join(images),
        "source_site": "Samtronix Guyana",
        "source_url": source_url,
        "scraped_at": published_at,
        "make": clean(product.get("vendor")),
        "model": "",
        "trim": "",
        "year": "",
        "condition": "new",
        "transmission": "",
        "color": "",
        "mileage_km": "",
        "attributes": json.dumps(attributes, ensure_ascii=False, separators=(",", ":")),
        "source_availability": "active",
        "source_availability_checked_at": utc_iso(),
        "source_http_status": "200",
        "source_unavailable_reason": "",
        "source_last_seen_at": utc_iso(),
        "source_resolved_url": source_url,
        "source_miss_count": "0",
        "source_miss_recorded_at": "",
        "sync_visibility": "visible",
        "sync_visibility_reason": "",
    }
    required = (row["title"], row["price_value"], row["phone"], row["image_urls"], row["source_url"])
    return row if all(required) else None


def scrape_samtronix(*, limit: int, status: str) -> list[dict[str, str]]:
    payload = json.loads(request_text(SAMTRONIX_CATALOG))
    products = payload.get("products") if isinstance(payload, dict) else []
    rows = [normalize_samtronix_product(product, status=status) for product in products or []]
    eligible = [row for row in rows if row]
    eligible.sort(key=lambda row: json.loads(row["attributes"])["sourcePublishedAt"], reverse=True)
    return eligible[: max(0, limit)]


def home_hub_links(page_html: str) -> list[str]:
    soup = BeautifulSoup(page_html, "html.parser")
    links: list[str] = []
    seen: set[str] = set()
    for anchor in soup.find_all("a", href=True):
        href = clean(anchor.get("href"))
        if not re.fullmatch(r"/properties/(?!buy|rent|commercial|developments)[a-z0-9-]+", href):
            continue
        url = urljoin(HOME_HUB_BASE, href)
        if url not in seen:
            seen.add(url)
            links.append(url)
    return links


def decode_home_hub_property(page_html: str) -> dict[str, Any] | None:
    marker = page_html.find('\\"owner_whatsapp\\"')
    start = page_html.rfind('{\\"id\\"', 0, marker)
    if marker < 0 or start < 0:
        return None
    script_end = page_html.find("</script>", marker)
    encoded_tail = page_html[start:script_end]
    string_end = encoded_tail.rfind('\\n\"]')
    if string_end > 0:
        encoded_tail = encoded_tail[:string_end]
    try:
        decoded_tail = json.loads(f'"{encoded_tail}"')
        value, _ = json.JSONDecoder().raw_decode(decoded_tail)
    except (json.JSONDecodeError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def timestamp_from_images(images: list[str]) -> str:
    timestamps: list[int] = []
    for url in images:
        match = re.search(r"/(1[0-9]{12})-[^/]+\.(?:jpe?g|png|webp)(?:\?|$)", url, re.I)
        if match:
            timestamps.append(int(match.group(1)))
    if not timestamps:
        return utc_iso()
    return utc_iso(datetime.fromtimestamp(max(timestamps) / 1000, tz=timezone.utc))


def normalize_home_hub_property(
    property_data: dict[str, Any],
    source_url: str,
    *,
    listing_type: str,
    status: str,
) -> dict[str, str] | None:
    if clean(property_data.get("status")).lower() != "active":
        return None
    images = [clean(value) for value in property_data.get("images") or [] if clean(value)][:4]
    profile = property_data.get("agent_profile") if isinstance(property_data.get("agent_profile"), dict) else {}
    phone = normalized_phone(property_data.get("owner_whatsapp") or profile.get("phone"))
    if not phone or not images:
        return None
    source_id = clean(property_data.get("id")) or clean(property_data.get("slug"))
    source_posted_at = timestamp_from_images(images)
    first_name = clean(profile.get("first_name"))
    last_name = clean(profile.get("last_name"))
    seller = clean(f"{first_name} {last_name}") or "Guyana Home Hub verified agent"
    property_type = clean(property_data.get("property_type"))
    price = clean(property_data.get("price"))
    neighborhood = clean(property_data.get("neighborhood"))
    city = clean(neighborhood.split(",", 1)[0]) or clean(property_data.get("city")) or "Georgetown"
    rent_suffix = "/month" if listing_type == "for_rent" else ""
    description = clean(property_data.get("description"))
    if not description or re.fullmatch(r"\$[a-z0-9]+", description, re.I):
        listing_label = "for rent" if listing_type == "for_rent" else "for sale"
        facts = []
        if property_data.get("bedrooms") not in (None, ""):
            facts.append(f"{clean(property_data.get('bedrooms'))} bedroom")
        if property_data.get("bathrooms") not in (None, ""):
            facts.append(f"{clean(property_data.get('bathrooms'))} bathroom")
        fact_text = f" Features: {', '.join(facts)}." if facts else ""
        description = (
            f"{property_type or 'Property'} {listing_label} in {city}, Guyana."
            f"{fact_text} Contact {seller} for full details and current availability."
        )
    attributes = {
        "parser": "guyana_home_hub_public_property",
        "sourcePostedAt": source_posted_at,
        "propertyType": property_type,
        "bedrooms": property_data.get("bedrooms"),
        "bathrooms": property_data.get("bathrooms"),
        "listingType": listing_type,
        "propertyStatus": clean(property_data.get("status")),
        "agentSlug": clean(profile.get("slug")),
        "verifiedAgent": bool(profile.get("is_verified_agent")),
        "contactSource": "public listing owner/agent WhatsApp",
    }
    row = {
        "id": f"homehub-gy-{source_id}",
        "status": status,
        "target_surface": "marketplace",
        "app_category": "real_estate",
        "app_subcategory": listing_type,
        "title": clean(property_data.get("title")),
        "price_text": format_gyd(price, rent_suffix),
        "price_value": price,
        "currency": clean(property_data.get("currency")) or "GYD",
        "city": city,
        "country": "Guyana",
        "seller": seller,
        "phone": phone,
        "description": description,
        "image_urls": "|".join(images),
        "source_site": "Guyana Home Hub",
        "source_url": source_url,
        "scraped_at": source_posted_at,
        "make": "",
        "model": "",
        "trim": "",
        "year": clean(property_data.get("year_built")),
        "condition": "good",
        "transmission": "",
        "color": "",
        "mileage_km": "",
        "attributes": json.dumps(attributes, ensure_ascii=False, separators=(",", ":")),
        "source_availability": "active",
        "source_availability_checked_at": utc_iso(),
        "source_http_status": "200",
        "source_unavailable_reason": "",
        "source_last_seen_at": utc_iso(),
        "source_resolved_url": source_url,
        "source_miss_count": "0",
        "source_miss_recorded_at": "",
        "sync_visibility": "visible",
        "sync_visibility_reason": "",
    }
    required = (row["id"], row["title"], row["phone"], row["image_urls"], row["source_url"])
    return row if all(required) else None


def scrape_home_hub(*, limit: int, status: str, delay: float) -> list[dict[str, str]]:
    if limit <= 0:
        return []
    per_type = max(1, (limit + 1) // 2)
    rows: list[dict[str, str]] = []
    for listing_type, page_url in HOME_HUB_PAGES.items():
        links = home_hub_links(request_text(page_url))[:per_type]
        for source_url in links:
            property_data = decode_home_hub_property(request_text(source_url))
            if property_data:
                row = normalize_home_hub_property(
                    property_data,
                    source_url,
                    listing_type=listing_type,
                    status=status,
                )
                if row:
                    rows.append(row)
            if delay > 0:
                time.sleep(delay)
    rows.sort(key=lambda row: row["scraped_at"], reverse=True)
    return rows[:limit]


def csv_fieldnames(path: Path) -> list[str]:
    with path.open(newline="", encoding="utf-8-sig") as handle:
        return list(csv.DictReader(handle).fieldnames or [])


def align_rows_to_csv(path: Path, rows: list[dict[str, str]]) -> list[dict[str, str]]:
    """Keep the deployed CSV schema stable while allowing it to evolve later."""
    headers = csv_fieldnames(path)
    return [{header: row.get(header, "") for header in headers} for row in rows]


def prune_missing_managed_rows(
    path: Path,
    current_rows: list[dict[str, str]],
    *,
    dry_run: bool,
) -> int:
    """Remove older managed-source rows that are no longer in the current feed."""
    raw_text = path.read_text(encoding="utf-8-sig")
    with io.StringIO(raw_text, newline="") as handle:
        reader = csv.DictReader(handle)
        headers = list(reader.fieldnames or [])
        rows = list(reader)

    current_urls: dict[str, set[str]] = {source: set() for source in MANAGED_SOURCES}
    for row in current_rows:
        source = clean(row.get("source_site"))
        source_url = clean(row.get("source_url"))
        if source in current_urls and source_url:
            current_urls[source].add(source_url)

    kept_rows: list[dict[str, str]] = []
    removed = 0
    for row in rows:
        source = clean(row.get("source_site"))
        is_managed_guyana_row = clean(row.get("country")).lower() == "guyana" and source in MANAGED_SOURCES
        if is_managed_guyana_row and clean(row.get("source_url")) not in current_urls[source]:
            removed += 1
            continue
        kept_rows.append(row)

    if removed and not dry_run:
        with tempfile.NamedTemporaryFile(
            "w",
            newline="",
            encoding="utf-8",
            dir=path.parent,
            delete=False,
        ) as handle:
            writer = csv.DictWriter(handle, fieldnames=headers, extrasaction="ignore", lineterminator="\n")
            writer.writeheader()
            writer.writerows({header: row.get(header, "") for header in headers} for row in kept_rows)
            temporary = Path(handle.name)
        temporary.replace(path)
    return removed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--csv", type=Path, default=DEFAULT_CSV)
    parser.add_argument("--max-electronics", type=int, default=12)
    parser.add_argument("--max-properties", type=int, default=20)
    parser.add_argument("--delay", type=float, default=0.25)
    parser.add_argument("--status", choices=("pending", "published"), default="published")
    parser.add_argument("--refresh-existing", action="store_true")
    parser.add_argument("--prune-missing", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    electronics = scrape_samtronix(limit=max(0, args.max_electronics), status=args.status)
    properties = scrape_home_hub(limit=max(0, args.max_properties), status=args.status, delay=max(0, args.delay))
    normalized = electronics + properties
    by_url = {row["source_url"]: row for row in normalized}
    normalized = sorted(by_url.values(), key=lambda row: row["scraped_at"], reverse=True)
    removed = prune_missing_managed_rows(args.csv, normalized, dry_run=args.dry_run) if args.prune_missing else 0
    normalized = align_rows_to_csv(args.csv, normalized)
    inserted, updated = merge_csv(
        args.csv,
        normalized,
        dry_run=args.dry_run,
        refresh_existing=args.refresh_existing,
    )
    print(
        json.dumps(
            {
                "sources": {
                    "Samtronix Guyana": len(electronics),
                    "Guyana Home Hub": len(properties),
                },
                "eligible_public_listings": len(normalized),
                "inserted": inserted,
                "updated": updated,
                "removed": removed,
                "status": args.status,
                "dry_run": args.dry_run,
            },
            indent=2,
        )
    )
    return 0 if normalized else 2


if __name__ == "__main__":
    raise SystemExit(main())
