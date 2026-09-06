import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const pending = [];
const watches = [];
const cleared = [];
const timers = new Map();
const windowEvents = new Map();
const documentEvents = new Map();
let now = Date.now();
let timerId = 0;
const window = {
  setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id; },
  clearTimeout(id) { timers.delete(id); },
  addEventListener(type, fn) { windowEvents.set(type, fn); }
};
const document = {
  visibilityState: 'visible',
  addEventListener(type, fn) { documentEvents.set(type, fn); },
  getElementById() { return null; }, querySelector() { return null; }
};
const getCurrentPosition = (success, error, options) => pending.push({ success, error, options });
const navigator = { geolocation: {
  getCurrentPosition,
  watchPosition(success, error, options) { watches.push({ success, error, options }); return watches.length; },
  clearWatch(id) { cleared.push(id); }
} };
class ClockDate extends Date { static now() { return now; } }
const context = { window, document, navigator, console, Date: ClockDate, URL, URLSearchParams };
vm.runInNewContext(`${source.slice(0, source.indexOf('// Initialize the app when the page loads'))}\nglobalThis.App = DatingApp;`, context);
const position = (lat = 43.6534, lng = -79.3841, accuracy = 20) => ({ coords: { latitude: lat, longitude: lng, accuracy }, timestamp: now });
const flush = () => new Promise(setImmediate);
function advance(ms) {
  const target = now + ms;
  for (;;) {
    const next = [...timers].filter(([, task]) => task.at <= target).sort((a,b) => a[1].at - b[1].at)[0];
    if (!next) break;
    now = next[1].at; timers.delete(next[0]); next[1].fn();
  }
  now = target;
}
function app() {
  pending.length = 0; watches.length = 0; cleared.length = 0; timers.clear();
  document.visibilityState = 'visible';
  delete navigator.permissions;
  navigator.geolocation.getCurrentPosition = getCurrentPosition;
  const instance = Object.create(context.App.prototype);
  Object.assign(instance, {
    locationRequestInFlight: false, locationRequestPromise: null,
    locationPermissionState: 'granted', hasBrowserGeolocation: false, userLocation: null,
    currentUser: {}, cityLocationMaxAccuracyMeters: 1000,
    samples: [], errors: [], retries: 0,
    handleLocationSuccess(fix, options) {
      this.samples.push({ fix, options }); this.hasBrowserGeolocation = true;
      this.userLocation = { lat: fix.coords.latitude, lng: fix.coords.longitude, accuracy: fix.coords.accuracy };
      return true;
    },
    updateHomeCurrentLocationDisplay() {}, updateMarketplaceLocationControls() {},
    scheduleLocationFreshnessCheck() {},
    scheduleLocationTrackingRetry() { this.retries++; }, showNotification() {}
  });
  return instance;
}

const concurrent = app();
const first = concurrent.requestLocationPermission();
assert.equal(concurrent.requestLocationPermission(), first);
assert.equal(pending.length, 1);
assert.equal(pending[0].options.maximumAge, 0);
pending[0].success(position(0, 0));
assert.equal(await first, true);
assert.equal(concurrent.locationRequestPromise, null);

const synchronous = app();
navigator.geolocation.getCurrentPosition = success => success(position());
assert.equal(await synchronous.requestLocationPermission(), true, 'Synchronous platform callbacks cannot trap the shared promise');
assert.equal(synchronous.locationRequestInFlight, false);

const fallback = app();
const fallbackRequest = fallback.requestLocationPermission();
pending[0].error({ code: 3 });
assert.equal(pending.length, 2);
assert.equal(pending[1].options.enableHighAccuracy, false);
assert.equal(pending[1].options.maximumAge, 0, 'The fallback is another fresh device fix, never a stored location');
pending[0].success(position(48.85837, 2.294481));
assert.equal(fallback.samples.length, 0, 'Retired high-accuracy callbacks cannot win against the fallback');
pending[1].success(position(-1.2865, 36.8218, 2000));
assert.equal(await fallbackRequest, true);
assert.equal(fallback.userLocation.lat, -1.2865);

