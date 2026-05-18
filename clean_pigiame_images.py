#!/usr/bin/env python3
"""Create cleaner local copies of Pigiame thumbnail images and update the CSV."""

from __future__ import annotations

import argparse
import csv
import json
import re
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen


def split_images(value: str) -> list[str]:
    return [part.strip() for part in re.split(r"\s*\|\s*", value or "") if part.strip()]


def safe_stem(value: str) -> str:
    stem = re.sub(r"[^a-zA-Z0-9_-]+", "-", value.strip()).strip("-")
    return stem[:80] or "pigiame-image"


def image_suffix(url: str) -> str:
    suffix = Path(urlparse(url).path).suffix.lower()
    if suffix in {".jpg", ".jpeg", ".png", ".webp"}:
        return ".jpg" if suffix == ".jpeg" else suffix
    return ".jpg"


def fetch_image(url: str) -> bytes:
    request = Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
            "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        },
    )
    with urlopen(request, timeout=30) as response:
        return response.read()


def clean_image(url: str, destination: Path, width: int) -> bool:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(suffix=image_suffix(url), delete=False) as handle:
        temp_path = Path(handle.name)
        handle.write(fetch_image(url))
    try:
        destination.write_bytes(temp_path.read_bytes())
        subprocess.run(
            ["sips", "--resampleWidth", str(width), str(destination)],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if destination.suffix.lower() in {".jpg", ".jpeg"}:
            subprocess.run(
                ["sips", "-s", "formatOptions", "92", str(destination)],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        return destination.exists() and destination.stat().st_size > 0
    finally:
        temp_path.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Clean current Pigiame listing thumbnails.")
    parser.add_argument("--csv", type=Path, default=Path("data/scraped-listings.csv"))
    parser.add_argument("--image-dir", type=Path, default=Path("data/pigiame-clean-images"))
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    with args.csv.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        fieldnames = list(reader.fieldnames or [])
        rows = list(reader)

    updated_rows = 0
    downloaded = 0
    failed: list[str] = []

    for row in rows:
        if str(row.get("source_site", "")).strip().lower() != "pigiame":
            continue
        row_id = safe_stem(row.get("id", ""))
        source_images = split_images(row.get("image_urls", ""))
        if not source_images:
            continue

        cleaned_images: list[str] = []
        original_images: list[str] = []
        for index, image_url in enumerate(source_images, start=1):
            if image_url.startswith("data/pigiame-clean-images/"):
                cleaned_images.append(image_url)
                continue
            original_images.append(image_url)
            if "i.roamcdn.net" not in image_url:
                cleaned_images.append(image_url)
                continue
            suffix = image_suffix(image_url)
            destination = args.image_dir / f"{row_id}-{index}{suffix}"
            relative_destination = destination.as_posix()
            if not destination.exists():
                if args.limit and downloaded >= args.limit:
                    cleaned_images.append(image_url)
                    continue
                try:
                    if clean_image(image_url, destination, args.width):
                        downloaded += 1
                except Exception as exc:  # noqa: BLE001
                    failed.append(f"{row_id}: {exc}")
                    cleaned_images.append(image_url)
                    continue
            cleaned_images.append(relative_destination)

        if cleaned_images and cleaned_images != source_images:
            row["image_urls"] = "|".join(cleaned_images)
            try:
                attributes = json.loads(row.get("attributes") or "{}")
                if original_images and "originalImageUrls" not in attributes:
                    attributes["originalImageUrls"] = original_images
                attributes["cleanedImageWidth"] = args.width
                row["attributes"] = json.dumps(attributes, ensure_ascii=False, separators=(",", ":"))
            except json.JSONDecodeError:
                pass
            updated_rows += 1

    with args.csv.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames, extrasaction="ignore", lineterminator="\n")
        writer.writeheader()
        for row in rows:
            writer.writerow(row)

    print(f"updated_rows={updated_rows} downloaded={downloaded} failed={len(failed)}")
    for item in failed[:10]:
        print(f"warning: {item}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
