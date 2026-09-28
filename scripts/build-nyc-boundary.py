"""Merge NYC DCP borough polygons into one city, without simplifying boundaries.

Usage: python3 scripts/build-nyc-boundary.py /path/to/boroughs.geojson
Requires shapely. Source and terms are recorded alongside the generated data.
"""
import hashlib
import json
import sys
from datetime import date
from pathlib import Path
from shapely.geometry import shape, mapping
from shapely.ops import unary_union

source = Path(sys.argv[1])
data = json.loads(source.read_text())
assert data['type'] == 'FeatureCollection'
assert {f['properties']['boroname'] for f in data['features']} == {
    'Manhattan', 'Bronx', 'Brooklyn', 'Queens', 'Staten Island'
}
assert len(data['features']) == 5
geometry = unary_union([shape(f['geometry']) for f in data['features']])
assert geometry.is_valid and geometry.geom_type == 'MultiPolygon'
assert -74.3 < geometry.bounds[0] < -74.2 and 40.9 < geometry.bounds[3] < 40.95

def rounded(value):
    if isinstance(value, (tuple, list)):
        return [rounded(x) for x in value]
    return round(value, 6)

out = Path(__file__).resolve().parents[1] / 'data/geography'
result = [{'city': 'New York', 'region': 'New York', 'country': 'United States',
           'countryCode': 'US', 'geometry': {'type': geometry.geom_type,
           'coordinates': rounded(mapping(geometry)['coordinates'])}}]
(out / 'US-nyc.json').write_text(json.dumps(result, separators=(',', ':')) + '\n')
metadata = {
    'source': 'https://data.cityofnewyork.us/City-Government/Borough-Boundaries/gthc-hcne',
    'download': 'https://data.cityofnewyork.us/resource/gthc-hcne.geojson',
    'attribution': 'New York City Department of City Planning, NYC Open Data',
    'terms': 'https://opendata.cityofnewyork.us/overview/#termsofuse',
    'retrievedOn': date.today().isoformat(),
    'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
    'precisionDecimalPlaces': 6,
    'description': 'Five borough polygons dissolved into New York City. No geometry simplification; internal borough borders do not limit city confidence.'
}
(out / 'nyc-boundary-source.json').write_text(json.dumps(metadata, indent=2) + '\n')
print('Built New York City boundary:', (out / 'US-nyc.json').stat().st_size, 'bytes')