const hung = app();
const hungRequest = hung.requestLocationPermission();
advance(22000);
assert.equal(pending.length, 2, 'A hung granted request must fall back');
advance(10000);
assert.equal(await hungRequest, false);
assert.equal(hung.locationRequestInFlight, false);
assert.equal(hung.retries, 1, 'Both failed device attempts must enter bounded recovery');

const throwing = app();
navigator.geolocation.getCurrentPosition = () => { throw new Error('Platform unavailable'); };
assert.equal(await throwing.requestLocationPermission(), false);
assert.equal(throwing.locationRequestInFlight, false);
assert.equal(throwing.retries, 1);

const denied = app();
const deniedRequest = denied.requestLocationPermission();
pending[0].error({ code: 1 });
assert.equal(await deniedRequest, false);
assert.equal(pending.length, 1, 'Permission denial must never trigger another device attempt');
assert.equal(denied.locationPermissionState, 'denied');
assert.equal(await denied.requestLocationPermission(), false);
assert.equal(denied.retries, 0);

const backgrounded = app();
const oldRequest = backgrounded.requestLocationPermission();
const retired = pending[0];
document.visibilityState = 'hidden';
backgrounded.stopLocationTracking();
assert.equal(await oldRequest, false);
assert.equal(await backgrounded.requestLocationPermission(), false);
document.visibilityState = 'visible';
const resumed = backgrounded.requestLocationPermission();
retired.success(position(48.85837, 2.294481));
retired.error({ code: 1 });
assert.equal(backgrounded.samples.length, 0);
assert.equal(backgrounded.locationRequestInFlight, true, 'A late old callback cannot clear the new request');
pending[1].success(position());
assert.equal(await resumed, true);

const watcher = app();
watcher.applyPreciseBrowserLocation = fix => watcher.samples.push(fix);
watcher.startLocationTracking(); watcher.startLocationTracking();
assert.equal(watches.length, 1);
const oldWatch = watches[0];
watcher.stopLocationTracking();
watcher.startLocationTracking();
oldWatch.success(position()); oldWatch.error({ code: 1 });
assert.equal(watcher.samples.length, 0);
assert.equal(watcher.locationPermissionState, 'granted');
watches[1].success(position(-1.2865, 36.8218));
assert.equal(watcher.samples.length, 1);
assert.deepEqual(cleared, [1]);

const watchRecovery = app();
const activeFix = watchRecovery.requestLocationPermission();
watchRecovery.startLocationTracking();
const labelTimer = watchRecovery.locationLabelRetryTimer = window.setTimeout(() => {}, 60000);
watches[0].error({ code: 2 });
assert.equal(watchRecovery.locationRequestInFlight, true, 'A transient watch failure must not cancel an independent device request');
assert.equal(watchRecovery.locationLabelRetryTimer, labelTimer, 'A transient watch failure must preserve city-lookup recovery');
assert.equal(watchRecovery.locationLifecycleGeneration, undefined);
pending[0].success(position());
assert.equal(await activeFix, true);

const permissionTimeout = app();
let completeQuery;
navigator.permissions = { query: () => new Promise(resolve => { completeQuery = resolve; }) };
const permissionRequest = permissionTimeout.refreshLocationPermissionState({ requestIfAllowed: true });
advance(1500); await flush();
assert.equal(pending.length, 1, 'A stuck Permissions API cannot block first entry');
pending[0].success(position());
assert.equal(await permissionRequest, true);
completeQuery({ state: 'denied' }); await flush();
assert.equal(permissionTimeout.locationPermissionState, 'granted', 'A late permission query cannot revoke a newer device fix');

