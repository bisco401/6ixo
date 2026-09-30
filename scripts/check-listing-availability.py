#!/usr/bin/env python3
"""Recheck every imported feed without treating failed requests as removals."""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import threading
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urljoin, urlsplit

import requests
from bs4 import BeautifulSoup

FEEDS = [f"data/{name}" for name in (
    "scraped-listings.csv", "jamaica-listings.csv", "dubai-listings.csv",
    "guyana-listings.csv", "kenya-listings.csv", "kijiji-gta-recent-with-phones.csv",
    "oxglow-auto-parts-accessories-recent.csv", "oxglow-electronics-recent.csv", "oxglow-real-estate-recent.csv",
)]
UNAVAILABLE = {"sold", "unavailable", "gone"}
FIELDS = ["source_availability", "source_availability_checked_at", "source_http_status",
          "source_unavailable_reason", "source_last_seen_at", "source_resolved_url",
          "source_miss_count", "source_miss_recorded_at", "status", "sync_visibility",
          "sync_visibility_reason"]
USER_AGENT = "Mozilla/5.0 (compatible; 6ixoMarketplace/1.0; +https://6ixo.com)"


def source_url(row):
    value = (row.get("source_url") or row.get("url") or "").strip()
    if value.startswith("/") and "jacars" in row.get("source_site", "").lower():
        value = urljoin("https://www.jacars.net", value)
    return value if value.startswith(("https://", "http://")) else ""


def source_key(url):
    return re.sub(r"^https?://(?:www\.)?", "", url, flags=re.I).split("?")[0].split("#")[0].rstrip("/").lower()


def entities(value):
    if isinstance(value, list):
        for child in value:
            yield from entities(child)
    elif isinstance(value, dict):
        yield value
        if "@graph" in value:
            yield from entities(value["@graph"])


def classify(row, status, body, resolved_url=""):
    soup = BeautifulSoup(body or "", "html.parser")
    heading = " ".join(h.get_text(" ", strip=True) for h in soup.select("h1"))
    page_title = soup.title.get_text(" ", strip=True) if soup.title else ""
    # Inspect challenge documents before their HTTP code: some return a fake 404.
    if re.search(r"just a moment|access denied|verify you are human|attention required", page_title + " " + heading, re.I):
        return "unknown", "Source returned a verification or access page"
    if status in (401, 403, 429) or status >= 500 or status == 0:
        return "unknown", f"Blocked, limited, or temporary source error: HTTP {status}"
    original = source_url(row)
    if "kijiji.ca" in original and parse_qs(urlsplit(resolved_url).query).get("adRemoved") == ["true"]:
        return "unavailable", "Kijiji redirected the exact ad to adRemoved=true"
    if resolved_url and original and urlsplit(resolved_url).path.rstrip("/") != urlsplit(original).path.rstrip("/"):
        return "unknown", "Source redirected away from the exact listing"
    if status in (404, 410):
        return "gone", f"Exact source URL returned HTTP {status}"
    if not 200 <= status < 400:
        return "unknown", f"Unexpected HTTP {status}"
    title = row.get("title", "")
    words = [w for w in re.findall(r"[\w]+", title.lower()) if len(w) >= 3 and w not in {"sale", "used", "with", "for", "the", "and", "wholesale", "export"}]
    identity = (heading + " " + page_title).lower()
    matched = bool(words) and sum(w in identity for w in words) >= min(2, len(words))
    for script in soup.select('script[type="application/ld+json"]'):
        try:
            structured = json.loads(script.string or script.get_text())
        except (ValueError, TypeError):
            continue
        for entity in entities(structured):
            kinds = entity.get("@type", [])
            kinds = kinds if isinstance(kinds, list) else [kinds]
            if not set(kinds) & {"Product", "Vehicle", "Car", "Apartment", "House", "RealEstateListing"}:
                continue
            own_name = str(entity.get("name", "")).lower()
            own_url = str(entity.get("url") or entity.get("@id") or "").split("#")[0]
            exact = bool(own_url) and urlsplit(own_url).path.rstrip("/") == urlsplit(original).path.rstrip("/")
            if not exact and not (matched and own_name and sum(w in own_name for w in words) >= min(2, len(words))):
                continue
            offers = entity.get("offers", [])
            offers = offers if isinstance(offers, list) else [offers]
            stock = [str(o.get("availability", "")).rsplit("/", 1)[-1] for o in offers if isinstance(o, dict)]
            if any(s in {"InStock", "LimitedAvailability", "PreOrder", "BackOrder"} for s in stock):
                return "active", "Matching listing has an available source offer"
            if stock and all(s in {"SoldOut", "OutOfStock", "Discontinued"} for s in stock):
                return "sold" if "SoldOut" in stock else "unavailable", "All offers for this exact listing are unavailable"
    for node in soup.select("script,style,nav,footer,header,template"):
        node.decompose()
    # Never scan recommendations for availability text belonging to another ad.
    for node in soup.select('[class*="related"], [class*="recommend"], [class*="similar"], [id*="related"]'):
        node.decompose()
    if matched:
        # Explicit badges and alerts; exclude seller descriptions such as "never sold".
        for node in soup.find_all(string=re.compile(r"sold|no longer available|expired|removed", re.I)):
            text = str(node).strip()
            if len(text) > 140 or (node.parent and node.parent.name in {"option", "label"}):
                continue
            if re.fullmatch(r"(?:this )?(?:item|ad|listing|vehicle|property) (?:has been |is |already )?sold[.!]?|sold(?: out)?[.!]?", text, re.I):
                return "sold", f"Matching source listing displays: {text}"
            if re.fullmatch(r"(?:this )?(?:ad|listing|item|property) (?:is )?(?:no longer available|expired|removed)[.!]?", text, re.I):
                return "unavailable", f"Matching source listing displays: {text}"
    if not matched:
        return "unknown", "Source loaded but the listing identity was not confirmed"
    return "active", "Source title still matches the exact listing"


