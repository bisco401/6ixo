import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const context = { console, window: { setTimeout }, URL, URLSearchParams };
vm.runInNewContext(source.slice(0, source.indexOf('// Initialize the app when the page loads')) + '\nglobalThis.App = DatingApp;', context);
const plain = value => JSON.parse(JSON.stringify(value));

test('CSV retains quoted descriptions, JSON, Unicode, empty cells and CRLF', () => {
    const app = Object.create(context.App.prototype);
    const input = '\uFEFFid,title,description,attributes,empty\r\n'
        + '1,"Couch, blue","First line\r\nSecond ""quoted"" line","{""color"":""blue""}",\r\n'
        + '2,雪,"Contains , commas and\nnewlines",{},\r\n\r\n';
    assert.deepEqual(plain(app.parseCsvRows(input)), [
        { id: '1', title: 'Couch, blue', description: 'First line\r\nSecond "quoted" line', attributes: '{"color":"blue"}', empty: '' },
        { id: '2', title: '雪', description: 'Contains , commas and\nnewlines', attributes: '{}', empty: '' }
    ]);
    assert.deepEqual(plain(app.parseCsvRows('a,b\n1,2')), [{ a: '1', b: '2' }]);
    assert.deepEqual(plain(app.parseCsvRows('a,b\n1,')), [{ a: '1', b: '' }]);
    assert.deepEqual(plain(app.parseCsvRows('')), []);
});

test('Large description fields remain intact without character-by-character accumulation', () => {
    const app = Object.create(context.App.prototype);
    const description = 'Full listing details 雪, "original".\n'.repeat(30000);
    const input = 'id,description\n1,"' + description.replaceAll('"', '""') + '"';
    assert.equal(app.parseCsvRows(input)[0].description, description);
});

test('Inventory yields for painting, then publishes all valid rows together without losing existing listings', async () => {
    let normalized = 0;
    let refreshed = 0;
    const yields = [];
    const rows = Array.from({ length: 200 }, (_, id) => ({ id: String(id), status: 'published' }));
    const app = Object.assign(Object.create(context.App.prototype), {
        csvScrapedListingIds: new Set(['old-import']),
        marketplaceItems: [{ sourceRowId: 'old-import' }, { sourceRowId: 'posted-by-user' }],
        vehicleListings: [], realestateListings: [], serviceProfiles: [],
        fetchImportedListingRows: async file => file === 'scraped-listings.csv' ? rows : [],
        dedupeScrapedListingRows: rows => rows,
        normalizeCsvScrapedListingRow(row) {
            normalized++;
            return Number(row.id) % 5 === 0 ? null : { item: { sourceRowId: row.id }, isVehicle: Number(row.id) % 2 === 0 };
        },
        buildRealestateFeedEntryFromMarketplaceItem: () => null,
        buildServiceProfileEntryFromMarketplaceItem: () => null,
        deduplicateImportedListingFeeds() {}, syncScrapedHomeFeaturedAds() {}, renderHomeTodayDeals() {},
        refreshImportedListingViews() { refreshed++; }
    });
    const originalTimer = context.window.setTimeout;
    context.window.setTimeout = (callback, delay) => {
        assert.equal(delay, 0);
        yields.push(normalized);
        assert.equal(refreshed, 0, 'Keep the currently visible inventory until the new snapshot is complete');
        assert.equal(app.marketplaceItems[0].sourceRowId, 'old-import');
        return setTimeout(callback, delay);
    };
    try {
        const result = await app.loadCsvScrapedListings();
        assert.deepEqual(yields, [75, 150]);
        assert.equal(normalized, 200);
        assert.equal(refreshed, 1);
        const expected = rows.filter(row => Number(row.id) % 5 !== 0).map(row => row.id);
        assert.deepEqual(plain(result.map(item => item.sourceRowId)), expected);
        assert.equal(app.csvScrapedListingIds.size, expected.length);
        const inventory = [...app.marketplaceItems, ...app.vehicleListings].map(item => item.sourceRowId);
        assert.equal(inventory.length, expected.length + 1);
        assert.ok(inventory.includes('posted-by-user'));
        assert.ok(!inventory.includes('old-import'));
        for (const id of expected) assert.ok(inventory.includes(id));
    } finally { context.window.setTimeout = originalTimer; }
});
