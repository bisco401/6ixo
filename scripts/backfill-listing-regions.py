#!/usr/bin/env python3
"""Repair missing US states from each exact source address, never its search area."""
import argparse
import csv
import importlib.util
import json
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("refresh", ROOT / "scripts/refresh-marketplace-listings.py")
refresh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(refresh)


def verified_region(row, body, resolved_url):
    state, reason = refresh.availability.classify(row, 200, body, resolved_url)
    if state != "active":
        raise ValueError(reason)
    _, product = refresh.product_schema(body)
    address = (product.get("offers") or {}).get("availableAtOrFrom", {}).get("address") or product.get("address") or {}
    if refresh.clean(address.get("addressLocality")).casefold() != refresh.clean(row["city"]).casefold():
        raise ValueError("Source city no longer matches saved listing")
    source_state = refresh.clean(address.get("addressRegion"))
    region = refresh.US_STATES.get(source_state.upper(), source_state)
    if region not in refresh.US_STATES.values():
        raise ValueError("No recognized source state")
    return region


def apply_report(path, report):
    with path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        rows, headers = list(reader), reader.fieldnames
    updated = 0
    for row in rows:
        result = report["regions"].get(row.get("source_url"))
        if not result or row.get("title") != result["title"] or row.get("city") != result["city"]:
            continue
        attrs = json.loads(row.get("attributes") or "{}")
        attrs.update(region=result["region"], regionSourceUrl=row["source_url"], regionVerifiedAt=report["checkedAt"])
        if result["region"] == "New York" and row["city"] in {"Brooklyn", "Bronx", "Manhattan", "Queens", "Staten Island"}:
            attrs["searchMetro"] = "New York City"
        row["attributes"] = json.dumps(attrs, ensure_ascii=False, separators=(",", ":"))
        updated += 1
    temporary = path.with_suffix(".regions.tmp")
    with temporary.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=headers, lineterminator="\n")
        writer.writeheader(); writer.writerows(rows)
    temporary.replace(path)
    return updated


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=Path("output/listing-regions-report.json"))
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--apply-report", action="store_true")
    args = parser.parse_args()
    feed = ROOT / "data/scraped-listings.csv"
    if args.apply_report:
        print(f"Updated {apply_report(feed, json.loads(args.report.read_text()))} source-verified regions")
        return
    rows = list(csv.DictReader(feed.open()))
    rows = [r for r in rows if r.get("country") == "United States" and r.get("status") == "published"
            and "craigslist.org/" in r.get("source_url", "") and not json.loads(r.get("attributes") or "{}").get("region")]
    def fetch(row):
        try:
            r = requests.get(row["source_url"], headers={"User-Agent": refresh.availability.USER_AGENT}, timeout=20)
            r.raise_for_status()
            return row["source_url"], {"title": row["title"], "city": row["city"], "region": verified_region(row, r.text, r.url)}, None
        except (requests.RequestException, ValueError, TypeError, KeyError) as e:
            return row["source_url"], None, str(e)[:180]
    regions, failures = {}, []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for index, (url, result, error) in enumerate(pool.map(fetch, rows)):
            if result:
                regions[url] = result
            else:
                failures.append({"url": url, "reason": error})
            if (index + 1) % 100 == 0:
                print(f"Checked {index + 1}/{len(rows)}; verified {len(regions)} source addresses", flush=True)
    report = {"checkedAt": datetime.now(timezone.utc).isoformat(), "checked": len(rows), "regions": regions, "failures": failures,
              "counts": dict(Counter(r["region"] for r in regions.values()))}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2))
    print(json.dumps({k: v for k, v in report.items() if k not in {"regions", "failures"}}, indent=2))


if __name__ == "__main__":
    main()
