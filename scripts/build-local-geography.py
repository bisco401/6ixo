"""Build same-origin GeoNames files from downloaded extracts (no runtime API).

Usage: python3 scripts/build-local-geography.py /path/to/geonames-extracts
Required inputs and attribution are documented in data/geography/README.md.
"""
import hashlib
import json
import sys
import zipfile
from collections import defaultdict
from datetime import date
from pathlib import Path

source = Path(sys.argv[1])
dest = Path(__file__).resolve().parents[1] / 'data' / 'geography'
dest.mkdir(parents=True, exist_ok=True)

def rows(name):
    return [line.split('\t') for line in (source / name).read_text().splitlines() if line and not line.startswith('#')]

countries = {r[0]: {'code': r[0], 'name': r[4], 'id': r[16]} for r in rows('countryInfo.txt') if len(r) > 16}
regions = {r[0]: r[1] for r in rows('admin1CodesASCII.txt')}
by_country = defaultdict(list)
with zipfile.ZipFile(source / 'cities500.zip') as archive:
    for line in archive.read('cities500.txt').decode().splitlines():
        r = line.split('\t')
        if len(r) < 19 or r[8] not in countries or r[6] != 'P' or r[7] in {'PPLX', 'PPLQ', 'PPLH', 'PPLW'}:
            continue
        # Keep display names, administrative region and coordinates only.
        by_country[r[8]].append([r[1], regions.get(r[8] + '.' + r[10], ''), round(float(r[4]), 5), round(float(r[5]), 5)])

def compact(value):
    if isinstance(value, list):
        return [compact(x) for x in value]
    return round(value, 4) if isinstance(value, float) else value

def write(name, data):
    (dest / name).write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n')

with zipfile.ZipFile(source / 'shapes_simplified_low.json.zip') as archive:
    shapes = json.loads(archive.read('shapes_simplified_low.json'))['features']
by_id = {str(f['properties']['geoNameId']): f['geometry'] for f in shapes}
index = []
for code, country in sorted(countries.items()):
    cities = sorted(by_country[code], key=lambda row: (row[0], row[1]))
    geometry = by_id.get(country['id'])
    if not geometry and not cities:
        continue
    item = {'code': code, 'name': country['name'], 'cityCount': len(cities)}
    if geometry:
        item['geometry'] = {'type': geometry['type'], 'coordinates': compact(geometry['coordinates'])}
    index.append(item)
    write(code + '.json', cities)
write('countries.json', index)
write('manifest.json', {
    'builtOn': date.today().isoformat(), 'license': 'CC-BY-4.0',
    'source': 'https://download.geonames.org/export/dump/',
    'countryCount': len(index), 'cityCount': sum(len(v) for v in by_country.values()),
    'inputSha256': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(source.iterdir()) if p.is_file()}
})
print(f'Built {len(index)} countries, {sum(len(v) for v in by_country.values())} cities; {sum(p.stat().st_size for p in dest.glob("*.json")):,} bytes split by country.')
