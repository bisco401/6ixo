import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const source = readFileSync(new URL('app.js', root), 'utf8');
const picker = readFileSync(new URL('area-picker.js', root), 'utf8');
const rows = [
    { id: 'toronto', city: 'Toronto', country: 'Canada' },
    { id: 'vancouver', city: 'Vancouver', country: 'Canada' },
    { id: 'nairobi', city: 'Nairobi', country: 'Kenya' }
];
class Element {
    value = ''; dataset = {}; hidden = true; events = {}; children = []; attributes = {};
    addEventListener(name, handler) { this.events[name] = handler; }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this.attributes[name]; }
    replaceChildren() { this.children = []; }
    append(...children) { this.children.push(...children); }
    scrollIntoView() {}
    contains() { return false; }
    focus() {}
}
function fixture() {
    const elements = Object.fromEntries([
        'main-app', 'home-search-location', 'area-picker', 'area-picker-countries',
        'area-picker-status', 'area-picker-retry'
    ].map(id => [id, new Element()]));
    let dismissals = 0;
    const document = {
        visibilityState: 'visible', activeElement: null,
        getElementById: id => elements[id] || null,
        querySelectorAll: () => [], querySelector: () => null,
        addEventListener() {}, createElement: () => new Element()
    };
    const window = {
        setTimeout, clearTimeout,
        localStorage: { removeItem() {} },
        SIXO_LOCATION_ENTRY: { dismiss() { dismissals++; } },
        SIXO_LOCATION_AUTOCOMPLETE: { search: async query => {
            const normalized = query.trim().toLowerCase();
            const row = rows.find(row => normalized === row.city.toLowerCase()
                || normalized === `${row.city}, ${row.country}`.toLowerCase());
            if (row) return [{ ...row, label: `${row.city}, ${row.country}`, type: 'city' }];
            return normalized === 'canada' ? [{ city: '', country: 'Canada', label: 'Canada', type: 'country' }] : [];
        } }
    };
    const context = vm.createContext({ window, document, console, URL, URLSearchParams, setTimeout, clearTimeout,
        navigator: { geolocation: { getCurrentPosition() { throw new Error('Manual search must not request GPS'); } } } });
    vm.runInContext(source.slice(0, source.indexOf('// Initialize the app when the page loads')) + '\nglobalThis.App = DatingApp;', context);
    const app = Object.assign(Object.create(context.App.prototype), {
        strictDeviceLocation: true, locationPermissionState: 'denied', hasBrowserGeolocation: false,
        deviceLocationFeedsReady: false, didApplyEntryLocationDefaults: false, activeScreen: 'home',
        currentUser: { location: {} }, userLocation: null, renders: [],
        getHomeSearchLocationEntries: () => rows,
        populateHomeCityDropdown() {}, updateMarketplaceLocationControls() {},
        applyHomeSmartSearchIntentToControls() {}, rememberHomeRecentSearch() {}, hideHomeSmartSuggestions() {},
        applyResolvedLocationDefaults() { this.setHomeLocationControls({ ...this.manualDiscoveryLocation, auto: true }); },
        applyHomeFilters() {
            const selected = this.getHomeSearchLocationSelection();
            const scope = this.getHomeListingLocationScope({ text: selected.text, interpretedCity: selected.city, interpretedCountry: selected.country });
            this.renders.push(rows.filter(row => this.matchesListingLocationScope(row, scope)).map(row => row.id));
        },
        renderHomePersonalizedRows() {}, renderHomeTodayDeals() {}
    });
    vm.runInContext(picker, context);
    window.SIXO_AREA_PICKER.setup(app);
    app.updateDeviceLocationUi();
    return { app, window, field: elements['home-search-location'], elements, dismissals: () => dismissals };
}

// Safari autofill, restored controls and early typing may supply a value without
// the picker's input event. Search must still commit that explicit area.
const typed = fixture();
typed.field.value = 'Toronto, Canada';
await typed.app.submitHomeSearch();
assert.equal(typed.app.getCurrentLocationDisplayText(), 'Toronto, Canada');
assert.equal(typed.elements['main-app'].dataset.deviceLocationReady, 'true');
assert.deepEqual(typed.app.renders.at(-1), ['toronto']);
assert.equal(typed.app.userLocation, null);
assert.equal(typed.app.locationPermissionState, 'denied');
assert.ok(typed.dismissals() > 0);

typed.field.value = 'Nairobi, Kenya';
await typed.app.submitHomeSearch();
assert.equal(typed.app.getCurrentLocationDisplayText(), 'Nairobi, Kenya');
assert.deepEqual(typed.app.renders.at(-1), ['nairobi'], 'An edited manual value must replace the previous browsing area');

const country = fixture();
country.field.value = 'Canada';
await country.app.submitHomeSearch();
assert.deepEqual(country.app.renders.at(-1), ['toronto', 'vancouver']);

const immediate = fixture();
immediate.field.events.focus();
immediate.field.value = 'Toronto, Canada';
immediate.field.events.input();
await immediate.app.submitHomeSearch();
assert.deepEqual(immediate.app.renders.at(-1), ['toronto'], 'Search waits for confirmation even before suggestions render');

const invalid = fixture();
invalid.field.value = 'Toronto, Kenya';
await invalid.app.submitHomeSearch();
assert.equal(invalid.app.getCurrentLocationDisplayText(), '');
assert.equal(invalid.elements['main-app'].dataset.deviceLocationReady, 'false');
assert.equal(invalid.app.renders.length, 0, 'An invalid qualifier must not expose a different location');
assert.match(invalid.elements['area-picker-status'].textContent, /No matching locations/);

const safariBlur = fixture();
let finishLookup;
safariBlur.window.SIXO_LOCATION_AUTOCOMPLETE.search = () => new Promise(resolve => { finishLookup = resolve; });
safariBlur.field.value = 'Toronto, Canada';
const searching = safariBlur.app.submitHomeSearch();
safariBlur.field.events.blur({ relatedTarget: null });
finishLookup([{ city: 'Toronto', country: 'Canada', label: 'Toronto, Canada', type: 'city' }]);
await searching;
assert.deepEqual(safariBlur.app.renders.at(-1), ['toronto'], 'A Safari blur without a related target cannot cancel an explicit Search');
console.log('Manual Home search passed: denied GPS, direct typed values, edited areas, countries, immediate Search, Safari blur and invalid qualifiers.');
