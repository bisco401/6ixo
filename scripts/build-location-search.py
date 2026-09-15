"""Build small, same-origin city autocomplete shards from the GeoNames extracts.

Usage: python3 scripts/build-location-search.py /path/to/geonames-extracts
"""
import hashlib
import json
import sys
import unicodedata
import zipfile
from collections import defaultdict
from pathlib import Path

source = Path(sys.argv[1])
dest = Path(__file__).resolve().parents[1] / 'data' / 'geography' / 'search'
dest.mkdir(parents=True, exist_ok=True)

def rows(name):
    return [line.split('\t') for line in (source / name).read_text().splitlines() if line and not line.startswith('#')]

def normalize(text):
    return ' '.join(''.join(c for c in unicodedata.normalize('NFD', text).lower() if not unicodedata.combining(c)).split())

def prefix_key(text):
    return '-'.join(format(ord(c), 'x') for c in text[:2])

def write(name, data):
    (dest / name).write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n')

countries = {r[0]: r[4] for r in rows('countryInfo.txt') if len(r) > 16}
regions = {r[0]: r[1] for r in rows('admin1CodesASCII.txt')}
shards = defaultdict(list)
count = 0
with zipfile.ZipFile(source / 'cities500.zip') as archive:
    for line in archive.read('cities500.txt').decode().splitlines():
        r = line.split('\t')
        if len(r) < 19 or r[8] not in countries or r[6] != 'P' or r[7] in {'PPLX', 'PPLQ', 'PPLH', 'PPLW'}:
            continue
        names = sorted({normalize(name) for name in r[1:3] if name.strip()})
        record = [int(r[0]), r[1], regions.get(r[8] + '.' + r[10], ''), r[8], int(r[14] or 0), names]
        for key in {prefix_key(name) for name in names}:
            shards[key].append(record)
        count += 1

for key, records in sorted(shards.items()):
    write(key + '.json', sorted(records, key=lambda r: (-r[4], r[0])))
write('catalog.json', {
    'countries': [{'code': code, 'name': name} for code, name in sorted(countries.items(), key=lambda r: r[1])],
    'shards': sorted(shards), 'cityCount': count,
    'sourceSha256': hashlib.sha256((source / 'cities500.zip').read_bytes()).hexdigest(),
    'license': 'CC-BY-4.0'
})
print(f'Built {count:,} cities in {len(shards)} search shards; {sum(p.stat().st_size for p in dest.glob("*.json")):,} bytes.')
