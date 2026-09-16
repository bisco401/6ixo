const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

function makeApp() {
    const context = { console, Date, Map, Set, URL, URLSearchParams };
    vm.runInNewContext(`${source.slice(0, source.indexOf('// Initialize the app when the page loads'))}\nglobalThis.App = DatingApp;`, context);
    return { app: Object.create(context.App.prototype), context };
}

test('the photographed Ghana seat-cover listing opens its original seller description', () => {
    const { app, context } = makeApp();
    const rows = app.parseCsvRows(fs.readFileSync(path.join(root, 'data/oxglow-auto-parts-accessories-recent.csv'), 'utf8'));
    const row = rows.find(row => row.url === 'https://oxglow.com.gh/listing/car-seat-cover-74078');
    assert.ok(row, 'The reported seat-cover listing exists');
    const item = app.normalizeOxglowAutoPartsRow(row);
    assert.ok(item);
    assert.notEqual(item.description, row.description, 'The card still has a concise summary');
    assert.equal(app.getMarketplaceFullDescription(item), row.description);
    assert.match(app.getMarketplaceFullDescription(item), /let's us talk/);

    const element = () => ({
        textContent: '', scrollTop: 10,
        classList: { add() {}, remove() {} },
        setAttribute() {}, focus() {}, querySelector() { return element(); }
    });
    const elements = new Map(['vehicle-description-dialog', 'vehicle-description-dialog-close',
        'vehicle-description-dialog-listing', 'vehicle-description-dialog-body',
        'vehicle-modal-desc', 'vehicle-modal'].map(id => [id, element()]));
    context.document = {
        getElementById: id => elements.get(id),
        createElement: () => ({ set innerHTML(value) { this.value = value; } }),
        body: element()
    };
    context.requestAnimationFrame = callback => callback();
    app.syncOverlayViewportMeta = () => {};
    app.activeVehicleListing = item;
    app.openVehicleDescriptionDialog();
    assert.equal(elements.get('vehicle-description-dialog-body').textContent, row.description);
});

test('all published Ghana imports retain the complete source text through normalization', () => {
    const { app } = makeApp();
    const feeds = [
        ['data/oxglow-auto-parts-accessories-recent.csv', 'normalizeOxglowAutoPartsRow'],
        ['data/oxglow-electronics-recent.csv', 'normalizeOxglowElectronicsRow'],
        ['data/oxglow-real-estate-recent.csv', 'normalizeOxglowRealestateRow'],
        ['data/scraped-listings.csv', 'normalizeCsvScrapedListingRow']
    ];
    let count = 0;
    for (const [file, normalize] of feeds) {
        const rows = app.parseCsvRows(fs.readFileSync(path.join(root, file), 'utf8'));
        for (const row of rows) {
            if ((row.status || 'published') !== 'published' || !row.description) continue;
            if (file === 'data/scraped-listings.csv' && row.country !== 'Ghana') continue;
            const normalized = app[normalize](row);
            assert.ok(normalized, `${file}: ${row.title} normalizes`);
            const item = normalized.item || normalized;
            const expected = app.decodeScrapedDescription(row.description);
            assert.equal(app.getMarketplaceFullDescription(item), expected, `${file}: ${row.title}`);
            if (item.category === 'real_estate') {
                const profile = app.buildRealestateFeedEntryFromMarketplaceItem(item);
                assert.equal(app.getMarketplaceFullDescription(profile), expected, 'Property profile retains the full text');
            }
            count++;
        }
    }
    assert.ok(count > 50, `Expected Ghana feed coverage, checked ${count}`);
});

test('full descriptions preserve late sentences and contact details without rendering source HTML', () => {
    const { app } = makeApp();
    const raw = `<p>${'This vehicle includes documented maintenance and new parts. '.repeat(20)}</p><p>Call after 6 p.m. for collection &amp; delivery.</p><script>unwanted()</script>`;
    const item = { description: app.cleanScrapedListingDescription(raw), fullDescription: raw, source: { type: 'scraped_csv' } };
    assert.ok(item.description.length <= 620);
    const full = app.getMarketplaceFullDescription(item);
    assert.ok(full.length > 620);
    assert.match(full, /Call after 6 p\.m\. for collection & delivery\.$/);
    assert.doesNotMatch(full, /<\/?p>|<script|unwanted\(\)/);
    assert.equal(app.getMarketplaceFullDescription({ description: 'My original description.', source: { type: 'user' } }), 'My original description.');
    assert.equal(app.getMarketplaceFullDescription({}, 'No description provided yet.'), 'No description provided yet.');
});
