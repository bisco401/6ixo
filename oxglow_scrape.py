#!/usr/bin/env python3
"""Scrape public Oxglow listing summaries.

This only reads publicly available HTML. It does not log in, bypass access
controls, or click hidden UI.
"""

from __future__ import annotations

import argparse
import csv
import html
import json
import re
import sys
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Iterable
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen


DEFAULT_URL = "https://oxglow.com.gh/real-estate"
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
)


@dataclass
class Listing:
    title: str
    price: str
    url: str
    image_url: str
    image_urls: str
    image_files: str
    description: str
    location: str
    published_at: str
    seller: str = ""
    phone_numbers: str = ""
    category: str = ""
    sku: str = ""


def normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(value)).strip()


def classes(attrs: list[tuple[str, str | None]]) -> set[str]:
    value = dict(attrs).get("class") or ""
    return set(value.split())


def absolute_url(base_url: str, maybe_url: str) -> str:
    return urljoin(base_url, maybe_url)


def full_size_image_url(base_url: str, maybe_url: str) -> str:
    # Oxglow's Product schema sometimes labels a `-medium` filename as an
    # original. Removing that suffix fabricates a URL that often returns 404.
    return absolute_url(base_url, maybe_url)


def image_download_candidates(base_url: str, maybe_url: str) -> list[str]:
    """Return real Oxglow image variants without inventing an original URL."""
    url = absolute_url(base_url, maybe_url)
    candidates: list[str] = []

    def add(candidate: str) -> None:
        if candidate and candidate not in candidates:
            candidates.append(candidate)

    add(url)
    if "/uploads/original/" in url:
        medium = url.replace("/uploads/original/", "/uploads/medium/", 1)
        add(medium)
        path, separator, query = medium.partition("?")
        if not re.search(r"-medium\.(?:jpe?g|png|webp)$", path, flags=re.I):
            with_suffix = re.sub(
                r"(\.(?:jpe?g|png|webp))$",
                r"-medium\1",
                path,
                flags=re.I,
            )
            add(with_suffix + (separator + query if separator else ""))
    return candidates


def is_image_bytes(data: bytes) -> bool:
    return (
        data.startswith(b"\xff\xd8\xff")
        or data.startswith(b"\x89PNG\r\n\x1a\n")
        or data.startswith((b"GIF87a", b"GIF89a"))
        or (len(data) >= 12 and data.startswith(b"RIFF") and data[8:12] == b"WEBP")
    )


def fetch_html(url: str, delay: float = 0.0) -> str:
    if delay > 0:
        time.sleep(delay)

    request = Request(url, headers={"User-Agent": DEFAULT_USER_AGENT})
    with urlopen(request, timeout=30) as response:
        charset = response.headers.get_content_charset() or "utf-8"
        return response.read().decode(charset, errors="replace")


def fetch_bytes(url: str, delay: float = 0.0) -> bytes:
    if delay > 0:
        time.sleep(delay)

    request = Request(url, headers={"User-Agent": DEFAULT_USER_AGENT})
    with urlopen(request, timeout=30) as response:
        return response.read()


def extract_next_page_url(source_html: str, base_url: str) -> str:
    match = re.search(r'<link\s+rel="next"\s+href="([^"]+)"', source_html, flags=re.I)
    if not match:
        return ""
    return absolute_url(base_url, match.group(1))


def timestamp_from_media_url(media_url: str) -> str:
    match = re.search(r"-(1[0-9]{9})-\d+-(?:medium|thumbnail|original)\.", media_url)
    if not match:
        return ""

    stamp = datetime.fromtimestamp(int(match.group(1)), tz=timezone.utc)
    return stamp.isoformat()


def unique_join(values: Iterable[str]) -> str:
    seen: set[str] = set()
    output: list[str] = []
    for value in values:
        cleaned = normalize_text(value)
        if not cleaned or cleaned in seen:
            continue
        output.append(cleaned)
        seen.add(cleaned)
    return " | ".join(output)


def split_joined(value: str) -> list[str]:
    return [item.strip() for item in value.split("|") if item.strip()]


def extract_phone_numbers(source_html: str) -> str:
    numbers = re.findall(r'data-full-number=["\']([^"\']+)["\']', source_html)
    return unique_join(numbers)


def safe_filename(value: str, fallback: str) -> str:
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-._")
    return name[:90] or fallback


