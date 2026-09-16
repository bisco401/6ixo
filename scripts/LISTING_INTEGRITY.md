# Imported listing integrity

`lib/listing-integrity.cjs` owns source category mappings, listing identity matching and gallery extraction. It is embedded in the browser and n8n code by `build-listing-integrity.mjs`. After changing the helper, run the builder and the regression tests. If the optional image-upgrade workflow is present, rebuild it with `build-n8n-listing-image-workflow.mjs` too.

Images must come from the exact listing ID or primary structured entity. Never scan every image on a detail page, combine a refreshed gallery with old images, or associate concurrent crawler results using array positions. Missing source identity means no verified replacement.

`data/listing-integrity-repairs.json` keeps verified source galleries keyed by source URL and guarded by the original listing title and verification time. The browser applies these before constructing listing cards, seller profiles, search entries and featured ads. Source photos localized under `data/oxglow-*-images/*-verified-*` are downloaded from the exact source gallery and validated as image responses.

`repair-listing-feeds.mjs` applies the same repairs and categories to CSV files. Its optional `--refresh-kijiji` flag refreshes galleries by exact listing ID. The listing-integrity GitHub workflow runs when scraped feeds change so older scraper configurations cannot repeatedly corrupt existing records. Provider failures retain the last verified repair; they never pull photos from recommendations.

Run `node scripts/listing-integrity.test.cjs` for behavior checks, including shuffled crawler results, unrelated recommended products, categories, service profiles and detail galleries.

The September 16 profile audit also stores exact-source category/title corrections and review holds in the repair feed. `applyRepair` is shared by the browser and CSV repair tools; it checks the source URL and original or corrected title before applying a decision. A hold hides stale cached rows too. Clear a hold only after verifying the source again. HTTP 403/429 alone does not mean a listing is removed; retain those rows unless a separate reviewed mismatch requires a hold. Source 404/410 and exact-ID removed-ad redirects are recorded separately from photo conflicts.

Keep complete identity-matched galleries (up to 12 source photos) and existing localized originals. Do not replace a gallery with arbitrary page images or an unrelated listing when verification fails. Source photo identity does not prove that a seller's title is accurate; visible title/photo conflicts require review.
