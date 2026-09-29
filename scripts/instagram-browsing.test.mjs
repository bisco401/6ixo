import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const elements = {
  'main-app': { dataset: {}, querySelectorAll: () => [] },
  'browsing-location-recovery': { hidden: true },
  'browsing-location-choose': { dataset: {}, addEventListener(_, handler) { this.click = handler; } },
  'home-search-location': { focus() { this.focused = true; } }
};
let dismissals = 0;
const window = { SIXO_LOCATION_ENTRY: { dismiss() { dismissals++; } } };
const document = { getElementById: id => elements[id], querySelectorAll: () => [] };
const context = { window, document, console, URL, URLSearchParams };
vm.runInNewContext(source.slice(0, source.indexOf('// Initialize the app when the page loads')) + '\nglobalThis.App = DatingApp;', context);
const app = Object.assign(Object.create(context.App.prototype), {
  strictDeviceLocation: true, deviceLocationFeedsReady: false,
  getCurrentLocationDisplayText() { return this.manualDiscoveryLocation?.country || ''; },
  filterFeaturedCardsForDeviceLocation() {},
  switchScreen(screen) { this.activeScreen = screen; this.updateDeviceLocationUi(); },
  applyResolvedLocationDefaults() {}, refreshDeviceLocationFeeds: async () => {},
  updateHomeCurrentLocationDisplay() { this.updateDeviceLocationUi(); }, updateMarketplaceLocationControls() {}
});
for (const screen of ['marketplace', 'electronics', 'clothing', 'jobs', 'vehicles', 'services', 'community', 'rewards', 'other', 'dating']) {
  app.switchScreen(screen);
  assert.equal(elements['browsing-location-recovery'].hidden, false, `${screen} needs a manual browsing path when GPS is unavailable`);
}
for (const screen of ['home', 'profile', 'premium', 'personal', 'realestate']) {
  app.switchScreen(screen);
  assert.equal(elements['browsing-location-recovery'].hidden, true, `${screen} already has its own controls`);
}
app.switchScreen('electronics');
app.setupHomeLocationRetry();
elements['browsing-location-choose'].click();
assert.equal(app.activeScreen, 'home');
assert.equal(elements['home-search-location'].focused, true);
assert.equal(dismissals, 1, 'Manual browsing must stop location prompts');
await app.applyManualDiscoveryLocation({ country: 'Canada', city: 'Toronto' });
assert.equal(app.activeScreen, 'electronics', 'Choosing an area returns to the intended category');
assert.equal(elements['main-app'].dataset.deviceLocationReady, 'true');
assert.equal(elements['browsing-location-recovery'].hidden, true);
assert.equal(app.browsingLocationReturnScreen, null);
app.deviceLocationFeedsReady = false;
app.updateDeviceLocationUi();
assert.equal(elements['browsing-location-recovery'].hidden, false, 'GPS refresh failure must retain the browsing recovery path');
app.browsingLocationReturnScreen = 'electronics';
app.switchScreen('profile');
await app.applyManualDiscoveryLocation({ country: 'Kenya' });
assert.equal(app.activeScreen, 'profile', 'A late location selection must not pull the user away from another screen');
console.log('Instagram browsing passed: all gated categories, denied/pending location, manual selection, category return, and late-result navigation.');
