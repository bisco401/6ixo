const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const classStart = source.indexOf('class DatingApp');
const classEnd = source.indexOf('// Initialize the app when the page loads');
const DatingApp = vm.runInNewContext(
    `${source.slice(classStart, classEnd)}\nDatingApp;`,
    { console, URL }
);
const parser = Object.create(DatingApp.prototype);

function readDubaiRows() {
    const csv = fs.readFileSync(path.join(root, 'data', 'dubai-listings.csv'), 'utf8');
    return parser.parseCsvRows(csv);
}

test('restores a broad set of unique, active Dubai listings', () => {
    const rows = readDubaiRows();
    assert.ok(rows.length >= 60, `expected at least 60 Dubai rows, found ${rows.length}`);
    assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
    assert.equal(new Set(rows.map((row) => row.source_url)).size, rows.length);

    rows.forEach((row) => {
        assert.equal(row.status, 'published');
        assert.equal(row.city, 'Dubai');
        assert.equal(row.country, 'United Arab Emirates');
        assert.equal(row.source_site, 'OpenSooq');
        assert.equal(row.source_availability, 'active');
        assert.match(row.source_url, /^https:\/\/ae\.opensooq\.com\/en\/search\/\d+$/);
        assert.ok(row.image_urls, `${row.id} has no photos`);
    });
});

test('Dubai inventory spans cars, phones, and furniture', () => {
    const rows = readDubaiRows();
    const categories = new Map();
    rows.forEach((row) => categories.set(row.app_category, (categories.get(row.app_category) || 0) + 1));

    assert.ok((categories.get('vehicles') || 0) >= 20);
    assert.ok((categories.get('electronics') || 0) >= 20);
    assert.ok((categories.get('buy_sell') || 0) >= 20);
});

test('uses clear OpenSooq gallery images and keeps contact on the source', () => {
    const rows = readDubaiRows();
    rows.forEach((row) => {
        assert.equal(row.phone, '');
        assert.doesNotMatch(row.description, /\{phone_key_\d+\}/i);
        const images = row.image_urls.split('|').filter(Boolean);
        assert.ok(images.length >= 1 && images.length <= 12);
        images.forEach((image) => {
            assert.match(
                image,
                /^https:\/\/opensooq-imagesv2\.os-cdn\.com\/previews\/2048x0\//,
                `${row.id} did not retain a clear source image`
            );
        });
    });
});

test('the CSV loader accepts source-contact-only OpenSooq rows', () => {
    const row = readDubaiRows()[0];
    const normalized = parser.normalizeCsvScrapedListingRow(row);
    assert.ok(normalized?.item, 'OpenSooq listing was rejected because its phone remains on the source');
    assert.equal(normalized.item.city, 'Dubai');
    assert.equal(normalized.item.country, 'United Arab Emirates');
    assert.equal(normalized.item.source.url, row.source_url);
    assert.equal(normalized.item.phone || normalized.item.contactPhone || '', '');
    assert.match(source, /data\/dubai-listings\.csv\?fresh=/);
});
