"""Build the local Toronto district lookup from the City's WGS84 open dataset.

Usage: python3 scripts/build-toronto-boundaries.py /path/to/download.geojson
Source and licence: data/geography/toronto-boundaries-source.json
"""
import hashlib
import json
import sys
from pathlib import Path

source = Path(sys.argv[1])
data = json.loads(source.read_text())
expected = {'Scarborough', 'North York', 'East York', 'York', 'Etobicoke', 'Toronto'}
assert data['type'] == 'FeatureCollection'
assert data.get('crs', {}).get('properties', {}).get('name') == 'urn:ogc:def:crs:OGC:1.3:CRS84'

def rounded(value):
    if isinstance(value, list):
        return [rounded(v) for v in value]
    assert isinstance(value, (float, int))
    return round(value, 6)

areas = []
for feature in data['features']:
    city = feature['properties']['AREA_NAME'].title()
    assert city in expected
    geometry = feature['geometry']
    assert geometry['type'] in {'Polygon', 'MultiPolygon'}
    areas.append({'city': city, 'region': 'Ontario', 'country': 'Canada', 'countryCode': 'CA',
                  'geometry': {'type': geometry['type'], 'coordinates': rounded(geometry['coordinates'])}})
assert {area['city'] for area in areas} == expected and len(areas) == 6
out = Path(__file__).resolve().parents[1] / 'data/geography'
(out / 'CA-toronto.json').write_text(json.dumps(sorted(areas, key=lambda a: a['city']), separators=(',', ':')) + '\n')
metadata = {
    'source': 'https://open.toronto.ca/dataset/former-municipality-boundaries/',
    'download': 'https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/833937f6-e190-49a2-9835-80137cf88c41/resource/4eadc3a3-bafa-44cf-a43f-f99a7fa98eb4/download/former-municipality-boundaries-data-4326.geojson',
    'license': 'https://open.toronto.ca/open-data-licence/',
    'attribution': 'Contains information licensed under the Open Government Licence – Toronto.',
    'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
    'precisionDecimalPlaces': 6,
    'description': 'Historical six-municipality boundaries used for familiar Toronto district labels; not current municipal governments.'
}
(out / 'toronto-boundaries-source.json').write_text(json.dumps(metadata, indent=2) + '\n')
print('Built six Toronto district polygons:', (out / 'CA-toronto.json').stat().st_size, 'bytes')
