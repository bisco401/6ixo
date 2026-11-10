import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const elements = new Map();
function field(id, value = '') {
  const element = { id, value, tagName: 'INPUT', dataset: {}, classList: { toggle() {}, contains() { return false; } }, querySelectorAll: () => [], setAttribute() {} };
  elements.set(id, element);
  return element;
}
const grid = field('realestate-grid');
const count = field('realestate-count');
const pagination = field('realestate-pagination');
const city = field('realestate-city', 'Toronto');
const country = field('realestate-country', 'Canada');
field('realestate-location');
field('realestate-content');
const context = {
  console,
  window: { matchMedia: () => ({ matches: false }), localStorage: { getItem: () => null } },
  document: { getElementById: id => elements.get(id) || null, querySelectorAll: () => [], querySelector: () => null }
};
vm.runInNewContext(`${source.slice(0, source.indexOf('// Initialize the app when the page loads'))}\nglobalThis.App = DatingApp;`, context);
const app = Object.assign(Object.create(context.App.prototype), {
  strictDeviceLocation: false, currentUser: {}, bindImageCarousels() {},
  realestateListings: [
    { id: 'local', title: 'Toronto apartment', city: 'Toronto', country: 'Canada', location: 'Toronto, Ontario, Canada' },
    { id: 'alias', title: 'Toronto basement', city: 'City of Toronto', country: 'Canada', location: 'City of Toronto, Ontario, Canada' },
    { id: 'other-city', title: 'Ottawa apartment', city: 'Ottawa', country: 'Canada', location: 'Ottawa, Ontario, Canada' },
    { id: 'other-country', title: 'Toronto abroad', city: 'Toronto', country: 'United States', location: 'Toronto, Ohio, United States' }
  ].map(item => ({ ...item, categories: ['for_rent'], images: ['listing.jpg'], date: '2026-10-03', price: '$1000 /mo' }))
});

app.renderRealestateFeed('all');
assert.equal(count.textContent, '2 results');
assert.match(grid.innerHTML, /Toronto apartment/);
assert.match(grid.innerHTML, /Toronto basement/);
assert.doesNotMatch(grid.innerHTML, /Ottawa apartment|Toronto abroad/);
city.value = '';
app.renderRealestateFeed('all');
assert.equal(count.textContent, '3 results', 'Selecting Canada includes all its cities.');
country.value = 'United States';
city.value = 'Toronto';
app.renderRealestateFeed('all');
assert.equal(count.textContent, '1 result');
assert.match(grid.innerHTML, /Toronto abroad/);
assert.doesNotMatch(grid.innerHTML, /Toronto apartment|Toronto basement/);

// A first-time visitor must be able to browse and select a destination while
// GPS is pending or denied. Other public feeds now have the same behavior.
app.strictDeviceLocation = true;
app.didApplyEntryLocationDefaults = false;
app.getCurrentLocationDisplayText = () => '';
app.getCurrentLocationDefaultParts = () => ({});
city.value = '';
country.value = '';
app.renderRealestateFeed('all');
assert.equal(count.textContent, '4 results', 'Properties load before GPS resolves.');
assert.equal(app.matchesListingLocationScope(app.realestateListings[0]), true, 'Public feeds also browse without device location.');
country.value = 'Canada';
app.renderRealestateFeed('all');
assert.equal(count.textContent, '3 results', 'An explicit country works without device permission.');
assert.doesNotMatch(grid.innerHTML, /Toronto abroad/);
city.value = 'Toronto';
app.locationPermissionState = 'denied';
app.renderRealestateFeed('all');
assert.equal(count.textContent, '2 results', 'Denying GPS preserves the selected destination.');
assert.match(grid.innerHTML, /Toronto apartment/);
assert.doesNotMatch(grid.innerHTML, /Ottawa apartment|Toronto abroad/);
country.value = 'United States';
app.renderRealestateFeed('all');
assert.equal(count.textContent, '1 result', 'Country changes exclude same-named cities abroad.');
city.value = '';
country.value = '';
app.getCurrentLocationDefaultParts = () => ({ city: 'Toronto', country: 'Canada' });
app.renderRealestateFeed('all');
assert.equal(count.textContent, '3 results', 'A known location supplies the default country.');
country.value = 'United States';
app.renderRealestateFeed('all');
assert.equal(count.textContent, '1 result', 'A destination overrides the known device country.');

app.getCurrentLocationDefaultParts = () => ({});
country.value = '';
app.realestateListings = Array.from({ length: 40 }, (_, index) => ({
  ...app.realestateListings[0], id: `property-${index}`, city: index < 20 ? 'Toronto' : 'Ottawa'
}));
app.renderRealestateFeed('all');
const cardCount = () => (grid.innerHTML.match(/class="dating-feed-card vehicle-feed-card realestate-feed-card"/g) || []).length;
assert.equal(count.textContent, '40 results', 'The count includes the entire matching inventory.');
assert.equal(cardCount(), 12, 'Opening Real Estate must not create hundreds of cards at once.');
assert.match(pagination.innerHTML, /Showing 12 of 40/);
pagination.onclick({ target: { closest: () => ({}) } });
assert.equal(cardCount(), 24, 'Show more exposes the next batch.');
app.renderRealestateFeed('all');
assert.equal(cardCount(), 24, 'A background feed refresh keeps the expanded batch.');
city.value = 'Ottawa';
app.renderRealestateFeed('all');
assert.equal(count.textContent, '20 results');
assert.equal(cardCount(), 12, 'Changing destination starts a fresh first batch.');
pagination.onclick({ target: { closest: () => ({}) } });
assert.equal(cardCount(), 20);
assert.equal(pagination.innerHTML, '', 'The final batch does not leave a nonfunctional Show more button.');

console.log('Real estate location passed: pending/denied GPS, destination changes, country defaults, city aliases and isolation from other feeds.');
