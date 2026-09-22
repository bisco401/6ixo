import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';

const entrySource = readFileSync(new URL('../location-entry.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const indexSource = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function createHarness({ startRequest = true, native = false, supported = true, secure = true, storage = new Map(), cookies = { value: '' }, storageUnavailable = false } = {}) {
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
  // Existing acquisition/recovery cases begin after the visitor chooses Allow.
  if (startRequest && supported && secure) window.SIXO_LOCATION_ENTRY?.request({ userInitiated: true });
  return { window, document, navigator, context, requests, timers, panels, storage, cookies };
}

const position = { coords: { latitude: 43.65, longitude: -79.38, accuracy: 15 }, timestamp: Date.now() };

const firstVisit = createHarness();
assert.equal(firstVisit.requests.length, 1, 'Allow must call the browser permission API before the app loads.');
assert.equal(firstVisit.requests[0].options.maximumAge, 0);
assert.equal(firstVisit.requests[0].options.enableHighAccuracy, true);
const initialRequest = firstVisit.window.SIXO_LOCATION_ENTRY.request();
assert.equal(firstVisit.requests.length, 1, 'Background consumers must reuse the entry request.');
assert.equal(firstVisit.window.SIXO_LOCATION_ENTRY.request(), initialRequest);
assert.equal(firstVisit.panels.filter(panel => !panel.hidden).length, 0, 'The browser dialog must be the only location prompt.');
assert.ok([...firstVisit.timers.values()].some(timer => timer.delay === 1500), 'A suppressed browser prompt must have a visible tap fallback.');
firstVisit.requests[0].success(position);
assert.equal((await initialRequest).position, position);
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
assert.equal(firstVisit.requests.length, 1, 'App startup must reuse the entry result instead of prompting again.');
assert.equal(app.appliedSamples, 1);
assert.equal(app.locationPermissionState, 'granted');
assert.equal(app.hasUsableCurrentLocation(), true);
const refresh = app.requestLocationPermission({ announce: true });
assert.equal(app.requestLocationPermission({ announce: true }), refresh);
assert.equal(firstVisit.requests.length, 2);
firstVisit.requests[1].error({ code: 1, message: 'Permission revoked' });
assert.equal(await refresh, false);
assert.equal(app.locationPermissionState, 'denied');
assert.equal(app.userLocation, null);
assert.equal(firstVisit.panels.filter(panel => !panel.hidden).length, 1, 'An explicit denied retry must explain the blocked device permission.');
const retry = app.requestLocationPermission({ announce: true });
firstVisit.requests[2].success(position);
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
assert.equal(pendingVisit.panels.filter(panel => !panel.hidden).length, 0, 'Successful automatic permission must not show an extra app prompt.');

// The live release also has lifecycle cancellation and a lower-accuracy GPS
// fallback. The entry integration must preserve those existing recovery paths.
if (typeof pendingApp.refreshLocationPermissionState === 'function') {
  const delegatedVisit = createHarness();
  const delegatedApp = connectApp(delegatedVisit);
  await delegatedApp.requestLocationPermissionOnLoad();
  const sharedEntry = delegatedApp.requestLocationPermission();
  assert.equal(delegatedApp.requestLocationPermission(), sharedEntry);
  assert.equal(delegatedVisit.requests.length, 1);
  const pinRetry = delegatedApp.requestLocationPermission({ announce: true });
  assert.equal(delegatedVisit.requests.length, 2, 'A tap after app startup must still reach geolocation synchronously.');
  assert.equal(await sharedEntry, false, 'Retired entry consumers must settle after a deliberate retry.');
  delegatedVisit.requests[0].success(position);
  assert.equal(delegatedApp.appliedSamples, 0, 'The retired automatic callback must not overwrite a new request.');
  delegatedVisit.requests[1].error({ code: 3, message: 'High accuracy unavailable' });
  assert.equal(delegatedVisit.requests.length, 3);
  assert.equal(delegatedVisit.requests[2].options.enableHighAccuracy, false, 'The release must retain its fresh-device fallback.');
  delegatedVisit.requests[2].success(position);
  assert.equal(delegatedApp.appliedSamples, 1);
  assert.equal(await pinRetry, true);
  assert.equal(delegatedVisit.panels.filter(panel => !panel.hidden).length, 0);

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
assert.equal(deniedVisit.panels.filter(panel => !panel.hidden).length, 1);
assert.match(deniedVisit.panels[0].querySelector('[data-location-entry-message]').textContent, /browser.*blocking location/);
assert.equal((await deniedVisit.window.SIXO_LOCATION_ENTRY.request()).skipped, true);
assert.equal(deniedVisit.timers.size, 0);

for (const options of [{ supported: false }, { secure: false }]) {
  const unavailable = createHarness(options);
  assert.equal(unavailable.requests.length, 0);
  assert.equal(unavailable.panels.filter(panel => !panel.hidden).length, 1);
  assert.equal(unavailable.panels[0].querySelector('[data-location-entry-allow]').disabled, true);
}
const nativeVisit = createHarness({ native: true });
assert.equal(nativeVisit.requests.length, 0, 'Native location must remain owned by the native bridge.');
assert.equal(nativeVisit.window.SIXO_LOCATION_ENTRY, undefined);

const preferenceKey = 'sixo_location_onboarding_v1';
const allowAgain = createHarness({ storage: firstVisit.storage });
assert.equal(allowAgain.requests.length, 1, 'Allowed returning visitors must automatically obtain fresh device coordinates');
for (const timer of allowAgain.timers.values()) timer.callback();
assert.equal(allowAgain.panels.filter(panel => !panel.hidden).length, 1, 'Returning visitors need recovery when GPS times out');
allowAgain.requests[0].error({ code: 1 });
assert.equal(allowAgain.panels.filter(panel => !panel.hidden).length, 1, 'A failed return visit must not leave location silently blank');
assert.equal(allowAgain.window.SIXO_LOCATION_ENTRY.showPrompt({ code: 1 }, { force: true }), true);

for (const savedChoice of ['denied', 'dismissed']) {
  const returning = createHarness({ storage: new Map([[preferenceKey, savedChoice]]) });
  const returningApp = connectApp(returning);
  await returningApp.requestLocationPermissionOnLoad();
  assert.equal(returning.requests.length, 1, 'A saved onboarding choice cannot suppress the browser permission request on a new visit.');
  returning.requests[0].error({ code: 1 });
  await returningApp.refreshLocationPermissionState({ requestIfAllowed: true });
  assert.equal(returning.requests.length, 1, 'A current browser denial must stop automatic retries on this page.');
  const explicit = returningApp.requestLocationPermission({ announce: true });
  assert.equal(returning.requests.length, 2, 'The pin lets the user deliberately retry after a current denial.');
  returning.requests[1].success(position);
  assert.equal(await explicit, true);
  assert.equal(returning.storage.get(preferenceKey), 'allowed');
  assert.equal(returning.panels.filter(panel => !panel.hidden).length, 0);
}

const permissionChanged = createHarness({ storage: new Map([[preferenceKey, 'denied']]) });
permissionChanged.navigator.permissions = { query: async () => ({ state: 'granted' }) };
const changedApp = connectApp(permissionChanged);
await changedApp.requestLocationPermissionOnLoad();
assert.equal(permissionChanged.requests.length, 1, 'Browser permission granted in Settings must override the stored denial');
permissionChanged.requests[0].success(position);
assert.equal(permissionChanged.storage.get(preferenceKey), 'allowed');
assert.equal(permissionChanged.panels.filter(panel => !panel.hidden).length, 0);

const legacy = createHarness({ storage: new Map([['sixo_app_build_version', 'old-build']]) });
for (const timer of legacy.timers.values()) timer.callback();
assert.equal(legacy.panels.filter(panel => !panel.hidden).length, 1, 'Old visitors also need a recovery button when no location is available');

const cookieVisit = createHarness({ storageUnavailable: true });
cookieVisit.requests[0].error({ code: 1 });
const cookieAgain = createHarness({ storageUnavailable: true, cookies: cookieVisit.cookies });
assert.equal(cookieAgain.requests.length, 1, 'A saved cookie choice must not suppress the current browser permission check.');
assert.equal(cookieAgain.panels.filter(panel => !panel.hidden).length, 0);

const unanswered = createHarness();
assert.equal(unanswered.storage.get(preferenceKey), 'requested');
const unansweredAgain = createHarness({ storage: unanswered.storage });
assert.equal(unansweredAgain.requests.length, 1, 'An unanswered first visit must not disable device location on future visits');
for (const timer of unansweredAgain.timers.values()) timer.callback();
assert.equal(unansweredAgain.panels.filter(panel => !panel.hidden).length, 1, 'An unanswered browser prompt must have a visible fallback on reload');

for (const savedChoice of ['seen', 'allowed']) {
  const safariReturning = createHarness({ storage: new Map([[preferenceKey, savedChoice]]) });
  const safariApp = connectApp(safariReturning);
  await safariApp.requestLocationPermissionOnLoad();
  assert.equal(safariReturning.requests.length, 1, `A saved ${savedChoice} choice cannot block Safari when Permissions.query is unavailable`);
  safariReturning.requests[0].success(position);
  assert.equal(safariApp.hasUsableCurrentLocation(), true);
  assert.equal(safariReturning.panels.filter(panel => !panel.hidden).length, 0);
}

const entryTag = indexSource.indexOf('<script src="location-entry.js?');
const bootstrapTag = indexSource.indexOf('<script src="coming-soon-bootstrap.js?');
const appTag = indexSource.indexOf('<script src="app.js?');
assert.ok(entryTag > 0 && entryTag < (bootstrapTag >= 0 ? bootstrapTag : appTag), 'QR landing pages must load the location request before the main app.');
assert.ok(!indexSource.includes('id="mode-bar"'), 'The online status bar is removed.');
assert.ok(!indexSource.includes('class="site-device-location"'), 'The site location notice is removed.');
assert.ok(!indexSource.includes('id="home-device-location-status"'), 'The repeated Home location notice is removed.');
assert.ok(indexSource.includes('id="home-use-location"'), 'Keep an explicit location retry control.');
const mobilePreparation = new URL('../mobile/scripts/prepare-web.mjs', import.meta.url);
if (existsSync(mobilePreparation)) assert.ok(readFileSync(mobilePreparation, 'utf8').includes("'location-entry.js'"));

console.log('Location entry test passed: one browser prompt, saved choices, explicit retry, app handoff, and native isolation.');

const silentVisit = createHarness({ storage: new Map([['sixo_location_onboarding_v1', 'allowed']]) });
const silentEntry = silentVisit.window.SIXO_LOCATION_ENTRY;
const silentRequest = silentEntry.pendingRequest;
[...silentVisit.timers.values()].find(timer => timer.delay === 22000).callback();
assert.equal((await silentRequest).error.code, 3, 'A silent browser must release the entry request for recovery');
assert.equal(silentEntry.pendingRequest, null);
silentVisit.requests[0].success(position);
let lateResults = 0;
silentEntry.connect(result => { if (result.position) lateResults++; });
assert.equal(lateResults, 0, 'A callback after the watchdog expired cannot restore an old fix');
const recoveredEntry = silentEntry.request({ userInitiated: true });
silentVisit.requests[1].success(position);
assert.equal((await recoveredEntry).position, position);
assert.equal(silentVisit.timers.size, 0, 'Success must clean up both prompt and request timers');
console.log('Silent entry recovery passed: bounded requests, retired callbacks and successful pin retry.');

const suppressed = createHarness();
const suppressedApp = connectApp(suppressed);
await suppressedApp.requestLocationPermissionOnLoad();
[...suppressed.timers.values()].find(timer => timer.delay === 1500).callback();
const recovery = suppressed.panels[0];
assert.equal(recovery.hidden, false, 'If browser permission UI is suppressed, display a direct location button');
recovery.querySelector('[data-location-entry-allow]').listeners.get('click')();
assert.equal(suppressed.requests.length, 2, 'The fallback must reach geolocation synchronously during the tap');
suppressed.requests[0].success(position);
assert.equal(suppressedApp.appliedSamples, 0, 'Retired automatic callbacks cannot overwrite the tap request');
suppressed.requests[1].success(position);
assert.equal(suppressedApp.appliedSamples, 1);
assert.equal(recovery.hidden, true, 'Allow must finalize and close the popup');

const closed = createHarness();
[...closed.timers.values()].find(timer => timer.delay === 1500).callback();
closed.panels[0].querySelector('[data-location-entry-dismiss]').listeners.get('click')();
closed.requests[0].error({ code: 1 });
assert.equal(closed.panels[0].hidden, true, 'Not now stays dismissed after the pending request fails');
assert.equal(closed.requests.length, 1, 'Dismissing recovery must not trigger further automatic requests');
assert.equal(closed.window.SIXO_LOCATION_ENTRY.showPrompt({ code: 1 }, { force: true }), true, 'An explicit pin retry may reopen recovery');
console.log('Suppressed prompt recovery passed: visible fallback, synchronous tap, stale callback isolation, success closure and dismissal.');

// Real page-entry behavior: no request or disappearance until the visitor acts.
for (const savedChoice of ['', 'seen', 'allowed', 'denied', 'dismissed']) {
  for (const permissionState of ['unknown', 'prompt', 'granted', 'denied']) {
    const visit = createHarness({ startRequest: false, storage: new Map([[preferenceKey, savedChoice]]) });
    if (permissionState !== 'unknown') visit.navigator.permissions = { query: async () => ({ state: permissionState }) };
    const entryApp = connectApp(visit);
    await entryApp.requestLocationPermissionOnLoad();
    assert.equal(visit.requests.length, 0, 'Page entry must wait for Allow, regardless of a saved choice or browser permission');
    assert.equal(visit.panels.filter(panel => !panel.hidden).length, 1, 'QR entry must immediately show a visible location choice');
    visit.panels[0].querySelector('[data-location-entry-dismiss]').listeners.get('click')();
    await entryApp.refreshLocationPermissionState({ requestIfAllowed: true });
    assert.equal(visit.requests.length, 0, 'Dismissal must stop background requests even for granted browser permission');
    assert.equal(visit.panels[0].hidden, true);
    visit.window.SIXO_LOCATION_ENTRY.showPrompt(null, { force: true });
    visit.panels[0].querySelector('[data-location-entry-allow]').listeners.get('click')();
    assert.equal(visit.requests.length, 1, 'Allow must reach geolocation synchronously after app startup');
    visit.requests[0].success(position);
    assert.equal(entryApp.appliedSamples, 1);
    assert.equal(visit.panels[0].hidden, true);
  }
}
const earlyAllow = createHarness({ startRequest: false });
earlyAllow.panels[0].querySelector('[data-location-entry-allow]').listeners.get('click')();
assert.equal(earlyAllow.requests.length, 1, 'Allow works before the marketplace app loads');
earlyAllow.requests[0].success(position);
const earlyApp = connectApp(earlyAllow);
await earlyApp.requestLocationPermissionOnLoad();
assert.equal(earlyApp.appliedSamples, 1);
assert.equal(earlyAllow.requests.length, 1);
console.log('QR entry popup passed: immediate choice, all saved/browser permission combinations, dismissal, synchronous Allow and early app handoff.');

// Preserve the original two-button popup while repairing the Allow action.
assert.match(entrySource, /“6ixo.com” Would Like to Use Your Location/);
assert.match(entrySource, />Don’t Allow<\/button>/);
assert.match(entrySource, />Allow<\/button>/);
assert.ok(!entrySource.includes('data-location-entry-manual'));

// An explicit second Allow must replace an unanswered user request, not
// silently reuse it. Old callbacks must not win over the new button action.
for (const connected of [false, true]) {
  const visit = createHarness({ startRequest: false });
  const app = connected ? connectApp(visit) : null;
  if (app) {
    await app.requestLocationPermissionOnLoad();
    app.manualDiscoveryLocation = { city: 'London', country: 'United Kingdom' };
    app.homeLocationDraft = { text: 'London' };
    app.didApplyEntryLocationDefaults = true;
  }
  const allow = visit.panels[0].querySelector('[data-location-entry-allow]').listeners.get('click');
  allow();
  assert.equal(visit.requests.length, 1);
  const first = app ? app.locationRequestPromise : visit.window.SIXO_LOCATION_ENTRY.pendingRequest;
  visit.window.SIXO_LOCATION_ENTRY.showPrompt({ code: 3 }, { force: true });
  allow();
  assert.equal(visit.requests.length, 2, 'A new Allow tap must reach the platform immediately, even if an earlier tap stalled');
  assert.ok(app ? await first === false : (await first).cancelled);
  if (app) {
    assert.equal(app.manualDiscoveryLocation, null, 'Allow must switch from a selected city to current device location');
    assert.equal(app.homeLocationDraft, null, 'An unfinished city draft must not hide the device label');
    assert.equal(app.didApplyEntryLocationDefaults, false);
  }
  visit.requests[0].success(position);
  if (app) assert.equal(app.appliedSamples, 0);
  else assert.ok(visit.window.SIXO_LOCATION_ENTRY.pendingRequest);
  visit.requests[1].success(position);
  if (app) assert.equal(app.appliedSamples, 1);
  assert.equal(visit.panels[0].hidden, true);
}

const closedAppVisit = createHarness({ startRequest: false });
const closedApp = connectApp(closedAppVisit);
await closedApp.requestLocationPermissionOnLoad();
closedAppVisit.panels[0].querySelector('[data-location-entry-allow]').listeners.get('click')();
const cancelledRequest = closedApp.locationRequestPromise;
closedAppVisit.panels[0].querySelector('[data-location-entry-dismiss]').listeners.get('click')();
assert.equal(await cancelledRequest, false);
closedAppVisit.requests[0].success(position);
assert.equal(closedApp.appliedSamples, 0, 'Don’t Allow must retire an app-owned GPS request');
assert.equal(closedAppVisit.panels[0].hidden, true);
console.log('Original Allow popup passed: fresh gesture retries, stale callback isolation, manual-to-device reset and cancellation.');
