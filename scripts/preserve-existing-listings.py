#!/usr/bin/env python3
"""Make scheduled discovery append-only; availability checks run afterward."""
import argparse
import csv
import importlib.util
import io
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('availability', ROOT / 'scripts/check-listing-availability.py')
availability = importlib.util.module_from_spec(spec)
spec.loader.exec_module(availability)


def source_identity(url):
    value = availability.source_key(url)
    # Shopify collection paths are aliases of the same MCcosme product.
    if value.startswith('mccosme.com/'):
        value = re.sub(r'/collections/[^/]+(/products/)', r'\1', value)
    return value


def identities(row):
    url = availability.source_url(row)
    return {v for v in [f"url:{source_identity(url)}" if url else '',
                        f"id:{row['id']}" if row.get('id') else ''] if v}


def additions(rows, known, unavailable):
    result, seen = [], set(known)
    excluded = {source_identity(url) for url in unavailable}
    for row in rows:
        ids = identities(row)
        if not ids or ids & seen or source_identity(availability.source_url(row)) in excluded:
            continue
        result.append(row)
        seen.update(ids)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['capture', 'enforce'])
    parser.add_argument('--snapshot', type=Path, default=Path('output/discovery-existing-snapshot.json'))
    parser.add_argument('--from-git', help='Capture a committed baseline for a one-time local repair')
    args = parser.parse_args()
    if args.action == 'capture':
        def read(path):
            return subprocess.check_output(['git', 'show', f'{args.from_git}:{path}'], cwd=ROOT, text=True) if args.from_git else (ROOT / path).read_text()
        feeds = {}
        for path in availability.FEEDS:
            reader = csv.DictReader(io.StringIO(read(path)))
            feeds[str(path)] = {'headers': reader.fieldnames, 'rows': list(reader)}
        snapshot = {'feeds': feeds, 'repairs': json.loads(read('data/listing-integrity-repairs.json')),
                    'unavailable': json.loads(read('data/listing-availability.json')).get('listings', {})}
        args.snapshot.parent.mkdir(parents=True, exist_ok=True)
        args.snapshot.write_text(json.dumps(snapshot, separators=(',', ':')))
        return
    snapshot = json.loads(args.snapshot.read_text())
    known = set().union(*(identities(row) for feed in snapshot['feeds'].values() for row in feed['rows']))
    report = {}
    for path, original in snapshot['feeds'].items():
        target = ROOT / path
        with target.open(newline='') as handle:
            reader = csv.DictReader(handle)
            headers = list(dict.fromkeys(original['headers'] + list(reader.fieldnames or [])))
            new = additions(list(reader), known, snapshot['unavailable'])
        temporary = target.with_suffix('.append.tmp')
        with temporary.open('w', newline='') as handle:
            writer = csv.DictWriter(handle, fieldnames=headers, lineterminator='\n')
            writer.writeheader()
            writer.writerows(original['rows'] + new)
        temporary.replace(target)
        report[path] = {'preserved': len(original['rows']), 'added': len(new)}
    repair_path = ROOT / 'data/listing-integrity-repairs.json'
    repairs = json.loads(repair_path.read_text())
    repairs.setdefault('listings', {}).update(snapshot['repairs'].get('listings', {}))
    repair_path.write_text(json.dumps(repairs, ensure_ascii=False, separators=(',', ':')) + '\n')
    output = ROOT / 'output/discovery-additions-report.json'
    output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
