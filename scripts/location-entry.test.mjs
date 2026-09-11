import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';

const entrySource = readFileSync(new URL('../location-entry.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const indexSource = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function createHarness({ native = false, supported = true, secure = true, storage = new Map(), cookies = { value: '' }, storageUnavailable = false } = {}) {
  const requests = [];
  const timers = new Map();
  const panels = [];
  let nextTimer = 0;
  const makeElement = () => ({
    hidden: false,
    children: new Map(),
    listeners: new Map(),
    setAttribute() {},
    addEventListener(event, listener) { this.listeners.set(event, listener); },
    querySelector(selector) {
      if (!this.children.has(selector)) this.children.set(selector, makeElement());
      return this.children.get(selector);
    }
  });
  const window = {
    isSecureContext: secure,
    location: { protocol: 'https:' },
    localStorage: {
      getItem(key) { if (storageUnavailable) throw new Error('Storage unavailable'); return storage.get(key) || null; },
      setItem(key, value) { if (storageUnavailable) throw new Error('Storage unavailable'); storage.set(key, value); },
      removeItem(key) { storage.delete(key); }
    },
    SIXO_APP_VARIANT: native ? 'marketplace-native' : undefined,
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener() {}
  };
  const document = {
    get cookie() { return cookies.value; },
    set cookie(value) { cookies.value = value.split(';')[0]; },
    visibilityState: 'visible',
    body: { appendChild(element) { panels.push(element); } },
    createElement: makeElement,
    addEventListener() {},
    getElementById() { return null; },
    querySelector() { return null; }
  };
  const navigator = supported ? {
    geolocation: {
      getCurrentPosition(success, error, options) { requests.push({ success, error, options }); },
      clearWatch() {}
    }
  } : {};
  const context = vm.createContext({ window, document, navigator, console, Date, Map, Set, URL, URLSearchParams });
  vm.runInContext(entrySource, context);
  return { window, document, navigator, context, requests, timers, panels, storage, cookies };
}

const position = { coords: { latitude: 43.65, longitude: -79.38, accuracy: 15 }, timestamp: Date.now() };

const firstVisit = createHarness();
assert.equal(firstVisit.requests.length, 1, 'A first visit must immediately call the browser permission API before the app loads.');
assert.equal(firstVisit.requests[0].options.maximumAge, 0);
assert.equal(firstVisit.requests[0].options.enableHighAccuracy, true);
const initialRequest = firstVisit.window.SIXO_LOCATION_ENTRY.request();
assert.equal(firstVisit.requests.length, 1, 'Background consumers must reuse the entry request.');
assert.equal(firstVisit.window.SIXO_LOCATION_ENTRY.request(), initialRequest);
for (const [id, timer] of firstVisit.timers) {
  firstVisit.timers.delete(id);
  timer.callback();
}
const fallback = firstVisit.panels[0];
assert.ok(fallback && !fallback.hidden, 'An unanswered automatic prompt must offer a visible fallback.');
const allow = fallback.querySelector('[data-location-entry-allow]');
allow.listeners.get('click')();
assert.equal(firstVisit.requests.length, 2, 'The Allow location tap must call geolocation synchronously, even if the automatic request is still pending.');
allow.listeners.get('click')();
assert.equal(firstVisit.requests.length, 2, 'Repeated taps must share the pending user request.');
firstVisit.requests[0].error({ code: 1, message: 'Old automatic denial' });
firstVisit.requests[1].success(position);
assert.equal((await initialRequest).position, position, 'All waiting consumers must receive the successful retry.');
assert.equal(fallback.hidden, true);
assert.equal(firstVisit.timers.size, 0);

function connectApp(harness) {
  const classEnd = appSource.indexOf('// Initialize the app when the page loads');
  assert.ok(classEnd > 0);
  vm.runInContext(`${appSource.slice(0, classEnd)}\nglobalThis.TestApp = DatingApp;`, harness.context);
  return Object.assign(Object.create(harness.context.TestApp.prototype), {
    isNativeMarketplaceApp: false,
    locationPermissionState: 'unknown',
    hasBrowserGeolocation: false,
    userLocation: null,
    watchLocationId: null,
    cityLocationMaxAccuracyMeters: 1000,
    appliedSamples: 0,
    handleLocationSuccess(sample) {
      this.appliedSamples += 1;
      this.hasBrowserGeolocation = true;
      this.userLocation = { lat: sample.coords.latitude, lng: sample.coords.longitude, accuracy: sample.coords.accuracy };
      return true;
    },
    showNotification() {},
    updateHomeCurrentLocationDisplay() {},
    updateMarketplaceLocationControls() {},
    scheduleLocationTrackingRetry() { throw new Error('A denial must not start automatic retries.'); }
  });
}

const app = connectApp(firstVisit);
await app.requestLocationPermissionOnLoad();
assert.equal(firstVisit.requests.length, 2, 'App startup must reuse the entry result instead of prompting again.');
assert.equal(app.appliedSamples, 1);
assert.equal(app.locationPermissionState, 'granted');
assert.equal(app.hasUsableCurrentLocation(), true);
const refresh = app.requestLocationPermission({ announce: true });
assert.equal(app.requestLocationPermission({ announce: true }), refresh);
assert.equal(firstVisit.requests.length, 3);
firstVisit.requests[2].error({ code: 1, message: 'Permission revoked' });
assert.equal(await refresh, false);
assert.equal(app.locationPermissionState, 'denied');
assert.equal(app.userLocation, null);
assert.equal(fallback.hidden, true, 'After successful onboarding a denial must not reopen the first-visit question.');
fallback.querySelector('[data-location-entry-dismiss]').listeners.get('click')();
assert.equal(fallback.hidden, true, 'Not now must dismiss the panel without another permission request.');
assert.equal(firstVisit.requests.length, 3);
const retry = app.requestLocationPermission({ announce: true });
firstVisit.requests[3].success(position);
assert.equal(await retry, true);
assert.equal(app.appliedSamples, 2);
assert.equal(app.locationRequestPromise, null);
assert.equal(app.locationRequestInFlight, false);

const pendingVisit = createHarness();
const pendingApp = connectApp(pendingVisit);
await pendingApp.requestLocationPermissionOnLoad();
assert.equal(pendingVisit.requests.length, 1);
pendingVisit.requests[0].success(position);
assert.equal(pendingApp.appliedSamples, 1, 'A result arriving after app startup must be applied once.');
assert.equal(pendingVisit.panels.length, 0, 'Successful automatic permission must not show an extra app prompt.');

// The live release also has lifecycle cancellation and a lower-accuracy GPS
// fallback. The entry integration must preserve those existing recovery paths.
if (typeof pendingApp.refreshLocationPermissionState === 'function') {
  const delegatedVisit = createHarness();
  const delegatedApp = connectApp(delegatedVisit);
  await delegatedApp.requestLocationPermissionOnLoad();
  const sharedEntry = delegatedApp.requestLocationPermission();
  assert.equal(delegatedApp.requestLocationPermission(), sharedEntry);
  assert.equal(delegatedVisit.requests.length, 1);
  for (const [id, timer] of delegatedVisit.timers) {
    delegatedVisit.timers.delete(id);
    timer.callback();
  }
  delegatedVisit.panels[0].querySelector('[data-location-entry-allow]').listeners.get('click')();
  assert.equal(delegatedVisit.requests.length, 2, 'A tap after app startup must still reach geolocation synchronously.');
  assert.equal(await sharedEntry, false, 'Retired entry consumers must settle after a deliberate retry.');
  delegatedVisit.requests[0].success(position);
  assert.equal(delegatedApp.appliedSamples, 0, 'The retired automatic callback must not overwrite a new request.');
  delegatedVisit.requests[1].error({ code: 3, message: 'High accuracy unavailable' });
  assert.equal(delegatedVisit.requests.length, 3);
  assert.equal(delegatedVisit.requests[2].options.enableHighAccuracy, false, 'The release must retain its fresh-device fallback.');
  delegatedVisit.requests[2].success(position);
  assert.equal(delegatedApp.appliedSamples, 1);
  assert.equal(delegatedVisit.panels[0].hidden, true);

  const hiddenVisit = createHarness();
  const hiddenApp = connectApp(hiddenVisit);
  await hiddenApp.requestLocationPermissionOnLoad();
  const hiddenRequest = hiddenApp.requestLocationPermission();
  hiddenVisit.document.visibilityState = 'hidden';
  hiddenApp.stopLocationTracking();
  assert.equal(await hiddenRequest, false);
  hiddenVisit.document.visibilityState = 'visible';
  hiddenVisit.requests[0].success(position);
  assert.equal(hiddenApp.appliedSamples, 0, 'A retired entry result must not restore location after backgrounding.');
}

const revokedBeforeApp = createHarness();
revokedBeforeApp.requests[0].success(position);
revokedBeforeApp.navigator.permissions = { async query() { return { state: 'denied' }; } };
const revokedApp = connectApp(revokedBeforeApp);
await revokedApp.requestLocationPermissionOnLoad();
assert.equal(revokedApp.hasUsableCurrentLocation(), false, 'Permission revoked before app startup must invalidate the entry sample.');
assert.equal(revokedApp.userLocation, null);

const deniedVisit = createHarness();
deniedVisit.requests[0].error({ code: 1, message: 'Browser permission denied' });
assert.equal(deniedVisit.requests.length, 1, 'A denial must not trigger repeated automatic prompts.');
assert.match(deniedVisit.panels[0].querySelector('[data-location-entry-message]').textContent, /browser and device settings/);
assert.equal(deniedVisit.timers.size, 0);

for (const options of [{ supported: false }, { secure: false }]) {
  const unavailable = createHarness(options);
  assert.equal(unavailable.requests.length, 0);
  assert.equal(unavailable.panels[0].querySelector('[data-location-entry-allow]').disabled, true);
}
const nativeVisit = createHarness({ native: true });
assert.equal(nativeVisit.requests.length, 0, 'Native location must remain owned by the native bridge.');
assert.equal(nativeVisit.window.SIXO_LOCATION_ENTRY, undefined);

const preferenceKey = 'sixo_location_onboarding_v1';
const allowAgain = createHarness({ storage: firstVisit.storage });
assert.equal(allowAgain.requests.length, 1, 'Allowed returning visitors must automatically obtain fresh device coordinates');
for (const timer of allowAgain.timers.values()) timer.callback();
assert.equal(allowAgain.panels.length, 0, 'Returning visitors must not see the onboarding panel while GPS loads');
allowAgain.requests[0].error({ code: 1 });
assert.equal(allowAgain.panels.length, 0, 'A returning visitor denial must not automatically reopen the question');
assert.equal(allowAgain.window.SIXO_LOCATION_ENTRY.showPrompt({ code: 1 }, { force: true }), false);

const dismissVisit = createHarness();
for (const timer of dismissVisit.timers.values()) timer.callback();
dismissVisit.panels[0].querySelector('[data-location-entry-dismiss]').listeners.get('click')();
assert.equal(dismissVisit.storage.get(preferenceKey), 'dismissed');
const dismissAgain = createHarness({ storage: dismissVisit.storage });
assert.equal(dismissAgain.requests.length, 0, 'Not now must persist across reloads without another automatic permission request');
dismissAgain.navigator.permissions = { query: async () => ({ state: 'prompt' }) };
const dismissApp = connectApp(dismissAgain);
await dismissApp.requestLocationPermissionOnLoad();
assert.equal(dismissAgain.requests.length, 0, 'App startup must respect the saved dismissal');
assert.equal(dismissAgain.panels.length, 0);
assert.equal(await dismissApp.requestLocationPermission(), false);
const explicitAfterDismiss = dismissApp.requestLocationPermission({ announce: true });
assert.equal(dismissAgain.requests.length, 1, 'The pin remains an explicit way to enable location after dismissing onboarding');
dismissAgain.requests[0].success(position);
assert.equal(await explicitAfterDismiss, true);
assert.equal(dismissAgain.storage.get(preferenceKey), 'allowed');
assert.equal(dismissAgain.panels.length, 0);

const permissionChanged = createHarness({ storage: new Map([[preferenceKey, 'denied']]) });
permissionChanged.navigator.permissions = { query: async () => ({ state: 'granted' }) };
const changedApp = connectApp(permissionChanged);
await changedApp.requestLocationPermissionOnLoad();
assert.equal(permissionChanged.requests.length, 1, 'Browser permission granted in Settings must override the stored denial');
permissionChanged.requests[0].success(position);
assert.equal(permissionChanged.storage.get(preferenceKey), 'allowed');
assert.equal(permissionChanged.panels.length, 0);

const legacy = createHarness({ storage: new Map([['sixo_app_build_version', 'old-build']]) });
for (const timer of legacy.timers.values()) timer.callback();
assert.equal(legacy.panels.length, 0, 'Existing site visitors must not be treated as first-time users during rollout');

const cookieVisit = createHarness({ storageUnavailable: true });
for (const timer of cookieVisit.timers.values()) timer.callback();
cookieVisit.panels[0].querySelector('[data-location-entry-dismiss]').listeners.get('click')();
const cookieAgain = createHarness({ storageUnavailable: true, cookies: cookieVisit.cookies });
assert.equal(cookieAgain.requests.length, 0, 'The cookie must retain dismissal when localStorage is unavailable');
assert.equal(cookieAgain.panels.length, 0);

const unanswered = createHarness();
assert.equal(unanswered.storage.get(preferenceKey), 'seen');
const unansweredAgain = createHarness({ storage: unanswered.storage });
assert.equal(unansweredAgain.requests.length, 0, 'Reloading an unanswered first visit must not repeat the question');

const entryTag = indexSource.indexOf('<script src="location-entry.js?');
const bootstrapTag = indexSource.indexOf('<script src="coming-soon-bootstrap.js?');
const appTag = indexSource.indexOf('<script src="app.js?');
assert.ok(entryTag > 0 && entryTag < (bootstrapTag >= 0 ? bootstrapTag : appTag), 'QR landing pages must load the location request before the main app.');
assert.ok(indexSource.includes('assets/location-entry.css?'), 'Permission recovery must be styled even before the full app loads.');
const mobilePreparation = new URL('../mobile/scripts/prepare-web.mjs', import.meta.url);
if (existsSync(mobilePreparation)) assert.ok(readFileSync(mobilePreparation, 'utf8').includes("'location-entry.js'"));

console.log('Location entry test passed: automatic first-visit requests, tap fallback, denial recovery, app handoff, and native isolation.');
