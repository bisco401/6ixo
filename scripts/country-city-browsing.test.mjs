import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const elements = new Map();
const element = (id, value = '') => {
    const el = { id, value, tagName: 'INPUT', dataset: {}, classList: { toggle() {} }, setAttribute() {}, removeAttribute() {}, getAttribute() { return null; } };
    elements.set(id, el); return el;
};
for (const id of ['home-search-location','country-filter','city-filter','services-location-filter','services-country-filter','services-city-filter','realestate-location','realestate-country','realestate-city','electronics-location','electronics-country','electronics-city','clothing-search-country','clothing-search-region','clothing-search-city','jobs-location','jobs-country','jobs-city','vehicles-country','vehicles-city','vehicle-rental-filter-country','vehicle-rental-filter-city','community-country','community-city','other-country','other-city']) element(id);
const context = {
    console, URL, URLSearchParams, setTimeout, clearTimeout,
    window: { localStorage: { getItem: () => null, setItem() {} } }, navigator: {},
    document: { visibilityState: 'visible', getElementById: id => elements.get(id) || null, querySelector: () => null, querySelectorAll: () => [] }
};
vm.runInNewContext(source.slice(0, source.indexOf('// Initialize the app when the page loads')) + '\nglobalThis.App = DatingApp;', context);
const app = Object.assign(Object.create(context.App.prototype), {
    strictDeviceLocation: true, hasBrowserGeolocation: true, currentUser: { location: {} },
    cityLocationMaxAccuracyMeters: 1000, servicesFeedFilters: {}, companionshipFilters: {},
    serviceProfiles: [], marketplaceItems: [], vehicleListings: [], realestateListings: [], communityPosts: [],
    syncMarketplaceSmartFilters() {}, applyMarketplaceFilters() {},
    applyHomeFilters() {}, renderHomePersonalizedRows() {}, renderHomeTodayDeals() {},
    renderServicesFeed() {}, updateServicesCityOptions() {}, renderRealestateFeed() {},
    applyElectronicsFilters() {}, applyClothingFilters() {}, applyJobsFilters() {},
    filterCommunityPosts() {}, applyDatingLocationFeed() {},
    syncOtherFilterUi() {}, syncGeoSearchInputs() {}, syncGeoFilterControls() {}, filterDiscoveryPosts() {},
    updateNearbyList() {}, updateMapMarkers() {},
    persistVehicleState() {}, updateVehiclesUrl() {}, syncVehicleLocationShortcutUi() {},
    syncCompanionshipMiniLocationFromFilters() {},
    populateHomeCityDropdown() {},
    populateCountryCitySelect(el, country, { active = '' } = {}) { el.value = active; }
});
const visit = (city, country, lat = 43.6532, lng = -79.3832) => {
    app.manualDiscoveryLocation = null;
    app.userLocation = { lat, lng, accuracy: 20, timestamp: Date.now() };
    app.currentUser.location = { city, country, lat, lng };
    app.resolvedDeviceLocation = { city, country, key: app.normalizeLocationKey(lat, lng) };
    app.applyResolvedLocationDefaults({ forceBrowserLocation: true });
};
const rows = [
    { id: 'toronto', city: 'Toronto', country: 'Canada' },
    { id: 'vancouver', city: 'Vancouver', country: 'Canada' },
    { id: 'foreign', city: 'Toronto', country: 'United States' }
].map(row => ({ ...row, category: 'electronics', title: 'Camera', price: 100, postedDate: new Date() }));
const ids = list => Array.from(list, row => row.id).sort();
const national = ['toronto','vancouver'];
for (const city of ['Toronto','Ottawa']) {
    visit(city, 'Canada');
    assert.equal(elements.get('home-search-location').value, `${city}, Canada`);
    const selected = app.getHomeSearchLocationSelection();
    const scope = app.getHomeListingLocationScope({ text: selected.text, interpretedCity: selected.city, interpretedCountry: selected.country });
    assert.deepEqual(ids(rows.filter(row => app.matchesListingLocationScope(row, scope))), national);
    assert.equal(app.marketplaceQuickFilters.nearMe, false);
    assert.equal(elements.get('country-filter').value, 'Canada');
    assert.equal(elements.get('city-filter').value, '');
    assert.equal(app.communityFilters.nearMe, false);
    assert.equal(app.otherFilters.city, '');
    assert.equal(app.vehicleFilters.city, '');
    assert.equal(app.vehicleFilters.country, 'canada');
    for (const key of ['electronicsFilters','clothingFilters','jobsFilters','communityFilters']) {
        assert.equal(app[key].city, '', `${key} must not reapply the device city`);
        assert.equal(app[key].country, 'Canada');
    }
    assert.equal(app.servicesFeedFilters.citySelect, 'all');
    assert.equal(elements.get('realestate-location').value, 'Canada');
    app.marketplaceItems = rows;
    assert.deepEqual(ids(app.getFilteredElectronicsItems().items), national);
    app.serviceProfiles = rows;
    assert.deepEqual(ids(app.getFilteredServiceProfiles()), national);
    assert.equal(app.matchesOtherLocation(rows[1]), true);
    assert.equal(app.getMarketplaceNearMeTarget().city, city.toLowerCase(), 'Explicit Near me must retain the real device city');
    assert.equal(app.getHomeNearMeTarget().city, city.toLowerCase());
}
const explicit = app.getHomeListingLocationScope({ interpretedCity: 'Toronto', interpretedCountry: 'Canada', explicitSearchLocation: true });
assert.deepEqual(ids(rows.filter(row => app.matchesListingLocationScope(row, explicit))), ['toronto']);
app.electronicsFilters.city = 'Vancouver';
assert.deepEqual(ids(app.getFilteredElectronicsItems().items), ['vancouver']);
visit('Toronto', 'United States');
assert.deepEqual(ids(rows.filter(row => app.matchesListingLocationScope(row, app.getDefaultListingCountryScope()))), ['foreign']);
app.manualDiscoveryLocation = { city: 'Vancouver', country: 'Canada' };
assert.deepEqual(ids(rows.filter(row => app.matchesListingLocationScope(row, app.getDeviceListingLocationScope()))), ['vancouver']);
console.log('Country browsing passed: actual default initialization, city movement, country changes, category feeds, manual cities and Near me targets.');
