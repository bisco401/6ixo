import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
assert.ok(!html.includes('id="home-current-location"'), 'Live location must not appear outside the search toolbar');
assert.match(html, /id="home-search-location"[^>]*placeholder="City, Country"/);
const timers = new Map();
let timerId = 0;
const input = { value: '', dataset: {} };
const status = { textContent: '', classList: { toggle() {} } };
const document = {
  visibilityState: 'visible',
  getElementById(id) {
    return { 'home-search-location': input, 'market-location-status': status }[id] || null;
  },
  querySelector() { return null; }
};
let geocodeResponse;
let geocodeCalls = 0;
let externalFetchCalls = 0;
const google = { maps: { Geocoder: class {
  geocode(request, callback) { geocodeCalls++; geocodeResponse(request, callback); }
} } };
const window = {
  google,
  setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
  clearTimeout(id) { timers.delete(id); }
};
const context = { window, document, google, navigator: { geolocation: { clearWatch() {} } }, console, URL, URLSearchParams,
  fetch: async () => { externalFetchCalls++; throw new Error('Unexpected non-Google network request'); }
};
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
assert.equal(input.placeholder, 'Detecting...');
assert.equal(input.value, '');
assert.equal(saved.getCurrentLocationDefaultParts().country, '');

for (const metres of [20, 1500, 25000]) {
  const live = app();
  live.applyPreciseBrowserLocation(position(43.4675, -79.6877, metres));
  await live.locationDefaultsPromise;
  assert.equal(live.getCurrentLocationDisplayText(), 'Oakville, Canada');
  assert.equal(input.value, 'Oakville, Canada', 'Real home search defaults must include both city and country');
  assert.equal(input.dataset.locationAccuracy, metres > 1000 ? 'approximate' : 'precise');
  assert.equal(input.placeholder, 'City, Country');
  assert.match(status.textContent, /Oakville, Canada/);
}

const failed = app();
failed.reverseGeocodeLatLng = async () => null;
failed.inferLocationFromCoords = () => { throw new Error('Catalog guesses must never be used for live labels'); };
failed.applyPreciseBrowserLocation(position());
await failed.locationDefaultsPromise;
assert.equal(failed.getCurrentLocationDisplayText(), '');
assert.equal(input.placeholder, 'City unavailable — retrying');
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
assert.equal(input.value, 'Nairobi, Kenya', 'A weaker reading after real travel must not freeze the old city');

const racing = app();
let finishOld;
racing.reverseGeocodeLatLng = () => new Promise(resolve => { finishOld = resolve; });
racing.applyPreciseBrowserLocation(position());
const oldRequest = racing.locationDefaultsPromise;
racing.reverseGeocodeLatLng = async () => nairobi;
racing.applyPreciseBrowserLocation(position(-1.2921, 36.8219));
await racing.locationDefaultsPromise;
finishOld(oakville); await oldRequest;
assert.equal(input.value, 'Nairobi, Kenya');

const revoked = app();
let finishRevoked;
revoked.reverseGeocodeLatLng = () => new Promise(resolve => { finishRevoked = resolve; });
revoked.applyPreciseBrowserLocation(position());
const revokedRequest = revoked.locationDefaultsPromise;
revoked.handleLocationError({ code: 1 });
finishRevoked(oakville); await revokedRequest;
assert.equal(revoked.getCurrentLocationDisplayText(), '');
assert.equal(input.placeholder, 'Location blocked');
assert.equal(input.value, '');
assert.equal(revoked.googleListingLocationScope.enabled, false);

const manual = app();
input.value = 'Paris, France'; input.dataset.autoLocationDefault = '0';
manual.applyPreciseBrowserLocation(position());
await manual.locationDefaultsPromise;
assert.equal(input.value, 'Paris, France');
assert.equal(manual.getCurrentLocationDisplayText(), 'Oakville, Canada', 'Manual search must not change the device coordinates');
assert.equal(input.title, 'Search a city and country.');
assert.equal(input.dataset.locationAccuracy, undefined);

const initialWatchWinner = app();
initialWatchWinner.didApplyEntryLocationDefaults = false;
input.value = 'Old city, Old country'; input.dataset.autoLocationDefault = '0';
let firstEntryReset = false;
initialWatchWinner.resetScreenLocationsForBrowserRefresh = ({ city, country, label }) => {
  firstEntryReset = true;
  initialWatchWinner.setHomeLocationControls({ city, country, text: label, auto: true });
};
initialWatchWinner.applyVehicleGeoLocationDefaults = () => {};
initialWatchWinner.applyPreciseBrowserLocation(position(), { forceBrowserLocation: false });
await initialWatchWinner.locationDefaultsPromise;
assert.equal(firstEntryReset, true, 'The initial watch winner must align restored home filters, even without the original force flag');
assert.equal(input.value, 'Oakville, Canada');
assert.equal(initialWatchWinner.didApplyEntryLocationDefaults, true);

