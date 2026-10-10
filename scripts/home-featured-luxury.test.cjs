'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('app.js', 'utf8');
const container = { querySelectorAll: () => [] };
const surface = { hidden: false, querySelector: () => container };
const context = { console, URL, URLSearchParams, window: { location: { origin: 'https://6ixo.com' } },
    document: { getElementById: id => id === 'home-featured-ads-strip' ? surface : null,
        querySelector: () => null, createElement: () => ({ innerHTML: '', get value() { return this.innerHTML; } }) } };
vm.runInNewContext(source.slice(0, source.indexOf('// Initialize the app when the page loads'))
    + '\nglobalThis.App = DatingApp;', context);
const app = Object.assign(Object.create(context.App.prototype), {
    getHomeSearchLocationSelection: () => ({ city: 'Toronto', country: 'Canada' }),
    getCurrentLocationDefaultParts: () => ({}), insertFeaturedAdCard() {},
    marketplaceItems: [], vehicleListings: [], realestateListings: [],
    scrapedListingIntegrityRepairs: {}, scrapedListingAvailability: {}
});
function listing(id, title, category, changes = {}) {
    return { id, sourceRowId: id, title, category, condition: 'good', city: 'Toronto', country: 'Canada',
        price: 1500, phone: '4165550101', images: ['https://example.com/photo.jpg'],
        description: 'Excellent condition. Photos show the available item. Contact the seller for details.',
        source: { type: 'scraped_csv', url: 'https://example.com/listings/' + id }, ...changes };
}
const approved = [
    listing('car', '2022 Porsche Cayenne', 'vehicles'),
    listing('iphone', 'Apple iPhone 16 Pro Max 256GB', 'electronics', { subcategory: 'phones_accessories' }),
    listing('galaxy', 'Samsung Galaxy S24 Ultra', 'electronics'),
    listing('macbook', 'MacBook Pro M3 16 inch', 'electronics'),
    listing('ipad', 'iPad Pro M4', 'electronics'),
    listing('villa', 'Luxury waterfront villa for sale', 'real_estate'),
    listing('condo', 'Two-bedroom condo for rent', 'real_estate')
];
for (const item of approved) assert.ok(app.buildScrapedHomeFeaturedListing(item), item.title);
const rejected = [
    listing('equipment', '2018 Skyjack SJ4626 Scissor Lift', 'vehicles'),
    listing('parts', 'BMW X5 engine 3.0', 'auto_parts'),
    listing('radio', 'BMW X5 Radio DVD Android touch screen player', 'vehicles'),
    listing('wheel', 'Mercedes-Benz alloy wheels', 'vehicles'),
    listing('oldcar', 'BMW E34 1991', 'vehicles'),
    listing('barebrand', 'Mercedes Benz', 'vehicles'),
    listing('budget', '2019 Toyota Corolla', 'vehicles'),
    listing('copy', 'iPhone 17 Pro Max copy', 'electronics'),
    listing('room-selfcontained', 'FULLY FURNISHED ROOM SELF CONTAINED APARTMENT TO LET', 'real_estate'),
    listing('phonecase', 'iPhone 16 Pro Max case', 'electronics'),
    listing('cable', 'Cable for iPhone 16', 'electronics'),
    listing('oldphone', 'iPhone 6s', 'electronics'),
    listing('damaged', 'iPhone 16 Pro Max cracked screen', 'electronics', { condition: 'damaged' }),
    listing('locked', 'iPhone 16 Pro Max', 'electronics', { description: 'iCloud locked' }),
    listing('battery', 'iPhone 16 Pro Max', 'electronics', { description: 'battery at service' }),
    listing('ordinary', 'HP Probook 440', 'electronics'),
    listing('room', 'Single room in luxury apartment', 'real_estate'),
    listing('land', 'Plot of land for sale', 'real_estate'),
    listing('services', 'Luxury home cleaning', 'services'),
    listing('sold', '2022 Porsche Cayenne', 'vehicles', { sold: true }),
    listing('gone', '2022 Porsche Cayenne', 'vehicles', { sourceAvailability: 'gone' }),
    listing('placeholder', 'iPhone 16 Pro Max', 'electronics', { images: ['ad-placeholder.png'] }),
    listing('user', 'iPhone 16 Pro Max', 'electronics', { source: null, sourceTable: 'marketplace_listings' })
];
for (const item of rejected) assert.equal(app.buildScrapedHomeFeaturedListing(item), null, item.title);
const alias = { ...approved[0], id: 'car-backup', sourceRowId: 'car-backup',
    source: { ...approved[0].source, url: approved[0].source.url.replace('https:', 'http:') + '?utm_source=backup' } };
let selected = app.syncScrapedHomeFeaturedAds([...approved, alias, ...rejected]);
assert.equal(selected.length, approved.length, 'Limited premium inventory must not be padded with ordinary ads');
assert.equal(new Set(selected.flatMap(item => app.getHomeFeaturedListingIdentityKeys(item))).size,
    selected.flatMap(item => app.getHomeFeaturedListingIdentityKeys(item)).length, 'No source aliases repeat');
assert.equal(selected.filter(item => item.title === approved[0].title).length, 1);
assert.ok(app.isScrapedHomeFeaturedListing(alias), 'Suppress aliases in recommendations');
const cars = Array.from({ length: 15 }, (_, i) => listing('car-' + i, '2023 BMW X5 ' + i, 'vehicles'));
selected = app.syncScrapedHomeFeaturedAds([...cars, approved[1], approved[5]]);
assert.equal(selected.length, 10);
assert.equal(new Set(selected.slice(0, 3).map(item => item.homeFeaturedGroup)).size, 3,
    'Cars, premium electronics and properties share the first rotation');
const foreign = { ...approved[1], id: 'foreign', sourceRowId: 'foreign', country: 'Ghana', city: 'Accra' };
selected = app.syncScrapedHomeFeaturedAds([foreign, approved[6]]);
assert.equal(selected[0].id, 'condo', 'Local eligible properties precede premium foreign phones');
app.marketplaceItems = [approved[1]];
app.vehicleListings = [approved[0]];
app.realestateListings = [{ ...approved[5], category: undefined }];
selected = app.syncScrapedHomeFeaturedAds([]);
assert.equal(selected.length, 3, 'Supplemental scraped feeds participate even when their loaders finish later');
assert.equal(new Set(selected.map(item => item.homeFeaturedGroup)).size, 3);
app.marketplaceItems = app.vehicleListings = app.realestateListings = [];
assert.equal(app.syncScrapedHomeFeaturedAds(rejected).length, 0);
assert.equal(surface.hidden, true, 'Hide an empty strip instead of featuring ineligible listings');
console.log('Luxury Featured passed: whole premium items, defects and accessory exclusions, category variety, local priority, deduplication, async feeds and limited inventory.');
