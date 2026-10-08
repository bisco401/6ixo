import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

const root = resolve(import.meta.dirname, '..');
const source = readFileSync(resolve(root, 'app.js'), 'utf8');
const classEnd = source.indexOf('// Initialize the app when the page loads');
assert.ok(classEnd > 0);

let now = 100000;
let timerId = 0;
const timers = new Map();
class TestDate extends Date { static now() { return now; } }
const windowStub = {
  scrollX: 0, scrollY: 1200, innerHeight: 800,
  setTimeout(callback, delay) {
    const id = ++timerId;
    timers.set(id, { callback, due: now + delay });
    return id;
  },
  clearTimeout(id) { timers.delete(id); },
  addEventListener() {},
  scrollTo({ left, top }) { this.scrollX = left; this.scrollY = top; }
};
const controls = Object.fromEntries(
  ['home-search-location', 'home-search-country', 'home-search-city']
    .map(id => [id, { value: '', dataset: { autoLocationDefault: '1' } }])
);
let cardTop = 1300;
const card = {
  getBoundingClientRect: () => ({ top: cardTop - windowStub.scrollY, bottom: cardTop - windowStub.scrollY + 300 }),
  hasAttribute: attribute => attribute === 'data-id',
  getAttribute: attribute => ({ 'data-id': 'listing-1', 'data-type': 'marketplace' })[attribute] ?? null
};
const screen = { scrollTop: 0, querySelectorAll: () => [card] };
const documentStub = {
  visibilityState: 'visible',
  getElementById: id => id === 'home-content' ? screen : (controls[id] || null),
  querySelector: () => null,
  addEventListener() {}
};
const context = {
  console, document: documentStub, window: windowStub, navigator: {}, Date: TestDate,
  Map, Set, URL, URLSearchParams, setTimeout, clearTimeout
};
vm.runInNewContext(`${source.slice(0, classEnd)}\nglobalThis.TestApp = DatingApp;`, context);
const prototype = context.TestApp.prototype;
const toronto = { city: 'Toronto', region: 'Ontario', country: 'Canada' };
const sample = latitude => ({ coords: { latitude, longitude: -79.38, accuracy: 10 }, timestamp: now });

function makeFlow() {
  return Object.assign(Object.create(prototype), {
    activeScreen: 'home', currentDatingCategory: '', strictDeviceLocation: true, deviceLocationFeedsReady: true,
    hasBrowserGeolocation: true, lastDeviceLocationSampleAt: now,
    userLocation: {lat: 43.65, lng: -79.38, accuracy: 10, timestamp: now},
    currentUser: {location: {}}, watchLocationId: null, renders: 0,
    async applyHomeFilters(options) {
      assert.equal(options.scrollToResults, false);
      this.renders++;
    }
  });
}

async function advance(milliseconds) {
  now += milliseconds;
  const due = [...timers].filter(([, timer]) => timer.due <= now);
  for (const [id, timer] of due) {
    timers.delete(id);
    await timer.callback();
  }
}

const nearby = makeFlow();
delete nearby.scheduleLocationAwareResultsRefresh;
nearby.hasBrowserGeolocation = true;
nearby.userLocation = { lat: 43.65, lng: -79.38, accuracy: 10 };
nearby.homeQuickFilters = { nearMe: true };
for (let i = 0; i < 5; i++) nearby.scheduleLocationAwareResultsRefresh();
assert.equal(timers.size, 1, 'Rapid GPS fixes must share one pending nearby refresh');
await advance(100);
assert.equal(nearby.renders, 1);
nearby.userLocation.lat += 0.0015;
nearby.scheduleLocationAwareResultsRefresh();
assert.equal(timers.size, 0, 'Small moves must not replace the nearby feed');
nearby.userLocation.lat += 0.003;
nearby.scheduleLocationAwareResultsRefresh();
await advance(29000);
assert.equal(nearby.renders, 1, 'Nearby refreshes must be spaced at least thirty seconds apart');
nearby.lastLocationBrowsingActivityAt = now + 800;
await advance(900);
assert.equal(nearby.renders, 1, 'Defer a GPS refresh during scrolling or touch interaction');
await advance(1000);
assert.equal(nearby.renders, 2, 'Refresh with the latest coordinates once browsing settles');
nearby.userLocation.lat += 0.004;
nearby.scheduleLocationAwareResultsRefresh();
assert.equal(timers.size, 1);
nearby.deviceLocationFeedsReady = false;
await advance(30000);
assert.equal(nearby.renders, 2, 'A queued nearby refresh must not empty the feed while a newer city lookup is pending');
nearby.deviceLocationFeedsReady = true;
nearby.scheduleLocationAwareResultsRefresh();
await advance(100);
assert.equal(nearby.renders, 3, 'Resume nearby refreshes once the current area is confirmed');
nearby.userLocation.lat += 0.004;
nearby.scheduleLocationAwareResultsRefresh();
assert.equal(timers.size, 1);
nearby.stopLocationTracking();
assert.equal(timers.size, 0, 'Stop background feed work when tracking is suspended');

windowStub.scrollY = 1200;
cardTop = 1300;
const restoreScroll = nearby.captureLocationRefreshScroll();
cardTop += 120;
restoreScroll();
assert.equal(windowStub.scrollY, 1320, 'Keep the visible listing at the same viewport position after a refresh');
const ignoreAfterTouch = nearby.captureLocationRefreshScroll();
nearby.lastLocationBrowsingActivityAt = ++now;
cardTop += 200;
ignoreAfterTouch();
assert.equal(windowStub.scrollY, 1320, 'Never undo a user interaction while a search is resolving');
const ignoreAfterNavigation = nearby.captureLocationRefreshScroll();
nearby.activeScreen = 'vehicles';
ignoreAfterNavigation();
assert.equal(windowStub.scrollY, 1320, 'Never restore an old screen after navigation');

console.log('Location movement tests passed: coalesced GPS refreshes, thirty-second spacing, movement guards, browsing deferral, cancellation, and preserved scroll.');
