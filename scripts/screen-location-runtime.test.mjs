import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const elements = new Map();
const screens = new Map();
class Field extends EventTarget {
    constructor(tagName = 'INPUT') {
        super(); this.tagName = tagName; this.dataset = {}; this.options = []; this.children = [];
        this.className = 'filter-input'; this.attributes = {}; this.hidden = false; this.labels = [];
        this.style = { setProperty() {} }; this.offsetWidth = 320; this.scrollHeight = 200;
    }
    get value() { return this._value || ''; }
    set value(value) { this._value = String(value); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] || null; }
    removeAttribute(name) { delete this.attributes[name]; }
    append(...children) { this.children.push(...children); }
    add(option) { this.options.push(option); }
    replaceChildren(...children) { this.children = children; }
    insertAdjacentElement(_, input) { input.screen = this.screen; elements.set(input.id, input); }
    closest(selector) { return selector === '.content-screen' ? this.screen : this.tagName === 'BUTTON' ? this : null; }
    contains(element) { return this.children.includes(element) || this.children.some(child => child.contains?.(element)); }
    getBoundingClientRect() { return { left: 20, top: 20, bottom: 64, width: 320 }; }
    scrollIntoView() {}
    focus() { document.activeElement = this; this.dispatchEvent(new Event('focus')); }
    click() { this.clicks = (this.clicks || 0) + 1; }
}
class Select extends Field {
    constructor() { super('SELECT'); }
    get value() { return this._value || ''; }
    set value(value) { this._value = String(value); }
}
const document = new EventTarget();
Object.assign(document, {
    getElementById: id => elements.get(id) || null,
    createElement: tag => new Field(tag.toUpperCase()),
    body: new Field('BODY'), activeElement: null
});
const window = Object.assign(new EventTarget(), { innerWidth: 1280, innerHeight: 900 });
const context = vm.createContext({ window, document, Event, setTimeout, clearTimeout, AbortController,
    HTMLInputElement: Field, HTMLSelectElement: Select, MutationObserver: class { observe() {} },
    Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    fetch: async url => {
        assert.match(url, /^\/data\/geography\/search\/[\w-]+\.json\?v=/);
        return { ok: true, json: async () => JSON.parse(readFileSync(new URL(url.slice(1).split('?')[0], root), 'utf8')) };
    }
});
vm.runInContext(readFileSync(new URL('location-autocomplete.js', root), 'utf8'), context);
const source = readFileSync(new URL('screen-location-search.js', root), 'utf8');
// Inventory the public groups before installing their actual DOM listeners.
const inventory = {};
vm.runInNewContext(source, inventory);
const html = readFileSync(new URL('index.html', root), 'utf8');
const groups = inventory.SIXO_SCREEN_LOCATION_SEARCH.groups.filter(([, city]) => html.includes(`id="${city}"`));
for (const [country, city, region] of groups) {
    const screen = {}; screens.set(city, screen);
    for (const id of [country, city, region].filter(Boolean)) {
        const field = new RegExp(`<select[^>]*id="${id}"`).test(html) ? new Select() : new Field();
        field.id = id; field.screen = screen; elements.set(id, field);
    }
    if (country) {
        elements.get(country).value = 'Canada';
        elements.get(country).addEventListener('change', () => { elements.get(city).value = ''; });
    } else elements.get(city).dataset.locationCountry = 'Canada';
}
vm.runInContext(source, context);
const settle = () => new Promise(setImmediate);
const enter = input => { const event = new Event('keydown'); Object.defineProperty(event, 'key', { value: 'Enter' }); input.dispatchEvent(event); };
for (const [country, city] of groups) {
    const input = elements.get(`${city}-autocomplete`);
    // No input event: browser autofill must still resolve on Enter.
    input.value = 'London'; enter(input); await settle();
    assert.equal(elements.get(city).value, 'London', city);
    assert.equal(country ? elements.get(country).value : elements.get(city).dataset.locationCountry, 'Canada', `${city}: city-only edits must respect the selected country`);
    input.value = 'London, United Kingdom'; enter(input); await settle();
    assert.equal(country ? elements.get(country).value : elements.get(city).dataset.locationCountry, 'United Kingdom', `${city}: an explicit qualifier can change the country`);
}

const pair = groups.find(([country]) => country === 'electronics-country');
const [country, city] = pair;
const countryInput = elements.get(`${country}-autocomplete`);
const cityInput = elements.get(`${city}-autocomplete`);
countryInput.value = 'Kenya'; cityInput.value = 'Nairobi';
const button = new Field('BUTTON'); button.textContent = 'Apply filters'; button.screen = screens.get(city);
const click = new Event('click', { cancelable: true }); Object.defineProperty(click, 'target', { value: button });
document.dispatchEvent(click); await settle();
assert.equal(elements.get(country).value, 'Kenya');
assert.equal(elements.get(city).value, 'Nairobi', 'Search commits both autofilled fields without losing the city');
assert.equal(button.clicks, 1, 'Apply is forwarded once after the complete area is confirmed');

countryInput.value = 'China'; enter(countryInput); await settle();
cityInput.value = 'London'; enter(cityInput); await settle();
assert.equal(elements.get(country).value, 'China', 'A missing city in the selected country must not switch countries');
assert.equal(elements.get(city).value, '');
assert.equal(cityInput.getAttribute('aria-invalid'), 'true');

countryInput.focus(); countryInput.value = 'Canada'; countryInput.dispatchEvent(new Event('input'));
const fieldClick = new Event('click'); Object.defineProperty(fieldClick, 'target', { value: cityInput });
document.dispatchEvent(fieldClick);
cityInput.focus(); cityInput.value = 'London'; cityInput.dispatchEvent(new Event('input'));
enter(cityInput); await settle();
assert.equal(elements.get(country).value, 'Canada', 'Moving between fields preserves an unfinished country edit');
assert.equal(elements.get(city).value, 'London');
assert.equal(cityInput.getAttribute('aria-invalid'), null);

// Existing Clear filters handlers reset backing values, retaining old metadata.
// An empty country control must mean worldwide, even after a prior selection.
elements.get(country).value = ''; elements.get(city).value = '';
cityInput.value = 'London'; enter(cityInput); await settle();
assert.equal(elements.get(country).value, 'United Kingdom', 'Cleared country filters search worldwide rather than reusing stale metadata');

for (const [nextCountry, nextCity] of [
    ['Canada', 'Hamilton'], ['Jamaica', 'Kingston'], ['Kenya', 'Nairobi'],
    ['United Arab Emirates', 'Dubai'], ['Guyana', 'Georgetown'], ['Ghana', 'Accra'],
    ['United States', 'Houston'], ['China', 'Guangzhou']
]) {
    countryInput.value = nextCountry; cityInput.value = nextCity;
    const action = new Event('click', { cancelable: true }); Object.defineProperty(action, 'target', { value: button });
    document.dispatchEvent(action); await settle();
    assert.equal(elements.get(country).value, nextCountry, `${nextCity}: country is committed`);
    assert.equal(elements.get(city).value, nextCity, `${nextCity}: city is committed`);
}
console.log(`Screen location runtime passed: all ${groups.length} control groups, eight listing countries, selected-country isolation, explicit country changes and autofilled Search.`);
