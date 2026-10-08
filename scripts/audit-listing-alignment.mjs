#!/usr/bin/env node
// Audit every feed row and verify available source entities without guessing blocked pages.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import integrity from './lib/listing-integrity.cjs';
import policy from './listing-sync-policy.cjs';
const args = process.argv.slice(2);
const option = name => args.find(v => v.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const apply = args.includes('--apply');
const refresh = args.includes('--fetch');
const cacheDir = option('cache') || path.join(process.env.RUNNER_TEMP || '/tmp', '6ixo-source-alignment');
const reportFile = option('report') || 'output/listing-alignment/audit.json';
const checkedAt = new Date().toISOString();
const files = args.filter(v => !v.startsWith('--'));
const inputs = files.length ? files : fs.readdirSync('data').filter(v => v.endsWith('.csv')).map(v => `data/${v}`);
const repairFile = 'data/listing-integrity-repairs.json';
const repairFeed = JSON.parse(fs.readFileSync(repairFile, 'utf8'));
const repairs = repairFeed.listings || {};
const availabilityFile = 'data/listing-availability.json';
const availabilityFeed = fs.existsSync(availabilityFile) ? JSON.parse(fs.readFileSync(availabilityFile, 'utf8')) : { listings: {} };
const sources = new Map();
const feeds = inputs.filter(fs.existsSync).map(file => ({ file, ...policy.parseCsv(fs.readFileSync(file, 'utf8')) }));
for (const feed of feeds) for (const row of feed.rows) {
  const url = integrity.sourceUrl(row);
  if (((row.status || 'published') === 'published' || row.sync_visibility === 'source_identity_unverified') && /^https?:\/\//.test(url)) sources.set(url, row);
}
fs.mkdirSync(cacheDir, { recursive: true });
const cache = url => path.join(cacheDir, crypto.createHash('sha256').update(url).digest('hex'));
if (refresh) {
  let cursor = 0;
  const urls = [...sources.keys()];
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (cursor < urls.length) {
      const url = urls[cursor++];
      try {
        const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(18000) });
        const html = await response.text();
        fs.writeFileSync(cache(url) + '.html', html);
        fs.writeFileSync(cache(url) + '.json', JSON.stringify({ url, status: response.status, resolvedUrl: response.url }));
      } catch (error) { fs.writeFileSync(cache(url) + '.json', JSON.stringify({ url, status: 0, error: error.name })); }
    }
  }));
}
const report = { version: integrity.VERSION, checkedAt, records: feeds.reduce((n, f) => n + f.rows.length, 0), sourceUrls: sources.size, feeds: {}, outcomes: {}, listings: [] };
const decisions = new Map();
for (const [url, row] of sources) {
  const stem = cache(url);
  const meta = fs.existsSync(stem + '.json') ? JSON.parse(fs.readFileSync(stem + '.json', 'utf8')) : { status: 0 };
  let outcome = 'source_unverified', result;
  let verifiedRow;
  if ([404, 410].includes(meta.status) || /[?&]adRemoved=/.test(meta.resolvedUrl || '')) outcome = 'source_removed';
  else if (meta.status === 200 && fs.existsSync(stem + '.html')) {
    const verified = integrity.verifyRecord(row, fs.readFileSync(stem + '.html', 'utf8'), checkedAt);
    result = verified.result; verifiedRow = verified.row;
    if (String(verifiedRow.description || '').length > 1000) {
      const fragment = verifiedRow.description.slice(0, 999).trimEnd();
      const boundary = fragment.lastIndexOf(' ');
      verifiedRow.description = (boundary > 700 ? fragment.slice(0, boundary) : fragment).trimEnd() + '…';
    }
    outcome = result.identityIssue || (result.matched ? 'verified' : 'source_unverified');
  } else if ([403, 429].includes(meta.status)) outcome = 'source_blocked';
  const decision = { id: row.id, title: row.title, sourceUrl: url, outcome, httpStatus: meta.status, resolvedUrl: meta.resolvedUrl, observedTitle: result?.title, observedSourceUrl: result?.sourceUrl };
  report.listings.push(decision);
  report.outcomes[outcome] = (report.outcomes[outcome] || 0) + 1;
  decisions.set(integrity.key(url), { ...decision, verifiedRow });
  if (apply && outcome === 'verified') {
    // Preserve human review decisions and retain the original title guard.
    repairs[integrity.key(url)] = { ...repairs[integrity.key(url)], id: row.id, title: row.title, sourceUrl: url, images: result.images, listingIdentity: JSON.parse(verifiedRow.attributes).listingIdentity, sourceFields: /kijiji\.ca\//.test(url) ? Object.fromEntries(['price_text', 'price_value', 'price', 'description'].filter(k => k in verifiedRow).map(k => [k, verifiedRow[k]])) : {}, replacementCity: verifiedRow.city || '', replacementPhone: result.phones?.length ? (verifiedRow.phone || verifiedRow.phone_numbers || '') : '', checkedAt, method: result.method };
  } else if (apply && ['source_identity_mismatch', 'foreign_contact', 'foreign_seller', 'foreign_location'].includes(outcome)) {
    repairs[integrity.key(url)] = { ...repairs[integrity.key(url)], id: row.id, title: row.title, sourceUrl: url, checkedAt, holdReason: outcome, reviewNote: `Source identity review required: ${outcome}. Source title: ${result?.title || 'unavailable'}.`, observedTitle: result?.title, observedSourceUrl: result?.sourceUrl };
  } else if (apply && outcome === 'source_removed') {
    availabilityFeed.listings[integrity.key(url)] = { id: row.id, sourceUrl: url, availability: 'gone', checkedAt, httpStatus: meta.status, resolvedUrl: meta.resolvedUrl, reason: 'Source returned a removed-ad redirect or HTTP 404/410.' };
  }
}
for (const feed of feeds) {
  const counts = { rows: feed.rows.length, categoryCorrections: 0, correctedGalleries: 0, held: 0, published: 0 };
  for (let row of feed.rows) {
    const before = { ...row };
    if (/^https?:\/\/(?:www\.)?kijiji\.ca\//.test(integrity.sourceUrl(row))) {
      let attributes; try { attributes = JSON.parse(row.attributes || '{}'); } catch { attributes = {}; }
      row.attributes = JSON.stringify({ ...attributes, sourceIdentityRequired: true });
    }
    Object.assign(row, integrity.applyRepair(row, repairs[integrity.key(integrity.sourceUrl(row))]));
    const verifiedDecision = decisions.get(integrity.key(integrity.sourceUrl(row)));
    if (row.sync_visibility === 'source_identity_unverified' && verifiedDecision?.outcome === 'verified' && !repairs[integrity.key(integrity.sourceUrl(row))]?.holdReason) { row.status = 'published'; row.sync_visibility = ''; row.sync_visibility_reason = ''; }
    if ((row.status || 'published') === 'published') {
      const decision = decisions.get(integrity.key(integrity.sourceUrl(row)));
      if (decision?.outcome === 'source_removed') {
        row.status = 'rejected'; row.source_availability = 'gone'; row.sync_visibility = 'source_removed';
        row.sync_visibility_reason = 'Source confirmed this ad has been removed.';
      }
      const issue = integrity.publicationIssue(row);
      if (issue && (row.status || 'published') === 'published') { row.status = 'pending'; row.sync_visibility = issue; row.sync_visibility_reason = `Source alignment verification required: ${issue}.`; }
      if (row.app_category || /kijiji-gta/.test(feed.file)) {
        const route = integrity.classify(row);
        if (['target_surface', 'app_category', 'app_subcategory'].some(k => row[k] !== route[k])) counts.categoryCorrections++;
        for (const k of ['target_surface', 'app_category', 'app_subcategory']) row[k] = route[k];
      }
    }
    if (before.image_urls !== row.image_urls) counts.correctedGalleries++;
    if ((before.status || 'published') === 'published' && (row.status || 'published') !== 'published') counts.held++;
    if ((row.status || 'published') === 'published') counts.published++;
    for (const k of Object.keys(row)) if (!feed.headers.includes(k)) feed.headers.push(k);
  }
  report.feeds[feed.file] = counts;
  if (apply) fs.writeFileSync(feed.file, policy.toCsv(feed.headers, feed.rows));
}
if (apply) {
  fs.writeFileSync(repairFile, JSON.stringify({ ...repairFeed, version: integrity.VERSION, checkedAt, listings: repairs }) + '\n');
  fs.writeFileSync(availabilityFile, JSON.stringify({ ...availabilityFeed, checkedAt }, null, 2) + '\n');
}
fs.mkdirSync(path.dirname(reportFile), { recursive: true });
fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ records: report.records, sourceUrls: report.sourceUrls, outcomes: report.outcomes, feeds: report.feeds, reportFile }, null, 2));
