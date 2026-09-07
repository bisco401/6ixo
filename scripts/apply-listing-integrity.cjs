#!/usr/bin/env node
// Repair only identity/category/media fields; preserve unrelated feed updates and local assets.
const fs = require('node:fs');
const integrity = require('./lib/listing-integrity.cjs');
const {parseCsv, toCsv} = require('./listing-sync-policy.cjs');
const repairsPath = 'data/listing-integrity-repairs.json';
const repairs = fs.existsSync(repairsPath) ? JSON.parse(fs.readFileSync(repairsPath,'utf8')).listings : {};
const files = process.argv.slice(2);
for (const filename of files) {
  const parsed = parseCsv(fs.readFileSync(filename,'utf8'));
  let categories = 0, images = 0;
  for (const row of parsed.rows) {
    if (!row.source_url || !row.app_category) continue;
    const route = integrity.classify(row);
    if (['target_surface','app_category','app_subcategory'].some(k=>row[k]!==route[k])) {
      for (const k of ['target_surface','app_category','app_subcategory']) row[k]=route[k];
      categories++;
    }
    const repair = repairs[integrity.key(integrity.sourceUrl(row))];
    if (!repair || repair.title.trim().toLowerCase()!==row.title.trim().toLowerCase()) continue;
    let attributes; try {attributes=JSON.parse(row.attributes||'{}');} catch {attributes={};}
    if (attributes.imageVerifiedAt && attributes.imageVerifiedAt > repair.checkedAt) continue;
    if (repair.images) {
      const next = repair.images.join('|');
      if (row.image_urls !== next) images++;
      row.image_urls = next;
      row.source_resolved_url = integrity.sourceUrl(row);
      row.attributes = JSON.stringify({...attributes,imageIntegrityVersion:integrity.VERSION,imageVerifiedAt:repair.checkedAt,imageSourceUrl:integrity.sourceUrl(row)});
    }
  }
  fs.writeFileSync(filename,toCsv(parsed.headers,parsed.rows));
  console.log(`${filename}: ${categories} category corrections; ${images} gallery corrections`);
}
