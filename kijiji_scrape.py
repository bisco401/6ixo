#!/usr/bin/env python3
"""Scrape public Kijiji listing pages for listings with visible phones/images."""

from __future__ import annotations

import argparse
import csv
import html
import json
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
)

LOCATIONS = {
    "toronto": ("Toronto", "https://www.kijiji.ca/b-city-of-toronto/{page}/l1700273?sort=dateDesc"),
    "hamilton": ("Hamilton", "https://www.kijiji.ca/b-hamilton/{page}/l80014?sort=dateDesc"),
    "brampton": ("Brampton", "https://www.kijiji.ca/b-brampton/{page}/l1700276?sort=dateDesc"),
}

PHONE_RE = re.compile(
    r"(?<!\d)(?:\+?1[\s.\-]*)?"
    r"(?:\(?((?:226|249|289|343|365|416|437|519|548|647|705|742|807|905))\)?[\s.\-]*)"
    r"(\d{3})[\s.\-]*(\d{4})(?!\d)"
)
PHONE_CONTEXT_RE = re.compile(r"\b(?:call|text|txt|phone|cell|tel|contact|whatsapp|message)\b", re.I)


@dataclass
class KijijiListing:
    id: str
    title: str
    price: str
    url: str
    city: str
    location_name: str
    location_address: str
    posted_at: str
    sorting_date: str
    seller_id: str
    phone_numbers: str
    image_url: str
    image_urls: str
    image_files: str
    description: str
    category_id: str


def normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(str(value or ""))).strip()


def normalize_image_url(value: str) -> str:
    url = str(value or "").strip()
    if "media.kijiji.ca" not in url.lower():
        return url
    return re.sub(
        r"([?&]rule=)kijijica-200-jpg(?=(&|$))",
        r"\1kijijica-640-webp",
        url,
        flags=re.IGNORECASE,
    )


def fetch_html(url: str, delay: float = 0.0) -> str:
    if delay > 0:
        time.sleep(delay)
    request = Request(url, headers={"User-Agent": USER_AGENT, "Accept-Language": "en-CA,en;q=0.9"})
    try:
        with urlopen(request, timeout=35) as response:
            charset = response.headers.get_content_charset() or "utf-8"
            return response.read().decode(charset, errors="replace")
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Fetch failed with HTTP {exc.code}: {url}\n{body[:300]}") from exc
    except URLError as exc:
        raise RuntimeError(f"Fetch failed: {url}: {exc.reason}") from exc


def fetch_bytes(url: str, delay: float = 0.0) -> bytes:
    if delay > 0:
        time.sleep(delay)
    request = Request(url, headers={"User-Agent": USER_AGENT, "Accept-Language": "en-CA,en;q=0.9"})
    with urlopen(request, timeout=35) as response:
        return response.read()


def extract_next_data(source_html: str) -> dict:
    match = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', source_html)
    if not match:
        raise ValueError("Kijiji page did not include __NEXT_DATA__ JSON.")
    return json.loads(html.unescape(match.group(1)))


def extract_state(source_html: str) -> dict:
    data = extract_next_data(source_html)
    return data.get("props", {}).get("pageProps", {}).get("__APOLLO_STATE__", {}) or {}


def page_url(template: str, page: int) -> str:
    page_part = "" if page == 1 else f"page-{page}"
    return template.format(page=page_part).replace("//l", "/l")


def listing_refs_from_search_page(url: str, city: str, delay: float) -> list[dict]:
    state = extract_state(fetch_html(url, delay=delay))
    listings = []
    seen = set()
    for item in state.values():
        if not isinstance(item, dict) or item.get("__typename") != "StandardListing":
            continue
        listing_id = str(item.get("id") or "").strip()
        listing_url = str(item.get("url") or "").strip()
        if not listing_id or not listing_url or listing_id in seen:
            continue
        seen.add(listing_id)
        if not item.get("imageUrls"):
            continue
        listings.append({
            "id": listing_id,
            "url": listing_url,
            "city": city,
            "sorting_date": str(item.get("sortingDate") or item.get("activationDate") or ""),
            "item": item,
        })
    listings.sort(key=lambda row: row["sorting_date"], reverse=True)
    return listings


