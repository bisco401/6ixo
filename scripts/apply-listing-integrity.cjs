#!/usr/bin/env node
// Apply reviewed identity/category/media corrections consistently with the browser.
const fs = require('node:fs');
const integrity = require('./lib/listing-integrity.cjs');
const {parseCsv, toCsv} = require('./listing-sync-policy.cjs');
const repairsPath = 'data/listing-integrity-repairs.json';
const repairs = fs.existsSync(repairsPath) ? JSON.parse(fs.readFileSync(repairsPath,'utf8')).listings : {};
for (const filename of process.argv.slice(2)) {
  const parsed = parseCsv(fs.readFileSync(filename,'utf8'));
  let changed = 0;
  for (const row of parsed.rows) {
    const url = integrity.sourceUrl(row);
    if (!url || (row.status && row.status !== 'published')) continue;
    const before = JSON.stringify(row);
    Object.assign(row, integrity.applyRepair(row, repairs[integrity.key(url)]));
    if (row.app_category) {
      const route = integrity.classify(row);
      for (const field of ['target_surface', 'app_category', 'app_subcategory']) row[field] = route[field];
    }
    for (const [field, value] of Object.entries(row)) {
      if (field !== 'reason' && value && !parsed.headers.includes(field)) parsed.headers.push(field);
    }
    if (JSON.stringify(row) !== before) changed++;
  }
  if (changed) fs.writeFileSync(filename,toCsv(parsed.headers,parsed.rows));
  console.log(`${filename}: ${changed} reviewed listing corrections`);
}
