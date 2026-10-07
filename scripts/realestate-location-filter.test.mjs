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
console.log('Real estate location passed: province labels, City of Toronto alias, other-country isolation and country-wide browsing.');