class ListingCardParser(HTMLParser):
    def __init__(self, base_url: str) -> None:
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.listings: list[Listing] = []
        self._current: dict[str, str] | None = None
        self._capture_field: str | None = None
        self._capture_parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr_dict = dict(attrs)
        tag_classes = classes(attrs)

        if tag == "a" and ({"listing-link", "ox-listing-card"} & tag_classes):
            href = attr_dict.get("href") or ""
            self._current = {
                "url": absolute_url(self.base_url, href),
                "title": "",
                "price": "",
                "image_url": "",
                "description": "",
                "location": "",
            }
            return

        if self._current is None:
            return

        if tag == "img" and not self._current["image_url"]:
            src = attr_dict.get("data-src") or attr_dict.get("src") or ""
            self._current["image_url"] = absolute_url(self.base_url, src)
            return

        field = None
        if tag in {"h3", "h4"} and ("ox-listing-title" in tag_classes or tag == "h4"):
            field = "title"
        elif "price" in tag_classes or "ox-listing-price" in tag_classes:
            field = "price"
        elif "description" in tag_classes or "ox-listing-copy" in tag_classes:
            field = "description"
        elif "location" in tag_classes:
            field = "location"

        if field:
            self._capture_field = field
            self._capture_parts = []

    def handle_data(self, data: str) -> None:
        if self._capture_field:
            self._capture_parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if self._current is None:
            return

        if self._capture_field and tag in {"h3", "h4", "p", "div"}:
            value = normalize_text(" ".join(self._capture_parts))
            if self._capture_field == "location":
                value = re.sub(r"^Location:\s*", "", value, flags=re.I)
            self._current[self._capture_field] = value
            self._capture_field = None
            self._capture_parts = []
            return

        if tag == "a":
            image_url = self._current["image_url"]
            self.listings.append(
                Listing(
                    title=self._current["title"],
                    price=self._current["price"],
                    url=self._current["url"],
                    image_url=image_url,
                    image_urls=image_url,
                    image_files="",
                    description=self._current["description"],
                    location=self._current["location"],
                    published_at=timestamp_from_media_url(image_url),
                )
            )
            self._current = None


class JsonLdParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.blocks: list[str] = []
        self._in_json_ld = False
        self._parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "script" and dict(attrs).get("type") == "application/ld+json":
            self._in_json_ld = True
            self._parts = []

    def handle_data(self, data: str) -> None:
        if self._in_json_ld:
            self._parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "script" and self._in_json_ld:
            self.blocks.append("".join(self._parts).strip())
            self._in_json_ld = False
            self._parts = []


def parse_listing_cards(source_html: str, base_url: str, limit: int) -> list[Listing]:
    parser = ListingCardParser(base_url)
    parser.feed(source_html)
    seen: set[str] = set()
    listings: list[Listing] = []

    for listing in parser.listings:
        if not listing.url or listing.url in seen:
            continue
        if not listing.title:
            continue
        listings.append(listing)
        seen.add(listing.url)
        if len(listings) >= limit:
            break

    return listings


def fetch_live_listing_cards(start_url: str, limit: int, delay: float) -> list[Listing]:
    listings: list[Listing] = []
    seen: set[str] = set()
    next_url = start_url

    while next_url and len(listings) < limit:
        source_html = fetch_html(next_url, delay=delay)
        page_listings = parse_listing_cards(source_html, next_url, limit)
        for listing in page_listings:
            if listing.url in seen:
                continue
            listings.append(listing)
            seen.add(listing.url)
            if len(listings) >= limit:
                break
        next_url = extract_next_page_url(source_html, next_url)

    return listings


def extract_product_schema(source_html: str) -> dict:
    parser = JsonLdParser()
    parser.feed(source_html)

    for block in parser.blocks:
        try:
            payload = json.loads(block, strict=False)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict) and payload.get("@type") == "Product":
            return payload
    return {}


def enrich_from_detail(listing: Listing, delay: float) -> Listing:
    detail_html = fetch_html(listing.url, delay=delay)
    listing.phone_numbers = extract_phone_numbers(detail_html)

    product = extract_product_schema(detail_html)
    if not product:
        return listing

    offers = product.get("offers") if isinstance(product.get("offers"), dict) else {}
    seller = offers.get("seller") if isinstance(offers.get("seller"), dict) else {}
    location = product.get("location") if isinstance(product.get("location"), dict) else {}
    address = location.get("address") if isinstance(location.get("address"), dict) else {}

    listing.title = normalize_text(product.get("name") or listing.title)
    listing.description = normalize_text(product.get("description") or listing.description)
    listing.category = normalize_text(product.get("category") or "")
    listing.sku = normalize_text(product.get("sku") or "")
    listing.seller = normalize_text(seller.get("name") or "")

    if offers.get("price"):
        listing.price = f"GHS {offers['price']}"

    locality = normalize_text(address.get("addressLocality") or "")
    region = normalize_text(address.get("addressRegion") or listing.location)
    listing.location = ", ".join(part for part in [locality, region] if part)

    image = product.get("image")
    image_urls: list[str] = []
    if isinstance(image, list):
        image_urls = [full_size_image_url(listing.url, item) for item in image if isinstance(item, str)][:4]
    elif isinstance(image, str):
        image_urls = [full_size_image_url(listing.url, image)]

    if image_urls:
        listing.image_url = image_urls[0]
        listing.image_urls = unique_join(image_urls[:4])

    if not listing.published_at:
        listing.published_at = timestamp_from_media_url(listing.image_url)

    return listing


