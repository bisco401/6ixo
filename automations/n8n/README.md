# 6ixo n8n CSV Scrape Workflow

This version does not store scraped listings in Supabase. Supabase stays for login and the existing app features.

n8n writes scraped listings to:

```text
data/scraped-listings.csv
```

The 6ixo website reads that CSV file on load and merges `published` rows into the existing feeds.

## Files

- `automations/n8n/6ixo-scrape-to-csv-github.json`: import this workflow into n8n.
- `automations/n8n/6ixo-kijiji-hamilton-sync-to-csv.json`: import this workflow for Hamilton Kijiji ads. It writes new/updated Kijiji rows into `data/scraped-listings.csv` and checks existing Hamilton Kijiji rows for sold/removed status.
- `automations/n8n/6ixo-check-listing-availability.json`: re-check existing `source_url` values every 36 hours, immediately hide confirmed sold/gone listings, and write source availability fields back to the CSV.
- `automations/n8n/6ixo-crawl4ai-facebook-pages.json`: crawl public Facebook page URLs with Crawl4AI and emit normalized page/post records in n8n.
- `automations/n8n/6ixo-crawl4ai-kijiji-listings.json`: crawl public Kijiji search pages with Crawl4AI and emit normalized listing records in n8n.
- `automations/n8n/6ixo-crawl4ai-texas-craigslist.json`: crawl Craigslist listings for the preferred Houston/Galveston, Atlanta, and New York metros, require a phone, real gallery image, and short description, then merge eligible profiles into the website CSV.
- `automations/n8n/6ixo-upgrade-listing-images.json`: re-open Kijiji and Pigiame detail pages, replace low-resolution CSV images with verified full-size source images, and retry failed pages later.
- `automations/n8n/6ixo-crawl4ai-guyana-listings.json`: dedicated six-hour Guyana vehicle sync using public `carsforsale.gy` listing pages and seller-enabled contacts.
- `automations/n8n/6ixo-enforce-listing-policy.json`: run after the source workflows to enforce four images per ad, 50 newest active listings per country, and confirmed-unavailable deletion safeguards.
- `.github/workflows/ghana-marketplace-sync.yml`: refresh current Ghana vehicle, electronics, property, and auto-parts listings from public Oxglow pages every day and merge them without replacing other countries.
- `automations/n8n/docker-compose.crawl4ai.yml`: standalone Crawl4AI service for a server.
- `automations/n8n/test-crawl4ai.sh`: quick health check for the Crawl4AI service.
- `apify_import.py`: import an Apify dataset or export file into the same website CSV.
- `guyana_scrape.py`: run the same Guyana import locally through Crawl4AI for testing or a one-time backfill.
- `guyana_marketplace_scrape.py`: import current in-stock Guyana electronics and verified properties with public contact numbers and images.
- `data/scraped-listings.csv`: listing database stored as a CSV file in the website repo.
- `app.js`: now loads `data/scraped-listings.csv` and routes rows into the right 6ixo screen.

## Flow

```text
n8n schedule/manual trigger
-> scrape allowed public pages
-> normalize each listing into 6ixo CSV columns
-> dedupe by source_url
-> update data/scraped-listings.csv in GitHub
-> GitHub Pages publishes the CSV
-> 6ixo.com loads published CSV rows
```

## Multicountry Listing Limits

The dedicated Ghana GitHub Actions workflow runs every day. The generic n8n scraper and availability workflows run every 36 hours when they are imported and activated. All CSV-writing workflows fall back to GitHub's blob API when the listing file is too large for inline Contents API data, and refuse to write if the existing CSV cannot be decoded. This prevents a single-country sync from erasing Ghana or any other country.

Import and activate `automations/n8n/6ixo-enforce-listing-policy.json` after the source-specific workflows. It runs every six hours and can also be run manually after a large import.

Default limits:

```text
maxImages=4
maxListingsPerCountry=50
deleteAfterMisses=3
countriesJson=[]
```

An empty `countriesJson` applies the policy to every country, including countries added later. To restrict it, use a JSON array such as:

```json
["Canada", "Ghana", "Jamaica", "Kenya", "Guyana", "United States"]
```

The 50-listing budget is shared across the configured marketplace categories for each country. Listings are ordered by their source-posted timestamp when available, then by the scrape timestamp. Older rows are marked `rejected` with `sync_visibility=capped`; they stay archived and can automatically return if they move back into the newest 50.

Source availability is handled separately from the country cap:

```text
active                    -> eligible for the newest 50
sold/unavailable/gone     -> hidden immediately
3 distinct confirmations  -> permanently removed from the CSV
unknown/blocked/error      -> never counted as a removal confirmation
```

The marketplace loader also applies the four-image and 50-per-country limits as a final display guardrail. This prevents a source workflow finishing before the policy workflow from temporarily exposing excess rows.

