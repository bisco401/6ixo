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
let backupCalls = 0;
let backupResponse = async () => { throw new Error('Unexpected backup request'); };
const google = { maps: { Geocoder: class {
  geocode(request, callback) { geocodeCalls++; geocodeResponse(request, callback); }
} } };
const window = {
  google,
  setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
  clearTimeout(id) { timers.delete(id); }
};
const context = { window, document, google, navigator: { geolocation: { clearWatch() {} } }, console, URL, URLSearchParams, AbortController,
  fetch: async (url, options) => { backupCalls++; return backupResponse(url, options); }
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

// All provider responses below are mocked. Do not send synthetic or stored
// coordinates to the free client-only BigDataCloud endpoint.
const backupData = { latitude: 43.4675, longitude: -79.6877, lookupSource: 'coordinates', city: 'Oakville', countryName: 'Canada', principalSubdivision: 'Ontario' };
const deniedGoogle = (_, callback) => callback([], 'REQUEST_DENIED');
const goodGoogle = (_, callback) => callback([{ address_components: [component('locality', 'Oakville'), component('country', 'Canada')] }], 'OK');
function providerApp(consent = 'allowed') {
  const instance = app();
  delete instance.reverseGeocodeLatLng;
  instance.locationBackupConsent = consent;
  instance.hasBrowserGeolocation = true;
  instance.userLocation = { lat: 43.4675, lng: -79.6877, accuracy: 20, timestamp: Date.now() };
  instance.lastDeviceLocationSampleAt = Date.now();
  backupCalls = 0;
  geocodeCalls = 0;
  backupResponse = async (url, options) => {
    const request = new URL(url);
    assert.equal(request.origin, 'https://api-bdc.net');
    assert.equal(request.searchParams.get('latitude'), '43.4675');
    assert.equal(request.searchParams.get('longitude'), '-79.6877');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store');
    return { ok: true, json: async () => ({ ...backupData }) };
  };
  return instance;
}

const primary = providerApp();
geocodeResponse = goodGoogle;
await primary.applyEntryLocationDefaults();
assert.equal(input.value, 'Oakville, Canada');
assert.equal(input.dataset.locationProvider, 'google');
assert.equal(backupCalls, 0, 'Google success must not contact BigDataCloud');

for (const googleFailure of ['REQUEST_DENIED', 'OVER_QUERY_LIMIT', 'ZERO_RESULTS', 'ERROR']) {
  const fallback = providerApp();
  geocodeResponse = (_, cb) => cb([], googleFailure);
  await fallback.applyEntryLocationDefaults();
  assert.equal(input.value, 'Oakville, Canada');
  assert.equal(input.dataset.locationProvider, 'bigdatacloud');
  assert.equal(backupCalls, 1);
  assert.ok(fallback.locationProviderRefreshTimer, 'The primary must be rechecked after using the backup');
}

const partial = providerApp();
geocodeResponse = (_, cb) => cb([{ address_components: [component('country', 'Canada')] }], 'OK');
await partial.applyEntryLocationDefaults();
assert.equal(input.value, 'Oakville, Canada', 'A country-only primary response must use the backup');
assert.equal(backupCalls, 1);

const coalesced = providerApp();
geocodeResponse = deniedGoogle;
await Promise.all([coalesced.reverseGeocodeLatLng(43.4675, -79.6877), coalesced.reverseGeocodeLatLng(43.4675, -79.6877)]);
assert.equal(geocodeCalls, 1);
assert.equal(backupCalls, 1);

const timedPrimary = providerApp();
geocodeResponse = () => {};
const timedLookup = timedPrimary.applyEntryLocationDefaults();
timers.get([...timers.keys()].find(id => timers.get(id).delay === 8000)).fn();
await timedLookup;
assert.equal(input.value, 'Oakville, Canada', 'A hanging primary must not prevent the backup');
assert.equal(timedPrimary.googleGeocodeStatus, 'TIMEOUT');

const recovered = providerApp();
geocodeResponse = deniedGoogle;
await recovered.applyEntryLocationDefaults();
const cachedBackup = recovered.reverseGeocodeCache.values().next().value;
cachedBackup.resolvedAt = Date.now() - 62000;
recovered.googleGeocodeRetryAt = 0;
geocodeResponse = goodGoogle;
timers.get(recovered.locationProviderRefreshTimer).fn();
await new Promise(setImmediate);
assert.equal(input.dataset.locationProvider, 'google', 'A stationary user must return to Google when it recovers');
assert.equal(backupCalls, 1);

for (const state of ['denied', 'unknown']) {
  const noConsent = providerApp(state);
  geocodeResponse = deniedGoogle;
  await noConsent.applyEntryLocationDefaults();
  assert.equal(backupCalls, 0, 'Never contact the backup without consent');
}

for (const change of [
  instance => { instance.locationPermissionState = 'denied'; },
  instance => { instance.hasBrowserGeolocation = false; },
  instance => { instance.lastDeviceLocationSampleAt = Date.now() - 130000; },
  instance => { instance.userLocation.lat = 0; },
  () => { document.visibilityState = 'hidden'; }
]) {
  const nonCurrent = providerApp();
  change(nonCurrent);
  assert.equal(await nonCurrent.reverseGeocodeWithBackup(43.4675, -79.6877), null);
  assert.equal(backupCalls, 0, 'Never send revoked, stale, hidden-page or other-coordinate requests');
  document.visibilityState = 'visible';
}

for (const invalid of [
  { ...backupData, lookupSource: 'ipGeolocation' },
  { ...backupData, latitude: 0 },
  { ...backupData, latitude: null },
  { ...backupData, city: '', locality: '' },
  { ...backupData, countryName: '' }
]) {
  const invalidBackup = providerApp();
  backupResponse = async () => ({ ok: true, json: async () => invalid });
  assert.equal(await invalidBackup.reverseGeocodeWithBackup(43.4675, -79.6877), null);
}

const localityFallback = providerApp();
backupResponse = async () => ({ ok: true, json: async () => ({ ...backupData, city: '', locality: 'Oakville' }) });
assert.equal((await localityFallback.reverseGeocodeWithBackup(43.4675, -79.6877)).city, 'Oakville');

const expiredRequest = providerApp();
let finishBackup;
backupResponse = (_, options) => new Promise((resolve, reject) => {
  finishBackup = resolve;
  options.signal.addEventListener('abort', () => reject(new Error('Aborted')));
});
const pendingBackup = expiredRequest.reverseGeocodeWithBackup(43.4675, -79.6877);
expiredRequest.setLocationBackupConsent(false);
assert.equal(await pendingBackup, null, 'Withdrawal must abort an in-flight backup request');
finishBackup({ ok: true, json: async () => backupData });

const withdrawn = providerApp();
geocodeResponse = deniedGoogle;
await withdrawn.applyEntryLocationDefaults();
withdrawn.setLocationBackupConsent(false);
assert.equal(withdrawn.reverseGeocodeCache.size, 0);
assert.equal(withdrawn.getCurrentLocationDisplayText(), '');
assert.equal(input.value, '');

const timedBackup = providerApp();
backupResponse = (_, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('Timeout'))));
const timedBackupResult = timedBackup.reverseGeocodeWithBackup(43.4675, -79.6877);
timers.get([...timers.keys()].find(id => timers.get(id).delay === 8000)).fn();
assert.equal(await timedBackupResult, null);

