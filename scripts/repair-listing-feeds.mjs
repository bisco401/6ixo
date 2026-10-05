#!/usr/bin/env node
import fs from 'node:fs';
import integrity from './lib/listing-integrity.cjs';
import policy from './listing-sync-policy.cjs';
const files = process.argv.slice(2).filter(f => !f.startsWith('--'));
const refresh = process.argv.includes('--refresh-kijiji');
const categoriesOnly = process.argv.includes('--categories-only');
const repairFile = 'data/listing-integrity-repairs.json';
const repairs = fs.existsSync(repairFile) ? JSON.parse(fs.readFileSync(repairFile,'utf8')).listings : {};
for (const file of files) {
  if (!fs.existsSync(file)) continue;
  const original = fs.readFileSync(file,'utf8');
  const parsed = policy.parseCsv(original);
  // A category repair must not refresh photos, contacts, prices or publication state.
  if (categoriesOnly) {
    let changed = 0;
    for (const row of parsed.rows) {
      if ((row.status || 'published') !== 'published') continue;
      // Legacy Oxglow feeds have dedicated normalizers and no category columns.
      if (!row.app_category && !/kijiji-gta-recent-with-phones\.csv$/.test(file)) continue;
      const repaired = integrity.applyRepair(row, repairs[integrity.key(integrity.sourceUrl(row))]);
      const next = integrity.classify(repaired);
      const fields = ['target_surface', 'app_category', 'app_subcategory'];
      const reviewedAttributes = JSON.parse(repaired.attributes || '{}');
      let attributes; try { attributes = JSON.parse(row.attributes || '{}'); } catch { attributes = {}; }
      const reviewChanged = reviewedAttributes.categoryReview && JSON.stringify(attributes.categoryReview) !== JSON.stringify(reviewedAttributes.categoryReview);
      if (!fields.some(field => row[field] !== next[field]) && !reviewChanged) continue;
      for (const field of fields) {
        if (!parsed.headers.includes(field)) parsed.headers.push(field);
        row[field] = next[field];
      }
      if (reviewChanged) {
        if (!parsed.headers.includes('attributes')) parsed.headers.push('attributes');
        row.attributes = JSON.stringify({ ...attributes, categoryReview: reviewedAttributes.categoryReview });
      }
      changed++;
    }
    if (changed) fs.writeFileSync(file, policy.toCsv(parsed.headers, parsed.rows));
    console.log(`${file}: ${changed} category corrections`);
    continue;
  }
  let cursor = 0;
  let changed = 0;
  await Promise.all(Array.from({length:4},async () => {
    while (cursor < parsed.rows.length) {
      const row = parsed.rows[cursor++];
      const before = JSON.stringify(row);
      const url = integrity.sourceUrl(row);
      if (!url) continue;
      const reject = issue => {
        row.status = 'rejected';
        row.sync_visibility = issue;
        row.sync_visibility_reason = ({
          no_phone: 'No usable seller phone number.',
          reviewed_image_mismatch: 'Reviewed rental photo does not show the advertised property.',
          foreign_gallery: 'Gallery belongs to a different source listing.',
          no_source_photo: 'No source listing photo is available.'
        })[issue];
      };
      Object.assign(row, integrity.applyRepair(row, repairs[integrity.key(url)]));
      for (const field of ['status', 'sync_visibility', 'sync_visibility_reason', 'attributes']) {
        if (row[field] && !parsed.headers.includes(field)) parsed.headers.push(field);
      }
      if (JSON.stringify(row) !== before) changed++;
      const initialIssue = integrity.publicationIssue(row);
      if (initialIssue && initialIssue !== 'no_source_photo') {
        reject(initialIssue);
        if (JSON.stringify(row) !== before) changed++;
        continue;
      }
      // Restore only the old country-cap exclusions; source and review holds remain intact.
      if (!initialIssue && row.sync_visibility === 'capped'
          && !['sold', 'unavailable', 'gone'].includes(String(row.source_availability || '').toLowerCase())) {
        row.status = 'published';
        row.sync_visibility = 'visible';
        row.sync_visibility_reason = '';
        changed++;
      }
      if (row.status && row.status !== 'published') continue;
      for (const field of ['phone', 'phone_numbers']) {
        if (row[field] && integrity.phone(row[field])) row[field] = integrity.phone(row[field]);
      }
      if (row.app_category || /kijiji-gta-recent-with-phones\.csv$/.test(file)) {
        const categories = Object.fromEntries(Object.entries(integrity.classify(row)).filter(([k]) => k !== 'reason'));
        for (const field of Object.keys(categories)) {
          if (!parsed.headers.includes(field)) parsed.headers.push(field);
        }
        Object.assign(row, categories);
      }
      let a; try {a=JSON.parse(row.attributes||'{}');} catch {a={};}
      if (refresh && /^https?:\/\/(?:www\.)?kijiji\.ca\/v-/.test(url)) {
        try {
          const response = await fetch(url,{headers:{'User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(25000)});
          if (response.ok && !/[?&]adRemoved=/.test(response.url)) {
            const gallery = integrity.extract(await response.text(),{...row,source_url:url});
            if (gallery.matched) {
              row.image_urls = gallery.images.slice(0,12).join('|');
              a={...a,imageIntegrityVersion:integrity.VERSION,imageVerifiedAt:new Date().toISOString(),imageSourceUrl:url};
            }
          }
        } catch (err) { console.warn(`Source verification deferred for ${row.id}: ${err.name}`); }
      }
      if (parsed.headers.includes('attributes')) row.attributes=JSON.stringify(a);
      if (parsed.headers.includes('image_url')) row.image_url=String(row.image_urls||'').split('|')[0] || '';
      if (parsed.headers.includes('source_resolved_url') && a.imageVerifiedAt) row.source_resolved_url=url;
      Object.assign(row, integrity.applyRepair(row, repairs[integrity.key(url)]));
      const issue = integrity.publicationIssue(row);
      if (issue) reject(issue);
      if (JSON.stringify(row)!==before) changed++;
    }
  }));
  if (changed) fs.writeFileSync(file,policy.toCsv(parsed.headers,parsed.rows));
  console.log(`${file}: repaired ${changed} records`);
}
