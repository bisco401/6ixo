import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

class Field extends EventTarget {
    constructor(tagName = 'INPUT') {
        super(); this.tagName = tagName; this.dataset = {}; this.value = ''; this.options = [];
    }
    setAttribute() {}
    add(option) { this.options.push(option); }
    replaceChildren(...options) { this.options = options; this.value = options[0]?.value || ''; }
}
function Option(text, value) { this.text = text; this.value = value; }
const root = new URL('../', import.meta.url);
const context = { Event, Option };
vm.runInNewContext(readFileSync(new URL('screen-location-search.js', root), 'utf8'), context);
const { applySelection, groups } = context.SIXO_SCREEN_LOCATION_SEARCH;
const atlanta = { city: 'Atlanta', country: 'United States', region: 'Georgia' };
const html = readFileSync(new URL('index.html', root), 'utf8');
assert.equal(groups.filter(([country, city]) => html.includes(`id="${city}"`)).length, 14);

// Exercise all backing-control shapes with country listeners that clear cities,
// as the existing category screens do. Downstream filters must see canonical pairs.
for (const [countryId, cityId, regionId] of groups) {
    if (!html.includes(`id="${cityId}"`)) continue;
    const tag = id => new RegExp(`<select[^>]*id="${id}"`).test(html) ? 'SELECT' : 'INPUT';
    const group = { country: countryId ? new Field(tag(countryId)) : null, city: new Field(tag(cityId)), region: regionId ? new Field() : null };
    let selected;
    group.country?.addEventListener('change', () => { group.city.value = ''; });
    group.city.addEventListener('change', () => { selected = { city: group.city.value, country: group.country?.value || group.city.dataset.locationCountry }; });
    applySelection(group, atlanta);
    assert.deepEqual(selected, { city: 'Atlanta', country: 'United States' }, cityId);
    if (group.region) assert.equal(group.region.value, 'Georgia');
    applySelection(group, { country: 'Kenya', city: '', region: '' }, 'country');
    assert.deepEqual(selected, { city: '', country: 'Kenya' }, 'Country selection clears previous city');
    applySelection(group, atlanta);
    applySelection(group, null, 'city');
    assert.equal(selected.city, '');
    if (group.country) assert.equal(selected.country, 'United States', 'Clearing city preserves country');
    applySelection(group, null, 'country');
    assert.deepEqual(selected, { city: '', country: '' }, 'Clearing country clears the pair');
}

// Use the actual category dropdown handlers: a marked autocomplete commit must
// not schedule the old 180ms clear-city timer or an external city request.
const elements = { country: new Field(), city: new Field('SELECT'), hidden: new Field() };
let timerCount = 0, fetchCount = 0, selection;
const appSource = readFileSync(new URL('app.js', root), 'utf8');
const appContext = {
    console, Option,
    document: { getElementById: id => elements[id] },
    window: { setTimeout() { timerCount++; }, clearTimeout() {} }
};
vm.runInNewContext(appSource.slice(0, appSource.indexOf('// Initialize the app when the page loads')) + '\nglobalThis.App = DatingApp;', appContext);
const app = Object.create(appContext.App.prototype);
Object.assign(app, {
    ensureDatalist: () => ({ id: 'countries' }), ensureWorldCountries: async () => [], fillDatalist() {},
    fetchCountriesNowCities() { fetchCount++; return Promise.resolve(['Old city']); }
});
elements.city.dataset.locationSearchSource = '1';
app.bindCountryCityDropdown({ countryId: 'country', cityId: 'city', hiddenId: 'hidden', onChange: next => { selection = next; } });
applySelection({ country: elements.country, city: elements.city }, atlanta);
await Promise.resolve();
assert.equal(selection.city, 'Atlanta');
assert.equal(selection.country, 'United States');
assert.equal(elements.hidden.value, 'Atlanta, United States');
assert.equal(elements.city.value, 'Atlanta');
assert.equal(timerCount, 0, 'No delayed reset after choosing a city');
assert.equal(fetchCount, 0, 'No external city fetch competes with local autocomplete');

// City-only discovery must not silently search around the device in a different country.
app.hookupPlusFilters = { city: 'Atlanta', country: 'United States', radiusKm: 10 };
app.companionshipCityGeo = {};
app.hasUsableCurrentLocation = () => true;
app.userLocation = { lat: 43.6, lng: -79.3 };
assert.equal(app.resolveHookupPlusCenter(), null);
app.companionshipCityGeo = { 'Atlanta|United States': { lat: 33.7, lng: -84.4 } };
assert.equal(app.resolveHookupPlusCenter().lat, 33.7);
app.datingCategoryFeeds = {};
app.users = [
    { id: 1, name: 'Atlanta US', location: { city: 'Atlanta', country: 'United States' } },
    { id: 2, name: 'Atlanta elsewhere', location: { city: 'Atlanta', country: 'Canada' } },
    { id: 3, name: 'Toronto', location: { city: 'Toronto', country: 'Canada' } }
];
assert.deepEqual(Array.from(app.buildHookupPlusDeck().deck, p => p.name), ['Atlanta US']);
console.log('Screen location search passed: all 14 groups, city/country commits, clears, existing category handlers, delayed reset prevention, and city-only country scope.');
