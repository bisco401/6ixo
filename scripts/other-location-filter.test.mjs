import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const storage = new Map();
const context = { console, window: { localStorage: {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value)
} } };
vm.runInNewContext(`${source.slice(0, source.indexOf('// Initialize the app when the page loads'))}\nglobalThis.App = DatingApp;`, context);
const app = Object.create(context.App.prototype);
app.marketplaceItems = [
    { id: 1, category: 'other', city: 'Hamilton', country: 'Canada', title: 'Blue chair', condition: 'good', subcategory: 'furniture_home_decor' },
    { id: 2, category: 'other', city: 'Toronto', country: 'Canada', title: 'Blue chair', condition: 'new', subcategory: 'furniture_home_decor' },
    { id: 3, category: 'other', city: 'Hamilton', country: 'United States', title: 'Blue chair', condition: 'good', subcategory: 'furniture_home_decor' },
    { id: 4, category: 'electronics', city: 'Hamilton', country: 'Canada', title: 'Phone' },
    { id: 5, category: 'other', city: 'Hamilton', country: 'CA', title: 'Wrench', condition: 'new', subcategory: 'tools_equipment' }
];
const ids = () => Array.from(app.getFilteredOtherItems().items, (item) => item.id);
app.otherFilters = {};
assert.deepEqual(ids(), [1, 2, 3, 5], 'Worldwide preserves all Other locations');
app.otherFilters = { country: 'Canada' };
assert.deepEqual(ids(), [1, 2, 5], 'All cities filters by country, including its aliases');
app.otherFilters.city = ' hAMilTon ';
assert.deepEqual(ids(), [1, 5], 'Same city names in other countries must be excluded');
assert.equal(app.getFilteredOtherItems().hasFilters, true);
app.otherFilters.term = 'chair';
assert.deepEqual(ids(), [1], 'Location combines with the existing search');
app.otherFilters = { country: 'Canada', city: 'Hamilton', condition: 'new', subcategory: 'tools_equipment' };
assert.deepEqual(ids(), [5], 'Location combines with category and condition');
app.otherFilters.city = 'Atlantis';
assert.deepEqual(ids(), [], 'Unknown city does not fall back to unrelated listings');
assert.equal(app.matchesOtherLocation({ city: 'New York', country: 'USA' }, { city: 'York', country: 'United States' }), false);
assert.equal(app.matchesOtherLocation({ city: 'New York City', country: 'USA' }, { city: 'New York', country: 'United States' }), true);

app.otherFilters = { country: 'Canada', city: 'Hamilton', term: 'chair' };
app.saveOtherLocationFilter();
app.otherFilters = { term: '' };
app.restoreOtherLocationFilter();
assert.equal(app.otherFilters.country, 'Canada');
assert.equal(app.otherFilters.city, 'Hamilton');
assert.equal(app.otherFilters.term, '', 'Only location is remembered');
app.otherFilters = { country: '', city: '' };
app.saveOtherLocationFilter();
app.otherFilters = {};
app.restoreOtherLocationFilter();
assert.equal(app.otherFilters.country, '', 'Worldwide remains cleared after refresh');
storage.set('otherLocationFilter_v1', '{invalid JSON');
assert.doesNotThrow(() => app.restoreOtherLocationFilter());
storage.set('otherLocationFilter_v1', JSON.stringify({ country: '', city: 'Hamilton' }));
app.restoreOtherLocationFilter();
assert.equal(app.otherFilters.city, '', 'A saved city cannot outlive its country');
context.window.localStorage.setItem = () => { throw new Error('Storage unavailable'); };
assert.doesNotThrow(() => app.saveOtherLocationFilter());
console.log('Other location tests passed: country/city matching, combined filters, aliases, and persistence.');
