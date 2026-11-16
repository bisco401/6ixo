import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const elements = new Map();
const context = {
    console, URL, URLSearchParams,
    window: { localStorage: { getItem: () => null, setItem() {} } },
    document: { getElementById: id => elements.get(id) || null, querySelectorAll: () => [], querySelector: () => null }
};
vm.runInNewContext(`${source.slice(0, source.indexOf('// Initialize the app when the page loads'))}\nglobalThis.App = DatingApp;`, context);
const geo = { 'Toronto|Canada': { lat: 43.6532, lng: -79.3832 }, 'Mississauga|Canada': { lat: 43.589, lng: -79.6441 }, 'Brampton|Canada': { lat: 43.7315, lng: -79.7624 }, 'Hamilton|Canada': { lat: 43.2557, lng: -79.8711 } };
const ids = items => Array.from(items, item => item.id);
const item = (id, city, extra = {}) => ({ id, title: 'Camera', city, country: 'Canada', category: 'electronics', price: 100, postedDate: new Date('2026-11-15'), ...extra });
function fixture() {
    elements.clear();
    elements.set('home-search-what', { value: 'camera' });
    elements.set('home-search-location', { value: 'Toronto, Canada', dataset: {} });
    const app = Object.assign(Object.create(context.App.prototype), {
        companionshipCityGeo: geo, marketplaceItems: [], vehicleListings: [], realestateListings: [], serviceProfiles: [], discoveryPosts: [], communityPosts: [],
        homeQuickFilters: {}, homeCategoryFilters: {},
        syncHomeCategoryNav() {}, syncHomeSmartFilters() {}, renderHomeListings() {},
        getCurrentListingLocationPriorityScope: () => ({ active: true, city: 'Toronto', country: 'Canada' }),
        syncHomeLocationHidden: () => ({ text: 'Toronto, Canada', city: 'Toronto', country: 'Canada' }),
        getHomeListingLocationScope: () => ({ active: true, city: 'Toronto', country: 'Canada' }),
        interpretHomeSearchQuery: term => ({ term, priceMin: null, priceMax: null }),
        fetchHomeLivePlaceResults: async () => [],
        getHomeNearMeTarget: () => ({ city: 'Toronto', country: 'Canada', ...geo['Toronto|Canada'] })
    });
    return app;
}
const options = { enabled: true, scope: { active: true, city: 'Toronto', country: 'Canada' }, target: { city: 'Toronto', country: 'Canada' } };

test('Local matches prevent expansion; empty local searches expand only to the first matching radius', () => {
    const app = fixture();
    let result = app.selectHomeNearbyResults([item('near', 'Mississauga'), item('local', 'Toronto')], options);
    assert.deepEqual(ids(result.items), ['local']);
    assert.equal(result.expanded, false);
    for (const [city, radiusKm] of [['Mississauga', 25], ['Brampton', 50], ['Hamilton', 100]]) {
        result = app.selectHomeNearbyResults([item('match', city)], options);
        assert.equal(result.radiusKm, radiusKm);
        assert.deepEqual(ids(result.items), ['match']);
        assert.match(result.message, new RegExp(`within ${radiusKm} km`));
    }
    result = app.selectHomeNearbyResults([item('outer', 'Unknown town', { lat: 44.9, lng: -79.3832 })], options);
    assert.equal(result.radiusKm, 200);
    assert.deepEqual(ids(result.items), ['outer']);
    result = app.selectHomeNearbyResults([item('distant', 'Far away', { lat: 49, lng: -123 })], options);
    assert.deepEqual(ids(result.items), []);
    assert.match(result.message, /within 200 km/);
});

test('Search relevance precedes distance; related accessories cannot block nearby actual items', () => {
    const app = fixture();
    const results = app.selectHomeNearbyResults([
        item('accessory', 'Toronto', { searchRelated: true, _queryScore: 40 }),
        item('broad', 'Mississauga', { _queryScore: 110 }),
        item('exact', 'Mississauga', { _queryScore: 140, lat: 43.5, lng: -79.5 })
    ], options);
    assert.deepEqual(ids(results.items), ['exact', 'broad', 'accessory']);
    assert.equal(results.expanded, true);
});

test('Country boundaries, missing coordinates, aliases and inaccurate device locations are respected', () => {
    const app = fixture();
    assert.deepEqual(ids(app.selectHomeNearbyResults([item('foreign', 'Toronto', { country: 'United States' }), item('alias', 'Toronto / Surrounding', { country: 'CA' })], options).items), ['alias']);
    const unknown = { ...options, target: { city: 'Unknown city', country: 'Canada', lat: null, lng: null } };
    let result = app.selectHomeNearbyResults([item('local', 'Unknown city'), item('near', 'Toronto')], unknown);
    assert.deepEqual(ids(result.items), ['local']);
    assert.equal(result.expanded, false);
    app.hasBrowserGeolocation = true;
    app.isDeviceLocationCityAccurate = () => false;
    result = app.selectHomeNearbyResults([item('one', 'Toronto'), item('two', 'Hamilton')], { enabled: true, useDeviceTarget: true, scope: { active: true, country: 'Canada' }, target: { country: 'Canada', ...geo['Toronto|Canada'] } });
    assert.equal(result.active, false);
    assert.equal(result.items.length, 2);
});