const suspendedLabel = app();
let finishSuspended;
suspendedLabel.reverseGeocodeLatLng = () => new Promise(resolve => { finishSuspended = resolve; });
suspendedLabel.applyPreciseBrowserLocation(position());
const suspendedLookup = suspendedLabel.locationDefaultsPromise;
document.visibilityState = 'hidden'; suspendedLabel.stopLocationTracking();
document.visibilityState = 'visible';
finishSuspended(oakville); await suspendedLookup;
assert.equal(suspendedLabel.getCurrentLocationDisplayText(), '', 'A lookup from the previous foreground session cannot restore an old label');

const refreshingFix = app();
let finishWhileRefreshing;
refreshingFix.reverseGeocodeLatLng = () => new Promise(resolve => { finishWhileRefreshing = resolve; });
refreshingFix.applyPreciseBrowserLocation(position());
const refreshingLookup = refreshingFix.locationDefaultsPromise;
refreshingFix.locationRequestGeneration = 1;
finishWhileRefreshing(oakville); await refreshingLookup;
assert.equal(input.value, 'Oakville, Canada', 'Starting another GPS request must not discard the current coordinate’s valid city lookup');

const internationalHome = app();
delete internationalHome.getHomeSearchLocationSelection;
internationalHome.reverseGeocodeLatLng = async () => nairobi;
internationalHome.applyPreciseBrowserLocation(position(-1.2865, 36.8218));
await internationalHome.locationDefaultsPromise;
internationalHome.parseHomeLocationText = () => { throw new Error('A resolved live label must not depend on the local country catalog'); };
const internationalSelection = internationalHome.getHomeSearchLocationSelection();
assert.equal(internationalSelection.city, 'Nairobi');
assert.equal(internationalSelection.country, 'Kenya');
const internationalScope = internationalHome.getHomeListingLocationScope({
  text: internationalSelection.text,
  interpretedCity: internationalSelection.city,
  interpretedCountry: internationalSelection.country
});
assert.equal(internationalScope.city, 'nairobi');
assert.equal(internationalScope.country, 'kenya', 'Home results must retain the actual country, not just the displayed city');

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

// Google responses are mocked; no real device coordinates or external calls.
const goodGoogle = (_, callback) => callback([{ address_components: [component('locality', 'Oakville'), component('country', 'Canada')] }], 'OK');
function googleApp() {
  const instance = app();
  delete instance.reverseGeocodeLatLng;
  instance.hasBrowserGeolocation = true;
  instance.userLocation = { lat: 43.4675, lng: -79.6877, accuracy: 20, timestamp: Date.now() };
  instance.lastDeviceLocationSampleAt = Date.now();
  geocodeCalls = 0;
  return instance;
}

assert.doesNotMatch(source, /api-bdc\.net|bigdatacloud|reverseGeocodeWithBackup|requestLocationBackupConsent/i);
assert.doesNotMatch(html, /bigdatacloud|location-backup-consent|location-backup-settings/i);
assert.match(html, /Google is the only live city-lookup provider/);

const primary = googleApp();
geocodeResponse = goodGoogle;
await primary.applyEntryLocationDefaults();
assert.equal(input.value, 'Oakville, Canada');
assert.equal(input.dataset.locationProvider, 'google');
assert.equal(primary.reverseGeocodeCache.size, 1);
await primary.applyEntryLocationDefaults();
assert.equal(geocodeCalls, 1, 'A successful same-area lookup stays cached');

for (const failure of ['REQUEST_DENIED', 'OVER_QUERY_LIMIT', 'ZERO_RESULTS', 'ERROR']) {
  const googleFailure = googleApp();
  geocodeResponse = (_, callback) => callback([], failure);
  await googleFailure.applyEntryLocationDefaults();
  assert.equal(input.value, '', 'A failed Google lookup must not substitute a saved or guessed city');
  assert.equal(input.placeholder, 'City unavailable — retrying');
  assert.equal(googleFailure.reverseGeocodeCache.size, 0);
  assert.ok(googleFailure.locationLabelRetryTimer);
  if (['REQUEST_DENIED', 'OVER_QUERY_LIMIT'].includes(failure)) {
    await googleFailure.applyEntryLocationDefaults();
    assert.equal(geocodeCalls, 1, 'Denied or rate-limited requests must honor the cooldown');
  }
  googleFailure.googleGeocodeRetryAt = 0;
  geocodeResponse = goodGoogle;
  timers.get(googleFailure.locationLabelRetryTimer).fn();
  await new Promise(setImmediate);
  assert.equal(input.value, 'Oakville, Canada', 'Stationary users recover when Google becomes available');
  assert.equal(input.dataset.locationProvider, 'google');
}

