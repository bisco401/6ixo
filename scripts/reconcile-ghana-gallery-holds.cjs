#!/usr/bin/env node
// Resolve only stale automatic holds where a fresh source check returns the
// SAME previously verified gallery. Explicit reviews and excluded photos stay.
const fs = require('node:fs');
const integrity = require('./lib/listing-integrity.cjs');
const policy = require('./listing-sync-policy.cjs');

function canRestore(row, repair, now = Date.now()) {
  if (row.country !== 'Ghana' || repair?.holdReason !== 'foreign_gallery'
      || repair.reviewNote !== 'Gallery belongs to a different source listing.'
      || repair.method !== 'fresh_source_gallery_and_public_contact') return false;
  const attrs = JSON.parse(row.attributes || '{}'), proof = attrs.listingIdentity;
  const checked = Date.parse(proof?.checkedAt);
  if (attrs.parser !== 'ghana_marketplace_sync' || !Number.isFinite(checked)
      || now - checked < 0 || now - checked > 6 * 3600000
      || row.source_availability !== 'active' || integrity.publicationIssue(row)) return false;
  if (integrity.key(repair.sourceUrl) !== integrity.key(row.source_url)
      || integrity.identityText(repair.title) !== integrity.identityText(row.title)) return false;
  const own = new Set((repair.images || []).map(integrity.imageKey));
  const excluded = new Set((repair.excludedImages || []).map(integrity.imageKey));
  const images = String(row.image_urls || '').split('|').filter(Boolean);
  return images.length > 0 && images.every(image => own.has(integrity.imageKey(image)) && !excluded.has(integrity.imageKey(image)));
}

function main() {
  const file = 'data/scraped-listings.csv', repairFile = 'data/listing-integrity-repairs.json';
  const parsed = policy.parseCsv(fs.readFileSync(file, 'utf8'));
  const ledger = JSON.parse(fs.readFileSync(repairFile, 'utf8'));
  const restored = [];
  for (const row of parsed.rows) {
    const repair = ledger.listings[integrity.key(row.source_url)];
    if (!canRestore(row, repair)) continue;
    delete repair.holdReason;
    delete repair.reviewNote;
    repair.holdResolvedAt = new Date().toISOString();
    repair.holdResolutionReason = 'Fresh exact source gallery matches the previously verified photos; excluded originals remain blocked.';
    row.status = 'published'; row.sync_visibility = 'visible'; row.sync_visibility_reason = '';
    restored.push({ id: row.id, url: row.source_url });
  }
  if (restored.length) {
    fs.writeFileSync(file, policy.toCsv(parsed.headers, parsed.rows));
    fs.writeFileSync(repairFile, JSON.stringify(ledger) + '\n');
  }
  fs.mkdirSync('output', { recursive: true });
  fs.writeFileSync('output/ghana-gallery-recovery-report.json', JSON.stringify({ checkedAt: new Date().toISOString(), restored }, null, 2) + '\n');
  console.log(`Ghana: restored ${restored.length} freshly verified ads with their previously verified source photos.`);
}
if (require.main === module) main();
module.exports = { canRestore };
