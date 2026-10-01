'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('app.js', 'utf8');
const container = { querySelectorAll: () => [] };
const surface = { hidden: false, querySelector: () => container };
const controls = {
    'home-search-what': { value: '' },
    'home-search-location': { value: 'Kenya' },
    'home-search-category': { value: '' }
};
const document = {
    getElementById: (id) => id === 'home-featured-ads-strip' ? surface : controls[id],
    querySelector: () => null,
    createElement: () => ({ innerHTML: '', get value() { return this.innerHTML; } })
};
const context = { console, document, URL, URLSearchParams, window: { location: { origin: 'https://6ixo.com' } } };
vm.runInNewContext(source.slice(0, source.indexOf('// Initialize the app when the page loads'))
    + '\nglobalThis.App = DatingApp;', context);
const scope = { active: true, city: '', country: 'kenya' };
const app = Object.assign(Object.create(context.App.prototype), {
    scrapedListingIntegrityRepairs: JSON.parse(fs.readFileSync('data/listing-integrity-repairs.json')).listings,
    scrapedListingAvailability: JSON.parse(fs.readFileSync('data/listing-availability.json')).listings,
    strictDeviceLocation: false,
    getHomeSearchLocationSelection: () => ({ country: 'Kenya' }),
    getCurrentLocationDefaultParts: () => ({}),
    syncHomeLocationHidden: () => ({ text: 'Kenya', country: 'Kenya', city: '' }),
    getHomeListingLocationScope: () => scope,
    getCurrentListingLocationPriorityScope: () => scope,
    interpretHomeSearchQuery: (term) => ({ term, priceMin: null, priceMax: null }),
    syncHomeCategoryNav() {},
    syncHomeSmartFilters() {},
    insertFeaturedAdCard() {},
    renderHomeListings() {},
    fetchHomeLivePlaceResults: async () => [],
    marketplaceItems: [], vehicleListings: [], realestateListings: [], serviceProfiles: []
});

const rows = ['data/scraped-listings.csv', 'data/kenya-listings.csv']
    .flatMap(file => app.parseCsvRows(fs.readFileSync(file, 'utf8')))
    .filter(row => row.status === 'published' && row.country === 'Kenya');
const entries = rows.map(row => app.normalizeCsvScrapedListingRow(row)).filter(Boolean);
assert.ok(entries.length >= 10, 'Exercise the overlapping production Kenya feeds');
const first = entries.find(entry => entry.item.category === 'electronics');
const alias = { item: { ...first.item, id: 'backup-id', sourceRowId: 'backup-kenya-id',
    source: { ...first.item.source, url: first.item.source.url.replace('https:', 'http:') + '?feed=backup' } } };
const inventory = [first, alias, ...entries];

let selected = app.syncScrapedHomeFeaturedAds(inventory);
assert.equal(selected.length, 10, 'Fill the carousel with ten distinct ads');
assert.equal(new Set(selected.map(item => app.getImportedListingIdentityKeys(item)[0])).size, 10,
    'Different feed IDs, tracking queries and schemes cannot repeat a source ad');
assert.equal(selected.filter(item => item.title === first.item.title).length, 1);
assert.ok(app.isScrapedHomeFeaturedListing(alias.item), 'Recognize a differently named backup copy');
assert.ok(selected.every(item => item.country === 'Kenya'), 'Keep the local inventory priority');
assert.ok(selected.every(item => item.images.length && item.phone), 'Keep photos and phone contacts');

app.marketplaceItems = inventory.map(entry => entry.item).filter(item => item.category === 'electronics');
async function run() {
    await app.applyHomeFilters();
    assert.ok(app.homeFilteredItems.length, 'The ordinary feed still shows other electronics');
    assert.ok(app.homeFilteredItems.every(entry => !app.isScrapedHomeFeaturedListing(entry.raw)),
        'Default Kenya browsing cannot repeat Featured ads in the main feed');

    controls['home-search-what'].value = 'HP Probook 440';
    await app.applyHomeFilters();
    assert.ok(app.homeFilteredItems.some(entry => entry.raw.sourceRowId === first.item.sourceRowId),
        'A targeted search still finds a featured listing');
    controls['home-search-what'].value = '';
    controls['home-search-category'].value = 'electronics';
    await app.applyHomeFilters();
    assert.ok(app.homeFilteredItems.some(entry => entry.raw.sourceRowId === first.item.sourceRowId),
        'Category searches retain every matching listing');

    selected = app.syncScrapedHomeFeaturedAds(inventory);
    assert.equal(selected.length, 10, 'Refreshing the same feeds does not add duplicates');
    surface.hidden = true;
    const results = [{ type: 'marketplace', id: first.item.id, raw: first.item }];
    assert.equal(app.dedupeHomeSearchResults(results, { excludeFeatured: true }).length, 1,
        'A hidden Featured section cannot hide an ad from the main feed');
    app.syncScrapedHomeFeaturedAds([]);
    assert.equal(app.isScrapedHomeFeaturedListing(first.item), false,
        'An empty refresh clears the previous featured identities');
    console.log('Kenya Featured passed: production feed overlap, source aliases, ten unique cards, refreshes, main feed exclusion and targeted searches.');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
