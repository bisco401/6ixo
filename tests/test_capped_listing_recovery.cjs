'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {parseCsv, toCsv} = require('../scripts/listing-sync-policy.cjs');
const repairs = JSON.parse(fs.readFileSync('data/listing-integrity-repairs.json')).listings;
const hold = Object.values(repairs).find(r => r.holdReason && r.title && r.sourceUrl);
const base = {attributes:'{}',status:'rejected',sync_visibility:'capped',sync_visibility_reason:'Outside the 50 newest listings.',title:'Test item',phone:'6475551234',country:'Canada',app_category:'other',image_urls:'https://example.test/item.jpg',source_availability:'active'};
const rows = [
 {...base,id:'eligible',source_url:'https://example.test/eligible'},
 {...base,id:'no-phone',phone:'',source_url:'https://example.test/no-phone'},
 {...base,id:'sold',source_availability:'sold',source_url:'https://example.test/sold'},
 {...base,id:'no-photo',image_urls:'',source_url:'https://example.test/no-photo'},
 {...base,id:'held',title:hold.title,source_url:hold.sourceUrl},
];
const folder = fs.mkdtempSync(path.join(os.tmpdir(),'6ixo-cap-recovery-'));
const file = path.join(folder,'listings.csv');
try {
 fs.writeFileSync(file,toCsv(Object.keys(rows[0]),rows));
 execFileSync(process.execPath,['scripts/repair-listing-feeds.mjs',file]);
 const actual = parseCsv(fs.readFileSync(file,'utf8')).rows;
 assert.deepEqual(actual.filter(r=>r.status==='published').map(r=>r.id),['eligible']);
 assert.equal(actual.find(r=>r.id==='held').sync_visibility,hold.holdReason);
 const once = fs.readFileSync(file,'utf8');
 execFileSync(process.execPath,['scripts/repair-listing-feeds.mjs',file]);
 assert.equal(fs.readFileSync(file,'utf8'),once,'repeated repair must be stable');
 console.log('Country-cap recovery passes: eligible listings return; missing contacts, missing photos, sold listings and review holds stay hidden.');
} finally {fs.rmSync(folder,{recursive:true,force:true});}
