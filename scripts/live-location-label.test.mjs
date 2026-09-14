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
const deviceStatus = { textContent: '' };
const status = { textContent: '', classList: { toggle() {} } };
const document = {
  visibilityState: 'visible',
  getElementById(id) {
    return { 'home-search-location': input, 'market-location-status': status, 'home-device-location-status': deviceStatus }[id] || null;
  },
  querySelector() { return null; }
};
const window = {
  setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
  clearTimeout(id) { timers.delete(id); }
};
const context = { window, document, navigator: { geolocation: { clearWatch() {} } }, console, URL, URLSearchParams,
  fetch: async () => { throw new Error('Unexpected network request in lifecycle test'); }
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
assert.equal(input.placeholder, 'City, Country');
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
assert.equal(input.placeholder, 'City, Country');
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
assert.equal(input.placeholder, 'City, Country');
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

manual.handleLocationError({ code: 1 });
assert.equal(input.value, 'Paris, France', 'Denied GPS must preserve a manually entered search city');
assert.equal(input.placeholder, 'City, Country');
assert.equal(input.dataset.locationAccuracy, undefined);

const unavailable = app();
unavailable.handleLocationError({ code: 2 });
assert.equal(input.placeholder, 'City, Country', 'Unavailable GPS must leave city search usable');
assert.equal(input.value, '');

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

const freshness = app();
const acceptedAt = Date.now() - 45000;
freshness.applyPreciseBrowserLocation({ ...position(), timestamp: acceptedAt });
await freshness.locationDefaultsPromise;
freshness.applyPreciseBrowserLocation(position(43.4675, -79.6777, 10000));
assert.equal(freshness.lastDeviceLocationSampleAt, acceptedAt, 'Rejecting a weak update must not renew an older precise fix');
assert.equal(freshness.userLocation.accuracy, 20);
freshness.userLocation.timestamp = Date.now() - 61000;
freshness.lastDeviceLocationSampleAt = freshness.userLocation.timestamp;
assert.equal(freshness.applyPreciseBrowserLocation(position(43.4675, -79.6777, 10000)), true, 'A fresh device fix must eventually replace an old precise fix');
await freshness.locationDefaultsPromise;
assert.equal(input.dataset.locationAccuracy, 'approximate');

let heartbeatRequests = 0;
freshness.requestLocationPermission = () => { heartbeatRequests++; return Promise.resolve(false); };
context.App.prototype.scheduleLocationFreshnessCheck.call(freshness);
const heartbeat = timers.get(freshness.locationFreshnessTimer);
assert.equal(heartbeat.delay, 30000, 'The active page must check location freshness every 30 seconds');
const heartbeatId = freshness.locationFreshnessTimer;
context.App.prototype.scheduleLocationFreshnessCheck.call(freshness);
assert.equal(freshness.locationFreshnessTimer, heartbeatId, 'Watch callbacks must not postpone the heartbeat');
freshness.userLocation.timestamp = Date.now() - 90001;
freshness.lastDeviceLocationSampleAt = freshness.userLocation.timestamp;
heartbeat.fn();
assert.equal(heartbeatRequests, 1);
assert.equal(freshness.hasBrowserGeolocation, false);
assert.equal(input.value, '', 'The heartbeat must clear expired automatic city text');
assert.equal(freshness.currentUser.location.city, '', 'An expired device city must not survive as a profile fallback');
assert.equal(freshness.currentUser.location.lat, null);

const invalidTime = app();
assert.equal(invalidTime.isValidBrowserLocationSample({ ...position(), timestamp: Date.now() + 60000 }), false);
assert.equal(invalidTime.isValidBrowserLocationSample({ ...position(), timestamp: Date.now() - 90001 }), false);

console.log('Freshness tests passed: rejected samples do not renew old fixes, stale precision expires, and visible pages refresh every 30 seconds.');

const latePermission = app();
let finishPermissionQuery;
context.navigator.permissions = { query: () => new Promise(resolve => { finishPermissionQuery = resolve; }) };
const oldPermissionQuery = latePermission.refreshLocationPermissionState();
latePermission.applyPreciseBrowserLocation(position());
await latePermission.locationDefaultsPromise;
finishPermissionQuery({ state: 'denied' });
await oldPermissionQuery;
assert.equal(latePermission.locationPermissionState, 'granted', 'An older permission query cannot revoke a newer successful device callback');
assert.equal(input.value, 'Oakville, Canada');
delete context.navigator.permissions;

// The device label must stay visible independently of the editable search field.
const visible = app();
visible.applyPreciseBrowserLocation(position());
await visible.locationDefaultsPromise;
assert.equal(deviceStatus.textContent, 'Device location: Oakville, Canada');
input.value = 'Paris, France'; input.dataset.autoLocationDefault = '0';
visible.updateHomeCurrentLocationDisplay();
assert.equal(deviceStatus.textContent, 'Device location: Oakville, Canada');
let finishTravelLookup;
visible.reverseGeocodeLatLng = () => new Promise(resolve => { finishTravelLookup = resolve; });
visible.applyPreciseBrowserLocation(position(-1.2921, 36.8219));
const travelLookup = visible.locationDefaultsPromise;
assert.match(deviceStatus.textContent, /Last confirmed: Oakville, Canada.*Updating location/);
assert.equal(visible.getCurrentLocationDisplayText(), '', 'Last-confirmed text cannot become a current location or filter');
finishTravelLookup(null); await travelLookup;
assert.match(deviceStatus.textContent, /Last confirmed: Oakville, Canada/);
visible.reverseGeocodeLatLng = async () => nairobi;
await visible.applyEntryLocationDefaults();
assert.equal(deviceStatus.textContent, 'Device location: Nairobi, Kenya');
assert.equal(input.value, 'Paris, France', 'Live updates preserve a manual search area');
visible.lastDeviceLocationSampleAt = Date.now() - 90001;
visible.handleLocationError({ code: 2 });
assert.match(deviceStatus.textContent, /Last confirmed: Nairobi, Kenya.*Updating location/);
assert.equal(visible.hasUsableCurrentLocation(), false);
visible.handleLocationError({ code: 1 });
assert.match(deviceStatus.textContent, /Location access is off/);
assert.doesNotMatch(deviceStatus.textContent, /Nairobi|Oakville/);
assert.equal(visible.lastConfirmedDeviceLocation, null);
const neverLocated = app();
neverLocated.updateHomeCurrentLocationDisplay();
assert.ok(deviceStatus.textContent);
neverLocated.handleLocationError({ code: 2 });
assert.match(deviceStatus.textContent, /unavailable.*retrying/);
neverLocated.reverseGeocodeLatLng = async () => null;
neverLocated.applyPreciseBrowserLocation(position());
await neverLocated.locationDefaultsPromise;
assert.match(deviceStatus.textContent, /Device location detected.*Choose an area/);
assert.match(html, /id="home-device-location-status"[^>]*role="status"/);
console.log('Always-visible device status passed: manual search, travel, lookup failure, expired GPS, recovery and revocation.');
