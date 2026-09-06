import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const timers = new Map();
let timerId = 0;
const value = { textContent: '' };
const accuracy = { textContent: '' };
const input = { value: '', dataset: {} };
const status = { textContent: '', classList: { toggle() {} } };
const wrap = {
  classList: { toggle() {} },
  querySelector(selector) { return selector.endsWith('value]') ? value : accuracy; }
};
const document = {
  visibilityState: 'visible',
  getElementById(id) {
    return { 'home-current-location': wrap, 'home-search-location': input, 'market-location-status': status }[id] || null;
  },
  querySelector() { return null; }
};
let geocodeResponse;
let geocodeCalls = 0;
const google = { maps: { Geocoder: class {
  geocode(request, callback) { geocodeCalls++; geocodeResponse(request, callback); }
} } };
const window = {
  google,
  setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
  clearTimeout(id) { timers.delete(id); }
};
const context = { window, document, google, navigator: { geolocation: { clearWatch() {} } }, console, URL, URLSearchParams };
vm.runInNewContext(`${source.slice(0, source.indexOf('// Initialize the app when the page loads'))}\nglobalThis.App = DatingApp;`, context);

const oakville = { city: 'Oakville', region: 'Ontario', country: 'Canada' };
const nairobi = { city: 'Nairobi', region: 'Nairobi County', country: 'Kenya' };
const position = (latitude = 43.4675, longitude = -79.6877, accuracy = 20) => ({ coords: { latitude, longitude, accuracy }, timestamp: Date.now() });
function app() {
  timers.clear();
  input.value = '';
  input.dataset = {};
  const instance = Object.create(context.App.prototype);
  Object.assign(instance, {
    cityLocationMaxAccuracyMeters: 1000,
    userLocation: null,
    hasBrowserGeolocation: false,
    currentUser: { location: { city: 'Saved city', country: 'Canada' } },
    currentUserLocationSource: 'profile',
    deviceLocationStatus: 'Detecting...',
    googleListingLocationScope: {},
    googleApiKey: 'test-key',
    reverseGeocodeCache: new Map(), reverseGeocodeInFlight: new Map(),
    servicesFeedFilters: {}, companionshipFilters: {},
    marketplaceQuickFilters: { nearMe: true, locationScope: 'near_me' },
    updateUserDistances() {}, scheduleLocationAwareResultsRefresh() {}, scheduleLocationFreshnessCheck() {},
    startLocationTracking() {}, showNotification() {}, populateHomeCityDropdown() {},
    getHomeSearchLocationSelection() { return { text: input.value }; },
    isHomeLocationClearedByUser() { return false; },
    applyHomeFilters() {}, renderServicesFeed() {}, filterCommunityPosts() {}, applyDatingLocationFeed() {},
    applyVisitorLocalFeedDefaults() {}, syncCompanionshipMiniLocationFromFilters() {}, applyActiveScreenLocationDefaults() {},
    reverseGeocodeLatLng: async () => oakville
  });
  return instance;
}

const saved = app();
saved.updateHomeCurrentLocationDisplay();
assert.equal(saved.getCurrentLocationDisplayText(), '');
assert.equal(value.textContent, 'Detecting...');
assert.equal(saved.getCurrentLocationDefaultParts().country, '');

for (const metres of [20, 1500, 25000]) {
  const live = app();
  live.applyPreciseBrowserLocation(position(43.4675, -79.6877, metres));
  await live.locationDefaultsPromise;
  assert.equal(live.getCurrentLocationDisplayText(), 'Oakville, Canada');
  assert.equal(value.textContent, 'Oakville, Canada');
  assert.equal(input.value, 'Oakville, Canada', 'Real home search defaults must include both city and country');
  assert.equal(accuracy.textContent, metres > 1000 ? '(Approximate)' : '');
  assert.match(status.textContent, /Oakville, Canada/);
}