Run these checks after editing the workflow source:

```bash
npm run build:n8n:policy
npm run test:n8n:policy
npm run build:n8n:images
npm run test:images
node scripts/enforce-n8n-scraper-limits.mjs
```

## Craigslist Metro Profiles

Import and activate `automations/n8n/6ixo-crawl4ai-texas-craigslist.json`. It prioritizes Houston (including Galveston/Houston South), Atlanta, and New York City while preserving the existing Texas sources.

Each published Craigslist row must include:

```text
a valid allowed-area-code phone number
at least one real Craigslist gallery image
up to four 1200x900 image URLs
a cleaned description capped at 320 characters
a title, category, metro label, and public source URL
```

The workflow ignores Craigslist posting IDs that resemble phone numbers. Its 50-detail crawl budget is balanced across categories and reserves up to 15 candidates for each preferred metro before using spare capacity on the remaining configured Texas regions.

Configuration is in `Set Config Here`:

```text
requirePhone=true
requireImage=true
requireDescription=true
descriptionMaxLength=320
preferredMetros=Houston,Atlanta,New York City
maxDetailsPerMetro=15
onlyPreferredMetros=true
crawlUrlBatchSize=25
```

## Full-Resolution Listing Images

Import and activate `automations/n8n/6ixo-upgrade-listing-images.json`. It runs every six hours after deployment and can also be run manually for the existing CSV rows.

Default behavior:

```text
read data/scraped-listings.csv from GitHub
-> immediately rewrite existing Kijiji CDN URLs to the 1600px rendition
-> remove Craigslist map tiles, 50px thumbnails, placeholders, and unrelated site graphics
-> select up to 100 remaining Pigiame, JACars, Oxglow, or carsforsale.gy rows
-> open each public source_url through Crawl4AI in batches of 5
-> Kijiji: request the kijijica-1600-webp CDN rendition
-> Pigiame: accept only a signed listing-gallery-full-* URL found on the detail page
-> JACars: use the full Product image gallery from the detail-page structured data
-> Oxglow: use the listing's original upload URLs instead of medium or thumbnail files
-> carsforsale.gy: retain only the listing's original gallery assets
-> keep the old image when a real full-size source asset is not found
-> write successful image_urls and attempt metadata back to the CSV
```

The Pigiame CDN signs its image paths. Do not create a full-gallery URL by replacing `listing-thumb-*` in the thumbnail URL; the signature/path may no longer be valid. The workflow fetches the listing detail page so it can use the full-gallery URL actually supplied by the source. Failed attempts are recorded in `attributes` and retried after `retryHours` (24 by default), which prevents one blocked page from being crawled continuously.

Configuration is in `Set Image Fetch Rules`:

```text
maxRows=100
batchSize=5
maxImages=4
retryHours=24
```

## Hamilton Kijiji Auto-Sync

Use `automations/n8n/6ixo-kijiji-hamilton-sync-to-csv.json` for Hamilton ads. This replaces the old local `data/kijiji-gta-recent-with-phones.csv` path for production updates.

Default behavior:

```text
Every hour
-> crawl https://www.kijiji.ca/b-hamilton/l80014?sort=dateDesc
-> add new ads with detected phone numbers to data/scraped-listings.csv
-> update existing rows when title, price, image, phone, or description changes
-> crawl existing Hamilton Kijiji detail URLs
-> mark sold rows as source_availability=sold
-> mark removed/expired/gone rows as rejected when hideUnavailableListings=true
```

Required services/config:

```bash
GITHUB_TOKEN='<your-fine-grained-token>'
GITHUB_OWNER=bisco401
GITHUB_REPO=6ixo
GITHUB_BRANCH=main
SIXO_CSV_PATH=data/scraped-listings.csv
CRAWL4AI_URL=http://10.0.0.164:11235/crawl
```

In the workflow's `Set Config Here` node, keep `defaultImportStatus=published` if Hamilton ads should appear automatically. Set it to `pending` if you want review before publishing. Keep `hideUnavailableListings=true` if removed or expired source ads should disappear from 6ixo automatically.

Hamilton Kijiji rows without detected phone numbers are skipped. If Kijiji does not expose the seller name in the crawl result, the workflow writes `Unknown` instead of a generic placeholder.

Performance controls in `Set Config Here`:

```text
availabilityMaxRows=24
availabilityBatchSize=6
availabilityFreshHours=12
```

`availabilityMaxRows` is the maximum number of existing detail pages to re-check for sold/removed status per run. `availabilityFreshHours` skips rows checked recently, so the hourly workflow spreads availability checks across runs instead of re-crawling the same URLs every hour. Increase these values only if n8n has enough execution time headroom.

## Apify Import