def listing_from_item(item: dict, city: str, url: str = "") -> KijijiListing | None:
    images = [normalize_image_url(src) for src in (item.get("imageUrls") or []) if str(src).strip()]
    if not images:
        return None

    title = normalize_text(item.get("title"))
    description = normalize_text(item.get("description"))
    phones = extract_phone_numbers(title, description)
    if not phones:
        return None

    location = item.get("location") or {}
    poster = item.get("posterInfo") or {}
    return KijijiListing(
        id=f"kijiji-{item.get('id')}",
        title=title,
        price=format_price(item.get("price") or {}),
        url=str(item.get("url") or url).strip(),
        city=city,
        location_name=normalize_text(location.get("name")),
        location_address=normalize_text(location.get("address")),
        posted_at=str(item.get("activationDate") or ""),
        sorting_date=str(item.get("sortingDate") or item.get("activationDate") or ""),
        seller_id=str(poster.get("posterId") or ""),
        phone_numbers=" | ".join(phones),
        image_url=images[0],
        image_urls=" | ".join(images),
        image_files="",
        description=description,
        category_id=str(item.get("categoryId") or ""),
    )


def format_price(price: dict) -> str:
    if not isinstance(price, dict):
        return ""
    price_type = str(price.get("type") or "").strip()
    amount = price.get("amount")
    if price_type == "GIVE_AWAY":
        return "Free"
    if price_type == "PLEASE_CONTACT":
        return "Please contact"
    if isinstance(amount, (int, float)):
        return f"CA$ {amount / 100:,.2f}"
    return ""


def extract_phone_numbers(*values: str) -> list[str]:
    found: list[str] = []
    seen = set()
    for value in values:
        text = normalize_text(value)
        for match in PHONE_RE.finditer(text):
            start = max(0, match.start() - 45)
            end = min(len(text), match.end() + 25)
            context = text[start:end]
            raw = match.group(0)
            has_separator = bool(re.search(r"[\s().-]", raw.strip()))
            if not has_separator and not PHONE_CONTEXT_RE.search(context):
                continue
            phone = f"{match.group(1)}{match.group(2)}{match.group(3)}"
            if phone not in seen:
                found.append(phone)
                seen.add(phone)
    return found


def parse_listing_detail(ref: dict, delay: float) -> KijijiListing | None:
    state = extract_state(fetch_html(ref["url"], delay=delay))
    item = None
    for value in state.values():
        if isinstance(value, dict) and value.get("__typename") == "StandardListing" and str(value.get("id")) == ref["id"]:
            item = value
            break
    if not item:
        return None

    return listing_from_item(item, ref["city"], ref["url"])


def safe_filename(value: str, fallback: str = "listing") -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9._-]+", "-", str(value or "").strip()).strip("-")
    return cleaned[:90] or fallback


def download_listing_images(listing: KijijiListing, image_dir: Path, delay: float) -> KijijiListing:
    image_dir.mkdir(parents=True, exist_ok=True)
    saved = []
    for index, image_url in enumerate([u.strip() for u in listing.image_urls.split("|") if u.strip()], start=1):
        parsed = urlparse(image_url)
        suffix = Path(parsed.path).suffix
        if not suffix or len(suffix) > 6:
            suffix = ".jpg"
        path = image_dir / f"{safe_filename(listing.id)}-{index}{suffix}"
        try:
            if not path.exists():
                path.write_bytes(fetch_bytes(image_url, delay=delay))
            saved.append(str(path))
        except Exception as err:
            print(f"warning: failed image download for {image_url}: {err}", file=sys.stderr)
    listing.image_files = " | ".join(saved)
    return listing


def write_csv(listings: Iterable[KijijiListing], output: Path) -> None:
    rows = [asdict(item) for item in listings]
    fields = list(KijijiListing.__dataclass_fields__.keys())
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def read_csv(path: Path) -> list[KijijiListing]:
    if not path.exists():
        return []
    fields = set(KijijiListing.__dataclass_fields__)
    with path.open(newline="", encoding="utf-8-sig") as handle:
        return [
            KijijiListing(**{field: str(row.get(field) or "") for field in fields})
            for row in csv.DictReader(handle)
        ]


def is_publishable(listing: KijijiListing) -> bool:
    return all(
        normalize_text(value)
        for value in (listing.id, listing.title, listing.url, listing.phone_numbers, listing.image_urls)
    )


