#!/usr/bin/env python3
"""Import current public Dubai marketplace listings from OpenSooq.

The importer reads the structured listing data exposed on OpenSooq search and
detail pages, keeps only Dubai inventory, and preserves links to the source ad.
Seller contact remains on OpenSooq rather than being copied into 6ixo.
"""

from __future__ import annotations

import argparse
import csv
import html
import json
import re
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


USER_AGENT = "6ixo-marketplace-dubai-import/1.0 (+https://6ixo.com)"
DEFAULT_OUTPUT = Path("data/dubai-listings.csv")
DEFAULT_LIMIT_PER_SOURCE = 30
SOURCE_CONFIGS = (
    {
        "url": "https://ae.opensooq.com/en/dubai/cars/cars-for-sale/used",
        "target_surface": "vehicles",
        "app_category": "vehicles",
        "app_subcategory": "vehicles",
        "source_category": "Used cars",
    },
    {
        "url": "https://ae.opensooq.com/en/dubai/mobile-phones-tablets",
        "target_surface": "marketplace",
        "app_category": "electronics",
        "app_subcategory": "phones_accessories",
        "source_category": "Phones and tablets",
    },
    {
        "url": "https://ae.opensooq.com/en/dubai/home-garden",
        "target_surface": "marketplace",
        "app_category": "buy_sell",
        "app_subcategory": "furniture",
        "source_category": "Home and furniture",
    },
)

