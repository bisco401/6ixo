"""Build East Legon boundary and search data from a Nominatim GeoJSON result.

Usage: python3 scripts/build-east-legon-boundary.py /path/to/east-legon-osm.json
Download URL, provenance and licence are saved alongside the boundary.
"""
import hashlib
import json
import sys
from datetime import date
from pathlib import Path

source = Path(sys.argv[1])
rows = json.loads(source.read_text())
area = next(r for r in rows if r.get('osm_type') == 'relation' and r.get('osm_id') == 20426436)
assert area['name'] == 'East Legon' and area['geojson']['type'] in {'Polygon', 'MultiPolygon'}
assert area['display_name'].endswith('Ghana')
dest = Path(__file__).resolve().parents[1] / 'data/geography'

def write(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n')

write(dest / 'GH-accra.json', [{
    'city': 'East Legon', 'region': 'Greater Accra', 'country': 'Ghana', 'countryCode': 'GH',
    'geometry': area['geojson']
}])
write(dest / 'accra-boundaries-source.json', {
    'source': 'https://www.openstreetmap.org/relation/20426436',
    'download': 'https://nominatim.openstreetmap.org/search?q=East%20Legon%2C%20Ghana&format=jsonv2&polygon_geojson=1',
    'retrievedOn': date.today().isoformat(),
    'license': 'https://opendatacommons.org/licenses/odbl/1-0/',
    'attribution': '© OpenStreetMap contributors',
    'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
    'description': 'Community-mapped East Legon boundary, preserved without simplification; not a surveyed or legally authoritative boundary.'
})
# Negative IDs reserve a separate namespace from positive GeoNames IDs.
record = [-20426436, 'East Legon', 'Greater Accra', 'GH', 0, ['east legon']]
supplements_path = dest / 'search-supplements.json'
supplements = json.loads(supplements_path.read_text()) if supplements_path.exists() else []
supplements = [r for r in supplements if r[0] != record[0]] + [record]
write(supplements_path, supplements)
# Update the existing search shard without needing the entire GeoNames dump.
# build-location-search.py also includes these supplements on a full rebuild.
shard_path = dest / 'search/65-61.json'
shard = json.loads(shard_path.read_text())
already_present = any(r[0] == record[0] for r in shard)
shard = [r for r in shard if r[0] != record[0]] + [record]
write(shard_path, sorted(shard, key=lambda r: (-r[4], r[0])))
catalog_path = dest / 'search/catalog.json'
catalog = json.loads(catalog_path.read_text())
if not already_present:
    catalog['cityCount'] += 1
catalog['supplementLicense'] = 'ODbL-1.0'
write(catalog_path, catalog)
print('Built East Legon boundary and autocomplete supplement.')
