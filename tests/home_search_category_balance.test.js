const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadDatingAppClass() {
    const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    const classList = { add() {}, remove() {}, contains() { return false; } };
    const document = {
        addEventListener() {}, body: { appendChild() {} }, cookie: '',
        documentElement: { classList }, getElementById() { return null; },
        querySelectorAll() { return []; }
    };
    const storage = { getItem() { return null; }, setItem() {}, removeItem() {} };
    const context = {
        URL, URLSearchParams, TextEncoder, clearInterval, clearTimeout, console,
        crypto: globalThis.crypto, document, localStorage: storage, navigator: {},
        requestAnimationFrame(callback) { return callback(); }, setInterval, setTimeout,
        window: {
            addEventListener() {}, crypto: globalThis.crypto,
            location: { href: 'http://localhost:8000/', hostname: 'localhost', protocol: 'http:' },
            localStorage: storage, TextEncoder
        }
    };
    context.window.window = context.window;
    context.window.document = document;
    vm.createContext(context);
    vm.runInContext(`${source}\nthis.__DatingApp = DatingApp;`, context, { filename: 'app.js' });
    return context.__DatingApp;
}

const DatingApp = loadDatingAppClass();

test('the imported loader includes the independent country feeds', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    assert.match(source, /data\/guyana-listings\.csv\?fresh=/);
    assert.match(source, /data\/kenya-listings\.csv\?fresh=/);
});

function entry(type, id, category, sourceRowId = id) {
    return { type, id, raw: { category, sourceRowId } };
}

test('home result groups use marketplace categories', () => {
    const app = Object.create(DatingApp.prototype);
    assert.equal(app.getHomeResultGroupKey(entry('marketplace', '1', 'electronics')), 'electronics');
    assert.equal(app.getHomeResultGroupKey(entry('marketplace', '2', 'clothing')), 'clothing');
    assert.equal(app.getHomeResultGroupKey(entry('vehicle', '3', 'vehicles')), 'vehicles');
    assert.equal(app.getHomeResultSectionLabel('buy_sell'), 'Buy & Sell');
});

test('home result dedupe prefers a specialized card for the same source row', () => {
    const app = Object.create(DatingApp.prototype);
    const deduped = app.dedupeHomeSearchResults([
        entry('marketplace', '1', 'services', 'sebu-1'),
        entry('service', '1', 'services', 'sebu-1'),
        entry('marketplace', '2', 'electronics', 'sebu-2'),
    ]);
    assert.equal(deduped.length, 2);
    assert.equal(deduped[0].type, 'service');
});

test('location-only result balancing puts every category on the first page', () => {
    const app = Object.create(DatingApp.prototype);
    const categories = [
        ['vehicle', 'vehicles'], ['realestate', 'real_estate'],
        ['marketplace', 'electronics'], ['marketplace', 'clothing'],
        ['marketplace', 'jobs'], ['service', 'services'],
        ['marketplace', 'beauty'], ['marketplace', 'buy_sell'],
        ['marketplace', 'community'],
    ];
    const items = [];
    categories.forEach(([type, category], groupIndex) => {
        items.push(entry(type, `${groupIndex}-new`, category));
        items.push(entry(type, `${groupIndex}-old`, category));
    });
    const balanced = app.balanceHomeSearchResults(items);
    const firstPageGroups = new Set(balanced.slice(0, 12).map((item) => app.getHomeResultGroupKey(item)));
    assert.equal(firstPageGroups.size, categories.length);
    categories.forEach(([, category], groupIndex) => {
        const groupItems = balanced.filter((item) => app.getHomeResultGroupKey(item) === category);
        assert.equal(groupItems[0].id, `${groupIndex}-new`);
    });
});