const suspendedQuery = app();
navigator.permissions = { query: () => new Promise(resolve => { completeQuery = resolve; }) };
const suspendedRefresh = suspendedQuery.refreshLocationPermissionState({ requestIfAllowed: true });
document.visibilityState = 'hidden'; suspendedQuery.stopLocationTracking();
document.visibilityState = 'visible';
completeQuery({ state: 'granted' }); await suspendedRefresh;
assert.equal(pending.length, 0, 'A permission query from a previous foreground session cannot start tracking');

const safari = app();
safari.locationPermissionState = 'denied';
const safariRefresh = safari.refreshLocationPermissionState({ requestIfAllowed: true });
assert.equal(pending.length, 1, 'Without Permissions.query, returning after Settings must check device permission again');
pending[0].success(position()); await safariRefresh;
assert.equal(safari.locationPermissionState, 'granted');

const askAgain = app();
let permissionChanged;
const permissionStatus = { state: 'granted', addEventListener(type, callback) { permissionChanged = callback; } };
askAgain.observeLocationPermission(permissionStatus);
askAgain.hasBrowserGeolocation = true;
askAgain.userLocation = { lat: 43.6, lng: -79.3 };
permissionStatus.state = 'prompt'; permissionChanged();
assert.equal(askAgain.hasBrowserGeolocation, false, 'Resetting permission to Ask must expire the previous live fix');
assert.equal(askAgain.deviceLocationStatus, 'Allow location access');
assert.equal(pending.length, 0, 'Permission reset must not immediately ask again');

const reconnect = app();
reconnect.didApplyEntryLocationDefaults = true;
reconnect.hasBrowserGeolocation = true;
reconnect.userLocation = { lat: 43.6, lng: -79.3, timestamp: now };
let cityRetries = 0;
reconnect.applyEntryLocationDefaults = () => { cityRetries++; };
reconnect.googleGeocodeStatus = 'TIMEOUT'; reconnect.googleGeocodeRetryAt = now + 60000;
reconnect.locationLabelRetryTimer = window.setTimeout(() => assert.fail('Old label retry survived reconnect'), 5000);
reconnect.setupLiveLocationLifecycle();
windowEvents.get('online')({ type: 'online' }); await flush();
assert.equal(reconnect.googleGeocodeRetryAt, 0);
assert.equal(reconnect.locationLabelRetryTimer, null);
assert.equal(cityRetries, 1, 'Reconnecting must retry the city independently of a pending fresh GPS request');
assert.equal(reconnect.locationRequestInFlight, true);
pending[0].success(position()); await flush();
assert.equal(reconnect.samples[0].options.forceBrowserLocation, false, 'Routine recovery must preserve deliberate manual searches');
reconnect.googleGeocodeStatus = 'OVER_QUERY_LIMIT'; reconnect.googleGeocodeRetryAt = now + 60000;
windowEvents.get('online')({ type: 'online' }); await flush();
assert.equal(reconnect.googleGeocodeRetryAt, now + 60000, 'Reconnect must not bypass quota cooldown');
reconnect.stopLocationTracking();

const validation = app();
assert.equal(validation.isValidBrowserLocationSample(position(0, 0)), true);
for (const fix of [position(91, 0), position(0, 181), position(null, 0), position(NaN, 0), { ...position(), timestamp: now - 300000 }]) {
  assert.equal(validation.isValidBrowserLocationSample(fix), false);
}
assert.equal(validation.shouldAcceptBrowserLocationSample(position(43.6, -79.3)), true);
validation.userLocation = { lat: 43.6, lng: -79.3, timestamp: now, accuracy: 20 };
assert.equal(validation.shouldAcceptBrowserLocationSample({ ...position(-1.2865, 36.8218), timestamp: now - 1000 }), false);
validation.hasBrowserGeolocation = true;
advance(180001);
assert.equal(validation.hasUsableCurrentLocation(), false, 'A prolonged device failure must expire the old live fix');

console.log('Location recovery tests passed: first entry, synchronous/hung requests, fresh fallback, denial, background races, retired watches, permission recovery, reconnect, and invalid/stale samples.');