def download_listing_images(listing: Listing, image_dir: Path, delay: float) -> Listing:
    image_urls = split_joined(listing.image_urls or listing.image_url)[:4]
    if not image_urls:
        return listing

    image_dir.mkdir(parents=True, exist_ok=True)
    listing_slug = safe_filename(listing.sku or listing.title, "listing")
    saved_paths: list[str] = []

    for index, image_url in enumerate(image_urls, start=1):
        parsed = urlparse(image_url)
        suffix = Path(parsed.path).suffix or ".jpg"
        filename = f"{listing_slug}-{index}{suffix}"
        destination = image_dir / filename
        try:
            if destination.exists() and is_image_bytes(destination.read_bytes()[:16]):
                saved_paths.append(str(destination))
                continue
            last_error: Exception | None = None
            for candidate in image_download_candidates(listing.url, image_url):
                try:
                    image_bytes = fetch_bytes(candidate, delay=delay)
                    if not is_image_bytes(image_bytes[:16]):
                        raise ValueError("response was not an image")
                    destination.write_bytes(image_bytes)
                    saved_paths.append(str(destination))
                    last_error = None
                    break
                except Exception as err:
                    last_error = err
            if last_error:
                raise last_error
        except Exception as err:
            print(f"warning: failed image download for {image_url}: {err}", file=sys.stderr)
            continue

    listing.image_files = unique_join(saved_paths)
    return listing


def write_json(listings: Iterable[Listing], output: Path | None) -> None:
    payload = json.dumps([asdict(item) for item in listings], indent=2, ensure_ascii=False)
    if output:
        output.write_text(payload + "\n", encoding="utf-8")
    else:
        print(payload)


def write_csv(listings: Iterable[Listing], output: Path | None) -> None:
    rows = [asdict(item) for item in listings]
    fields = list(Listing.__dataclass_fields__.keys())
    if output:
        with output.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=fields)
            writer.writeheader()
            writer.writerows(rows)
        return

    writer = csv.DictWriter(sys.stdout, fieldnames=fields)
    writer.writeheader()
    writer.writerows(rows)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Scrape recent public listings from Oxglow.")
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--url", default=DEFAULT_URL, help=f"Oxglow category URL. Defaults to {DEFAULT_URL}")
    source.add_argument("--html-file", type=Path, help="Use saved Oxglow category HTML instead of fetching.")
    parser.add_argument("--limit", type=int, default=50, help="Maximum newest listings to output.")
    parser.add_argument("--detail", action="store_true", help="Fetch each listing page and enrich with schema data.")
    parser.add_argument("--download-images", action="store_true", help="Download listing pictures locally.")
    parser.add_argument(
        "--image-dir",
        type=Path,
        default=Path("data/oxglow-real-estate-images"),
        help="Directory for downloaded pictures.",
    )
    parser.add_argument("--delay", type=float, default=0.5, help="Delay before live requests, in seconds.")
    parser.add_argument("--format", choices=["json", "csv"], default="json", help="Output format.")
    parser.add_argument("--output", type=Path, help="Output file. Defaults to stdout.")
    return parser


def main() -> int:
    args = build_parser().parse_args()

    if args.limit < 1:
        raise SystemExit("--limit must be at least 1")

    if args.html_file:
        source_html = args.html_file.read_text(encoding="utf-8", errors="replace")
        base_url = args.url
        listings = parse_listing_cards(source_html, base_url, args.limit)
    else:
        listings = fetch_live_listing_cards(args.url, args.limit, args.delay)
    if args.detail:
        listings = [enrich_from_detail(item, delay=args.delay) for item in listings]
    if args.download_images:
        listings = [download_listing_images(item, args.image_dir, delay=args.delay) for item in listings]

    if args.format == "json":
        write_json(listings, args.output)
    else:
        write_csv(listings, args.output)

    if not listings:
        print("No Oxglow listing cards found.", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
