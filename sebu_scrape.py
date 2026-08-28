#!/usr/bin/env python3
"""Sync recent Kenyan marketplace listings from Sebu's public sitemap.

The crawler identifies itself, honors robots.txt, keeps a sanitized local cache,
and deliberately omits seller phone numbers and private tokens. Listings retain
their source URL so contact can happen on the original listing page.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import sys
import tempfile
import time
import xml.etree.ElementTree as ET
from collections import defaultdict, deque
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import Request, urlopen
from urllib.robotparser import RobotFileParser


DEFAULT_SITEMAP = "https://sebu.co.ke/sitemap.xml"
USER_AGENT_TOKEN = "6ixoMarketplace"
USER_AGENT = "Mozilla/5.0 (compatible; 6ixoMarketplace/1.0; +https://6ixo.com)"
CORE_APP_CATEGORIES = {
    "buy_sell",
    "clothing",
    "services",
}
SOURCE_CATEGORY_MAP = {
    "baby-and-kids": ("marketplace", "buy_sell"),
    "books-music-and-hobbies": ("marketplace", "buy_sell"),
    "business-and-industrial": ("marketplace", "buy_sell"),
    "education-and-training": ("marketplace", "services"),
    "electronics": ("marketplace", "electronics"),
    "events-and-entertainment": ("marketplace", "community"),
    "fashion": ("marketplace", "clothing"),
    "food-and-grocery": ("marketplace", "buy_sell"),
    "gigs-and-freelance": ("marketplace", "services"),
    "health-and-beauty": ("marketplace", "beauty"),
    "home-furniture-and-appliances": ("marketplace", "buy_sell"),
    "job-hiring": ("marketplace", "jobs"),
    "job-looking-for-work": ("marketplace", "jobs"),
    "pets-and-animals": ("marketplace", "buy_sell"),
    "real-estate": ("marketplace", "real_estate"),
    "services": ("marketplace", "services"),
    "travel-and-tourism": ("marketplace", "services"),
    "vehicles": ("vehicles", "vehicles"),
}
CSV_FIELDS = [
    "id", "status", "target_surface", "app_category", "app_subcategory",
    "title", "price_text", "price_value", "currency", "city", "country",
    "seller", "phone", "description", "image_urls", "source_site",
    "source_url", "scraped_at", "make", "model", "trim", "year",
    "condition", "transmission", "color", "mileage_km", "attributes",
    "source_availability", "source_availability_checked_at",
    "source_http_status", "source_unavailable_reason", "source_last_seen_at",
    "source_resolved_url",
]
SITEMAP_NS = {
    "sm": "http://www.sitemaps.org/schemas/sitemap/0.9",
    "image": "http://www.google.com/schemas/sitemap-image/1.1",
}
KENYA_PHONE_RE = re.compile(
    r"(?<!\d)(?:\+?254|0)?\s*(?:7|1)\d{2}(?:[\s().-]*\d){6}(?!\d)"
)


def fetch_text(url: str, timeout: float = 30, retries: int = 3, delay: float = 0) -> str:
    """Fetch a public HTML/XML document with conservative retries."""
    last_error: Exception | None = None
    for attempt in range(retries):
        if delay > 0:
            time.sleep(delay)
        request = Request(url, headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-KE,en;q=0.9",
        })
        try:
            with urlopen(request, timeout=timeout) as response:
                charset = response.headers.get_content_charset() or "utf-8"
                return response.read().decode(charset, errors="replace")
        except (HTTPError, URLError, TimeoutError) as exc:
            last_error = exc
            if attempt + 1 < retries:
                time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"Unable to fetch {url}: {last_error}")


def robots_allows(sitemap_url: str, timeout: float) -> None:
    robots_url = urljoin(sitemap_url, "/robots.txt")
    parser = RobotFileParser()
    parser.set_url(robots_url)
    parser.parse(fetch_text(robots_url, timeout=timeout).splitlines())
    if not parser.can_fetch(USER_AGENT_TOKEN, sitemap_url):
        raise RuntimeError(f"robots.txt does not allow fetching {sitemap_url}")


def parse_sitemap_index(xml_text: str) -> list[str]:
    root = ET.fromstring(xml_text)
    return [
        str(node.text or "").strip()
        for node in root.findall("sm:sitemap/sm:loc", SITEMAP_NS)
        if str(node.text or "").strip()
    ]


def parse_listing_sitemap(xml_text: str) -> list[dict[str, str]]:
    root = ET.fromstring(xml_text)
    refs: list[dict[str, str]] = []
    for node in root.findall("sm:url", SITEMAP_NS):
        location = str(node.findtext("sm:loc", default="", namespaces=SITEMAP_NS)).strip()
        if not location:
            continue
        refs.append({
            "url": location,
            "lastmod": str(node.findtext("sm:lastmod", default="", namespaces=SITEMAP_NS)).strip(),
            "image": str(node.findtext("image:image/image:loc", default="", namespaces=SITEMAP_NS)).strip(),
            "title": str(node.findtext("image:image/image:title", default="", namespaces=SITEMAP_NS)).strip(),
        })
    return refs


def decode_js_single_quoted(value: str) -> str:
    """Decode the escapes used inside a JavaScript single-quoted string."""
    output: list[str] = []
    index = 0
    simple = {"n": "\n", "r": "\r", "t": "\t", "b": "\b", "f": "\f", "v": "\v"}
    while index < len(value):
        char = value[index]
        if char != "\\":
            output.append(char)
            index += 1
            continue
        index += 1
        if index >= len(value):
            output.append("\\")
            break
        escaped = value[index]
        if escaped in {"\\", "'", '"', "/"}:
            output.append(escaped)
        elif escaped in simple:
            output.append(simple[escaped])
        elif escaped == "u" and index + 4 < len(value):
            try:
                output.append(chr(int(value[index + 1:index + 5], 16)))
                index += 4
            except ValueError:
                output.extend(["\\", escaped])
        elif escaped == "x" and index + 2 < len(value):
            try:
                output.append(chr(int(value[index + 1:index + 3], 16)))
                index += 2
            except ValueError:
                output.extend(["\\", escaped])
        else:
            output.extend(["\\", escaped])
        index += 1
    return "".join(output)


def extract_ad_json(source_html: str) -> dict[str, Any]:
    match = re.search(r"const\s+ad\s*=\s*JSON\.parse\('((?:\\.|[^'])*)'\)", source_html, re.DOTALL)
    if not match:
        raise ValueError("Listing page did not contain the public ad JSON payload")
    payload = decode_js_single_quoted(match.group(1))
    return json.loads(payload)


def clean_text(value: Any) -> str:
    text = str(value or "").replace("\\r\\n", "\n").replace("\\n", "\n")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return "\n".join(line.rstrip() for line in text.splitlines()).strip()


def redact_contact_details(value: Any) -> str:
    """Keep imported copy useful while directing contact back to the source."""
    text = clean_text(value)
    text = KENYA_PHONE_RE.sub("contact via the original listing", text)
    text = re.sub(r"\b(?:https?://|www\.)\S+", "the original listing", text, flags=re.IGNORECASE)
    return clean_text(text)


def sanitize_ad(ad: dict[str, Any], ref: dict[str, str]) -> dict[str, Any] | None:
    title = clean_text(ad.get("title") or ref.get("title"))
    category = str(ad.get("category") or "").strip().lower()
    status = str(ad.get("status") or "active").strip().lower()
    images = [
        str(item.get("url") or "").strip()
        for item in sorted(ad.get("images") or [], key=lambda item: int(item.get("sort") or 999))
        if isinstance(item, dict) and str(item.get("url") or "").strip()
    ]
    if not images and ref.get("image"):
        images = [ref["image"]]
    if not title or not category or category not in SOURCE_CATEGORY_MAP or status != "active" or not images:
        return None
    seller = ad.get("seller") if isinstance(ad.get("seller"), dict) else {}
    dynamic = ad.get("dynamic") if isinstance(ad.get("dynamic"), dict) else {}
    return {
        "id": str(ad.get("id") or "").strip(),
        "url": ref["url"],
        "lastmod": ref.get("lastmod", ""),
        "title": title,
        "amount": ad.get("amount"),
        "negotiable": str(ad.get("negotiable") or "").strip(),
        "description": redact_contact_details(ad.get("description")),
        "created_at": str(ad.get("created_at") or ad.get("timestamp") or "").strip(),
        "category": category,
        "category_name": clean_text(ad.get("category_name")),
        "subcategory": str(ad.get("subcategory") or "").strip().lower(),
        "subcategory_name": clean_text(ad.get("subcategory_name")),
        "region": str(ad.get("region") or "").strip(),
        "region_name": clean_text(ad.get("region_name")),
        "area": str(ad.get("area") or "").strip(),
        "area_name": clean_text(ad.get("area_name")),
        "images": images[:4],
        "dynamic": dynamic,
        "seller": clean_text(seller.get("bizname") or seller.get("name")),
        "seller_phone_verified": str(seller.get("phone_verified") or "").lower() == "verified",
    }


def infer_subcategory(candidate: dict[str, Any], app_category: str) -> str:
    source_subcategory = str(candidate.get("subcategory") or "").lower()
    text = " ".join([
        source_subcategory,
        str(candidate.get("title") or "").lower(),
        " ".join(f"{key} {value}" for key, value in (candidate.get("dynamic") or {}).items()).lower(),
    ])
    if app_category == "vehicles":
        return "parts" if re.search(r"\b(part|parts|tyre|tire|rim|battery|accessor)", text) else "vehicles"
    if app_category == "real_estate":
        return "for_rent" if re.search(r"\b(rent|rental|airbnb|short[ -]?term|to let|lease)\b", text) else "for_sale"
    if app_category == "electronics":
        for key, pattern in (
            ("phones", r"\b(phone|smartphone|iphone|android|tablet)\b"),
            ("computers", r"\b(computer|laptop|desktop|monitor|printer)\b"),
            ("tv", r"\b(tv|television|projector)\b"),
            ("audio", r"\b(audio|speaker|headphone|earphone|sound)\b"),
            ("gaming", r"\b(gaming|console|playstation|xbox|nintendo)\b"),
        ):
            if re.search(pattern, text):
                return key
        return "other"
    if app_category == "services":
        for key, pattern in (
            ("classes_lessons", r"\b(education|training|class|lesson|tutor|course)\b"),
            ("home_services", r"\b(clean|home|house|moving|gardening|laundry)\b"),
            ("skilled_trades", r"\b(repair|mechanic|plumb|electric|construct|roof|install)\b"),
            ("travel", r"\b(travel|tour|hotel|holiday|flight)\b"),
            ("creative", r"\b(design|photo|video|music|event|freelance|writing)\b"),
        ):
            if re.search(pattern, text):
                return key
        return "other"
    return source_subcategory or "other"


def candidate_to_csv(candidate: dict[str, Any], checked_at: str) -> dict[str, str]:
    target_surface, app_category = SOURCE_CATEGORY_MAP[candidate["category"]]
    dynamic = candidate.get("dynamic") or {}
    amount = candidate.get("amount")
    try:
        numeric_amount = float(amount)
        price_value = str(int(numeric_amount) if numeric_amount.is_integer() else numeric_amount)
    except (TypeError, ValueError):
        numeric_amount = 0
        price_value = ""
    price_text = f"KSh {numeric_amount:,.0f}" if numeric_amount > 0 else "Contact seller"
    region = candidate.get("region_name") or str(candidate.get("region") or "").replace("-", " ").title()
    area = candidate.get("area_name") or str(candidate.get("area") or "").replace("-", " ").title()
    attributes: dict[str, Any] = {
        "parser": "sebu_sitemap_sync",
        "sourceCategory": candidate.get("category"),
        "sourceSubcategory": candidate.get("subcategory"),
        "sourceLastModified": candidate.get("lastmod"),
        "region": region,
        "area": area,
        "negotiable": candidate.get("negotiable"),
        "dynamic": dynamic,
        "sellerPhoneVerified": bool(candidate.get("seller_phone_verified")),
        "tags": [value for value in [candidate.get("category_name"), candidate.get("subcategory_name"), "Kenya"] if value],
    }
    lower_dynamic = {str(key).lower(): value for key, value in dynamic.items()}
    for source_key, target_key in (
        ("make", "make"), ("brand", "make"), ("model", "model"),
        ("trim", "trim"), ("year", "year"), ("condition", "condition"),
        ("transmission", "transmission"), ("color", "color"),
    ):
        value = lower_dynamic.get(source_key)
        if value not in (None, "") and target_key not in attributes:
            attributes[target_key] = value
    if app_category == "real_estate":
        for source_key, target_key in (("property_type", "propertyType"), ("bedrooms", "bedrooms"), ("bathrooms", "bathrooms")):
            if lower_dynamic.get(source_key) not in (None, ""):
                attributes[target_key] = lower_dynamic[source_key]
    fallback_id = hashlib.sha256(candidate["url"].encode("utf-8")).hexdigest()[:12]
    stable_id = str(candidate.get("id") or fallback_id)
    row = {field: "" for field in CSV_FIELDS}
    row.update({
        "id": f"sebu-{stable_id}",
        "status": "published",
        "target_surface": target_surface,
        "app_category": app_category,
        "app_subcategory": infer_subcategory(candidate, app_category),
        "title": clean_text(candidate.get("title")),
        "price_text": price_text,
        "price_value": price_value,
        "currency": "KES",
        "city": area or region,
        "country": "Kenya",
        "seller": clean_text(candidate.get("seller")) or "Sebu seller",
        "phone": "",
        "description": clean_text(candidate.get("description")),
        "image_urls": " | ".join(candidate.get("images") or []),
        "source_site": "Sebu",
        "source_url": candidate["url"],
        "scraped_at": candidate.get("created_at") or checked_at,
        "make": clean_text(attributes.get("make")),
        "model": clean_text(attributes.get("model")),
        "trim": clean_text(attributes.get("trim")),
        "year": clean_text(attributes.get("year")),
        "condition": clean_text(attributes.get("condition")) or "used",
        "transmission": clean_text(attributes.get("transmission")),
        "color": clean_text(attributes.get("color")),
        "attributes": json.dumps(attributes, ensure_ascii=False, separators=(",", ":")),
        "source_availability": "active",
        "source_availability_checked_at": checked_at,
        "source_http_status": "200",
        "source_last_seen_at": checked_at,
        "source_resolved_url": candidate["url"],
    })
    mileage = lower_dynamic.get("mileage") or lower_dynamic.get("mileage_km")
    if mileage not in (None, ""):
        row["mileage_km"] = clean_text(mileage)
    return row


def select_balanced(candidates: Iterable[dict[str, Any]], max_per_category: int) -> list[dict[str, Any]]:
    """Round-robin source categories within each app category, newest first."""
    app_buckets: dict[str, dict[str, deque[dict[str, Any]]]] = defaultdict(lambda: defaultdict(deque))
    ordered = sorted(candidates, key=lambda item: (item.get("created_at") or item.get("lastmod") or ""), reverse=True)
    for candidate in ordered:
        mapping = SOURCE_CATEGORY_MAP.get(str(candidate.get("category") or ""))
        if mapping:
            app_buckets[mapping[1]][candidate["category"]].append(candidate)
    selected: list[dict[str, Any]] = []
    for app_category in sorted(app_buckets):
        queues = app_buckets[app_category]
        source_keys = sorted(queues)
        category_selected: list[dict[str, Any]] = []
        while len(category_selected) < max_per_category and any(queues[key] for key in source_keys):
            for key in source_keys:
                if queues[key] and len(category_selected) < max_per_category:
                    category_selected.append(queues[key].popleft())
        selected.extend(category_selected)
    return selected


def read_cache(cache_path: Path) -> dict[str, dict[str, Any]]:
    if not cache_path.exists():
        return {}
    try:
        payload = json.loads(cache_path.read_text(encoding="utf-8"))
        listings = {}
        for item in payload.get("listings", []):
            if not item.get("url"):
                continue
            sanitized = dict(item)
            sanitized["description"] = redact_contact_details(sanitized.get("description"))
            listings[str(sanitized["url"])] = sanitized
        return listings
    except (OSError, ValueError, TypeError):
        return {}


def atomic_write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        handle.write(content)
        temporary = Path(handle.name)
    temporary.replace(path)


def write_cache(cache_path: Path, candidates: Iterable[dict[str, Any]]) -> None:
    payload = {"version": 1, "listings": sorted(candidates, key=lambda item: item["url"])}
    atomic_write_text(cache_path, json.dumps(payload, ensure_ascii=False, indent=2) + "\n")


def merge_csv(csv_path: Path, new_rows: list[dict[str, str]], dry_run: bool) -> tuple[int, int]:
    existing_rows: list[dict[str, str]] = []
    fields = list(CSV_FIELDS)
    if csv_path.exists():
        with csv_path.open(newline="", encoding="utf-8-sig") as handle:
            reader = csv.DictReader(handle)
            fields = list(reader.fieldnames or CSV_FIELDS)
            existing_rows = list(reader)
    preserved = [
        {key: "\n".join(line.rstrip() for line in str(value or "").splitlines()).strip() for key, value in row.items()}
        for row in existing_rows
        if str(row.get("source_site") or "").strip().lower() != "sebu"
    ]
    merged = preserved + new_rows
    if not dry_run:
        csv_path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile("w", newline="", encoding="utf-8", dir=csv_path.parent, delete=False) as handle:
            writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore", lineterminator="\n")
            writer.writeheader()
            writer.writerows(merged)
            temporary = Path(handle.name)
        temporary.replace(csv_path)
    return len(preserved), len(merged)


def run(args: argparse.Namespace) -> int:
    sitemap_url = args.sitemap
    robots_allows(sitemap_url, args.timeout)
    sitemap_documents = parse_sitemap_index(fetch_text(sitemap_url, timeout=args.timeout))
    listing_sitemaps = [url for url in sitemap_documents if "listing" in url.lower()]
    if not listing_sitemaps:
        raise RuntimeError("No listing sitemap was found in the Sebu sitemap index")
    refs: list[dict[str, str]] = []
    for listing_sitemap in listing_sitemaps:
        refs.extend(parse_listing_sitemap(fetch_text(listing_sitemap, timeout=args.timeout)))
    if not refs:
        raise RuntimeError("The Sebu listing sitemap contained no listing URLs")

    cache_path = Path(args.cache)
    cached = read_cache(cache_path)
    resolved: dict[str, dict[str, Any]] = {}
    pending: list[dict[str, str]] = []
    for ref in refs:
        prior = cached.get(ref["url"])
        if prior and str(prior.get("lastmod") or "") == ref.get("lastmod", ""):
            resolved[ref["url"]] = prior
        else:
            pending.append(ref)

    print(f"Sebu sitemap: {len(refs)} listings; {len(resolved)} cached; {len(pending)} to refresh")
    failures: list[str] = []

    def fetch_candidate(ref: dict[str, str]) -> tuple[dict[str, str], dict[str, Any] | None]:
        source_html = fetch_text(ref["url"], timeout=args.timeout, delay=args.request_delay)
        return ref, sanitize_ad(extract_ad_json(source_html), ref)

    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as executor:
        futures = {executor.submit(fetch_candidate, ref): ref for ref in pending}
        for future in as_completed(futures):
            ref = futures[future]
            try:
                _, candidate = future.result()
                if candidate:
                    resolved[ref["url"]] = candidate
            except Exception as exc:  # continue with a stale cached copy where possible
                failures.append(f"{ref['url']}: {exc}")
                if ref["url"] in cached:
                    resolved[ref["url"]] = cached[ref["url"]]

    if failures:
        print(f"warning: {len(failures)} listing pages failed; first: {failures[0]}", file=sys.stderr)
    failure_ratio = len(failures) / max(1, len(pending))
    if pending and failure_ratio > args.max_failure_ratio:
        raise RuntimeError(f"Too many listing fetches failed ({len(failures)}/{len(pending)})")

    candidates = list(resolved.values())
    selected = select_balanced(candidates, args.max_per_category)
    present_categories = {SOURCE_CATEGORY_MAP[item["category"]][1] for item in selected}
    missing = sorted(CORE_APP_CATEGORIES - present_categories)
    if missing and not args.allow_partial_categories:
        raise RuntimeError(f"Sebu feed is missing core app categories: {', '.join(missing)}")
    if len(present_categories) < 5 and not args.allow_partial_categories:
        raise RuntimeError(f"Sebu feed covers only {len(present_categories)} app categories; expected at least 5")

    checked_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    rows = [candidate_to_csv(candidate, checked_at) for candidate in selected]
    preserved_count, merged_count = merge_csv(Path(args.csv), rows, args.dry_run)
    if not args.dry_run:
        write_cache(cache_path, candidates)
    counts: dict[str, int] = defaultdict(int)
    for row in rows:
        counts[row["app_category"]] += 1
    print("Selected Kenya categories: " + ", ".join(f"{key}={counts[key]}" for key in sorted(counts)))
    print(f"CSV rows: preserved={preserved_count}, Sebu={len(rows)}, total={merged_count}")
    if args.dry_run:
        print("Dry run: no files changed")
    return 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--csv", default="data/kenya-listings.csv")
    parser.add_argument("--cache", default="data/sebu-listings-cache.json")
    parser.add_argument("--sitemap", default=DEFAULT_SITEMAP)
    parser.add_argument("--max-per-category", type=int, default=10)
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--timeout", type=float, default=30)
    parser.add_argument("--request-delay", type=float, default=0.15)
    parser.add_argument("--max-failure-ratio", type=float, default=0.20)
    parser.add_argument("--allow-partial-categories", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args(argv)


if __name__ == "__main__":
    try:
        raise SystemExit(run(parse_args()))
    except (RuntimeError, ValueError, ET.ParseError) as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