CSV_FIELDS = (
    "id", "status", "target_surface", "app_category", "app_subcategory",
    "title", "price_text", "price_value", "currency", "city", "country",
    "seller", "phone", "description", "image_urls", "source_site",
    "source_url", "scraped_at", "make", "model", "trim", "year",
    "condition", "transmission", "color", "mileage_km", "attributes",
    "source_availability", "source_availability_checked_at",
    "source_http_status", "source_unavailable_reason", "source_last_seen_at",
    "source_resolved_url", "source_miss_count", "source_miss_recorded_at",
    "sync_visibility", "sync_visibility_reason",
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def clean(value: Any) -> str:
    return re.sub(r"\s+", " ", html.unescape(str(value or ""))).strip()


def redact_contact_details(value: Any) -> str:
    text = clean(value)
    text = re.sub(
        r"\+?\{phone_key_\d+\}?",
        "the contact option on the OpenSooq listing",
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(
        r"(?<!\w)(?:\+|00)?\d[\d\s:/().-]{7,}\d(?!\w)",
        "the contact option on the OpenSooq listing",
        text,
    )
    text = re.sub(r"\s+", " ", text).strip(" ,;:-")
    return text


def fetch_html(url: str, timeout: int = 45) -> str:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "en-CA,en;q=0.9",
            "User-Agent": USER_AGENT,
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        if response.status != 200:
            raise RuntimeError(f"{url} returned HTTP {response.status}")
        return response.read().decode("utf-8", errors="replace")


def json_ld_blocks(source_html: str) -> list[Any]:
    pattern = re.compile(
        r"<script\b[^>]*\btype=[\"']application/ld\+json[\"'][^>]*>(.*?)</script>",
        re.IGNORECASE | re.DOTALL,
    )
    blocks: list[Any] = []
    for raw in pattern.findall(source_html):
        try:
            blocks.append(json.loads(html.unescape(raw)))
        except (json.JSONDecodeError, TypeError):
            continue
    return blocks


def iter_json_ld_nodes(value: Any) -> Iterable[dict[str, Any]]:
    if isinstance(value, list):
        for entry in value:
            yield from iter_json_ld_nodes(entry)
        return
    if not isinstance(value, dict):
        return
    yield value
    graph = value.get("@graph")
    if isinstance(graph, list):
        for entry in graph:
            yield from iter_json_ld_nodes(entry)


def extract_item_list(source_html: str) -> list[dict[str, Any]]:
    for block in json_ld_blocks(source_html):
        for node in iter_json_ld_nodes(block):
            if node.get("@type") != "ItemList":
                continue
            output: list[dict[str, Any]] = []
            for entry in node.get("itemListElement") or []:
                item = entry.get("item") if isinstance(entry, dict) else None
                if isinstance(item, dict):
                    output.append(item)
            if output:
                return output
    return []


def normalize_image_url(value: Any) -> str:
    url = clean(value)
    if not url.startswith("https://opensooq-imagesv2.os-cdn.com/"):
        return ""
    return re.sub(r"/previews/\d+x\d+/", "/previews/2048x0/", url, count=1)


def image_url_from_schema(value: Any) -> str:
    if isinstance(value, str):
        return normalize_image_url(value)
    if not isinstance(value, dict):
        return ""
    return normalize_image_url(value.get("contentUrl") or value.get("url"))


def extract_preloaded_listing_images(source_html: str) -> list[str]:
    head = source_html.split("</head>", 1)[0]
    urls: list[str] = []
    for tag in re.findall(r"<link\b[^>]*>", head, flags=re.IGNORECASE):
        if not re.search(r"\brel=[\"']preload[\"']", tag, flags=re.IGNORECASE):
            continue
        if not re.search(r"\bas=[\"']image[\"']", tag, flags=re.IGNORECASE):
            continue
        match = re.search(r"\bhref=[\"']([^\"']+)[\"']", tag, flags=re.IGNORECASE)
        url = normalize_image_url(match.group(1) if match else "")
        if url and url not in urls:
            urls.append(url)
    return urls[:12]


def schema_type(node: dict[str, Any]) -> set[str]:
    raw = node.get("@type")
    values = raw if isinstance(raw, list) else [raw]
    return {clean(value).lower() for value in values if clean(value)}


def extract_detail_listing(source_html: str, source_url: str) -> dict[str, Any]:
    candidates: list[dict[str, Any]] = []
    breadcrumb_text = ""
    for block in json_ld_blocks(source_html):
        for node in iter_json_ld_nodes(block):
            types = schema_type(node)
            if "breadcrumblist" in types:
                breadcrumb_text = " ".join(
                    clean(entry.get("name"))
                    for entry in node.get("itemListElement") or []
                    if isinstance(entry, dict)
                )
            if types.intersection({"vehicle", "product"}) and clean(node.get("url")) == source_url:
                candidates.append(node)

    listing = max(candidates, key=lambda item: len(clean(item.get("description"))), default={})
    image = listing.get("image") if isinstance(listing.get("image"), dict) else {}
    location = clean(image.get("contentLocation"))
    offers = listing.get("offers") if isinstance(listing.get("offers"), dict) else {}
    images = extract_preloaded_listing_images(source_html)
    primary = image_url_from_schema(listing.get("image"))
    if primary and primary not in images:
        images.insert(0, primary)
    published = clean(image.get("datePublished") or image.get("uploadDate"))
    return {
        "title": clean(listing.get("name")),
        "description": clean(listing.get("description") or offers.get("description")),
        "location": location,
        "breadcrumb": breadcrumb_text,
        "published": published,
        "images": images[:12],
    }


def extract_offer(item: dict[str, Any]) -> dict[str, Any]:
    offer = item.get("offers")
    return offer if isinstance(offer, dict) else {}


def extract_neighborhood(item: dict[str, Any]) -> str:
    offer = extract_offer(item)
    area = offer.get("areaServed") if isinstance(offer.get("areaServed"), dict) else {}
    address = area.get("address") if isinstance(area.get("address"), dict) else {}
    return clean(address.get("addressLocality"))


def listing_id(source_url: str) -> str:
    match = re.search(r"/search/(\d+)", source_url)
    return f"opensooq-ae-{match.group(1)}" if match else ""


def parse_year(*values: Any) -> str:
    match = re.search(r"\b(?:19|20)\d{2}\b", " ".join(clean(value) for value in values))
    return match.group(0) if match else ""


def row_from_listing(
    item: dict[str, Any],
    config: dict[str, str],
    detail: dict[str, Any],
    checked_at: str,
) -> dict[str, str] | None:
    source_url = clean(item.get("url"))
    row_id = listing_id(source_url)
    offer = extract_offer(item)
    availability = clean(offer.get("availability")).lower()
    if not row_id or not source_url.startswith("https://ae.opensooq.com/en/search/"):
        return None
    if availability and not availability.endswith("/instock"):
        return None

    location_evidence = clean(
        " ".join((detail.get("location", ""), detail.get("breadcrumb", "")))
    ).lower()
    list_region = clean(
        ((offer.get("areaServed") or {}).get("address") or {}).get("addressRegion")
        if isinstance(offer.get("areaServed"), dict)
        else ""
    )
    if location_evidence and "dubai" not in location_evidence and list_region.lower() != "dubai":
        return None

    title = clean(detail.get("title") or item.get("name"))
    description = redact_contact_details(detail.get("description") or item.get("description"))
    price_value = clean(offer.get("price"))
    currency = clean(offer.get("priceCurrency") or "AED") or "AED"
    images = [
        url for url in detail.get("images") or []
        if normalize_image_url(url)
    ]
    primary = image_url_from_schema(item.get("image"))
    if primary and primary not in images:
        images.insert(0, primary)
    if not title or not price_value or not images:
        return None

    neighborhood = extract_neighborhood(item)
    attributes = {
        "parser": "opensooq_json_ld",
        "sourceCategory": config["source_category"],
        "sourceListUrl": config["url"],
        "neighborhood": neighborhood,
        "sourceLocation": clean(detail.get("location")) or "Dubai, UAE",
        "contactSource": "OpenSooq source listing",
        "imageQuality": "source_gallery_2048",
    }
    row = {field: "" for field in CSV_FIELDS}
    row.update({
        "id": row_id,
        "status": "published",
        "target_surface": config["target_surface"],
        "app_category": config["app_category"],
        "app_subcategory": config["app_subcategory"],
        "title": title,
        "price_text": f"AED {int(float(price_value)):,}" if re.fullmatch(r"\d+(?:\.\d+)?", price_value) else price_value,
        "price_value": price_value,
        "currency": currency,
        "city": "Dubai",
        "country": "United Arab Emirates",
        "seller": "OpenSooq seller",
        "phone": "",
        "description": description,
        "image_urls": "|".join(dict.fromkeys(images)),
        "source_site": "OpenSooq",
        "source_url": source_url,
        "scraped_at": checked_at,
        "year": parse_year(title, description),
        "condition": "used" if "usedcondition" in clean(item.get("itemCondition")).lower() else "",
        "attributes": json.dumps(attributes, ensure_ascii=False, separators=(",", ":")),
        "source_availability": "active",
        "source_availability_checked_at": checked_at,
        "source_http_status": "200",
        "source_last_seen_at": checked_at,
        "source_resolved_url": source_url,
        "source_miss_count": "0",
        "sync_visibility": "visible",
    })
    return row


def load_detail(item: dict[str, Any], config: dict[str, str]) -> tuple[dict[str, Any], dict[str, str], dict[str, Any]]:
    source_url = clean(item.get("url"))
    source_html = fetch_html(source_url)
    return item, config, extract_detail_listing(source_html, source_url)


def scrape(limit_per_source: int = DEFAULT_LIMIT_PER_SOURCE, workers: int = 6) -> list[dict[str, str]]:
    queued: list[tuple[dict[str, Any], dict[str, str]]] = []
    for config in SOURCE_CONFIGS:
        source_html = fetch_html(config["url"])
        items = extract_item_list(source_html)
        if not items:
            raise RuntimeError(f"OpenSooq returned no structured listings for {config['url']}")
        queued.extend((item, config) for item in items[:limit_per_source])

    checked_at = utc_now()
    rows: list[dict[str, str]] = []
    errors: list[str] = []
    with ThreadPoolExecutor(max_workers=max(1, workers)) as executor:
        futures = [executor.submit(load_detail, item, config) for item, config in queued]
        for future in as_completed(futures):
            try:
                item, config, detail = future.result()
                row = row_from_listing(item, config, detail, checked_at)
                if row:
                    rows.append(row)
            except (OSError, RuntimeError, urllib.error.URLError) as error:
                errors.append(str(error))

    if errors:
        print(f"detail_errors={len(errors)}", file=sys.stderr)
    rows.sort(key=lambda row: (row["app_category"], row["id"]))
    unique: dict[str, dict[str, str]] = {}
    for row in rows:
        unique[row["source_url"]] = row
    return list(unique.values())


def write_csv(rows: Iterable[dict[str, str]], output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_FIELDS)
        writer.writeheader()
        writer.writerows(rows)


def main() -> int:
    parser = argparse.ArgumentParser(description="Import active Dubai OpenSooq listings.")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--limit-per-source", type=int, default=DEFAULT_LIMIT_PER_SOURCE)
    parser.add_argument("--workers", type=int, default=6)
    args = parser.parse_args()

    started = time.monotonic()
    rows = scrape(max(1, args.limit_per_source), max(1, args.workers))
    if not rows:
        print("No active Dubai listings were imported; existing output was left unchanged.", file=sys.stderr)
        return 1
    write_csv(rows, args.output)
    categories: dict[str, int] = {}
    for row in rows:
        categories[row["app_category"]] = categories.get(row["app_category"], 0) + 1
    print(
        f"wrote={len(rows)} output={args.output} categories={json.dumps(categories, sort_keys=True)} "
        f"seconds={time.monotonic() - started:.1f}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
