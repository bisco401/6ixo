#!/usr/bin/env python3
"""Verify larger renditions of the same listing photos; never enlarge source pixels.

Input is an export of the published, identity-checked inventory. The report keeps
unrecoverable photos visible for review. Only verified improvements enter the
image cache manifest; original feed URLs and identity proofs are preserved.
"""
import argparse
import hashlib
import io
import json
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import quote, urlsplit, urlunsplit
from urllib.request import Request, urlopen

from PIL import Image, ImageFile

ROOT = Path(__file__).resolve().parents[1]
MAX_BYTES = 20_000_000


def candidates(url):
    parsed = urlsplit(url)
    host, path = parsed.hostname, parsed.path
    paths = []
    if host == 'images.craigslist.org':
        paths.append(re.sub(r'_(?:50x50c|300x300|600x450)(?=\.)', '_1200x900', path))
    if host == 'oxglow.com.gh' and path.startswith('/uploads/medium/'):
        paths.append(path.replace('/medium/', '/original/').replace('-medium.', '.'))
    if '/wp-content/uploads/' in path:
        paths.append(re.sub(r'-\d{2,4}x\d{2,4}(?=\.[^.]+$)', '', path))
    if '/cdn/shop/' in path:
        paths.append(re.sub(r'_\d+x\d*(?=\.[^.]+$)', '', path))
    return list(dict.fromkeys(urlunsplit(parsed._replace(path=p)) for p in paths if p != path))


def read_image(url, full=False):
    if url.startswith(('https://', 'http://')):
        parsed = urlsplit(url)
        url = urlunsplit(parsed._replace(path=quote(parsed.path, safe='/%:@!$&\'()*+,;=-._~')))
        with urlopen(Request(url, headers={'User-Agent': 'Mozilla/5.0', 'Accept': 'image/webp,image/*'}), timeout=20) as response:
            if not response.headers.get_content_type().startswith(('image/', 'application/octet-stream')):
                raise ValueError('Response is not an image')
            if full:
                data = response.read(MAX_BYTES + 1)
            else:
                parser = ImageFile.Parser()
                chunks = []
                for _ in range(512):
                    chunk = response.read(4096)
                    if not chunk:
                        break
                    chunks.append(chunk)
                    try:
                        parser.feed(chunk)
                    except (OSError, ValueError, RuntimeError):
                        # Some WebP/AVIF decoders need the complete file.
                        chunks.append(response.read(MAX_BYTES + 1 - sum(map(len, chunks))))
                        break
                    if parser.image:
                        image = parser.image
                        return {'width': image.width, 'height': image.height, 'format': image.format}, b''
                data = b''.join(chunks)
    else:
        data = (ROOT / url.lstrip('/')).read_bytes()
    if not 100 < len(data) <= MAX_BYTES:
        raise ValueError('Image exceeds size limit or is empty')
    with Image.open(io.BytesIO(data)) as image:
        image.load()  # Reject truncated files, not just unreadable headers.
        return {'width': image.width, 'height': image.height, 'format': image.format}, data


def improves(before, after):
    return (after['width'] >= before['width'] and after['height'] >= before['height']
            and after['width'] * after['height'] > before['width'] * before['height'] * 1.15)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inventory', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--write', action='store_true')
    parser.add_argument('--resume', action='store_true')
    args = parser.parse_args()
    rows = json.loads(args.inventory.read_text())
    manifest = ROOT / 'data/listing-image-cache.json'
    cache = json.loads(manifest.read_text())
    urls = sorted({u for r in rows for u in r.get('image_urls', '').split('|') if u})
    prior = {}
    attempted = {}
    if args.resume and args.report.exists():
        attempted = {r['url']: r for line in args.report.read_text().splitlines() for r in [json.loads(line)]}
        prior = {url: r for url, r in attempted.items() if not r.get('error')}
    urls = [u for u in urls if u not in prior]

    def inspect(url):
        result = {'url': url, 'attempts': attempted.get(url, {}).get('attempts', 1 if url in attempted else 0) + 1}
        try:
            before, _ = read_image(cache.get(url, url), full=bool(attempted.get(url, {}).get('error')))
            result.update(before)
            for candidate in candidates(url):
                try:
                    # For standard Craigslist renditions, validate dimensions and
                    # retain the CDN original. Other recovered originals are cached.
                    after, data = read_image(candidate, full=urlsplit(url).hostname != 'images.craigslist.org')
                    if not improves(before, after):
                        continue
                    if urlsplit(url).hostname == 'images.craigslist.org':
                        result.update(upgraded=candidate, originalSize=[before['width'], before['height']], **after)
                        break
                    extension = {'JPEG': 'jpg', 'PNG': 'png', 'WEBP': 'webp'}.get(after['format'])
                    if not extension:
                        continue
                    local = '/data/listing-image-cache/' + hashlib.sha256(data).hexdigest()[:20] + '.' + extension
                    if args.write:
                        (ROOT / local.lstrip('/')).write_bytes(data)
                    result.update(upgraded=candidate, local=local, originalSize=[before['width'], before['height']], **after)
                    break
                except Exception as error:
                    result['upgradeError'] = str(error)
        except Exception as error:
            result['error'] = str(error)
        return result

    args.report.parent.mkdir(parents=True, exist_ok=True)
    results = list(prior.values())
    with ThreadPoolExecutor(max_workers=24) as pool, args.report.open('w') as report:
        for result in results:
            report.write(json.dumps(result) + '\n')
        futures = [pool.submit(inspect, u) for u in urls]
        for future in as_completed(futures):
            result = future.result()
            results.append(result)
            report.write(json.dumps(result) + '\n')
            report.flush()
            if len(results) % 100 == 0:
                print(f'{len(results)}/{len(urls) + len(prior)} gallery photos verified', flush=True)
    additions = {r['url']: r['local'] for r in results if r.get('local')}
    if args.write:
        cache.update(additions)
        manifest.write_text(json.dumps(cache, indent=2) + '\n')
    print(json.dumps({'checked': len(results), 'upgraded': len(additions), 'errors': sum('error' in r for r in results)}))


if __name__ == '__main__':
    main()