const partial = googleApp();
geocodeResponse = (_, callback) => callback([{ address_components: [component('country', 'Canada')] }], 'OK');
await partial.applyEntryLocationDefaults();
assert.equal(input.value, '');
assert.equal(partial.reverseGeocodeCache.size, 0, 'A country-only result is not a complete city lookup');
assert.ok(partial.locationLabelRetryTimer);

const oldCache = googleApp();
oldCache.reverseGeocodeCache.set(oldCache.normalizeLocationKey(43.4675, -79.6877), {
  city: 'Stale backup city', country: 'Canada', source: 'bigdatacloud', resolvedAt: Date.now()
});
geocodeResponse = goodGoogle;
await oldCache.applyEntryLocationDefaults();
assert.equal(geocodeCalls, 1, 'Only Google results are valid cache entries');
assert.equal(input.value, 'Oakville, Canada');
assert.equal(input.dataset.locationProvider, 'google');

const coalesced = googleApp();
geocodeResponse = goodGoogle;
await Promise.all([coalesced.reverseGeocodeLatLng(43.4675, -79.6877), coalesced.reverseGeocodeLatLng(43.4675, -79.6877)]);
assert.equal(geocodeCalls, 1, 'Concurrent lookups share one Google request');

const timedPrimary = googleApp();
let lateCallback;
geocodeResponse = (_, callback) => { lateCallback = callback; };
const timedLookup = timedPrimary.applyEntryLocationDefaults();
timers.get([...timers.keys()].find(id => timers.get(id).delay === 8000)).fn();
await timedLookup;
assert.equal(input.value, '');
assert.equal(timedPrimary.googleGeocodeStatus, 'TIMEOUT');
assert.ok(timedPrimary.locationLabelRetryTimer);
assert.ok(timedPrimary.googleGeocodeRetryAt - Date.now() <= 2000, 'A transient failure must not cause a minute-long initial cooldown');
goodGoogle(null, lateCallback);
await new Promise(setImmediate);
assert.equal(timedPrimary.reverseGeocodeCache.size, 0, 'A late timed-out response must not populate the cache');

const missingKey = googleApp();
missingKey.googleApiKey = '';
await missingKey.applyEntryLocationDefaults();
assert.equal(geocodeCalls, 0);
assert.equal(input.value, '');
assert.ok(missingKey.locationLabelRetryTimer);

const savedGoogle = window.google;
window.google = undefined;
const loadFailure = googleApp();
loadFailure.loadGoogleMaps = async () => { throw new Error('Script unavailable'); };
await loadFailure.applyEntryLocationDefaults();
assert.equal(loadFailure.googleGeocodeStatus, 'LOAD_ERROR');
assert.equal(input.value, '');
const hangingLoad = googleApp();
hangingLoad.loadGoogleMaps = () => new Promise(() => {});
const hangingLookup = hangingLoad.applyEntryLocationDefaults();
timers.get([...timers.keys()].find(id => timers.get(id).delay === 20000)).fn();
await hangingLookup;
assert.equal(hangingLoad.googleGeocodeStatus, 'TIMEOUT');
assert.equal(input.value, '');
window.google = savedGoogle;

window.google = undefined;
const slowSdk = googleApp();
let finishSdkLoad;
slowSdk.loadGoogleMaps = () => new Promise(resolve => { finishSdkLoad = resolve; });
const slowLookup = slowSdk.applyEntryLocationDefaults();
assert.ok([...timers.values()].some(timer => timer.delay === 20000), 'Cold Google loading needs its own bounded startup allowance');
assert.ok(![...timers.values()].some(timer => timer.delay === 8000), 'The geocoding-only deadline must not prematurely cancel the SDK');
window.google = savedGoogle;
geocodeResponse = goodGoogle;
finishSdkLoad(); await slowLookup;
assert.equal(input.value, 'Oakville, Canada');
assert.equal(slowSdk.googleGeocodeRetryAt, 0);

// Old backup consent is discarded, without deleting other browser preferences.
const preferences = new Map([['sixo_location_backup_consent_v1', 'allowed'], ['unrelated-preference', 'keep']]);
window.localStorage = { removeItem(key) { preferences.delete(key); } };
window.addEventListener = () => {};
document.addEventListener = () => {};
const cleanup = googleApp();
cleanup.setupLiveLocationLifecycle();
assert.equal(preferences.has('sixo_location_backup_consent_v1'), false);
assert.equal(preferences.get('unrelated-preference'), 'keep');
delete window.localStorage;
assert.equal(externalFetchCalls, 0, 'Google-only lookups must never fetch a backup API');

console.log('Google-only location tests passed: no backup, cache isolation, failures, cooldown, stationary recovery, timeouts and obsolete consent cleanup.');
