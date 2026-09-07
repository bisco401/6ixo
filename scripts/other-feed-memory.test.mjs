import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const document = {};
const window = { location: { href: 'https://6ixo.com/' } };
const context = { window, document, URL, console };
vm.runInNewContext(`${source.slice(0, source.indexOf('// Initialize the app when the page loads'))}\nglobalThis.App = DatingApp;`, context);
const app = Object.create(context.App.prototype);
app.getCurrentListingLocationPriorityScope = () => ({});
app.shouldPrioritizeMarketplaceLocalListings = () => false;
app.getListingPostedTime = (item) => item.postedDate;
const inventory = Array.from({ length: 10001 }, (_, id) => ({ id, postedDate: id, category: 'other' }));

const first = app.getOtherListingPage(inventory);
assert.equal(first.items.length, 24);
assert.equal(first.items[0].id, 10000, 'newest listings come first');
const second = app.getOtherListingPage(inventory, 2);
assert.equal(second.items.length, 24);
assert.equal(second.items[0].id, 9976);
assert.equal(new Set([...first.items, ...second.items].map((item) => item.id)).size, 48, 'pages must not overlap');
const last = app.getOtherListingPage(inventory, Infinity);
assert.equal(last.page, last.pageCount);
assert.equal(last.items.length, 17);
assert.equal(last.items.at(-1).id, 0, 'oldest listing remains reachable');
assert.equal(app.getOtherListingPage(inventory, -1).page, 1);
assert.equal(app.getOtherListingPage([], 20).items.length, 0);
assert.equal(app.getOtherListingPage(inventory, 2.8).page, 2);
assert.equal(inventory[0].id, 0, 'paging must not mutate shared inventory');
app.shouldPrioritizeMarketplaceLocalListings = () => true;
app.compareListingLocalPriority = (a, b) => Number(b.local || 0) - Number(a.local || 0);
assert.equal(app.getOtherListingPage([...inventory, { id: 'local', postedDate: -1, local: true }]).items[0].id, 'local');
app.shouldPrioritizeMarketplaceLocalListings = () => false;

const fullImage = 'https://media.kijiji.ca/api/v1/images/example?rule=kijijica-1600-webp';
assert.match(app.getListingPreviewImageUrl(fullImage), /rule=kijijica-640-webp/);
assert.match(fullImage, /1600/, 'gallery source stays unchanged');
assert.equal(app.getListingPreviewImageUrl('https://example.com/photo.jpg'), 'https://example.com/photo.jpg');
assert.equal(app.getListingPreviewImageUrl('assets/photo.jpg'), 'assets/photo.jpg');
assert.equal(app.getListingPreviewImageUrl('https://media.kijiji.ca.example.com/photo.jpg'), 'https://media.kijiji.ca.example.com/photo.jpg');

// Exercise paging through the actual filter controller, including shrinking results.
const elements = new Map();
const feed = { insertAdjacentElement(_position, node) { elements.set(node.id, node); } };
const heading = { focus() {}, scrollIntoView() {} };
elements.set('other-items', feed);
elements.set('other-feed-title', heading);
elements.set('other-count', {});
document.getElementById = (id) => elements.get(id);
document.createElement = () => ({ setAttribute() {}, addEventListener(type, handler) { this[type] = handler; } });
let filtered = inventory;
let rendered;
app.getFilteredOtherItems = () => ({ items: filtered, label: 'Other', hasFilters: Boolean(app.otherFilters?.term) });
const originalRelease = app.releaseOtherFeedImages;
const originalBind = app.bindOtherFeedImages;
app.releaseOtherFeedImages = () => {};
app.bindOtherFeedImages = () => {};
app.renderMarketplaceFeedGroups = (items, options) => { rendered = { items, options }; };
app.applyOtherFilters();
assert.equal(rendered.items.length, 24);
assert.equal(rendered.options.deferImages, true, 'Other must opt in to deferred media');
const pagination = elements.get('other-pagination');
pagination.click({ target: { closest: () => ({ dataset: { otherPage: '2' } }) } });
assert.equal(app.otherPage, 2);
app.applyOtherFilters();
assert.equal(app.otherPage, 2, 'background refresh keeps current page');
app.otherFilters = { term: 'bed' };
app.applyOtherFilters();
assert.equal(app.otherPage, 1, 'filter changes reset pagination');
app.applyOtherFilters({ page: 400 });
filtered = inventory.slice(0, 25);
app.applyOtherFilters();
assert.equal(app.otherPage, 2, 'removing inventory clamps to a valid page');
assert.equal(rendered.items.length, 1);
filtered = [];
app.applyOtherFilters();
assert.equal(pagination.hidden, true);
assert.equal(pagination.innerHTML, '');
assert.equal(elements.get('other-count').textContent, '0 listings');

