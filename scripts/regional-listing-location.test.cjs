const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const code = fs.readFileSync('app.js', 'utf8');
const context = { console, Date, Map, Set, URL, URLSearchParams, window: { location: { href: 'https://6ixo.com/' } }, navigator: {} };
vm.runInNewContext(code.slice(0, code.indexOf('// Initialize the app when the page loads')) + '\nglobalThis.App = DatingApp;', context);
const app = Object.create(context.App.prototype);
app.scrapedListingIntegrityRepairs = {};
app.scrapedListingAvailability = {};
const base = { id: 'regional-car', status: 'published', title: '2022 Kia Sorento', source_url: 'https://example.com/car',
  source_site: 'Dealer', app_category: 'vehicles', app_subcategory: 'vehicles', target_surface: 'vehicles',
  phone: '+17708005000', image_urls: 'https://example.com/car.jpg', country: 'United States' };
for (const [city, region] of [['Brooklyn', 'New York'], ['Largo', 'Florida'], ['Sugar Land', 'Texas'], ['Peachtree Corners', 'Georgia']]) {
  const item = app.normalizeCsvScrapedListingRow({ ...base, city, attributes: JSON.stringify({ region }) }).item;
  assert.equal(item.region, region);
  assert.ok(app.matchesListingLocationScope(item, { active: true, region, country: 'United States' }));
  assert.equal(app.matchesListingLocationScope(item, { active: true, region: 'Ontario', country: 'Canada' }), false);
}
const atlanta = app.normalizeCsvScrapedListingRow({ ...base, city: 'Peachtree Corners', attributes: JSON.stringify({ region: 'Georgia', searchMetro: 'Atlanta' }) }).item;
const dealer = app.normalizeCsvScrapedListingRow({ ...base, city: 'Peachtree Corners', seller: 'Atlanta Best Used Cars', source_site: 'Atlanta Best Used Cars',
  attributes: JSON.stringify({ region: 'Georgia', sourceKind: 'dealer' }) }).item;
assert.equal(dealer.seller, 'Atlanta Best Used Cars');
assert.equal(app.getImportedListingSellerName(dealer), 'Atlanta Best Used Cars', 'The direct dealer is the seller, even when it hosts the inventory');
assert.equal(app.isImportedMarketplaceSellerName({ source: { kind: 'dealer', site: 'Kijiji' } }, 'Kijiji'), true, 'Known marketplaces are never seller identities');
assert.equal(atlanta.city, 'Peachtree Corners', 'Keep the real town');
assert.ok(app.matchesListingLocationScope(atlanta, { active: true, city: 'Atlanta', country: 'United States', source: 'manual' }));
const crossPost = app.normalizeCsvScrapedListingRow({ ...base, city: 'Fort Lauderdale', attributes: JSON.stringify({ region: 'Florida', metro: 'Atlanta / Metro', sourceRegion: 'Atlanta / Metro' }) }).item;
assert.equal(crossPost.metro, '', 'An advertising/search area is not a verified physical metro');
assert.equal(app.matchesListingLocationScope(crossPost, { active: true, city: 'Atlanta', country: 'United States' }), false);
app.strictDeviceLocation = true;
app.getCurrentLocationDisplayText = () => 'Atlanta, United States';
assert.equal(app.matchesListingLocationScope(atlanta, { active: true, city: 'atlanta', country: 'united states', source: 'device' }), false, 'Device-city filtering remains exact');
console.log('Regional listing locations: state matching, verified metro search, cross-posts and device scope passed.');
