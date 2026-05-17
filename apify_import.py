#!/usr/bin/env python3
"""Import Apify listing exports into the 6ixo scraped-listings CSV.

The website already loads data/scraped-listings.csv on startup. This script
normalizes flexible Apify dataset/export shapes into that CSV schema and dedupes
by source_url when present, then id.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any
from urllib.parse import urljoin
from urllib.request import Request, urlopen


DEFAULT_COLUMNS = [
    "id",
    "status",
    "target_surface",
    "app_category",
    "app_subcategory",
    "title",
    "price_text",
    "price_value",
    "currency",
    "city",
    "country",
    "seller",
    "phone",
    "description",
    "image_urls",
    "source_site",
    "source_url",
    "scraped_at",
    "make",
    "model",
    "trim",
    "year",
    "condition",
    "transmission",
    "color",
    "mileage_km",
    "attributes",
    "source_availability",
    "source_availability_checked_at",
    "source_http_status",
    "source_unavailable_reason",
    "source_last_seen_at",
    "source_resolved_url",
]


ALIASES = {
    "id": ["id", "listing_id", "listingId", "ad_id", "adId", "item_id", "itemId"],
    "title": ["title", "name", "heading", "listing_title", "listingTitle"],
    "price_text": ["price_text", "priceText", "price", "formattedPrice", "displayPrice"],
    "price_value": ["price_value", "priceValue", "amount", "priceAmount", "numericPrice"],
    "currency": ["currency", "priceCurrency", "currencyCode"],
    "city": ["city", "location.city", "address.city", "place.city", "region"],
    "country": ["country", "location.country", "address.country", "place.country"],
    "seller": ["seller", "sellerName", "seller_name", "seller.name", "author", "authorName", "username", "user.name"],
    "phone": ["phone", "phoneNumber", "sellerPhone", "contactPhone", "telephone"],
    "description": ["description", "desc", "details", "body", "text", "summary"],
    "source_site": ["source_site", "sourceSite", "site", "source", "platform"],
    "source_url": ["source_url", "sourceUrl", "url", "listingUrl", "listing_url", "link", "href", "pageUrl"],
    "source_category": ["category", "sourceCategory", "source_category", "listingCategory"],
    "make": ["make", "vehicle.make", "car.make"],
    "model": ["model", "vehicle.model", "car.model"],
    "trim": ["trim", "vehicle.trim", "car.trim"],
    "year": ["year", "vehicle.year", "car.year"],
    "condition": ["condition", "itemCondition"],
    "transmission": ["transmission", "vehicle.transmission", "car.transmission"],
    "color": ["color", "colour", "vehicle.color", "car.color"],
    "mileage_km": ["mileage_km", "mileageKm", "mileage", "odometer"],
}

IMAGE_ALIASES = [
    "image_urls",
    "imageUrls",
    "images",
    "photos",
    "pictures",
    "media",
    "mediaUrls",
    "image",
    "image_url",
    "thumbnail",
    "coverImage",
]


def clean(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    return re.sub(r"\s+", " ", str(value)).strip()


def get_path(data: Any, path: str) -> Any:
    current = data
    for part in path.split("."):
        if not isinstance(current, dict):
            return None
        lowered = {str(key).lower(): key for key in current.keys()}
        key = lowered.get(part.lower())
        if key is None:
            return None
        current = current[key]
    return current


def first_value(data: dict[str, Any], aliases: list[str]) -> Any:
    for alias in aliases:
        value = get_path(data, alias)
        if value not in (None, "", [], {}):
            return value
    return ""


def flatten_images(value: Any, base_url: str = "") -> list[str]:
    images: list[str] = []

    def add(candidate: Any) -> None:
        if candidate in (None, "", [], {}):
            return
        if isinstance(candidate, str):
            parts = re.split(r"\s*\|\s*|\s*,\s*", candidate)
            for part in parts:
                url = part.strip()
                if url:
                    images.append(urljoin(base_url, url) if base_url else url)
            return
        if isinstance(candidate, list):
            for item in candidate:
                add(item)
            return
        if isinstance(candidate, dict):
            for key in ("url", "src", "image", "thumbnail", "large", "medium", "original"):
                if key in candidate:
                    add(candidate[key])
                    return

    add(value)
    deduped = []
    seen = set()
    for url in images:
        if url and url not in seen:
            deduped.append(url)
            seen.add(url)
    return deduped


def get_images(data: dict[str, Any], base_url: str = "") -> list[str]:
    for alias in IMAGE_ALIASES:
        value = get_path(data, alias)
        images = flatten_images(value, base_url=base_url)
        if images:
            return images
    return []


def parse_price_value(price_text: str) -> str:
    text = clean(price_text)
    if not text or re.search(r"call|contact|free", text, re.I):
        return "0" if re.search(r"free", text, re.I) else ""
    match = re.search(r"\d[\d,]*(?:\.\d+)?", text)
    return match.group(0).replace(",", "") if match else ""


def infer_currency(price_text: str) -> str:
    text = clean(price_text)
    if re.search(r"JA\$|JMD", text, re.I):
        return "JMD"
    if re.search(r"GH|GHS|GH¢", text, re.I):
        return "GHS"
    if re.search(r"CAD|C\$", text, re.I):
        return "CAD"
    if re.search(r"KSH|KES", text, re.I):
        return "KES"
    if re.search(r"USD|US\$|\$", text, re.I):
        return "USD"
    if "£" in text or re.search(r"GBP", text, re.I):
        return "GBP"
    if "€" in text or re.search(r"EUR", text, re.I):
        return "EUR"
    return ""


def stable_id(seed: str) -> str:
    digest = hashlib.sha1(seed.encode("utf-8")).hexdigest()[:12]
    return f"apify-{digest}"


def infer_vehicle_subcategory(item: dict[str, Any], title: str, description: str) -> str:
    text = f"{title} {description} {clean(first_value(item, ALIASES['source_category']))}".lower()
    if re.search(r"\b(rent|rental|hire|lease)\b", text):
        return "rentals"
    if re.search(r"\b(detailing|detail|wash|cleaning|polish|valet)\b", text):
        return "detailing"
    if re.search(r"\b(tire|tyre|rim|wheel|alloy|hubcap)\b", text) and not re.search(r"\b(spacious|interior|sedan|suv|van|hatchback)\b", text):
        return "tires_rims"
    if re.search(r"\b(repair|mechanic|service|maintenance|installation|diagnostic|rebuild|rebuilds)\b", text):
        return "repairs"
    if re.search(r"\b(part|parts|engine|headlight|bumper|spoiler|spring|battery|starter|mirror|accessor|accessory|decal|sticker)\b", text):
        return "auto_parts"
    if re.search(r"\b(car|cars|vehicle|vehicles|sedan|suv|van|truck|mazda|toyota|mercedes|benz|honda|nissan|subaru|bmw|audi|volkswagen|hyundai|kia|lexus|mitsubishi|land cruiser|prado)\b", text):
        return "vehicles"
    return "other"


def infer_service_subcategory(title: str, description: str) -> str:
    text = f"{title} {description}".lower()
    if re.search(r"\b(clean|cleaning|roof|home|office|plumb|electric|repair|maintenance|install|appliance|pest)\b", text):
        return "home_services"
    if re.search(r"\b(catering|restaurant|food|chef|meal)\b", text):
        return "food"
    if re.search(r"\b(barber|salon|beauty|spa|massage|makeup|hair)\b", text):
        return "health_beauty"
    if re.search(r"\b(event|dj|music|photo|video|entertain)\b", text):
        return "events_services"
    if re.search(r"\b(mechanic|weld|carpenter|mason|technician|installation|repair|maintenance)\b", text):
        return "skilled_trades"
    return "other"


def infer_property_subcategory(title: str, description: str) -> str:
    text = f"{title} {description}".lower()
    if re.search(r"\b(sale|buy|for sale)\b", text):
        return "for_sale"
    if re.search(r"\b(short[- ]?term|airbnb|night|daily)\b", text):
        return "for_rent_short"
    return "for_rent_long"


def is_vehicle_related(item: dict[str, Any], title: str, description: str) -> bool:
    text = f"{title} {description} {clean(first_value(item, ALIASES['source_category']))}".lower()
    return bool(re.search(
        r"\b(car|cars|vehicle|vehicles|auto|motor|sedan|suv|van|truck|engine|headlight|bumper|rim|wheel|tyre|tire|car wash|multimedia player|mazda|toyota|mercedes|benz|honda|nissan|subaru|bmw|audi|volkswagen|hyundai|kia|lexus|mitsubishi|land cruiser|prado)\b",
        text,
    ))


def infer_electronics_subcategory(title: str, description: str) -> str:
    text = f"{title} {description}".lower()
    if re.search(r"\b(laptop|macbook|computer|tablet|ipad|charger|adapter|battery|vga|cable)\b", text):
        return "computers_tablets"
    if re.search(r"\b(phone|iphone|samsung|smartphone)\b", text):
        return "phones_accessories"
    if re.search(r"\b(microphone|speaker|audio|headphone|earbud)\b", text):
        return "audio_headphones"
    if re.search(r"\b(tv|television|projector|monitor)\b", text):
        return "tv_video_home_theatre"
    return "other"


def is_electronics_related(title: str, description: str) -> bool:
    text = f"{title} {description}".lower()
    return bool(re.search(r"\b(laptop|macbook|computer|tablet|ipad|charger|adapter|battery|vga|microphone|speaker|audio|phone|smartphone|tv|camera)\b", text))


def infer_listing_route(item: dict[str, Any], args: argparse.Namespace, title: str, description: str) -> tuple[str, str, str]:
    if args.category != "auto":
        category = args.category
        subcategory = args.subcategory
        target_surface = args.target_surface or ("vehicles" if category == "vehicles" else "marketplace")
        if category == "vehicles" and subcategory in ("", "other", "vehicles"):
            subcategory = infer_vehicle_subcategory(item, title, description)
        return target_surface, category, subcategory

    source_category = clean(first_value(item, ALIASES["source_category"])).lower()
    if is_vehicle_related(item, title, description):
        return "vehicles", "vehicles", infer_vehicle_subcategory(item, title, description)
    if is_electronics_related(title, description):
        return "marketplace", "electronics", infer_electronics_subcategory(title, description)
    if "vehicle" in source_category or "car" in source_category or "motor" in source_category:
        return "vehicles", "vehicles", infer_vehicle_subcategory(item, title, description)
    if "service" in source_category:
        return "marketplace", "services", infer_service_subcategory(title, description)
    if "property" in source_category or "real" in source_category or "rental" in source_category:
        return "marketplace", "real_estate", infer_property_subcategory(title, description)
    return "marketplace", "buy_sell", args.subcategory or "other"


def normalize_item(item: dict[str, Any], args: argparse.Namespace) -> dict[str, str] | None:
    source_url = clean(first_value(item, ALIASES["source_url"]))
    if args.base_url and source_url:
        source_url = urljoin(args.base_url, source_url)

    raw_id = clean(first_value(item, ALIASES["id"]))
    title = clean(first_value(item, ALIASES["title"]))
    if not title:
        return None

    price_text = clean(first_value(item, ALIASES["price_text"]))
    price_value = clean(first_value(item, ALIASES["price_value"])) or parse_price_value(price_text)
    currency = clean(first_value(item, ALIASES["currency"])) or infer_currency(price_text)
    source_site = clean(first_value(item, ALIASES["source_site"])) or args.source_site
    city = clean(first_value(item, ALIASES["city"])) or args.city
    country = clean(first_value(item, ALIASES["country"])) or args.country
    seller = clean(first_value(item, ALIASES["seller"])) or args.seller or source_site or "Apify import"
    description = clean(first_value(item, ALIASES["description"]))
    images = get_images(item, base_url=args.base_url)
    target_surface, app_category, app_subcategory = infer_listing_route(item, args, title, description)

    seed = source_url or raw_id or f"{source_site}:{title}:{city}:{price_text}"
    attributes = {
        "parser": "apify_import",
        "apifyDatasetId": args.dataset_id or "",
        "rawId": raw_id,
        "sourceCategory": clean(first_value(item, ALIASES["source_category"])),
    }
    passthrough_tags = first_value(item, ["tags", "categories", "category"])
    if passthrough_tags:
        attributes["sourceTags"] = passthrough_tags

    row = {
        "id": raw_id or stable_id(seed),
        "status": args.status,
        "target_surface": target_surface,
        "app_category": app_category,
        "app_subcategory": app_subcategory,
        "title": title,
        "price_text": price_text,
        "price_value": price_value,
        "currency": currency,
        "city": city,
        "country": country,
        "seller": seller,
        "phone": clean(first_value(item, ALIASES["phone"])),
        "description": description,
        "image_urls": "|".join(images),
        "source_site": source_site,
        "source_url": source_url,
        "scraped_at": clean(first_value(item, ["scraped_at", "scrapedAt", "postedAt", "date", "createdAt"]))
        or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "make": clean(first_value(item, ALIASES["make"])),
        "model": clean(first_value(item, ALIASES["model"])),
        "trim": clean(first_value(item, ALIASES["trim"])),
        "year": clean(first_value(item, ALIASES["year"])),
        "condition": clean(first_value(item, ALIASES["condition"])) or args.condition,
        "transmission": clean(first_value(item, ALIASES["transmission"])),
        "color": clean(first_value(item, ALIASES["color"])),
        "mileage_km": clean(first_value(item, ALIASES["mileage_km"])),
        "attributes": json.dumps(attributes, ensure_ascii=False, separators=(",", ":")),
    }
    return row


def load_local_items(path: Path) -> list[dict[str, Any]]:
    suffix = path.suffix.lower()
    if suffix == ".csv":
        with path.open(newline="", encoding="utf-8-sig") as handle:
            return list(csv.DictReader(handle))
    text = path.read_text(encoding="utf-8-sig").strip()
    if not text:
        return []
    if suffix == ".jsonl":
        return [json.loads(line) for line in text.splitlines() if line.strip()]
    parsed = json.loads(text)
    if isinstance(parsed, list):
        return parsed
    if isinstance(parsed, dict):
        for key in ("items", "data", "results"):
            if isinstance(parsed.get(key), list):
                return parsed[key]
        return [parsed]
    raise ValueError(f"Unsupported input shape in {path}")


def fetch_dataset_items(dataset_id: str, token: str, limit: int = 1000) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    offset = 0
    page_size = min(max(limit, 1), 1000)
    headers = {"Authorization": f"Bearer {token}"}
    while True:
        url = (
            f"https://api.apify.com/v2/datasets/{dataset_id}/items"
            f"?clean=true&format=json&offset={offset}&limit={page_size}"
        )
        request = Request(url, headers=headers)
        with urlopen(request, timeout=60) as response:
            page = json.loads(response.read().decode("utf-8"))
        if not isinstance(page, list):
            raise ValueError("Apify dataset response was not a JSON array")
        items.extend(page)
        if len(page) < page_size:
            break
        offset += page_size
    return items


def read_existing_csv(path: Path) -> tuple[list[str], list[dict[str, str]]]:
    if not path.exists():
        return DEFAULT_COLUMNS, []
    with path.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        return list(reader.fieldnames or DEFAULT_COLUMNS), list(reader)


def merge_rows(existing: list[dict[str, str]], incoming: list[dict[str, str]]) -> list[dict[str, str]]:
    merged: dict[str, dict[str, str]] = {}
    for row in existing:
        key = clean(row.get("source_url")) or clean(row.get("id"))
        if key:
            merged[key] = row
    for row in incoming:
        key = clean(row.get("source_url")) or clean(row.get("id"))
        if key:
            merged[key] = {**merged.get(key, {}), **row}
    return sorted(merged.values(), key=lambda row: clean(row.get("scraped_at")), reverse=True)


def write_csv(path: Path, columns: list[str], rows: list[dict[str, str]]) -> None:
    all_columns = list(columns)
    for column in DEFAULT_COLUMNS:
        if column not in all_columns:
            all_columns.append(column)
    for row in rows:
        for column in row.keys():
            if column not in all_columns:
                all_columns.append(column)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=all_columns, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({column: row.get(column, "") for column in all_columns})


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Import Apify listing data into data/scraped-listings.csv.")
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--dataset-id", default=os.getenv("APIFY_DATASET_ID"), help="Apify dataset id to fetch.")
    source.add_argument("--input", type=Path, help="Local Apify export: .json, .jsonl, or .csv.")
    parser.add_argument("--apify-token", default=os.getenv("APIFY_TOKEN"), help="Apify API token. Defaults to APIFY_TOKEN.")
    parser.add_argument("--output", type=Path, default=Path("data/scraped-listings.csv"), help="Website CSV to update.")
    parser.add_argument("--status", default=os.getenv("SIXO_DEFAULT_IMPORT_STATUS", "published"), choices=["published", "pending", "rejected"])
    parser.add_argument("--target-surface", default="", choices=["", "marketplace", "vehicles"])
    parser.add_argument("--category", default="buy_sell", choices=["auto", "electronics", "clothing", "jobs", "services", "real_estate", "vehicles", "buy_sell"])
    parser.add_argument("--subcategory", default="other")
    parser.add_argument("--source-site", default="Apify")
    parser.add_argument("--city", default="")
    parser.add_argument("--country", default="")
    parser.add_argument("--seller", default="")
    parser.add_argument("--condition", default="good")
    parser.add_argument("--base-url", default="", help="Resolve relative source/image URLs against this URL.")
    parser.add_argument("--limit", type=int, default=0, help="Maximum source items to import. 0 means all.")
    parser.add_argument("--dry-run", action="store_true", help="Normalize and report without writing the CSV.")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        if not args.input and not args.dataset_id:
            raise ValueError("Pass --input for an Apify export or --dataset-id/ APIFY_DATASET_ID for a live Apify dataset.")
        if args.input:
            source_items = load_local_items(args.input)
        else:
            if not args.apify_token:
                raise ValueError("Set APIFY_TOKEN or pass --apify-token to fetch an Apify dataset.")
            source_items = fetch_dataset_items(args.dataset_id, args.apify_token)
        if args.limit > 0:
            source_items = source_items[: args.limit]
        if not all(isinstance(item, dict) for item in source_items):
            raise ValueError("Source items must be objects/rows.")
        incoming = [row for row in (normalize_item(item, args) for item in source_items) if row]
        columns, existing = read_existing_csv(args.output)
        merged = merge_rows(existing, incoming)
        print(f"source_items={len(source_items)} normalized={len(incoming)} existing={len(existing)} merged={len(merged)}")
        if args.dry_run:
            for row in incoming[:5]:
                print(json.dumps({key: row.get(key, "") for key in ("id", "status", "title", "source_url")}, ensure_ascii=False))
            return 0
        args.output.parent.mkdir(parents=True, exist_ok=True)
        write_csv(args.output, columns, merged)
        print(f"updated {args.output}")
        return 0
    except Exception as exc:
        print(f"apify import failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
