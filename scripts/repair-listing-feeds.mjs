#!/usr/bin/env node
import fs from 'node:fs';
import integrity from './lib/listing-integrity.cjs';
import policy from './listing-sync-policy.cjs';
const files = process.argv.slice(2).filter(f => !f.startsWith('--'));
const refresh = process.argv.includes('--refresh-kijiji');
const repairFile = 'data/listing-integrity-repairs.json';
const repairs = fs.existsSync(repairFile) ? JSON.parse(fs.readFileSync(repairFile,'utf8')).listings : {};
for (const file of files) {
  if (!fs.existsSync(file)) continue;
  const original = fs.readFileSync(file,'utf8');
  const parsed = policy.parseCsv(original);
  let cursor = 0;
  let changed = 0;
  await Promise.all(Array.from({length:4},async () => {
    while (cursor < parsed.rows.length) {
      const row = parsed.rows[cursor++];
      const before = JSON.stringify(row);
      const url = integrity.sourceUrl(row);
      if (!url || (row.status && row.status !== 'published')) continue;
      if (row.app_category) Object.assign(row, Object.fromEntries(Object.entries(integrity.classify(row)).filter(([k])=>k!=='reason')));
      let a; try {a=JSON.parse(row.attributes||'{}');} catch {a={};}
      const repair = repairs[integrity.key(url)];
      if (repair && repair.title.trim().toLowerCase() === row.title.trim().toLowerCase() && (!a.imageVerifiedAt || a.imageVerifiedAt < repair.checkedAt)) {
        row.image_urls = repair.images.join('|');
        a={...a,imageIntegrityVersion:integrity.VERSION,imageVerifiedAt:repair.checkedAt,imageSourceUrl:url};
      }
      if (refresh && /^https?:\/\/(?:www\.)?kijiji\.ca\/v-/.test(url)) {
        try {
          const response = await fetch(url,{headers:{'User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(25000)});
          if (response.ok && !/[?&]adRemoved=/.test(response.url)) {
            const gallery = integrity.extract(await response.text(),{...row,source_url:url});
            if (gallery.matched) {
              row.image_urls = gallery.images.slice(0,4).join('|');
              a={...a,imageIntegrityVersion:integrity.VERSION,imageVerifiedAt:new Date().toISOString(),imageSourceUrl:url};
            }
          }
        } catch (err) { console.warn(`Source verification deferred for ${row.id}: ${err.name}`); }
      }
      if (parsed.headers.includes('attributes')) row.attributes=JSON.stringify(a);
      if (parsed.headers.includes('image_url')) row.image_url=String(row.image_urls||'').split('|')[0] || '';
      if (parsed.headers.includes('source_resolved_url') && a.imageVerifiedAt) row.source_resolved_url=url;
      if (JSON.stringify(row)!==before) changed++;
    }
  }));
  if (changed) fs.writeFileSync(file,policy.toCsv(parsed.headers,parsed.rows));
  console.log(`${file}: repaired ${changed} records`);
}
