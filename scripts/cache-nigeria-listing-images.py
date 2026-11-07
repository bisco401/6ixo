#!/usr/bin/env python3
"""Preserve exact Korrect Cars photos: its same-site policy blocks embedded images."""
import csv
import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]


def main():
    manifest = ROOT / 'data/listing-image-cache.json'
    cache = json.loads(manifest.read_text()) if manifest.exists() else {}
    urls = set()
    with (ROOT / 'data/scraped-listings.csv').open(newline='') as feed:
        for row in csv.DictReader(feed):
            if row.get('country') != 'Nigeria' or row.get('status') != 'published':
                continue
            for url in row.get('image_urls', '').split('|'):
                parsed = urlsplit(url)
                if parsed.scheme == 'https' and parsed.hostname == 'www.korrectcars.com' and parsed.path.startswith('/uploads/cars/'):
                    urls.add(url)

    def preserve(url):
        local = '/data/listing-image-cache/' + hashlib.sha256(url.encode()).hexdigest()[:20] + '.jpg'
        target = ROOT / local.lstrip('/')
        if cache.get(url) == local and target.exists() and target.stat().st_size > 1024:
            return url, local
        with urlopen(Request(url, headers={'User-Agent': '6ixo-listing-photo-cache/1.0'}), timeout=30) as response:
            content = response.read(20_000_001)
            if response.headers.get_content_type() != 'image/jpeg' or not content.startswith(b'\xff\xd8\xff') or not 1024 < len(content) <= 20_000_000:
                raise ValueError(f'Expected a complete JPEG photo: {url}')
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        return url, local

    # Write the manifest only once every selected photo has been obtained.
    with ThreadPoolExecutor(max_workers=6) as pool:
        additions = dict(pool.map(preserve, sorted(urls)))
    cache.update(additions)
    manifest.write_text(json.dumps(cache, indent=2) + '\n')
    print(f'Cached all {len(additions)} Nigeria dealer gallery photos.')


if __name__ == '__main__':
    main()
