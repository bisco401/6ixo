# Local area lookup

This directory contains a reduced, reformatted extract of [GeoNames](https://www.geonames.org/), licensed under [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/). Commercial use is allowed with attribution. The website credits GeoNames beside the location controls and in its privacy text.

The data is supplied as-is. Nearest towns are approximate labels, not municipal-boundary determinations. Country boundaries are simplified and may omit coastlines, small islands or disputed borders. Automatic results use the containing country; small coastal gaps can use adjacent land within about 1.3 km only if one country matches. Ambiguous or missing boundaries return no automatic label; users can choose an area. Neighbourhoods, historical and abandoned settlements are excluded. A town farther than 80 km is omitted and the country is shown instead. GPS coordinates are never replaced by a town centre.

At runtime, `local-geography.js` downloads `countries.json` and a selected country's city file from the same origin as the site. It uses no GeoNames web service, API key or third-party geocoding request. No coordinates appear in the geography request URLs. Hosting/bandwidth costs still apply.

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
