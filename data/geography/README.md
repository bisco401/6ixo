# Device location lookup

The device supplies the coordinates after permission. Local boundary files handle known areas; `device-geocoder.js` now provides worldwide city/locality lookup through BigDataCloud when a local area boundary is unavailable. City names prefer the provider’s city field over neighbourhood/locality. IP-derived responses are rejected. The phone’s coordinates and accuracy remain visible during lookup failures. See the worldwide section below.

This directory contains a reduced, reformatted extract of [GeoNames](https://www.geonames.org/), licensed under [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/). Commercial use is allowed with attribution. The website credits GeoNames beside the location controls and in its privacy text.

The data is supplied as-is. The local lookup accepts city labels only from containing mapped polygons. Nearest-town points are never used to determine the current city. The separate worldwide provider supplies city/locality names for areas without these local polygons. Country boundaries are simplified and may omit coastlines, small islands or disputed borders. Automatic results use the containing country; small coastal gaps can use adjacent land within about 1.3 km only if one country matches. Ambiguous or missing boundaries return no automatic label; users can choose an area. The general city search extract excludes neighbourhoods, historical and abandoned settlements, with separately attributed supplements. Outside supported area polygons, the local lookup supplies country data while the device performs the worldwide lookup; manual city selection remains available. GPS coordinates are never replaced by a town centre.

At runtime, `local-geography.js` downloads `countries.json` and applicable local boundary files from the same origin as the site. It uses no GeoNames web service, API key or third-party geocoding request. No coordinates appear in these local geography request URLs. The separate worldwide lookup does send the current device coordinates to BigDataCloud with consent. Hosting/bandwidth costs still apply.

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

`GH-accra.json` contains the [OpenStreetMap East Legon boundary](https://www.openstreetmap.org/relation/20426436), © OpenStreetMap contributors, available under the [Open Database Licence](https://opendatacommons.org/licenses/odbl/1-0/). This is a community-mapped boundary, not an official survey. The exact published polygon is retained without simplification. Its bounding box only limits downloads; only points inside the polygon receive the East Legon label. Neighbouring areas use worldwide device lookup unless another mapped boundary is available. A failed boundary download returns Ghana without guessing Medina Estates, and remains retryable. Device accuracy is still disclosed independently.

Rebuild with `python3 scripts/build-east-legon-boundary.py /path/to/east-legon-osm.json`, using the download URL recorded in `accra-boundaries-source.json`. The script also adds the attributed East Legon name to autocomplete. `search-supplements.json` retains this neighbourhood across a full search rebuild; negative IDs distinguish these supplemental records from GeoNames IDs. The supplemental data is ODbL-licensed; original GeoNames data retains its CC BY 4.0 attribution. The source metadata records the download hash and retrieval date. This geographic data is publicly distributed with the website and local polygon lookup remains in the browser.

East Legon was absent from the general cities500 extract, causing points inside it to resolve to the nearby Medina Estates point. Do not fix that by renaming Medina Estates or by adding an unbounded nearest-neighbour override.


## Strict city verification and New York City

`US-nyc.json` uses the [NYC Department of City Planning Borough Boundaries](https://data.cityofnewyork.us/City-Government/Borough-Boundaries/gthc-hcne). All five borough polygons are dissolved into one city without simplification; shared borough borders must not act as city edges. See `nyc-boundary-source.json` for the source checksum, attribution and terms. Rebuild with `python3 scripts/build-nyc-boundary.py /path/to/boroughs.geojson` (requires Shapely). Coordinates are rounded to six decimal places. This includes Inwood in Manhattan, but does not rename Inwood in Nassau County or places in New Jersey.

Automatic city membership requires a fresh device sample (less than 90 seconds old, with a valid timestamp), a containing boundary, reported accuracy at most 1,000 metres, and the accuracy radius plus a 10-metre margin entirely within that polygon. The margin covers coordinate rounding, local distance projection and the metre-scale cache. Unknown accuracy, broad fixes and boundary-straddling fixes suppress the city and region. Country-level fallback is approximate because the worldwide country polygons are simplified. The UI says “City unverified” and offers manual selection. Accurate updates restore the city without a reload. This is bounded by the device's reported accuracy, not a guarantee against incorrect device readings.

Local mapped coverage includes NYC, the existing Toronto districts and East Legon. Other cities now use the worldwide device-coordinate lookup below. Manual browsing is explicitly labeled “Browsing” and never changes GPS coordinates.


## Worldwide device-coordinate lookup

`device-geocoder.js` calls BigDataCloud’s [free client-side reverse geocoding endpoint](https://www.bigdatacloud.com/free-api/free-reverse-geocode-to-city-api) directly from the browser, only for that device’s current, permission-granted GPS/Wi-Fi coordinates. The site’s Allow notice and privacy policy disclose this transfer and BigDataCloud’s use of anonymised GPS/IP pairings. No API key or paid subscription is configured. Follow the provider’s [fair-use policy](https://www.bigdatacloud.com/docs/article/fair-use-policy-for-free-client-side-reverse-geocoding-api). Never call this endpoint from a server or test it with simulated, saved or third-party coordinates. Automated tests intercept the request and use fixtures.

Requests require an active, visible page, granted device permission, the same current accepted device fix, no manual browsing override and a sample younger than 30 seconds. Requests include both coordinates, omit cookies/referrers and disable HTTP caching. The response must explicitly identify GPS reverse geocoding and echo matching coordinates. IP-based results, coordinate mismatches and malformed countries are rejected. Provider results keep `cityVerified: false` and `approximate: true`; they are not represented as local polygon proof. The existing 1,000-metre device accuracy ceiling still controls city display. Known NYC/Toronto/East Legon boundaries remain preferred and do not call the provider.

Provider responses are cached only in memory at the exact metre-scale coordinate key for five minutes. Failures time out after eight seconds and back off; rate-limit/policy responses pause requests for five minutes. Movement, permission revocation, backgrounding and manual choice invalidate results. Fresh stationary samples renew after 30 seconds when at least as accurate, permitting retries without reusing an aged sample. This module neither persists coordinates nor substitutes IP geolocation.

A visible status below the home search field shows coordinate/accuracy information while the city is unavailable, or the provider-resolved area with reported GPS accuracy. Permission alone cannot guarantee that a device delivers a fix, a network service responds, or map labels are perfect. Denied/unavailable GPS has an explicit retry/manual-choice state. Worldwide provider accuracy and physical iPhone/Android GPS are not established by fixture tests.
