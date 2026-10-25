# Regional listing refresh

`refresh-regional-listings.py` imports public inventory into `data/scraped-listings.csv`.

| Market | Source | Data |
| --- | --- | --- |
| New York | [LIUsedCars / Saw Mill Auto](https://www.liusedcars.com/dealers/saw-mill-auto) | Vehicles in Yonkers |
| Atlanta | [Atlanta Best Used Cars](https://www.atlantabestusedcars.com/used-cars-in-peachtree-corners-ga) | Vehicles in Peachtree Corners; searchable under Atlanta |
| Florida | [Turnpike Motors](https://www.turnpikemotorsflorida.com/cars-for-sale) | Vehicles in Pompano Beach |
| Texas | [Lexo Enterprises](https://www.lexoinc.com/cars-for-sale) | Vehicles in Houston |
| Ethiopia | [Mekina Showroom](https://mekinashowroom.com/cars) | Vehicles with a public seller phone |
| Ethiopia | [Betoch.et](https://betoch.et/) | Recent properties for sale with a listing-specific agency contact |

The existing GitHub workflow discovers/imports daily at 03:47 UTC and rechecks availability every six hours. It runs the regional importer, existing multi-country importers, missing-state repair, availability checks and publication guards. GitHub may delay scheduled jobs. The website reloads its CSV feeds every five minutes for an open session; a source outage can prevent fresh verification.

Run with `python scripts/refresh-regional-listings.py --limit-per-source 12 --candidate-limit 36 --workers 3`. Optional `--cache-dir` saves current source HTML for inspection, never substitutes old HTML for a new source request. `--dry-run` produces a report without merging. New URLs get priority; previously imported URLs rotate by oldest refresh date to update prices and details. Published pagination links are followed for up to two additional catalogue pages.

Every published row needs an exact source identity, public seller/agency phone, city, source currency/price and at least one reachable listing photo. The importer checks every retained photo and keeps at most four. Miles are retained as miles in specifications; unknown units are explicitly labelled as source units. Georgia dealer prices use the source's fee-inclusive retail offer. Contradictory electric-vehicle engine displacement is omitted. Betoch prices below 10,000 ETB, unclear rental terms, properties older than 180 days and missing agent contacts are held, never guessed. Website descriptions and contact forms are not copied into listing descriptions.

`backfill-listing-regions.py` verifies saved US ads against each exact source page, saving address evidence in `output/listing-regions-report.json`. `--apply-report` applies the region only when URL, city and title still match. Craigslist search areas can include out-of-state cross-posts, so `sourceRegion`/legacy `metro` are not physical location evidence. New imports retain the actual `addressRegion`. Only `searchMetro` is used for explicit metro browsing; strict device-city matching is unchanged.

Home's area picker includes the app's US state and Canadian province aliases. An exact state selection retains a region-only scope instead of resolving to a similarly named city such as Florida Ridge. Category filters retain the record's region and verified metro. Direct-dealer sources declare `sourceKind: dealer` so their business name remains the seller; known marketplace names are still suppressed.

South Florida Used Cars and Texas Auto Deals were replaced with accessible direct dealer inventory. Engocha returned HTTP 403 to automated requests and is not enabled. A blocked response never removes a saved listing; the shared availability checker handles exact-source sold/removed notices.

Validation: `python -m unittest discover -s tests -p test_regional_listing_refresh.py`, `node scripts/regional-listing-location.test.cjs`, `npm run test:location`, and `npm run test:listings`. The compact source fixtures retain factual structured fields and the exact selectors used by the importers.