const limited = providerApp();
backupResponse = async () => ({ ok: false, status: 429 });
await limited.reverseGeocodeWithBackup(43.4675, -79.6877);
await limited.reverseGeocodeWithBackup(43.4675, -79.6877);
assert.equal(backupCalls, 1, 'Do not hammer a rate-limited backup');

// Consent dialog is coalesced and contacts no provider until the visitor opts in.
const actualGetElement = document.getElementById;
const allowButton = {}, declineButton = {};
const dialog = { opens: 0, showModal() { this.opens++; }, close() {} };
document.getElementById = id => ({ 'location-backup-consent': dialog, 'location-backup-allow': allowButton, 'location-backup-decline': declineButton }[id] || actualGetElement(id));
const prompted = providerApp('unknown');
geocodeResponse = deniedGoogle;
const promptLookup = prompted.applyEntryLocationDefaults();
await new Promise(setImmediate);
assert.equal(dialog.opens, 1);
assert.equal(backupCalls, 0);
allowButton.onclick();
await promptLookup;
assert.equal(backupCalls, 1);
assert.equal(input.value, 'Oakville, Canada');
const review = prompted.requestLocationBackupConsent({ review: true });
declineButton.onclick();
assert.equal(await review, false);
assert.equal(prompted.getLocationBackupConsent(), 'denied');
document.getElementById = actualGetElement;

console.log('Google-primary/BigDataCloud-backup tests passed: consent, failover, recovery, timeouts, privacy guards, cancellation and rate limits.');
