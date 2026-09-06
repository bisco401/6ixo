#!/usr/bin/env python3
"""Refresh Ghana marketplace listings from Oxglow without replacing other countries."""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Iterable

from apify_import import merge_rows, normalize_item, read_existing_csv, write_csv
from oxglow_scrape import (
    Listing,
    download_listing_images,
    enrich_from_detail,
    fetch_live_listing_cards,
    full_size_image_url,
)


CONFIRMED_UNAVAILABLE = {"sold", "unavailable", "gone"}


@dataclass(frozen=True)
class GhanaSource:
    name: str
    url: str
    target_surface: str
    app_category: str
    app_subcategory: str


SOURCES = (
    GhanaSource("vehicles", "https://oxglow.com.gh/vehicles", "vehicles", "vehicles", "vehicles"),
    GhanaSource("electronics", "https://oxglow.com.gh/electronics", "marketplace", "electronics", "other"),
    GhanaSource("real-estate", "https://oxglow.com.gh/real-estate", "marketplace", "real_estate", "for_sale"),
    GhanaSource("auto-parts", "https://oxglow.com.gh/auto-parts-accessories", "vehicles", "vehicles", "auto_parts"),
)


def clean(value: object = "") -> str:
    return " ".join(str(value or "").split()).strip()


def parse_timestamp(value: str) -> float:
    text = clean(value)
    if not text:
        return 0.0
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


def row_timestamp(row: dict[str, str]) -> float:
    attributes: dict = {}
    try:
        attributes = json.loads(row.get("attributes") or "{}") or {}
    except (TypeError, json.JSONDecodeError):
        pass
    for value in (
        row.get("source_posted_at"),
        row.get("posted_at"),
        row.get("published_at"),
        attributes.get("sourcePostedAt"),
        row.get("scraped_at"),
    ):
        timestamp = parse_timestamp(clean(value))
        if timestamp:
            return timestamp
    return 0.0


def normalize_listing(listing: Listing, source: GhanaSource, checked_at: str) -> dict[str, str] | None:
    args = SimpleNamespace(
        base_url="https://oxglow.com.gh",
        source_site="Oxglow",
        seller="",
        city=clean(listing.location),
        country="Ghana",
        status="published",
        max_images=4,
        target_surface=source.target_surface,
        category=source.app_category,
        subcategory=source.app_subcategory,
        condition="good",
        dataset_id="",
    )
    row = normalize_item(asdict(listing), args)
    if not row or not clean(row.get("phone")) or not clean(row.get("image_urls")):
        return None

    row["image_urls"] = "|".join(
        full_size_image_url(row["source_url"], image)
        for image in str(row["image_urls"]).split("|")
        if clean(image)
    )

    source_posted_at = clean(listing.published_at)
    attributes = json.loads(row.get("attributes") or "{}")
    attributes.update(
        {
            "parser": "ghana_marketplace_sync",
            "sourceCategory": source.name,
            "sourcePostedAt": source_posted_at,
        }
    )
    row.update(
        {
            "status": "published",
            "scraped_at": source_posted_at or checked_at,
            "attributes": json.dumps(attributes, ensure_ascii=False, separators=(",", ":")),
            "source_availability": "active",
            "source_availability_checked_at": checked_at,
            "source_http_status": "200",
            "source_unavailable_reason": "",
            "source_last_seen_at": checked_at,
            "source_resolved_url": row["source_url"],
            "source_miss_count": "0",
            "source_miss_recorded_at": "",
            "sync_visibility": "visible",
            "sync_visibility_reason": "",
        }
    )
    local_images = [clean(value) for value in str(listing.image_files or "").split("|") if clean(value)]
    if local_images:
        row["image_urls"] = "|".join(local_images[:4])
    return row


def has_managed_local_images(row: dict[str, str], repository_root: Path) -> bool:
    images = [clean(value) for value in str(row.get("image_urls") or "").split("|") if clean(value)]
    return bool(images) and all(
        image.startswith("data/oxglow-") and (repository_root / image).is_file()
        for image in images
    )


def apply_ghana_cap(rows: list[dict[str, str]], maximum: int) -> dict[str, int]:
    candidates = []
    for row in rows:
        if clean(row.get("country")).lower() != "ghana":
            continue
        availability = clean(row.get("source_availability")).lower()
        if availability in CONFIRMED_UNAVAILABLE:
            continue
        policy_managed = clean(row.get("sync_visibility")).lower() in {"visible", "capped"}
        if clean(row.get("status")).lower() != "published" and not policy_managed:
            continue
        candidates.append(row)

    candidates.sort(key=lambda row: (row_timestamp(row), clean(row.get("source_url"))), reverse=True)
    for index, row in enumerate(candidates):
        if index < maximum:
            row["status"] = "published"
            row["sync_visibility"] = "visible"
            row["sync_visibility_reason"] = ""
        else:
            row["status"] = "rejected"
            row["sync_visibility"] = "capped"
            row["sync_visibility_reason"] = f"Outside the {maximum} newest listings for Ghana."
    return {"eligible": len(candidates), "published": min(len(candidates), maximum), "capped": max(0, len(candidates) - maximum)}


