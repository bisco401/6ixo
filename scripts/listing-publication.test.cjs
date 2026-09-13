const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const integrity = require('./lib/listing-integrity.cjs');
const { parseCsv } = require('./listing-sync-policy.cjs');
const code = fs.readFileSync('app.js', 'utf8');
const context = { console, Date, Map, Set, URL, URLSearchParams, window: { location: { href: 'https://6ixo.com/' } }, navigator: {} };
vm.runInNewContext(code.slice(0, code.indexOf('// Initialize the app when the page loads')) + '\nglobalThis.App = DatingApp;', context);
const app = Object.create(context.App.prototype);
app.scrapedListingIntegrityRepairs = JSON.parse(fs.readFileSync('data/listing-integrity-repairs.json')).listings;
const row = { id:'test-rental', status:'published', title:'Room for Rent', source_url:'https://www.kijiji.ca/v-room-rental-roommate/toronto/room/123456', app_category:'electronics', app_subcategory:'other', phone:'6474030077', image_urls:'https://media.kijiji.ca/api/v1/images/room?rule=kijijica-1600-webp', city:'Toronto', country:'Canada' };
for (const phone of ['', 'N/A', 'Contact seller', '+187646064XX', '0000000000', '2026-09-13']) {
 for (const source_site of ['Kijiji', 'Sebu', 'OpenSooq']) assert.equal(app.normalizeCsvScrapedListingRow({...row,phone,source_site}), null, `${source_site}: ${phone}`);
 assert.equal(app.normalizeKijijiGtaRow({...row,url:row.source_url,phone_numbers:phone}),null);
}
for (const phone of ['+86 755 1234 5678','(647) 403-0077','0759710738 0756500101','0595972097/0260180627','0248928734 or 0553346512']) assert.ok(integrity.phone(phone),phone);
assert.equal(integrity.phone('0759710738 0756500101'),'0759710738 | 0756500101');
const rental = app.normalizeCsvScrapedListingRow(row).item;
assert.equal(rental.category,'real_estate');
assert.equal(rental.realestate.listingType,'for_rent_long');
const profile = app.buildRealestateFeedEntryFromMarketplaceItem(rental);
assert.equal(profile.contactPhone,row.phone);
assert.equal(profile.images[0],rental.images[0]);
assert.equal(app.normalizeCsvScrapedListingRow({...row,image_urls:''}),null);
assert.equal(app.normalizeCsvScrapedListingRow({...row,attributes:JSON.stringify({imageSourceUrl:'https://example.com/different-listing',imageVerifiedAt:'2026-09-13'})}),null);
const badUrl='https://www.kijiji.ca/v-short-term-rental/city-of-toronto/room-for-rent/1741762769';
assert.equal(app.normalizeCsvScrapedListingRow({...row,source_url:badUrl}),null);
assert.equal(app.normalizeKijijiGtaRow({...row,url:badUrl,phone_numbers:row.phone}),null);
const featured=app.buildScrapedHomeFeaturedListing({item:rental});
const attrs=app.buildFeaturedAdDataAttrs(featured,featured.featuredAd);
assert.equal(attrs.adPhone,row.phone);
assert.equal(attrs.adCategory,app.marketplaceCategoryLabel(rental.category));
const card={dataset:attrs,querySelector(){return null;},querySelectorAll(){return rental.images.map(src=>({src}));},closest(){return null;}};
const modal=app.getLuxuryAdDataFromCard(card);
assert.ok(modal.details.some(d=>d.label==='Phone'&&d.value===row.phone));
assert.ok(modal.details.some(d=>d.label==='Category'&&d.value===attrs.adCategory));
assert.equal(modal.photos[0],rental.images[0]);
assert.equal(app.getLuxuryAdDataFromCard({...card,querySelector:()=>({textContent:'Toronto, Canada'})}).price,'','Missing price must not borrow location text');
assert.match(app.renderPhoneLinkHtml(row.phone),/href="tel:\+16474030077"/);
assert.equal(app.buildScrapedHomeFeaturedListing({item:{...rental,phone:'',contact:{},realestate:{}}}),null);
app.marketplaceItems=[rental,{...rental,id:2,sourceRowId:'bad',phone:'',contact:{},realestate:{}}];
app.deduplicateImportedListingFeeds();assert.equal(app.marketplaceItems.length,1);
let checked=0;
for(const file of fs.readdirSync('data').filter(f=>f.endsWith('.csv'))) {
 const rows=parseCsv(fs.readFileSync('data/'+file,'utf8')).rows;
 for(const entry of rows) {
  if((entry.status||'published')!=='published')continue;
  assert.equal(integrity.publicationIssue(entry),'',`${file}: ${entry.id||entry.sku} ${entry.title}`);
  const method = file === 'kijiji-gta-recent-with-phones.csv' ? 'normalizeKijijiGtaRow'
    : file.startsWith('oxglow-auto-') ? 'normalizeOxglowAutoPartsRow'
    : file.startsWith('oxglow-electronics-') ? 'normalizeOxglowElectronicsRow'
    : file.startsWith('oxglow-real-estate-') ? 'normalizeOxglowRealestateRow'
    : 'normalizeCsvScrapedListingRow';
  assert.ok(app[method](entry), `${file}: public record must survive normalization: ${entry.id||entry.sku}`);
  checked++;
 }
}
console.log(`Listing publication tests passed: ${checked} public feed records; phone, category, gallery, featured modal, legacy imports and cached-feed guards.`);
