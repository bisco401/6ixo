# Dubai listings with seller phone numbers

Dubai publication requires a complete public seller phone number. The browser's existing contact requirement remains unchanged; masked numbers and source links alone do not qualify.

On September 20, 2026, 18 current Alba Cars vehicle ads were added from the dealer's public Dubai inventory. Each exact vehicle page provides the seller's public telephone link, purchase price, in-stock vehicle schema and source gallery. The importer checked each retained photo response. Two candidates with no working photos were excluded. The 80 existing OpenSooq records without full phones remain rejected.

Refresh manually with:

```sh
python3 -B dubai_phone_listings_scrape.py --limit 20 --audit-dir /tmp/6ixo-dubai-phone-audit
```

This merges records into `data/dubai-listings.csv`, preserving other sources and archived records. It does not claim to confirm the number by calling it. The OpenSooq importer now reads only a public telephone on the matching listing's seller schema and skips listings without one; it also preserves other sources when writing.

Checks:

```sh
python3 -B -m unittest tests/test_opensooq_dubai_scrape.py tests/test_dubai_phone_listings_scrape.py
node --test tests/dubai_listings.test.js
node scripts/listing-publication.test.cjs
```