def merge_ghana_listings(
    existing: list[dict[str, str]],
    incoming: Iterable[dict[str, str]],
    repository_root: Path,
    maximum: int = 50,
) -> tuple[list[dict[str, str]], dict[str, int]]:
    existing_by_url = {clean(row.get("source_url")): row for row in existing if clean(row.get("source_url"))}
    prepared = []
    for row in incoming:
        current = existing_by_url.get(clean(row.get("source_url")))
        if current and has_managed_local_images(current, repository_root):
            row = {**row, "image_urls": current["image_urls"]}
        prepared.append(row)

    merged = merge_rows(existing, prepared)
    stats = apply_ghana_cap(merged, maximum)
    stats["incoming"] = len(prepared)
    stats["totalRows"] = len(merged)
    return merged, stats


def localize_published_ghana_images(
    rows: list[dict[str, str]],
    repository_root: Path,
    delay: float = 0.0,
) -> dict[str, int]:
    """Store published Ghana photos in the repo and drop broken remote URLs."""
    localized_listings = 0
    localized_images = 0
    unresolved: list[str] = []
    image_dir = repository_root / "data/oxglow-listing-images"

    for row in rows:
        if clean(row.get("country")).lower() != "ghana" or clean(row.get("status")).lower() != "published":
            continue
        current_images = [clean(value) for value in str(row.get("image_urls") or "").split("|") if clean(value)]
        valid_local = [
            image for image in current_images
            if not image.startswith(("http://", "https://")) and (repository_root / image).is_file()
        ]
        remote_images = [image for image in current_images if image.startswith(("http://", "https://"))]

        downloaded: list[str] = []
        if remote_images:
            listing = Listing(
                title=clean(row.get("title")),
                price=clean(row.get("price_text")),
                url=clean(row.get("source_url")),
                image_url=remote_images[0],
                image_urls=" | ".join(remote_images[:4]),
                image_files="",
                description=clean(row.get("description")),
                location=clean(row.get("city")),
                published_at=clean(row.get("scraped_at")),
                sku=clean(row.get("id")),
            )
            listing = download_listing_images(listing, image_dir, delay=delay)
            for saved in str(listing.image_files or "").split("|"):
                saved_value = clean(saved)
                if not saved_value:
                    continue
                saved_path = Path(saved_value)
                try:
                    downloaded.append(saved_path.relative_to(repository_root).as_posix())
                except ValueError:
                    downloaded.append(saved_path.as_posix())

        final_images = list(dict.fromkeys([*valid_local, *downloaded]))[:4]
        if not final_images:
            unresolved.append(clean(row.get("id")) or clean(row.get("title")) or "unknown")
            continue
        if remote_images or final_images != current_images:
            row["image_urls"] = "|".join(final_images)
            localized_listings += 1
            localized_images += len(downloaded)

    if unresolved:
        raise RuntimeError(f"Could not recover images for published Ghana listings: {', '.join(unresolved)}")
    return {"localizedListings": localized_listings, "localizedImages": localized_images}


def scrape_source(
    source: GhanaSource,
    limit: int,
    delay: float,
    checked_at: str,
    localize_vehicles: int = 0,
) -> list[dict[str, str]]:
    cards = fetch_live_listing_cards(source.url, limit, delay)
    rows = []
    for index, card in enumerate(cards):
        try:
            listing = enrich_from_detail(card, delay=delay)
            if source.name == "vehicles" and index < localize_vehicles:
                listing = download_listing_images(listing, Path("data/oxglow-vehicles-images"), delay=delay)
            row = normalize_listing(listing, source, checked_at)
            if row:
                rows.append(row)
        except Exception as error:  # One removed detail page must not abort the whole country refresh.
            print(f"warning: {source.name} detail failed for {card.url}: {error}", file=sys.stderr)
    if not rows:
        raise RuntimeError(f"Oxglow returned no publishable {source.name} listings; refusing a partial refresh.")
    return rows


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Refresh and merge current Ghana marketplace listings.")
    parser.add_argument("--output", type=Path, default=Path("data/scraped-listings.csv"))
    parser.add_argument("--limit-per-source", type=int, default=25)
    parser.add_argument("--max-published", type=int, default=50)
    parser.add_argument("--delay", type=float, default=0.25)
    parser.add_argument("--min-total", type=int, default=8)
    parser.add_argument("--localize-vehicles", type=int, default=0)
    parser.add_argument("--localize-published", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if args.limit_per_source < 1 or args.max_published < 1 or args.min_total < 1 or args.localize_vehicles < 0:
        raise SystemExit("Limits must be positive integers, and --localize-vehicles cannot be negative.")

    checked_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    incoming = []
    source_counts = {}
    for source in SOURCES:
        rows = scrape_source(source, args.limit_per_source, args.delay, checked_at, args.localize_vehicles)
        incoming.extend(rows)
        source_counts[source.name] = len(rows)
    if len(incoming) < args.min_total:
        raise RuntimeError(f"Only {len(incoming)} Ghana listings were collected; refusing to update the CSV.")

    columns, existing = read_existing_csv(args.output)
    merged, stats = merge_ghana_listings(existing, incoming, Path.cwd(), args.max_published)
    if args.localize_published:
        stats.update(localize_published_ghana_images(merged, Path.cwd(), delay=args.delay))
    summary = {"sources": source_counts, **stats, "output": str(args.output)}
    if not args.dry_run:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        write_csv(args.output, columns, merged)
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
