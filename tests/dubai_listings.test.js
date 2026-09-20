const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const {parseCsv} = require('../scripts/listing-sync-policy.cjs');
const integrity = require('../scripts/lib/listing-integrity.cjs');
const source = fs.readFileSync('app.js','utf8');
const context={console,Date,Map,Set,URL,URLSearchParams,window:{location:{href:'https://6ixo.com/'}},navigator:{}};
vm.runInNewContext(source.slice(0,source.indexOf('// Initialize the app when the page loads'))+'\nglobalThis.App=DatingApp;',context);
const app=Object.create(context.App.prototype);
app.scrapedListingIntegrityRepairs=JSON.parse(fs.readFileSync('data/listing-integrity-repairs.json')).listings;
const rows=parseCsv(fs.readFileSync('data/dubai-listings.csv','utf8')).rows;

test('Dubai publishes only unique ads with complete source seller phones and photos',()=>{
 assert.equal(new Set(rows.map(r=>r.id)).size,rows.length);
 const published=rows.filter(r=>r.status==='published');
 assert.ok(published.length>0,'Dubai must have phone-equipped listings');
 for(const row of published){
  assert.equal(row.city,'Dubai');assert.equal(row.country,'United Arab Emirates');
  assert.equal(integrity.publicationIssue(row),'',row.id);
  assert.match(row.phone,/^\+971\d{8,9}$/);
  assert.equal(row.source_availability,'active');
  const item=app.normalizeCsvScrapedListingRow(row)?.item;
  assert.ok(item,row.id);assert.equal(item.contactPhone || item.phone,row.phone);
  const a=JSON.parse(row.attributes);
  assert.equal(a.contactSource,row.source_url);
  assert.equal(a.imageSourceUrl,row.source_url);
  assert.ok(a.phoneVerifiedAt);
 }
});
test('Dubai cannot use a source-link-only fallback for a missing or masked phone',()=>{
 const valid=rows.find(r=>r.status==='published');
 for(const phone of ['', 'Contact seller', '05015047XX']){
  assert.equal(app.normalizeCsvScrapedListingRow({...valid,phone}),null);
 }
 for(const row of rows.filter(r=>!integrity.phone(r.phone))) assert.notEqual(row.status,'published');
});