def merge_listings(
    incoming: Iterable[KijijiListing],
    existing: Iterable[KijijiListing],
    max_records: int,
) -> list[KijijiListing]:
    merged: dict[str, KijijiListing] = {}
    for listing in [*existing, *incoming]:
        if not is_publishable(listing):
            continue
        key = normalize_text(listing.url) or normalize_text(listing.id)
        merged[key] = listing
    return sorted(
        merged.values(),
        key=lambda row: row.sorting_date or row.posted_at,
        reverse=True,
    )[:max_records]


def scrape(args: argparse.Namespace) -> list[KijijiListing]:
    requested_locations = [item.strip().lower() for item in args.locations.split(",") if item.strip()]
    location_configs = [(key, *LOCATIONS[key]) for key in requested_locations if key in LOCATIONS]
    if not location_configs:
        raise SystemExit(f"No supported locations in --locations. Supported: {', '.join(LOCATIONS)}")

    refs_by_id: dict[str, dict] = {}
    for page in range(1, args.max_pages + 1):
        for key, city, template in location_configs:
            refs = listing_refs_from_search_page(page_url(template, page), city, delay=args.delay)
            for ref in refs:
                refs_by_id.setdefault(ref["id"], ref)

    refs = sorted(refs_by_id.values(), key=lambda row: row.get("sorting_date") or "", reverse=True)
    results_by_id: dict[str, KijijiListing] = {}
    for ref in refs:
        listing = listing_from_item(ref.get("item") or {}, ref["city"], ref["url"])
        if listing:
            results_by_id[listing.id] = listing

    if len(results_by_id) < args.limit and args.detail:
        with ThreadPoolExecutor(max_workers=max(1, args.workers)) as executor:
            detail_refs = [
                ref for ref in refs
                if f"kijiji-{ref['id']}" not in results_by_id
            ][: args.max_detail_pages]
            futures = {executor.submit(parse_listing_detail, ref, args.delay): ref for ref in detail_refs}
            for future in as_completed(futures):
                try:
                    listing = future.result()
                except Exception as err:
                    print(f"warning: skipped detail page: {err}", file=sys.stderr)
                    continue
                if not listing:
                    continue
                results_by_id[listing.id] = listing
                if len(results_by_id) >= args.limit:
                    break

    listings = sorted(results_by_id.values(), key=lambda row: row.sorting_date, reverse=True)[: args.limit]
    if args.download_images:
        listings = [download_listing_images(item, args.image_dir, args.delay) for item in listings]
    return listings


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Scrape recent public Kijiji listings with visible phone numbers and images.")
    parser.add_argument("--locations", default="toronto,hamilton,brampton")
    parser.add_argument("--limit", type=int, default=25)
    parser.add_argument("--max-pages", type=int, default=8)
    parser.add_argument("--workers", type=int, default=6)
    parser.add_argument("--max-detail-pages", type=int, default=120)
    parser.add_argument("--delay", type=float, default=0.0)
    parser.add_argument("--detail", action="store_true", help="Fetch detail pages if search-result JSON has fewer than --limit qualifying listings.")
    parser.add_argument("--download-images", action="store_true")
    parser.add_argument("--image-dir", type=Path, default=Path("data/kijiji-gta-recent-images"))
    parser.add_argument("--output", type=Path, default=Path("data/kijiji-gta-recent-with-phones.csv"))
    parser.add_argument("--merge-existing", action="store_true", help="Merge new rows into the current output instead of replacing it.")
    parser.add_argument("--max-records", type=int, default=100, help="Maximum rows retained when merging.")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if args.limit < 1:
        raise SystemExit("--limit must be at least 1")
    if args.max_detail_pages < 0:
        raise SystemExit("--max-detail-pages cannot be negative")
    if args.max_records < 1:
        raise SystemExit("--max-records must be at least 1")
    listings = scrape(args)
    if not listings:
        print("No qualifying Kijiji listings found; existing output was left unchanged.", file=sys.stderr)
        return 1
    if args.merge_existing:
        listings = merge_listings(listings, read_csv(args.output), args.max_records)
    write_csv(listings, args.output)
    print(f"wrote {len(listings)} listings to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