def apply_result(row, result, checked_at):
    availability, reason = result["availability"], result["reason"]
    # A later blocked request must not undo a previously confirmed removal.
    if availability == "unknown" and row.get("source_availability") in UNAVAILABLE:
        row["source_http_status"] = str(result["status"])
        return
    row.update(source_availability=availability, source_availability_checked_at=checked_at,
               source_http_status=str(result["status"]), source_unavailable_reason=reason,
               source_resolved_url=result["resolved_url"])
    if availability in UNAVAILABLE:
        misses = int(row.get("source_miss_count") or 0)
        if row.get("source_miss_recorded_at") != checked_at:
            misses += 1
        row.update(status="rejected", sync_visibility="unavailable", sync_visibility_reason=reason,
                   source_miss_count=str(misses), source_miss_recorded_at=checked_at)
    elif availability == "active":
        row.update(source_last_seen_at=checked_at, source_miss_count="0", source_miss_recorded_at="")
        if row.get("sync_visibility") == "unavailable":
            row.update(status="published", sync_visibility="visible", sync_visibility_reason="")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--files", nargs="+", default=FEEDS)
    parser.add_argument("--workers", type=int, default=16)
    parser.add_argument("--max-urls", type=int, default=0)
    parser.add_argument("--crawl4ai-url", default="")
    parser.add_argument("--cache-dir", type=Path)
    parser.add_argument("--report", type=Path, default=Path("output/listing-availability-report.json"))
    parser.add_argument("--ledger", type=Path, default=Path("data/listing-availability.json"))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    checked_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    feeds, by_url = {}, defaultdict(list)
    for name in args.files:
        path = Path(name)
        if not path.exists():
            continue
        with path.open(newline="", encoding="utf-8-sig") as handle:
            reader = csv.DictReader(handle)
            rows, headers = list(reader), list(reader.fieldnames or [])
        feeds[path] = (headers, rows)
        for row in rows:
            if url := source_url(row):
                by_url[url].append(row)
    urls = sorted(by_url, key=lambda u: min(r.get("source_availability_checked_at") or "" for r in by_url[u]))
    if args.max_urls:
        urls = urls[:args.max_urls]
    if args.cache_dir:
        args.cache_dir.mkdir(parents=True, exist_ok=True)
    limits = defaultdict(lambda: threading.Semaphore(3))
    def load(url):
        cache = args.cache_dir / (hashlib.sha256(url.encode()).hexdigest() + ".json") if args.cache_dir else None
        if cache and cache.exists():
            return json.loads(cache.read_text())
        with limits[urlsplit(url).netloc]:
            try:
                response = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=22)
                status, body, resolved = response.status_code, response.text, response.url
                availability, reason = classify(by_url[url][0], status, body, resolved)
            except requests.RequestException as error:
                status, availability, reason, resolved = 0, "unknown", type(error).__name__, url
        result = dict(url=url, availability=availability, reason=reason, status=status, resolved_url=resolved)
        if cache:
            cache.write_text(json.dumps(result))
        return result
    results = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for future in as_completed([pool.submit(load, url) for url in urls]):
            results.append(future.result())
            if len(results) % 100 == 0:
                print(json.dumps({"checked": len(results), "of": len(urls), "counts": dict(Counter(r["availability"] for r in results))}), flush=True)
    if args.crawl4ai_url:
        blocked = [r for r in results if r["availability"] == "unknown" and r["status"] in (403, 429)]
        for offset in range(0, len(blocked), 20):
            batch = blocked[offset:offset + 20]
            try:
                response = requests.post(args.crawl4ai_url, json={"urls": [r["url"] for r in batch],
                    "browser_config": {"type": "BrowserConfig", "params": {"headless": True}},
                    "crawler_config": {"type": "CrawlerRunConfig", "params": {"stream": False, "cache_mode": "bypass", "page_timeout": 30000}}}, timeout=180)
                response.raise_for_status()
                crawled = {r.get("url"): r for r in response.json().get("results", [])}
                for result in batch:
                    item = crawled.get(result["url"], {})
                    if not item.get("success"):
                        continue
                    status = int(item.get("status_code") or 0)
                    resolved = item.get("redirected_url") or result["url"]
                    availability, reason = classify(by_url[result["url"]][0], status, item.get("html") or "", resolved)
                    result.update(availability=availability, reason=reason, status=status, resolved_url=resolved)
                    if args.cache_dir:
                        (args.cache_dir / (hashlib.sha256(result["url"].encode()).hexdigest() + ".json")).write_text(json.dumps(result))
            except (requests.RequestException, ValueError) as error:
                print(f"Crawler batch deferred: {type(error).__name__}", flush=True)
            print(f"Browser recheck {min(offset+20, len(blocked))}/{len(blocked)}", flush=True)
    for result in results:
        for row in by_url[result["url"]]:
            apply_result(row, result, checked_at)
    if not args.dry_run:
        for path, (headers, rows) in feeds.items():
            headers = list(dict.fromkeys(headers + FIELDS))
            temporary = path.with_suffix(".availability.tmp")
            with temporary.open("w", newline="", encoding="utf-8") as handle:
                writer = csv.DictWriter(handle, fieldnames=headers, lineterminator="\n")
                writer.writeheader()
                writer.writerows(rows)
            temporary.replace(path)
        ledger = json.loads(args.ledger.read_text()).get("listings", {}) if args.ledger.exists() else {}
        for result in results:
            key = source_key(result["url"])
            if result["availability"] == "active":
                ledger.pop(key, None)
            elif result["availability"] in UNAVAILABLE:
                ledger[key] = {"availability": result["availability"], "checkedAt": checked_at, "reason": result["reason"]}
        args.ledger.parent.mkdir(parents=True, exist_ok=True)
        args.ledger.write_text(json.dumps({"checkedAt": checked_at, "listings": ledger}, indent=2) + "\n")
    report = {"checkedAt": checked_at, "checkedUrls": len(results), "counts": dict(Counter(r["availability"] for r in results)),
              "byDomain": {h: dict(Counter(r["availability"] for r in results if urlsplit(r["url"]).netloc == h)) for h in sorted({urlsplit(r["url"]).netloc for r in results})},
              "results": results}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2))
    print(json.dumps({k: v for k, v in report.items() if k != "results"}, indent=2))


if __name__ == "__main__":
    main()