test('Home applies price and category filters before nearby expansion and retries the original city', async () => {
    const app = fixture();
    elements.set('home-filter-price-max', { value: '200' });
    app.marketplaceItems = [item('expensive', 'Toronto', { price: 300 }), item('near', 'Mississauga')];
    await app.applyHomeFilters();
    assert.deepEqual(ids(app.homeFilteredItems), ['near']);
    assert.equal(app.homeSearchContext.searchArea.radiusKm, 25);
    app.marketplaceItems.push(item('local', 'Toronto'));
    await app.applyHomeFilters();
    assert.deepEqual(ids(app.homeFilteredItems), ['local']);
    assert.equal(app.homeSearchContext.searchArea.expanded, false);
    assert.equal(elements.get('home-search-location').value, 'Toronto, Canada');
    assert.equal(app.homeFilterCandidates.length, 3, 'Preview retains candidates outside the original city.');
});

test('Explicit country and worldwide searches stay broad; device-default searches start locally', async () => {
    const app = fixture();
    app.marketplaceItems = [item('local', 'Toronto'), item('near', 'Hamilton')];
    app.syncHomeLocationHidden = () => ({ text: 'Canada', country: 'Canada' });
    app.getHomeListingLocationScope = () => ({ active: true, country: 'Canada' });
    await app.applyHomeFilters();
    assert.equal(app.homeFilteredItems.length, 2);
    assert.equal(app.homeSearchContext.searchArea.active, false);
    elements.get('home-search-location').dataset.autoLocationDefault = '1';
    await app.applyHomeFilters();
    assert.deepEqual(ids(app.homeFilteredItems), ['local']);
    elements.get('home-search-location').dataset = {};
    elements.get('home-search-location').value = '';
    app.browseWorldwideSelected = true;
    app.syncHomeLocationHidden = () => ({ text: '' });
    app.getHomeListingLocationScope = () => ({ active: false });
    await app.applyHomeFilters();
    assert.equal(app.homeFilteredItems.length, 2);
    assert.equal(app.homeSearchContext.searchArea.active, false);
});

test('Changing a query resets pagination while rerunning the same search preserves it', async () => {
    const app = fixture();
    app.marketplaceItems = [item('local', 'Toronto')];
    await app.applyHomeFilters();
    app.homePagination.page = 2;
    app.homePagination.expanded = true;
    await app.applyHomeFilters();
    assert.equal(app.homePagination.page, 2);
    assert.equal(app.homePagination.expanded, true);
    elements.get('home-search-what').value = 'phone';
    await app.applyHomeFilters();
    assert.equal(app.homePagination.page, 1);
    assert.equal(app.homePagination.expanded, false);
});

test('Rendering keeps relevance order across categories and labels related results separately', () => {
    const app = fixture();
    const grid = { innerHTML: '', querySelectorAll: () => [] };
    elements.set('home-listings-grid', grid);
    Object.assign(app, {
        homeSearchContext: { rawQuery: 'camera', groupedResults: true },
        bindImageCarousels() {}, bindFeaturedAdCardLightbox() {}, renderHomePagination() {}
    });
    const entries = [
        { ...item('best', 'Toronto'), type: 'marketplace', raw: { category: 'electronics' } },
        { ...item('less-relevant-car', 'Toronto'), type: 'vehicle' },
        { ...item('accessory', 'Toronto'), type: 'marketplace', searchRelated: true }
    ];
    context.App.prototype.renderHomeListings.call(app, entries, { hasFilters: true });
    assert.ok(grid.innerHTML.indexOf('data-id="best"') < grid.innerHTML.indexOf('data-id="less-relevant-car"'));
    assert.match(grid.innerHTML, /data-home-results-group="matches"/);
    assert.match(grid.innerHTML, /Related mentions &amp; accessories/);
    assert.ok(grid.innerHTML.indexOf('data-id="less-relevant-car"') < grid.innerHTML.indexOf('data-id="accessory"'));
});

test('Opening a Home search listing records it without moving results by rebuilding the recent row', () => {
    const app = fixture();
    app.activeScreen = 'home';
    app.homeSearchContext = { rawQuery: 'camera' };
    app.marketplaceItems = [item('local', 'Toronto')];
    let recent, opened, renders = 0;
    app.recordMarketplaceRecent = id => { recent = id; };
    app.renderHomePersonalizedRows = () => { renders++; };
    app.openMarketplaceItemModal = entry => { opened = entry.id; };
    app.openHomeListing('marketplace', 'local');
    assert.equal(opened, 'local');
    assert.equal(recent, 'local');
    assert.equal(renders, 0);
    app.homeSearchContext.rawQuery = '';
    app.openHomeListing('marketplace', 'local');
    assert.equal(renders, 1, 'General browsing still updates the recent row.');
});

test('Near me without any usable location never falls back to worldwide listings', async () => {
    const app = fixture();
    app.homeQuickFilters = { nearMe: true };
    app.getHomeNearMeTarget = () => ({ lat: null, lng: null });
    app.getHomeListingLocationScope = () => ({ active: false });
    app.syncHomeLocationHidden = () => ({ text: '' });
    elements.get('home-search-location').value = '';
    app.marketplaceItems = [item('somewhere', 'Toronto')];
    await app.applyHomeFilters();
    assert.deepEqual(ids(app.homeFilteredItems), []);
});

test('Explicit price/rating intent keeps its ordering when relevance ties', () => {
    const app = fixture();
    const result = app.selectHomeNearbyResults([
        item('cheap', 'Mississauga', { _queryScore: 140, lat: 43.5, lng: -79.5 }),
        item('expensive', 'Mississauga', { _queryScore: 140 })
    ], { ...options, sortByDistance: false });
    assert.deepEqual(ids(result.items), ['cheap', 'expensive']);
});
