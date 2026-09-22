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

test('Dubai apartments keep annual AED prices and property details on the property feed',()=>{
 const rentals=rows.filter(r=>r.status==='published' && r.app_category==='real_estate');
 assert.ok(rentals.length>0);
 for(const row of rentals){
  const item=app.normalizeCsvScrapedListingRow(row).item;
  const profile=app.buildRealestateFeedEntryFromMarketplaceItem(item);
  const attrs=JSON.parse(row.attributes);
  assert.equal(item.category,'real_estate');
  assert.equal(profile.listingType,'for_rent_long');
  assert.equal(profile.propertyType,'apartment');
  assert.equal(profile.price,row.price_text);
  assert.match(profile.price,/^AED [\d,]+\/year$/);
  assert.equal(profile.priceTerm,'per_year');
  assert.equal(profile.sqft,attrs.sqft);
  assert.equal(profile.bedrooms,attrs.bedrooms);
  assert.equal(profile.bathrooms,attrs.bathrooms);
  assert.equal(profile.contactPhone,row.phone);
 }
 const manual=app.buildRealestateFeedEntryFromMarketplaceItem({category:'real_estate',price:2500,realestate:{priceTerm:'per_month'}});
 assert.equal(manual.price,'$2,500/mo');
});

test('different products in one public catalogue survive both dedupe stages',()=>{
 const products=rows.filter(r=>r.status==='published' && r.id.startsWith('hgc-dubai-'));
 assert.ok(products.length>1);
 const uniqueRows=app.dedupeScrapedListingRows([...products,products[0]]);
 assert.equal(uniqueRows.length,products.length);
 const items=uniqueRows.map(row=>app.normalizeCsvScrapedListingRow(row).item);
 assert.equal(new Set(items.map(i=>i.id)).size,items.length);
 app.marketplaceItems=[...items,{...items[0]}];
 app.deduplicateImportedListingFeeds();
 assert.equal(app.marketplaceItems.length,items.length);
 for(const item of items) assert.equal(item.category,'electronics');
});
