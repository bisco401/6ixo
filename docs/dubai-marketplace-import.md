# Dubai products and apartment rentals

`dubai_marketplace_scrape.py` merges into `data/dubai-listings.csv`, preserving other source records. It requires complete public UAE phone numbers, a positive AED price, current source availability, and at least one responding source-owned gallery image. No seller messages or orders are sent.

Sources:
- HGC Technologies' public retail catalogue and public stock JSON, including SKU, stock count, displayed retail/deal price and SKU image. Configurable products are skipped. Multiple SKUs share the store URL, so browser identity includes `catalogItemId` to keep distinct products separate.
- Used Appliances UAE's exact product pages: in-stock AED offer, gallery, public store phone and visible specification tables. Generic `NewCondition` schema is not trusted for this used-appliance seller; visible pre-owned wording takes priority, otherwise condition is `Ask seller`.
- Allsopp & Allsopp's exact apartment pages: live Dubai rental, matching reference and schema price, agent phone, property gallery, bedroom/bathroom counts and floor area. Annual rent remains annual; the importer does not convert it to a monthly payment. Availability reflects the source at import time.

Run manually from the repository with network access:

```sh
python3 -B dubai_marketplace_scrape.py --audit-dir /tmp/dubai-marketplace-audit --limit 12
python3 -B -m unittest discover -s tests -p 'test_dubai*scrape.py'
node --test tests/dubai_listings.test.js
node scripts/listing-publication.test.cjs
```

The audit directory keeps source snapshots, import IDs, category totals, timestamps and skipped-record reasons. Existing rows are merged by ID; this manual import does not continuously refresh or retire listings that disappear later.
