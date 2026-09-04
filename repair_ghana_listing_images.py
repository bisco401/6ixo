#!/usr/bin/env python3
"""Localize every published Ghana listing image from the production CSV."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from apify_import import read_existing_csv, write_csv
from ghana_marketplace_sync import localize_published_ghana_images


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=Path("data/scraped-listings.csv"))
    parser.add_argument("--delay", type=float, default=0.05)
    args = parser.parse_args()

    columns, rows = read_existing_csv(args.input)
    stats = localize_published_ghana_images(rows, Path.cwd(), delay=args.delay)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    write_csv(args.output, columns, rows)
    print(json.dumps({**stats, "rows": len(rows), "output": str(args.output)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
