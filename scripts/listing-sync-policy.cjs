'use strict';

const DEFAULT_ALLOWED_CATEGORIES = [
  'vehicles',
  'electronics',
  'clothing',
  'jobs',
  'services',
  'real_estate',
  'buy_sell',
  'community',
  'other',
  'home',
];

const CONFIRMED_UNAVAILABLE = new Set(['sold', 'unavailable', 'gone']);

function clean(value = '') {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function positiveInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

function parseJsonArray(value, fallback) {
  if (Array.isArray(value)) return value;
  if (!clean(value)) return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function splitImageUrls(value = '') {
  const seen = new Set();
  const urls = [];
  for (const candidate of String(value || '').split(/\s*\|\s*/)) {
    const url = clean(candidate);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

function listingTimestamp(row = {}) {
  let attributes = {};
  try {
    attributes = JSON.parse(row.attributes || '{}') || {};
  } catch {}
  const candidates = [
    row.source_posted_at,
    row.posted_at,
    row.published_at,
    attributes.sourcePostedAt,
    attributes.sourceLastModified,
    attributes.publishedAt,
    row.scraped_at,
  ];
  for (const candidate of candidates) {
    const timestamp = Date.parse(candidate || '');
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}

function normalizeIdentityText(value = '') {
  return clean(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizedPhoneKey(value = '') {
  const phones = String(value || '')
    .split('|')
    .map((entry) => entry.replace(/\D/g, ''))
    .map((entry) => entry.length === 11 && entry.startsWith('1') ? entry.slice(1) : entry)
    .filter((entry) => entry.length === 10);
  return [...new Set(phones)].sort().join('|');
}

function normalizedImageKey(value = '') {
  const first = splitImageUrls(value)[0] || '';
  return first
    .toLowerCase()
    .replace(/_(?:50x50c|300x300|600x450|1200x900)(?=\.)/i, '')
    .replace(/[?#].*$/, '')
    .replace(/^https?:\/\/www\./, 'https://');
}

function sourcePathKey(value = '') {
  const sourceUrl = clean(value);
  if (!sourceUrl) return '';
  try {
    return new URL(sourceUrl, 'https://relative.invalid').pathname.replace(/\/$/, '').toLowerCase();
  } catch {
    return sourceUrl.replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase();
  }
}

function listingDuplicateKeys(row = {}) {
  const keys = [];
  const id = normalizeIdentityText(row.id);
  const source = normalizeIdentityText(row.source_site);
  const path = sourcePathKey(row.source_url);
  const title = normalizeIdentityText(row.title);
  const phone = normalizedPhoneKey(row.phone);
  const image = normalizedImageKey(row.image_urls || row.image_url);
  const description = normalizeIdentityText(row.description);
  const category = normalizeIdentityText(row.app_category);
  const city = normalizeIdentityText(row.city || row.location_city);
  const country = normalizeIdentityText(row.country);

  if (id) keys.push(`id:${id}`);
  if (source && path) keys.push(`source-path:${source}|${path}`);
  if (source && title && phone && image) keys.push(`content-image:${source}|${title}|${phone}|${image}`);
  if (title.length >= 8 && phone && city && country) {
    keys.push(`title-phone-location:${title}|${phone}|${city}|${country}`);
  }
  if (source && title && phone && description.length >= 40 && !['vehicles', 'real estate'].includes(category)) {
    keys.push(`content-description:${source}|${title}|${phone}|${description}`);
  }
  return keys;
}

function listingCompletenessScore(row = {}) {
  let score = 0;
  if (/^https?:\/\//i.test(clean(row.source_url))) score += 20;
  if (clean(row.status).toLowerCase() === 'published') score += 10;
  if (clean(row.source_availability).toLowerCase() === 'active') score += 5;
  score += Math.min(4, splitImageUrls(row.image_urls || row.image_url).length) * 3;
  if (normalizedPhoneKey(row.phone)) score += 4;
  score += Math.min(4, Math.floor(clean(row.description).length / 120));
  return score;
}

function deduplicateListings(inputRows = []) {
  const sorted = inputRows.map((row) => ({ ...row })).sort((left, right) => (
    listingTimestamp(right) - listingTimestamp(left)
    || listingCompletenessScore(right) - listingCompletenessScore(left)
    || clean(right.source_url).localeCompare(clean(left.source_url))
  ));
  const seenKeys = new Set();
  const rows = [];
  const deletedRows = [];
  for (const row of sorted) {
    const keys = listingDuplicateKeys(row);
    const isDuplicate = keys.some((key) => seenKeys.has(key));
    keys.forEach((key) => seenKeys.add(key));
    if (isDuplicate) deletedRows.push(row);
    else rows.push(row);
  }
  return {
    rows,
    deletedRows,
    stats: {
      inputRows: sorted.length,
      outputRows: rows.length,
      deletedDuplicates: deletedRows.length,
    },
  };
}

function parseCsv(text = '') {
  const records = [];
  let row = [];
  let field = '';
  let quoted = false;
  const input = String(text || '').replace(/^\uFEFF/, '');
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field.replace(/\r$/, ''));
      if (row.some((value) => value !== '')) records.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }
  if (field || row.length) {
    row.push(field.replace(/\r$/, ''));
    if (row.some((value) => value !== '')) records.push(row);
  }
  const headers = (records.shift() || []).map(clean);
  const rows = records.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] || ''])));
  return { headers, rows };
}

function csvEscape(value = '') {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(headers, rows) {
  const allHeaders = [...headers];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!allHeaders.includes(key)) allHeaders.push(key);
    }
  }
  return [
    allHeaders.map(csvEscape).join(','),
    ...rows.map((row) => allHeaders.map((header) => csvEscape(row[header] || '')).join(',')),
  ].join('\n') + '\n';
}

function applyListingPolicy(inputRows, options = {}) {
  const maxImages = positiveInteger(options.maxImages, 4, 4);
  const maxListingsPerCountry = positiveInteger(options.maxListingsPerCountry, 50, 50);
  const deleteAfterMisses = positiveInteger(options.deleteAfterMisses, 1, 20);
  const allowedCategories = new Set(
    parseJsonArray(options.allowedCategories, DEFAULT_ALLOWED_CATEGORIES)
      .map((value) => clean(value).toLowerCase())
      .filter(Boolean),
  );
  const configuredCountries = new Set(
    parseJsonArray(options.countries, [])
      .map((value) => clean(value).toLowerCase())
      .filter(Boolean),
  );
  const manageEveryCountry = configuredCountries.size === 0;
  const rows = inputRows.map((row) => ({ ...row }));
  const deletedRows = [];
  const stats = {
    inputRows: rows.length,
    outputRows: 0,
    imagesTrimmed: 0,
    hiddenUnavailable: 0,
    deletedUnavailable: 0,
    deletedDuplicates: 0,
    hiddenByCountryCap: 0,
    restoredToCountryCap: 0,
    countries: {},
  };

  const availableRows = [];
  for (const row of rows) {
    const images = splitImageUrls(row.image_urls || row.image_url || '');
    if (images.length > maxImages) stats.imagesTrimmed += images.length - maxImages;
    row.image_urls = images.slice(0, maxImages).join('|');

    const availability = clean(row.source_availability).toLowerCase();
    const checkedAt = clean(row.source_availability_checked_at);
    let missCount = Number.parseInt(row.source_miss_count || '0', 10);
    if (!Number.isFinite(missCount) || missCount < 0) missCount = 0;

    if (availability === 'active') {
      row.source_miss_count = '0';
      row.source_miss_recorded_at = '';
      if (row.sync_visibility === 'unavailable' && row.status === 'rejected') {
        row.status = 'published';
        row.sync_visibility = 'visible';
        row.sync_visibility_reason = '';
      }
    } else if (CONFIRMED_UNAVAILABLE.has(availability)) {
      if (checkedAt && checkedAt !== clean(row.source_miss_recorded_at)) {
        missCount += 1;
        row.source_miss_recorded_at = checkedAt;
      }
      row.source_miss_count = String(missCount);
      row.status = 'rejected';
      row.sync_visibility = 'unavailable';
      row.sync_visibility_reason = clean(row.source_unavailable_reason) || `Source confirmed ${availability}.`;
      stats.hiddenUnavailable += 1;
      if (missCount >= deleteAfterMisses) {
        deletedRows.push(row);
        stats.deletedUnavailable += 1;
        continue;
      }
    }
    availableRows.push(row);
  }

  const deduplicated = deduplicateListings(availableRows);
  stats.deletedDuplicates = deduplicated.stats.deletedDuplicates;
  deletedRows.push(...deduplicated.deletedRows);

  const countryGroups = new Map();
  for (const row of deduplicated.rows) {
    const country = clean(row.country);
    const countryKey = country.toLowerCase();
    const category = clean(row.app_category).toLowerCase();
    if (!countryKey || (!manageEveryCountry && !configuredCountries.has(countryKey))) continue;
    if (allowedCategories.size && !allowedCategories.has(category)) continue;
    if (CONFIRMED_UNAVAILABLE.has(clean(row.source_availability).toLowerCase())) continue;
    const policyManaged = ['visible', 'capped'].includes(clean(row.sync_visibility).toLowerCase());
    if (clean(row.status).toLowerCase() !== 'published' && !policyManaged) continue;
    if (!countryGroups.has(countryKey)) countryGroups.set(countryKey, { label: country, rows: [] });
    countryGroups.get(countryKey).rows.push(row);
  }

  for (const { label, rows: countryRows } of countryGroups.values()) {
    countryRows.sort((left, right) => listingTimestamp(right) - listingTimestamp(left)
      || clean(right.source_url).localeCompare(clean(left.source_url)));
    countryRows.forEach((row, index) => {
      if (index < maxListingsPerCountry) {
        if (row.status === 'rejected' && row.sync_visibility === 'capped') {
          row.status = 'published';
          stats.restoredToCountryCap += 1;
        }
        row.sync_visibility = 'visible';
        row.sync_visibility_reason = '';
      } else {
        if (row.status !== 'rejected' || row.sync_visibility !== 'capped') stats.hiddenByCountryCap += 1;
        row.status = 'rejected';
        row.sync_visibility = 'capped';
        row.sync_visibility_reason = `Outside the ${maxListingsPerCountry} newest listings for ${label}.`;
      }
    });
    stats.countries[label] = {
      eligible: countryRows.length,
      visible: Math.min(countryRows.length, maxListingsPerCountry),
      capped: Math.max(0, countryRows.length - maxListingsPerCountry),
    };
  }

  deduplicated.rows.sort((left, right) => listingTimestamp(right) - listingTimestamp(left)
    || clean(right.source_url).localeCompare(clean(left.source_url)));
  stats.outputRows = deduplicated.rows.length;
  return { rows: deduplicated.rows, deletedRows, stats };
}

if (typeof module !== 'undefined') {
  module.exports = {
    DEFAULT_ALLOWED_CATEGORIES,
    applyListingPolicy,
    clean,
    deduplicateListings,
    listingDuplicateKeys,
    listingTimestamp,
    parseCsv,
    splitImageUrls,
    toCsv,
  };
}