// Observer lifecycle: off-screen slides have no source and old callbacks cannot reload them.
app.releaseOtherFeedImages = originalRelease;
app.bindOtherFeedImages = originalBind;
const images = Array.from({ length: 8 }, (_, i) => ({
    dataset: { listingSrc: `https://example.com/${i}.jpg` }, isConnected: true,
    hasAttribute(name) { return name === 'src' && Boolean(this.src); },
    removeAttribute(name) { if (name === 'src') delete this.src; }
}));
let activeObserver;
window.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; this.observed = []; activeObserver = this; }
    observe(img) { this.observed.push(img); }
    disconnect() { this.disconnected = true; }
};
document.querySelectorAll = () => images;
feed.querySelectorAll = () => images;
app.bindOtherFeedImages(feed);
const oldObserver = activeObserver;
assert.equal(images.filter((img) => img.src).length, 0, 'binding must not fetch galleries');
oldObserver.callback([{ target: images[0], isIntersecting: true }]);
assert.equal(images.filter((img) => img.src).length, 1);
oldObserver.callback([{ target: images[0], isIntersecting: false }, { target: images[1], isIntersecting: true }]);
assert.equal(images[0].src, undefined, 'leaving the viewport releases the image source');
assert.equal(images[1].src, images[1].dataset.listingSrc);
app.releaseOtherFeedImages();
assert.equal(oldObserver.disconnected, true);
app.bindOtherFeedImages(feed);
oldObserver.callback([{ target: images[0], isIntersecting: true }]);
assert.equal(images[0].src, undefined, 'queued callbacks from an old page stay inactive');
images[0].isConnected = false;
activeObserver.callback([{ target: images[0], isIntersecting: true }]);
assert.equal(images[0].src, undefined, 'detached cards must not start requests');
app.releaseOtherFeedImages();
delete window.IntersectionObserver;
app.bindOtherFeedImages(feed);
assert.equal(images[1].src, images[1].dataset.listingSrc, 'older browsers retain native lazy images');

// Opening a deferred card must pass its original image, never add a preview to the gallery.
const originals = [fullImage, fullImage.replace('/example?', '/second?')];
const preview = { getAttribute: () => app.getListingPreviewImageUrl(originals[1]) };
const track = { children: [null, preview] };
const media = { querySelector: () => track };
const card = {
    dataset: { id: '123', deferListingImages: '1', images: originals.map(encodeURIComponent).join('|') },
    querySelector: () => media
};
const root = { dataset: {}, addEventListener(type, handler) { this[type] = handler; } };
app.getCarouselSlideWidth = () => 320;
app.getCarouselMaxIndex = () => 1;
app.getCarouselNearestIndex = () => 1;
let opened;
app.showItemDetails = (id, options) => { opened = { id, ...options }; };
app.bindMarketplaceCardInteractions(root);
root.click({ target: { closest: (selector) => selector === '.marketplace-item' ? card : null } });
assert.equal(opened.preferredPhotoIndex, 1);
assert.equal(opened.preferredPhotoSrc, originals[1]);
console.log('Other feed memory tests passed: bounded pages, filters, previews, image release, and observer cleanup.');
