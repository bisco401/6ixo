# 6ixo n8n CSV Scrape Workflow

This version does not store scraped listings in Supabase. Supabase stays for login and the existing app features.

n8n writes scraped listings to:

```text
data/scraped-listings.csv
```

The 6ixo website reads that CSV file on load and merges `published` rows into the existing feeds.

## Files

- `automations/n8n/6ixo-scrape-to-csv-github.json`: import this workflow into n8n.
- `automations/n8n/6ixo-check-listing-availability.json`: re-check existing `source_url` values and write source availability fields back to the CSV.
- `automations/n8n/6ixo-crawl4ai-facebook-pages.json`: crawl public Facebook page URLs with Crawl4AI and emit normalized page/post records in n8n.
- `automations/n8n/6ixo-crawl4ai-kijiji-listings.json`: crawl public Kijiji search pages with Crawl4AI and emit normalized listing records in n8n.
- `automations/n8n/docker-compose.crawl4ai.yml`: standalone Crawl4AI service for a server.
- `automations/n8n/test-crawl4ai.sh`: quick health check for the Crawl4AI service.
- `apify_import.py`: import an Apify dataset or export file into the same website CSV.
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

## Apify Import

The site does not need a new frontend change for Apify listings. Import Apify output into `data/scraped-listings.csv`; the existing app loader publishes rows with `status=published`.

From a live Apify dataset:

```bash
APIFY_TOKEN=apify_api_xxx python3 apify_import.py \
  --dataset-id YOUR_DATASET_ID \
  --category buy_sell \
  --subcategory other \
  --country Jamaica \
  --source-site "Apify"
```

From a downloaded Apify export:

```bash
python3 apify_import.py \
  --input path/to/apify-export.json \
  --category vehicles \
  --subcategory vehicles \
  --target-surface vehicles \
  --country Jamaica \
  --source-site "Apify"
```

Use `--status pending` if you want to review rows before they appear on the site. Use `--dry-run` to preview the normalized rows without changing the CSV.

## Required n8n Environment Variables

```bash
GITHUB_TOKEN=github_pat_or_token_with_repo_contents_access
GITHUB_OWNER=bisco401
GITHUB_REPO=6ixo
GITHUB_BRANCH=main
SIXO_CSV_PATH=data/scraped-listings.csv
SIXO_DEFAULT_IMPORT_STATUS=pending
SIXO_SCRAPE_SOURCES_JSON='[]'
```

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
