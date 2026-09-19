import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

class Element {
    constructor() { this.value = ''; this.dataset = {}; this.hidden = true; this.events = {}; this.children = []; }
    addEventListener(name, handler) { this.events[name] = handler; }
    setAttribute() {}
    removeAttribute() {}
    replaceChildren() { this.children = []; }
    scrollIntoView() {}
    contains() { return false; }
}
const elements = Object.fromEntries(['home-search-location', 'area-picker', 'area-picker-countries', 'area-picker-status', 'area-picker-retry'].map(id => [id, new Element()]));
const field = elements['home-search-location'];
const app = {
    getHomeSearchLocationSelection() { return { text: field.value }; },
    updateHomeCurrentLocationDisplay() {
        if (!field.value || field.dataset.autoLocationDefault === '1') {
            field.value = 'Oakville, Canada';
            field.dataset.autoLocationDefault = '1';
        }
    }
};
const window = { SIXO_LOCATION_AUTOCOMPLETE: { search: async () => [] } };
const document = { getElementById: id => elements[id], addEventListener() {} };
vm.runInNewContext(readFileSync(new URL('../area-picker.js', import.meta.url), 'utf8'), { window, document, setTimeout, clearTimeout });
window.SIXO_AREA_PICKER.setup(app);
field.events.focus();
field.value = 'Atla';
field.events.input();
assert.ok(app.homeLocationDraft);
field.events.blur({ relatedTarget: null });
assert.equal(field.value, 'Oakville, Canada', 'Cancelling a draft opened before GPS resolved must restore the detected city');
assert.equal(app.homeLocationDraft, null);
field.value = 'Paris, France';
field.dataset.autoLocationDefault = '0';
field.events.focus();
field.value = 'Atla';
field.events.input();
field.events.blur({ relatedTarget: null });
assert.equal(field.value, 'Paris, France', 'Cancelling must retain an existing manual selection');
console.log('Area picker recovery passed: delayed GPS is restored after draft cancellation; manual selections are preserved.');
