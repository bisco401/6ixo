# Imported listing integrity

`lib/listing-integrity.cjs` owns source category mappings, listing identity matching and gallery extraction. It is embedded in the browser and n8n code by `build-listing-integrity.mjs`. After changing the helper, run the builder and the regression tests. If the optional image-upgrade workflow is present, rebuild it with `build-n8n-listing-image-workflow.mjs` too.

Images must come from the exact listing ID or primary structured entity. Never scan every image on a detail page, combine a refreshed gallery with old images, or associate concurrent crawler results using array positions. Missing source identity means no verified replacement.

`data/listing-integrity-repairs.json` keeps verified source galleries keyed by source URL and guarded by the original listing title and verification time. The browser applies these before constructing listing cards, seller profiles, search entries and featured ads. Source photos localized under `data/oxglow-*-images/*-verified-*` are downloaded from the exact source gallery and validated as image responses.

`repair-listing-feeds.mjs` applies the same repairs and categories to CSV files. Its optional `--refresh-kijiji` flag refreshes galleries by exact listing ID. The listing-integrity GitHub workflow runs when scraped feeds change so older scraper configurations cannot repeatedly corrupt existing records. Provider failures retain the last verified repair; they never pull photos from recommendations.

Run `node scripts/listing-integrity.test.cjs` for behavior checks, including shuffled crawler results, unrelated recommended products, categories, service profiles and detail galleries.