The site does not need a new frontend change for Apify listings. Import Apify output into `data/scraped-listings.csv`; the existing app loader publishes rows with `status=published`.

From a live Apify dataset:

```bash
APIFY_TOKEN='<your-apify-token>' python3 apify_import.py \
  --dataset-id YOUR_DATASET_ID \
  --category buy_sell \
  --subcategory other \
  --country Jamaica \
  --source-site "Apify" \
  --max-images 4 \
  --limit-per-country 50
```

From a downloaded Apify export:

```bash
python3 apify_import.py \
  --input path/to/apify-export.json \
  --category vehicles \
  --subcategory vehicles \
  --target-surface vehicles \
  --country Jamaica \
  --source-site "Apify" \
  --max-images 4 \
  --limit-per-country 50
```

Use `--status pending` if you want to review rows before they appear on the site. Use `--dry-run` to preview the normalized rows without changing the CSV.

## Guyana Vehicle Import (Crawl4AI)

`guyana_scrape.py` reads the public `carsforsale.gy` listing sitemap, crawls
public detail pages through Crawl4AI, and imports only listings that include a
seller-enabled public WhatsApp number and at least one image. By default it
keeps only Guyana `+592` contacts, up to four images per ad, and publishes up
to 50 recent listings.

```bash
python3 guyana_scrape.py --dry-run
python3 guyana_scrape.py --status published
```

The importer never calls the source's blocked account, private messaging, or
reveal-phone endpoints. Seller/dealer profile links and source timestamps are
stored in the CSV `attributes` JSON for attribution and future availability
checks.

## Guyana Electronics and Property Import

`guyana_marketplace_scrape.py` adds categories beyond vehicles from public,
current sources:

- in-stock electronics from Samtronix Guyana;
- verified properties for sale and rent from Guyana Home Hub.

Every imported row must include a public Guyana phone number and at least one
source image. The daily GitHub Actions workflow in
`.github/workflows/guyana-marketplace-sync.yml` refreshes up to 12 electronics
and 20 property listings, deduplicated by source URL.

```bash
python3 guyana_marketplace_scrape.py --dry-run
python3 guyana_marketplace_scrape.py --status published --refresh-existing
```

## Required n8n Environment Variables

```bash
GITHUB_TOKEN='<your-fine-grained-token>'
GITHUB_OWNER=bisco401
GITHUB_REPO=6ixo
GITHUB_BRANCH=main
SIXO_CSV_PATH=data/scraped-listings.csv
SIXO_DEFAULT_IMPORT_STATUS=pending
SIXO_SCRAPE_SOURCES_JSON='[]'
```

The Guyana sync reads `GITHUB_TOKEN` directly inside its Code node so the
secret is not copied into Set-node output or saved with execution input data.
Self-hosted n8n must allow runtime environment access by setting
`N8N_BLOCK_ENV_ACCESS_IN_NODE=false`, then restarting n8n.

Use `pending` while testing. Change to `published` only when you are comfortable with auto-publishing scraped records.

## Crawl4AI Server URL

If n8n runs on a server, `127.0.0.1` means the n8n server or container, not your laptop. A refused connection in the `Crawl4AI` node usually means Crawl4AI is not running at the URL configured in n8n.

Set this environment variable in the n8n server environment:

```bash
CRAWL4AI_URL=http://crawl4ai:11235/crawl
```

Use `http://crawl4ai:11235/crawl` when n8n and Crawl4AI are services on the same Docker network. Use `http://PRIVATE_SERVER_IP:11235/crawl` when Crawl4AI is running on another machine reachable from the n8n server. Avoid exposing Crawl4AI publicly without a private network, firewall, or reverse proxy authentication.

Example Docker Compose services for n8n plus Crawl4AI on the same server:

```yaml
services:
  n8n:
    image: n8nio/n8n:latest
    environment:
      - CRAWL4AI_URL=http://crawl4ai:11235/crawl
    ports:
      - "5678:5678"

  crawl4ai:
    image: unclecode/crawl4ai:latest
    shm_size: "1g"
    ports:
      - "11235:11235"
```

After starting the services, test from inside the n8n container:

```bash
docker exec -it YOUR_N8N_CONTAINER sh -lc 'wget -qO- http://crawl4ai:11235/health || curl -sS http://crawl4ai:11235/health'
```

If your existing n8n install is not managed by this repo, copy `automations/n8n/docker-compose.crawl4ai.yml` to the server and start only Crawl4AI:

```bash
docker compose -f docker-compose.crawl4ai.yml up -d
./test-crawl4ai.sh
```

Then set the n8n workflow `crawl4aiUrl` to whichever URL works from the n8n server:

```text
http://127.0.0.1:11235/crawl
http://crawl4ai:11235/crawl
http://PRIVATE_SERVER_IP:11235/crawl
```

## CSV Status

