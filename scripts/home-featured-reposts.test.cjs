'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('app.js', 'utf8');
let cards = [];
const container = {
    querySelectorAll: selector => selector === '.featured-ad-card' ? cards : [],
    appendChild(card) { cards = cards.filter(entry => entry !== card); cards.push(card); }
};
const surface = { hidden: false, querySelector: () => container };
const context = { console, URL, URLSearchParams, window: { location: { origin: 'https://6ixo.com' } },
    document: { getElementById: id => id === 'home-featured-ads-strip' ? surface : null,
        querySelector: () => null, createElement: () => ({ innerHTML: '', get value() { return this.innerHTML; } }) } };
vm.runInNewContext(source.slice(0, source.indexOf('// Initialize the app when the page loads'))
    + '\nglobalThis.App = DatingApp;', context);
const app = Object.assign(Object.create(context.App.prototype), {
    scrapedListingIntegrityRepairs: JSON.parse(fs.readFileSync('data/listing-integrity-repairs.json')).listings,
    scrapedListingAvailability: {},
    getHomeSearchLocationSelection: () => ({ city: 'Hamilton', country: 'Canada' }),
    getCurrentLocationDefaultParts: () => ({}),
    insertFeaturedAdCard() {}
});
// Captured from the actual Kijiji feed on 2026-10-08 so future scrapes cannot erase the regression.
const equipment = JSON.parse(fs.readFileSync('scripts/fixtures/home-featured-equipment-reposts.json', 'utf8'));
const lifts2018 = equipment.filter(entry => /2018 Skyjack/i.test(entry.item.title));
assert.ok(lifts2018.length >= 2, 'Use actual separately posted copies of the 2018 lift from the screenshot');
const fillers = app.parseCsvRows(fs.readFileSync('data/kenya-listings.csv', 'utf8'))
    .map(row => app.normalizeCsvScrapedListingRow(row)).filter(Boolean);
let selected = app.syncScrapedHomeFeaturedAds([...lifts2018, ...fillers]);
assert.equal(selected.filter(item => /2018 Skyjack/i.test(item.title)).length, 1,
    'Different titles, photo URLs and source IDs cannot feature the same 268-hour lift twice');
assert.equal(selected.length, 10, 'Fill freed slots with distinct eligible inventory');
assert.ok(lifts2018.every(entry => app.isScrapedHomeFeaturedListing(entry.item)),
    'Every repost of the featured lift is excluded from default browsing and recommendations');
assert.equal(app.syncScrapedHomeFeaturedAds([...lifts2018, ...fillers]).length, 10,
    'Refreshing inventory keeps ten distinct ads');

selected = app.syncScrapedHomeFeaturedAds(equipment);
assert.equal(selected.length, 3,
    'Keep the 2018/268-hour lift and both distinct 2012 lifts with 267 and 304 hours');
const original = lifts2018[0].item;
const separate = (changes) => ({ item: { ...original, id: 'distinct', sourceRowId: 'csv-distinct',
    title: 'Different machine', source: { ...original.source, url: 'https://www.kijiji.ca/v-machinery/distinct/999' },
    ...changes } });
const description = original.fullDescription || original.description;
for (const changes of [
    { fullDescription: description.replace(/268/g, '269') },
    { fullDescription: description.replace(/2018/g, '2019') },
    { fullDescription: description.replace(/SJ\s*(?:III\s*)?4626/gi, 'SJ4632') },
    { phone: '416-555-0199' },
    { city: 'Ottawa' },
    { fullDescription: description + '\nSerial number: UNIT-002' },
]) {
    assert.equal(app.syncScrapedHomeFeaturedAds([lifts2018[0], separate(changes)]).length, 2,
        'Different identifying specs, seller or location must remain separate');
}

function paidCard(dataset) {
    const card = { dataset, hidden: false, classList: { contains: () => false },
        remove() { cards = cards.filter(entry => entry !== card); } };
    cards.push(card);
    return card;
}
const attrs = app.buildFeaturedAdDataAttrs({ ...original, placement: 'home_featured' }, {}, {});
paidCard({ ...attrs, postItemId: String(original.id), promoted: '1' });
paidCard({ ...attrs, postItemId: String(original.id), promoted: '1' });
selected = app.syncScrapedHomeFeaturedAds([...lifts2018, ...fillers]);
assert.equal(cards.length, 1, 'A repeated paid card uses only one featured slot');
assert.equal(selected.length, 9, 'One paid ad leaves room for nine unique fillers');
assert.ok(selected.every(item => !/2018 Skyjack/i.test(item.title)),
    'A paid ad suppresses imported reposts with different source IDs');
assert.ok(app.isScrapedHomeFeaturedListing(lifts2018[1].item),
    'Recommendations cannot repeat a differently named copy of a paid featured ad');
cards = [];
app.syncScrapedHomeFeaturedAds([]);
assert.equal(app.isScrapedHomeFeaturedListing(original), false, 'Empty refresh clears old identities');
console.log('Home Featured reposts passed: real Skyjack reposts, distinct machines, ten unique slots, refreshes and paid overlap.');
