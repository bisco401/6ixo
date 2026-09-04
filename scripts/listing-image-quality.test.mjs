import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { parseCsv, splitImageUrls } = require('./listing-sync-policy.cjs');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const workflowCode = (relativePath, nodeName) => {
  const workflow = JSON.parse(read(relativePath));
  const node = workflow.nodes?.find((entry) => entry.name === nodeName);
  assert.equal(typeof node?.parameters?.jsCode, 'string', `${nodeName} code node is missing`);
  return node.parameters.jsCode;
};

const app = read('app.js');
const styles = read('styles.css');
assert.match(app, /async uploadMarketplaceListingImages\(files = \[\]\)/, 'ordinary listing image uploader is missing');
assert.match(app, /async createSupabaseMarketplaceListing\(item = \{\}\)/, 'ordinary listing persistence is missing');
assert.match(app, /await this\.uploadMarketplaceListingImages\(/, 'post flow does not upload ordinary listing originals');
assert.match(app, /normalizeKijijiCdnImageUrl/, 'legacy and generic CSV rows do not normalize Kijiji CDN images');
assert.match(app, /imageUrls\.length \? imageUrls : imageFiles/, 'legacy Kijiji rows still prefer local thumbnails');
assert.match(app, /kijiji-gta-recent-images/, 'local Kijiji thumbnails are not marked low resolution');
assert.match(app, /kijijica-.*200.*300.*640/, 'small Kijiji CDN presets are not marked low resolution');
const legacyKijijiNormalizer = app.slice(app.indexOf('    normalizeKijijiGtaRow(row = {})'), app.indexOf('    normalizeOxglowElectronicsRow(row = {})'));
assert.match(legacyKijijiNormalizer, /seller:\s*'Unknown'/, 'legacy Kijiji rows expose a seller identifier');
assert.match(legacyKijijiNormalizer, /if \(!phone\) return null;/, 'legacy Kijiji rows without phone numbers are not rejected');
assert.match(app, /\^kijiji\(\?:\\s\+seller\)\?\$/i, 'standalone Kijiji seller labels are not normalized');
assert.match(app, /isKijijiImportedListing\(item = \{\}\)/, 'Kijiji source detection is missing');
assert.match(app, /isImportedMarketplaceSellerName\(item = \{\}, value = ''\)/, 'source marketplace seller detection is missing');
const importedSellerResolver = app.slice(app.indexOf('    getImportedListingSellerName(item = {},'), app.indexOf('    inferKijijiGtaCategory(row = {})'));
assert.match(importedSellerResolver, /isImportedMarketplaceSellerName\(item, value\)/, 'imported seller resolution does not hide marketplace names');
const marketplaceCardRenderer = app.slice(app.indexOf('    renderMarketplaceCard(item,'), app.indexOf('    renderMarketplaceFeedCard(item)'));
assert.match(marketplaceCardRenderer, /getImportedListingSellerName\(item, 'Seller'\)/, 'marketplace profile cards bypass Kijiji seller normalization');
const sellerProfileBuilder = app.slice(app.indexOf('    buildSellerProfileData(item)'), app.indexOf('    buildSellerProfileDataFromLuxuryAd(ad)'));
assert.match(sellerProfileBuilder, /getImportedListingSellerName/, 'seller profile builders bypass Kijiji seller normalization');
const genericCsvNormalizer = app.slice(app.indexOf('    normalizeCsvScrapedListingRow(row = {})'), app.indexOf('    startCsvScrapedListingsRefresh()'));
assert.match(genericCsvNormalizer, /isKijijiSource[\s\S]*?\?\s*'Unknown'/, 'generic Kijiji rows do not force the Unknown seller label');
assert.match(genericCsvNormalizer, /sellerIsMarketplaceName\s*\?\s*'Unknown'/, 'generic marketplace rows expose the source marketplace as the seller');
assert.match(genericCsvNormalizer, /no\[_-\]\?image/, 'generic CSV rows do not reject no-image placeholders');
assert.match(genericCsvNormalizer, /map\\d\*\\\.craigslist\\\.org/, 'generic CSV rows do not reject Craigslist map tiles');
assert.match(app, /enforceImportedListingCityDisplayLimits\(maxPerCity = 100\)/, 'frontend listing guardrail is not 100 per city');
const mediaLightboxImageRule = styles.slice(styles.indexOf('.media-lightbox-frame img {'), styles.indexOf('.media-lightbox-frame video {'));
assert.match(mediaLightboxImageRule, /width:\s*100%/, 'lightbox images do not scale to the available frame width');
assert.match(mediaLightboxImageRule, /height:\s*100%/, 'lightbox images do not scale to the available frame height');
assert.match(mediaLightboxImageRule, /object-fit:\s*contain/, 'lightbox images do not preserve their full aspect ratio');

const kijijiListCode = workflowCode('automations/n8n/6ixo-crawl4ai-kijiji-listings.json', 'Normalize Kijiji Listings');
assert.match(kijijiListCode, /kijijica-1600-webp/, 'Kijiji list workflow does not request the 1600px CDN asset');
assert.match(kijijiListCode, /const imageUrlsFromValue/, 'Kijiji list workflow does not inspect image variants and srcsets');

const hamiltonCode = workflowCode('automations/n8n/6ixo-kijiji-hamilton-sync-to-csv.json', 'Sync New Updated Sold Rows');
assert.match(hamiltonCode, /kijijica-1600-webp/, 'Hamilton workflow does not request the 1600px CDN asset');
assert.doesNotMatch(hamiltonCode, /kijijica-640-webp/, 'Hamilton workflow still requests the small 640px asset');

const upgradeCode = workflowCode('automations/n8n/6ixo-upgrade-listing-images.json', 'Fetch Full-Resolution Images');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
assert.doesNotThrow(() => new AsyncFunction(upgradeCode), 'listing image upgrade code does not parse');
assert.match(upgradeCode, /listing-gallery-full-\\d\+w/, 'Pigiame detail-page full-gallery rule is missing');
assert.match(upgradeCode, /listing-thumb-\\d\+w/, 'Pigiame thumbnail detection is missing');
assert.match(upgradeCode, /const sanitizeStoredImages/, 'stored listing galleries are not sanitized');
assert.match(upgradeCode, /const upgradeKijijiMediaUrl/, 'Kijiji CDN upgrades are not sandbox-safe');
assert.doesNotMatch(upgradeCode, /new URL\(value\)/, 'Kijiji CDN upgrades still depend on the unavailable URL constructor');
assert.match(upgradeCode, /type:\s*'BrowserConfig'/, 'Crawl4AI browser configuration is not using the typed API shape');
assert.match(upgradeCode, /type:\s*'CrawlerRunConfig'/, 'Crawl4AI crawler configuration is not using the typed API shape');
assert.match(upgradeCode, /cdn2\\\.jacars\\\.net/, 'JACars full gallery extraction is missing');
assert.match(upgradeCode, /uploads\\\/original/, 'Oxglow original image extraction is missing');
assert.match(upgradeCode, /media\\\.carsforsale\\\.gy/, 'carsforsale.gy gallery extraction is missing');
assert.match(upgradeCode, /map\\d\*\\\.craigslist\\\.org/, 'Craigslist map-tile filtering is missing');
assert.match(upgradeCode, /if \(\/craigslist\/\.test\(source\)\) return !images\.some/, 'Craigslist rows without a real gallery are not selected for backfill');
assert.match(upgradeCode, /no_source_photo/, 'photo-less Craigslist rows are not hidden while backfill is pending');
assert.match(upgradeCode, /imageRefreshAttemptedAt/, 'failed image refreshes are not rate-limited');

const apify = read('apify_import.py');
assert.match(apify, /listing-gallery-full/, 'Apify importer does not prefer full Pigiame gallery images');
assert.match(apify, /kijijica-1600-webp/, 'Apify importer does not normalize Kijiji images');
assert.match(apify, /seller = "Unknown" if is_kijiji_source/, 'Apify importer does not anonymize Kijiji sellers');
assert.match(apify, /def is_marketplace_seller_name\(/, 'Apify importer is missing marketplace seller detection');
assert.match(apify, /if is_marketplace_seller_name\(seller, source_site, source_url\)/, 'Apify importer exposes source marketplace names as sellers');
assert.match(apify, /if is_kijiji_source and not phone:\s*\n\s*return None/, 'Apify importer does not reject Kijiji rows without phone numbers');

const kijijiScraper = read('kijiji_scrape.py');
assert.match(kijijiScraper, /kijijica-1600-webp/, 'local Kijiji scraper does not request high-resolution images');

const cleaner = read('clean_pigiame_images.py');
assert.match(cleaner, /source_width > width/, 'Pigiame cleaner does not guard against upscaling');
assert.match(cleaner, /sourceImageWasThumbnail/, 'Pigiame thumbnail provenance is not recorded');

const scrapedRows = parseCsv(read('data/scraped-listings.csv')).rows;
const publishedGhanaRows = scrapedRows.filter((row) => (
  String(row.status).toLowerCase() === 'published'
  && String(row.country).toLowerCase() === 'ghana'
));
assert.equal(publishedGhanaRows.length, 50, 'expected 50 published Ghana listings');
for (const row of publishedGhanaRows) {
  const images = splitImageUrls(row.image_urls);
  assert.ok(images.length >= 1, `${row.title} has no listing photos`);
  for (const image of images) {
    assert.match(image, /^data\/oxglow-/, `${row.title} still depends on a fragile remote image`);
    const absoluteImage = path.join(root, image);
    assert.ok(fs.existsSync(absoluteImage), `${row.title} is missing ${image}`);
    assert.ok(fs.statSync(absoluteImage).size > 1024, `${row.title} has an invalid image file at ${image}`);
  }
}
const ghanaCars = scrapedRows.filter((row) => (
  String(row.status).toLowerCase() === 'published'
  && String(row.country).toLowerCase() === 'ghana'
  && String(row.target_surface).toLowerCase() === 'vehicles'
  && /oxglow/i.test(`${row.source_site} ${row.source_url}`)
  && String(row.image_urls).startsWith('data/oxglow-vehicles-images/')
));
assert.ok(ghanaCars.length >= 10, 'expected the current Ghana vehicle inventory');
for (const row of ghanaCars) {
  assert.equal(row.app_subcategory, 'vehicles', `${row.title} is not routed to the Vehicles category`);
  const images = splitImageUrls(row.image_urls);
  assert.ok(images.length >= 1, `${row.title} has no listing photos`);
  for (const image of images) {
    assert.match(image, /^data\/oxglow-vehicles-images\//, `${row.title} still depends on a fragile remote image`);
    const absoluteImage = path.join(root, image);
    assert.ok(fs.existsSync(absoluteImage), `${row.title} is missing ${image}`);
    assert.ok(fs.statSync(absoluteImage).size > 0, `${row.title} has an empty image file at ${image}`);
  }
}

console.log('listing image quality checks passed');