```text
pending    scraped but hidden from website
published  visible on 6ixo.com
rejected   hidden from website
```

To review listings manually, leave n8n at `pending`, then edit `data/scraped-listings.csv` and change selected rows to `published`.

## Source Availability Check

Import `automations/n8n/6ixo-check-listing-availability.json` into n8n after the scrape workflow. It reads `data/scraped-listings.csv` from GitHub, checks each row's `source_url`, and appends these columns:

```text
source_availability
source_availability_checked_at
source_http_status
source_unavailable_reason
source_last_seen_at
source_resolved_url
```

Availability values:

```text
active       detail page still loads and appears to match the listing
sold         source page explicitly says the item sold
unavailable source page says removed, expired, or no longer available
gone         source returned HTTP 404 or 410
unknown      blocked, rate limited, temporary error, or not enough evidence
```

By default, the checker does not change the app `status` column. If you want unavailable rows hidden from 6ixo automatically, set `hideUnavailableListings` to `true` in the workflow's `Set Config Here` node. That changes confirmed `sold`, `unavailable`, and `gone` rows to `rejected`.

## 6ixo Category Mapping

Use these values in each source config.

Top-level categories:

```text
electronics
clothing
jobs
services
real_estate
vehicles
```

Targets:

```text
target_surface=marketplace  -> electronics, clothing, jobs, services, real_estate
target_surface=vehicles     -> Vehicles screen
```

Electronics subcategories:

```text
phones_accessories
tv_video_home_theatre
computers_tablets
audio_headphones
gaming_consoles
cameras_photography
repair_parts_accessories
other
```

Fashion subcategories:

```text
sneakers
streetwear
accessories
deadstock
used
kids
```

Vehicle subcategories:

```text
vehicles
repairs
detailing
tires_rims
auto_parts
other
```

Job subcategories:

```text
marketing_sales
skilled_trades
creative_media
tech_digital
business_office
transportation
food_hospitality
healthcare_wellness
cleaning_maintenance
childcare_education
retail_customer_service
general_gigs
other
```

Service subcategories:

```text
food
fitness
financial
health_beauty
home_services
pet_services
skilled_trades
entertainment
events_services
travel
other
```

Real estate subcategories:

```text
for_rent
for_sale
short_term
long_term
house
condo
land
commercial
```

## Source Config Example

Set `SIXO_SCRAPE_SOURCES_JSON` to a JSON array like this:

```json
[
  {
    "name": "Example Cars",
    "enabled": true,
    "base_url": "https://example.com",
    "list_url": "https://example.com/cars",
    "target_surface": "vehicles",
    "app_category": "vehicles",
    "app_subcategory": "vehicles",
    "default_status": "pending",
    "rate_limit_seconds": 10,
    "extractor_config": {
      "cardPattern": "<article[\\s\\S]*?</article>",
      "titlePattern": "<h2[^>]*>([\\s\\S]*?)</h2>",
      "pricePattern": "(GH¢|GHS|\\$)\\s?[0-9,]+",
      "urlPattern": "href=\"([^\"]+)\"",
      "imagePattern": "<img[^>]+src=\"([^\"]+)\"",
      "locationPattern": "<span class=\"location\">([\\s\\S]*?)</span>",
      "country": "Ghana"
    }
  }
]
```

## CSV Columns

```text
id,status,target_surface,app_category,app_subcategory,title,price_text,price_value,currency,city,country,seller,phone,description,image_urls,source_site,source_url,scraped_at,make,model,trim,year,condition,transmission,color,mileage_km,attributes
```

For multiple images, put URLs in `image_urls` separated by `|`.

`attributes` is optional JSON for category-specific fields such as job type, remote status, tags, bedrooms, or service badge.

## Blocked Sites

If a site returns Cloudflare, CAPTCHA, login, or anti-bot pages, the workflow logs that source as failed. Use official APIs, seller exports, saved public HTML, or screenshot/OCR for those sources. Do not use the workflow to bypass access controls.

Facebook-specific note:

- `6ixo-crawl4ai-facebook-pages.json` is for public Facebook page URLs only.
- It does not include login cookies, session replay, or anti-bot bypass behavior.
- If Facebook returns a login wall or incomplete shell markup, switch that source to the Meta Graph API for production use.

Kijiji-specific note:

- `6ixo-crawl4ai-kijiji-listings.json` is driven by public Kijiji search/list URLs, so city targeting is done by the `list_url` you put in `sourcesJson`.
- Example: `https://www.kijiji.ca/b-buy-sell/city-of-toronto/c10l1700273`
- Set `strict_city_match` to `true` if you want the workflow to drop listings whose parsed location does not match the configured city.
- Kijiji image URLs are normalized to `rule=kijijica-1600-webp`; the former 200px and 640px renditions should not be stored in new CSV rows.
