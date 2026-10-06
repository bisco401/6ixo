import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');
const source = readFileSync(resolve(root, 'app.js'), 'utf8');
const classEnd = source.indexOf('// Initialize the app when the page loads');
if (classEnd < 0) throw new Error('Could not isolate DatingApp for the featured carousel test.');

const context = {
  console,
  document: {},
  navigator: {},
  window: {
    getComputedStyle() {
      return { columnGap: '16px', gap: '16px' };
    }
  },
  Date,
  Map,
  Set,
  URL,
  URLSearchParams
};
vm.runInNewContext(
  `${source.slice(0, classEnd)}\nglobalThis.TestDatingApp = DatingApp;`,
  context
);

const card = (offsetLeft, width = 320, hidden = false) => ({
  offsetLeft,
  clientWidth: width,
  hidden,
  getBoundingClientRect() {
    return { width };
  }
});

const cards = [card(12), card(348), card(684, 320, true)];
const scrollCalls = [];
const scroller = {
  clientWidth: 320,
  scrollWidth: 668,
  scrollLeft: 0,
  dataset: {},
  querySelectorAll() {
    return cards;
  },
  scrollTo(options) {
    scrollCalls.push(options);
    this.scrollLeft = options.left;
  }
};

const app = Object.create(context.TestDatingApp.prototype);
const visibleCards = app.getFeaturedStripCards(scroller);
if (visibleCards.length !== 2) {
  throw new Error(`Featured navigation must count only visible ads; received ${visibleCards.length}.`);
}

const positions = app.getFeaturedStripCardPositions(scroller);
if (positions.length !== 2 || positions[0] !== 0 || positions[1] !== 336) {
  throw new Error(`Featured card positions must use actual card offsets; received ${JSON.stringify(positions)}.`);
}

const targetIndex = app.scrollFeaturedStripToIndex(scroller, 1, { smooth: true });
if (targetIndex !== 1 || scrollCalls.length !== 1 || scrollCalls[0].left !== 336 || scrollCalls[0].behavior !== 'smooth') {
  throw new Error(`Next featured ad must scroll directly to card 2; received ${JSON.stringify(scrollCalls)}.`);
}
if (app.getFeaturedStripNearestIndex(scroller) !== 1) {
  throw new Error('The featured counter must advance to 2 / 2 after scrolling to the second ad.');
}

app.scrollFeaturedStripToIndex(scroller, 0, { smooth: false });
if (scrollCalls.at(-1)?.left !== 0 || scrollCalls.at(-1)?.behavior !== 'auto') {
  throw new Error('Previous featured ad must return directly to card 1.');
}

// Only an explicit country or confirmed location can label Services.
context.navigator.language = 'en-US';
app.servicesFeedFilters = {};
app.getCurrentLocationDefaultParts = () => ({});
assert.equal(app.getServicesFeaturedCountry(), '');
app.servicesFeedFilters.country = 'Canada';
assert.equal(app.getServicesFeaturedCountry(), 'Canada');
app.servicesFeedFilters.country = '';
app.getCurrentLocationDefaultParts = () => ({ country: 'Canada' });
assert.equal(app.getServicesFeaturedCountry(), 'Canada');
const featuredHeading = { textContent: '' };
context.document.getElementById = () => featuredHeading;
app.syncServicesFeaturedHeading();
assert.equal(featuredHeading.textContent, 'Featured Services in Canada');
app.getCurrentLocationDefaultParts = () => ({});
app.syncServicesFeaturedHeading();
assert.equal(featuredHeading.textContent, 'Featured Services');
app.servicesFeedFilters.category = 'health_beauty';
app.syncServicesFeaturedHeading();
assert.equal(featuredHeading.textContent, 'Featured Beauty Services');

app.bindGlobalMobileCarouselSwipe = () => {};

// Only a deliberate drag captures the pointer; taps still reach the card.
context.window.matchMedia = () => ({ matches: false });
context.window.requestAnimationFrame = () => {};
const stripListeners = new Map();
let capturedPointers = 0;
const pointerStrip = {
  ...scroller,
  dataset: {},
  style: { setProperty() {} },
  getAttribute() { return null; },
  setAttribute() {},
  closest() { return null; },
  querySelectorAll(selector) { return selector === 'img' ? [] : cards; },
  addEventListener(type, listener) { stripListeners.set(type, listener); },
  setPointerCapture() { capturedPointers++; },
  releasePointerCapture() {}
};
context.document.querySelectorAll = () => [pointerStrip];
app.bindFeaturedAdStripScrollers();
const pointerEvent = { pointerId: 7, pointerType: 'mouse', button: 0, clientX: 200, target: { closest: () => null } };
stripListeners.get('pointerdown')(pointerEvent);
assert.equal(capturedPointers, 0, 'A tap must retain its card target.');
stripListeners.get('pointerup')(pointerEvent);
let clickPrevented = false;
const clickEvent = { preventDefault() { clickPrevented = true; }, stopPropagation() {} };
stripListeners.get('click')(clickEvent);
assert.equal(clickPrevented, false);
stripListeners.get('pointerdown')(pointerEvent);
stripListeners.get('pointermove')({ ...pointerEvent, clientX: 100 });
assert.equal(capturedPointers, 1, 'Dragging must capture only after movement.');
stripListeners.get('pointerup')({ ...pointerEvent, clientX: 100 });
stripListeners.get('click')(clickEvent);
assert.equal(clickPrevented, true, 'Dragging must not also open the ad.');
stripListeners.get('pointerdown')({ ...pointerEvent, target: { closest: (selector) => selector === '.carousel-track' ? {} : null } });
stripListeners.get('pointermove')({ ...pointerEvent, clientX: 100 });
assert.equal(capturedPointers, 1, 'Photo gestures must stay inside the photo gallery.');

console.log('Featured carousel tests passed: navigation, confirmed countries, and tap/drag separation.');
