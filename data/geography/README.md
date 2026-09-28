# Local area lookup

This directory contains a reduced, reformatted extract of [GeoNames](https://www.geonames.org/), licensed under [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/). Commercial use is allowed with attribution. The website credits GeoNames beside the location controls and in its privacy text.

The data is supplied as-is. Automatic city labels require a containing mapped polygon. Nearest-town points are never used to determine the current city. Country boundaries are simplified and may omit coastlines, small islands or disputed borders. Automatic results use the containing country; small coastal gaps can use adjacent land within about 1.3 km only if one country matches. Ambiguous or missing boundaries return no automatic label; users can choose an area. The general city search extract excludes neighbourhoods, historical and abandoned settlements, with separately attributed supplements. Outside supported area polygons, the country is shown and users can select a city manually. GPS coordinates are never replaced by a town centre.

At runtime, `local-geography.js` downloads `countries.json` and applicable local boundary files from the same origin as the site. It uses no GeoNames web service, API key or third-party geocoding request. No coordinates appear in the geography request URLs. Hosting/bandwidth costs still apply.

To rebuild, download these public files from https://download.geonames.org/export/dump/ into a temporary directory:

- `cities500.zip`
- `countryInfo.txt`
- `admin1CodesASCII.txt`
- `shapes_simplified_low.json.zip`

Run `python3 scripts/build-local-geography.py /path/to/downloads`. The builder removes unused columns, rounds boundary coordinates and splits cities by country. `manifest.json` records source hashes, date and counts. Update the version in `local-geography.js` after replacing data. No scheduled or paid data subscription is needed.

Deployment includes every generated JSON file. Keep `local-geography.js` loaded before `app.js`. An explicit area choice is held only for the current page session and does not grant GPS permission or change stored profile coordinates.

## City autocomplete

`location-autocomplete.js` uses `search/catalog.json` and a single prefix shard as a visitor types in the homepage City, country field. These contain the same 225,184 populated places, country labels, regions, population ranks, and normalized display/ASCII names. A two-character prefix selects a shard; full typed queries and device coordinates are never sent to an external search service. Results are ranked by exact name and population, with regions shown to distinguish duplicate city names. Selecting a suggestion changes the browsing area, not GPS coordinates.

Rebuild with `python3 scripts/build-location-search.py /path/to/downloads` using the same GeoNames extracts. Deploy the entire search directory and update the version in `location-autocomplete.js` when replacing the data. The search catalog records the cities extract checksum and CC BY 4.0 license.

## Toronto district boundaries

Within Toronto, `CA-toronto.json` supplies familiar district labels. It uses the City's [Former Municipality Boundaries](https://open.toronto.ca/dataset/former-municipality-boundaries/) for familiar district names: Scarborough, North York, East York, York, Etobicoke and Toronto. These are historical district labels, not separate current municipal governments. Coordinates are rounded to six decimals without simplifying the polygon shapes. A coarse box limits the download; only polygon containment selects a district. Outside these polygons the existing worldwide lookup applies. If this file fails to load, the lookup retries instead of guessing a nearby district.

Contains information licensed under the [Open Government Licence – Toronto](https://open.toronto.ca/open-data-licence/). Source URL and checksum are recorded in `toronto-boundaries-source.json`. Rebuild with `python3 scripts/build-toronto-boundaries.py /path/to/former-municipality-boundaries-data-4326.geojson`. The general GeoNames rebuild leaves this separate dataset intact. Bump the geography and application script versions after changing boundaries. The device's reported accuracy still applies; polygon matching does not improve an inaccurate device reading.

## East Legon boundary and search supplement

`GH-accra.json` contains the [OpenStreetMap East Legon boundary](https://www.openstreetmap.org/relation/20426436), © OpenStreetMap contributors, available under the [Open Database Licence](https://opendatacommons.org/licenses/odbl/1-0/). This is a community-mapped boundary, not an official survey. The exact published polygon is retained without simplification. Its bounding box only limits downloads; only points inside the polygon receive the East Legon label. Neighbouring areas fall back to country-only automatic lookup unless another mapped boundary is available. A failed boundary download returns Ghana without guessing Medina Estates, and remains retryable. Device accuracy is still disclosed independently.

Rebuild with `python3 scripts/build-east-legon-boundary.py /path/to/east-legon-osm.json`, using the download URL recorded in `accra-boundaries-source.json`. The script also adds the attributed East Legon name to autocomplete. `search-supplements.json` retains this neighbourhood across a full search rebuild; negative IDs distinguish these supplemental records from GeoNames IDs. The supplemental data is ODbL-licensed; original GeoNames data retains its CC BY 4.0 attribution. The source metadata records the download hash and retrieval date. This geographic data is publicly distributed with the website and all lookup remains in the browser.

East Legon was absent from the general cities500 extract, causing points inside it to resolve to the nearby Medina Estates point. Do not fix that by renaming Medina Estates or by adding an unbounded nearest-neighbour override.


## Strict city verification and New York City

`US-nyc.json` uses the [NYC Department of City Planning Borough Boundaries](https://data.cityofnewyork.us/City-Government/Borough-Boundaries/gthc-hcne). All five borough polygons are dissolved into one city without simplification; shared borough borders must not act as city edges. See `nyc-boundary-source.json` for the source checksum, attribution and terms. Rebuild with `python3 scripts/build-nyc-boundary.py /path/to/boroughs.geojson` (requires Shapely). Coordinates are rounded to six decimal places. This includes Inwood in Manhattan, but does not rename Inwood in Nassau County or places in New Jersey.

Automatic city membership requires a fresh device sample (less than 90 seconds old, with a valid timestamp), a containing boundary, reported accuracy at most 1,000 metres, and the accuracy radius plus a 10-metre margin entirely within that polygon. The margin covers coordinate rounding, local distance projection and the metre-scale cache. Unknown accuracy, broad fixes and boundary-straddling fixes suppress the city and region. Country-level fallback is approximate because the worldwide country polygons are simplified. The UI says “City unverified” and offers manual selection. Accurate updates restore the city without a reload. This is bounded by the device's reported accuracy, not a guarantee against incorrect device readings.

Automatic mapped coverage currently includes NYC, the existing Toronto districts and East Legon. Other cities remain available in manual search but are not guessed as the current city. Missing coverage does not retry endlessly; failed downloads do retry. Manual browsing is explicitly labeled “Browsing” and never changes GPS coordinates. No device coordinates are sent to external geocoding services.
