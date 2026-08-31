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
    { console }
);
const parser = Object.create(DatingApp.prototype);

function readJamaicaRows() {
    const csv = fs.readFileSync(path.join(root, 'data', 'jamaica-listings.csv'), 'utf8');
    return parser.parseCsvRows(csv);
}

test('restores every unique Jamaican listing as published inventory', () => {
    const rows = readJamaicaRows();
    const ids = new Set(rows.map((row) => row.id));
    const urls = new Set(rows.map((row) => row.source_url));

    assert.equal(rows.length, 376);
    assert.equal(ids.size, rows.length);
    assert.equal(urls.size, rows.length);
    rows.forEach((row) => {
        assert.equal(row.status, 'published', `${row.id} was not published`);
        assert.equal(row.country, 'Jamaica', `${row.id} was assigned to the wrong country`);
        assert.match(row.source_url, /^https:\/\/www\.jacars\.net\/adv\//, `${row.id} has an invalid source URL`);
        assert.ok(row.image_urls, `${row.id} is missing listing media`);
    });
});

test('restored Jamaican inventory spans the marketplace and vehicle feeds', () => {
    const rows = readJamaicaRows();
    const surfaces = new Set(rows.map((row) => row.target_surface));
    const categories = new Set(rows.map((row) => row.app_category));

    assert.ok(surfaces.has('marketplace'));
    assert.ok(surfaces.has('vehicles'));
    assert.ok(categories.has('real_estate'));
    assert.ok(categories.has('vehicles'));
    assert.ok(categories.has('buy_sell'));
});

test('uses full JACars galleries whenever the source listing is still available', () => {
    const rows = readJamaicaRows();
    const upgraded = rows.filter((row) => {
        try {
            return JSON.parse(row.attributes || '{}').imageQuality === 'source_detail_high_resolution';
        } catch {
            return false;
        }
    });

    assert.equal(upgraded.length, 237);
    upgraded.forEach((row) => {
        const images = row.image_urls.split('|').filter(Boolean);
        assert.ok(images.length >= 1 && images.length <= 12, `${row.id} has an invalid full gallery`);
        images.forEach((image) => {
            assert.match(image, /^https:\/\/cdn2\.jacars\.net\/media\/cache\//, `${row.id} has a non-JACars image`);
        });
    });

    const featuredIds = new Set(['jacars-2522040', 'jacars-2512301']);
    rows.filter((row) => featuredIds.has(row.id)).forEach((row) => {
        assert.equal(JSON.parse(row.attributes).imageQuality, 'source_detail_high_resolution');
    });
});
