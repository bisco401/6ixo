import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const classes = () => {
  const values = new Set();
  return { add: value => values.add(value), remove: value => values.delete(value), toggle(value, on) { if (on) values.add(value); else values.delete(value); }, contains: value => values.has(value) };
};
const screens = Object.fromEntries(['home', 'arrive', 'dating', 'other'].map(name => [`${name}-content`, { classList: classes() }]));
const buttons = ['home', 'arrive', 'profile'].map(screen => ({ dataset: { screen }, classList: classes() }));
const context = { console, URL, URLSearchParams, document: {
  getElementById: id => screens[id] || null,
  querySelector: selector => buttons.find(button => selector === `[data-screen="${button.dataset.screen}"]`) || null,
  querySelectorAll: selector => selector === '.nav-btn' ? buttons : selector === '.content-screen' ? Object.values(screens).filter(screen => screen.classList) : [],
}, window: { SIXO_DATING_COMING_SOON_LOCKED: true, scrollTo() {} } };
vm.runInNewContext(`${source.slice(0, source.indexOf('// Initialize the app when the page loads'))}\nglobalThis.App = DatingApp;`, context);
const app = Object.assign(Object.create(context.App.prototype), { isNativeMarketplaceApp: false, nativeBlockedScreens: new Set(), activeScreen: 'home' });
for (const name of ['applyUiState', 'applyActiveScreenLocationDefaults', 'bindImageCarousels', 'bindFeaturedAdCardLightbox', 'syncOverlayViewportMeta', 'setChatViewportMeta', 'updateNotificationBellVisibility', 'pushNavHistory', 'updateNavArrows']) app[name] = () => {};
let plannerLoads = 0;
assert.equal(typeof context.App.prototype.setupDatingSchedule, 'function');
app.setupDatingSchedule = () => plannerLoads++;
for (const name of ['renderDatingScheduleList', 'renderTripAlerts', 'renderArrivePlusInterestedProfiles']) {
  assert.equal(typeof context.App.prototype[name], 'function');
  app[name] = () => {};
}
app.loadDatingPage = () => assert.fail('Dating must not load while coming soon');
app.updateBrowserRoute = route => { app.savedRoute = route; };
app.switchScreen('arrive');
assert.equal(app.activeScreen, 'arrive');
assert.equal(plannerLoads, 1);
assert.equal(buttons.find(button => button.dataset.screen === 'arrive').classList.contains('active'), true);
assert.equal(app.buildHashFromRoute(app.savedRoute), '#arrive');
app.switchScreen('dating');
assert.equal(app.activeScreen, 'dating');
assert.equal(plannerLoads, 1);
app.applyRoute(app.parseRouteFromHash('#dating/arrive_plus'), { source: 'init' });
assert.equal(app.activeScreen, 'arrive', 'Existing Arrive+ deep links must bypass the Dating screen');
assert.equal(app.buildHashFromRoute(app.savedRoute), '#arrive');
app.applyRoute({ screen: 'dating' });
assert.equal(app.activeScreen, 'dating', 'Dating remains its own locked destination');
app.openDatingCategory('arrive_plus');
assert.equal(app.activeScreen, 'arrive', 'Existing in-app Arrive+ shortcuts must reach the standalone planner');
app.users = [{ id: 'dating-profile' }];
assert.equal(app.getArrivePlusProfilePreviewForDestination('Toronto, Canada').profiles.length, 0, 'Dating profiles remain unavailable while coming soon');
assert.equal(app.getArrivePlusProfilePreviewForDestination('').profiles.length, 0);
let onOtherClick;
screens['home-other-subcategory-nav'] = { dataset: {}, addEventListener(type, handler) { onOtherClick = handler; } };
app.homeOtherSubcategory = 'appliances';
app.bindHomeOtherSubcategoryNav();
onOtherClick({ target: { closest: () => ({ dataset: { homeOtherScreen: 'dating' } }) } });
assert.equal(app.activeScreen, 'dating');
assert.equal(app.homeOtherSubcategory, 'appliances', 'Dating shortcut must not become a listing subcategory');
console.log('Navigation verified: direct planner, bottom navigation, legacy links, Other shortcut, and Dating gate isolation.');
