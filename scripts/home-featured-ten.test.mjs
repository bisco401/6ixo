import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const container = { querySelectorAll: () => [] };
const surface = { querySelector: () => container, hidden: false };
let cards = [];
const document = {
    getElementById: () => surface,
    querySelectorAll: () => cards
};
const context = { document, console };
vm.runInNewContext(source.slice(0, source.indexOf('// Initialize the app when the page loads'))
    + '\nglobalThis.App = DatingApp;', context);
const app = Object.assign(Object.create(context.App.prototype), {
    strictDeviceLocation: true,
    getHomeSearchLocationSelection: () => ({}),
    getCurrentLocationDefaultParts: () => ({}),
    getCurrentLocationDisplayText: () => 'Stoney Creek, Canada',
    getDefaultListingCountryScope: () => ({ active: true, city: 'stoney creek', country: 'canada', source: 'device' }),
    buildScrapedHomeFeaturedListing: (item) => item.invalid ? null : item,
    insertFeaturedAdCard() {}
});
const listing = (id, city = 'Toronto', country = 'Canada') => ({ id, city, country });
const local = listing('local', 'Stoney Creek');
const sameCountry = Array.from({ length: 12 }, (_, i) => listing(`canada-${i}`));
const worldwide = Array.from({ length: 12 }, (_, i) => listing(`world-${i}`, 'Elsewhere', `Country ${i}`));

let selected = app.syncScrapedHomeFeaturedAds([...worldwide, local, local]);
assert.equal(selected.length, 10, 'One local result must still produce ten Featured ads');
assert.equal(selected[0].id, 'local', 'Local ads must come first');
assert.equal(new Set(selected.map(item => item.id)).size, 10, 'Do not repeat ads to fill slots');
selected = app.syncScrapedHomeFeaturedAds([...sameCountry, local]);
assert.equal(selected.length, 10, 'Country variety must not prevent filling all ten slots');
assert.equal(selected[0].id, 'local');
assert.equal(app.syncScrapedHomeFeaturedAds(worldwide).length, 10, 'No local results still allows Featured');
assert.equal(app.syncScrapedHomeFeaturedAds([local, listing('invalid'), { invalid: true }]).length, 2);
assert.equal(app.syncScrapedHomeFeaturedAds([]).length, 0);
assert.equal(surface.hidden, true);

const card = (isHome, location) => ({
    dataset: { adLocation: location }, excluded: true,
    closest: selector => isHome && selector === '#home-featured-ads-strip' ? surface : null,
    classList: { toggle(_name, excluded) { this.owner.excluded = excluded; } }
});
cards = [card(true, 'Nairobi, Kenya'), card(false, 'Nairobi, Kenya'), card(false, 'Stoney Creek, Canada')];
cards.forEach(item => { item.classList.owner = item; });
app.getDeviceListingLocationScope = app.getDefaultListingCountryScope;
app.filterFeaturedCardsForDeviceLocation();
assert.deepEqual(cards.map(item => item.excluded), [false, true, false], 'Only Home Featured bypasses the city filter');
console.log('Home Featured passed: ten unique ads, local priority, country fallback, limited inventory, and section-scoped filtering.');