const failed = app();
failed.reverseGeocodeLatLng = async () => null;
failed.inferLocationFromCoords = () => { throw new Error('Catalog guesses must never be used for live labels'); };
failed.applyPreciseBrowserLocation(position());
await failed.locationDefaultsPromise;
assert.equal(failed.getCurrentLocationDisplayText(), '');
assert.equal(value.textContent, 'City unavailable — retrying');
assert.equal(input.value, '');
assert.ok(failed.locationLabelRetryTimer);
failed.reverseGeocodeLatLng = async () => oakville;
const retry = timers.get(failed.locationLabelRetryTimer);
assert.equal(retry.delay, 2000);
retry.fn();
await new Promise(setImmediate);
assert.equal(failed.getCurrentLocationDisplayText(), 'Oakville, Canada', 'Stationary users recover without another GPS movement');

const moving = app();
moving.applyPreciseBrowserLocation(position(43.46751, -79.68769));
await moving.locationDefaultsPromise;
moving.applyPreciseBrowserLocation(position(43.46751, -79.68701));
await moving.locationDefaultsPromise;
assert.equal(input.value, 'Oakville, Canada', 'An accepted movement under 100m must not erase the city');
moving.reverseGeocodeLatLng = async () => nairobi;
moving.applyPreciseBrowserLocation(position(-1.2921, 36.8219, 1500));
await moving.locationDefaultsPromise;
assert.equal(value.textContent, 'Nairobi, Kenya', 'A weaker reading after real travel must not freeze the old city');

const racing = app();
let finishOld;
racing.reverseGeocodeLatLng = () => new Promise(resolve => { finishOld = resolve; });
racing.applyPreciseBrowserLocation(position());
const oldRequest = racing.locationDefaultsPromise;
racing.reverseGeocodeLatLng = async () => nairobi;
racing.applyPreciseBrowserLocation(position(-1.2921, 36.8219));
await racing.locationDefaultsPromise;
finishOld(oakville); await oldRequest;
assert.equal(value.textContent, 'Nairobi, Kenya');

const revoked = app();
let finishRevoked;
revoked.reverseGeocodeLatLng = () => new Promise(resolve => { finishRevoked = resolve; });
revoked.applyPreciseBrowserLocation(position());
const revokedRequest = revoked.locationDefaultsPromise;
revoked.handleLocationError({ code: 1 });
finishRevoked(oakville); await revokedRequest;
assert.equal(revoked.getCurrentLocationDisplayText(), '');
assert.equal(value.textContent, 'Location blocked');
assert.equal(revoked.googleListingLocationScope.enabled, false);

const manual = app();
input.value = 'Paris, France'; input.dataset.autoLocationDefault = '0';
manual.applyPreciseBrowserLocation(position());
await manual.locationDefaultsPromise;
assert.equal(input.value, 'Paris, France');
assert.equal(value.textContent, 'Oakville, Canada', 'Manual search area stays separate from live location');

const lookup = app();
delete lookup.reverseGeocodeLatLng;
const component = (type, long_name) => ({ types: [type], long_name });
geocodeResponse = (_, cb) => cb([{ address_components: [component('country', 'Canada')] }], 'OK');
await lookup.reverseGeocodeLatLng(43.4675, -79.6877);
assert.equal(lookup.reverseGeocodeCache.size, 0, 'Country-only responses must remain retryable');
geocodeResponse = (_, cb) => cb([{ address_components: [component('locality', 'Oakville'), component('country', 'Canada')] }], 'OK');
const cityResult = await lookup.reverseGeocodeLatLng(43.4675, -79.6877);
assert.equal(cityResult.city, 'Oakville');
assert.equal(lookup.reverseGeocodeCache.size, 1);
assert.equal(geocodeCalls, 2);
await lookup.reverseGeocodeLatLng(43.4675, -79.6877);
assert.equal(geocodeCalls, 2, 'Successful same-area results should be cached');

console.log('Live city/country label tests passed: precise/approximate, real UI defaults, retries, travel, races, revocation and manual search.');
