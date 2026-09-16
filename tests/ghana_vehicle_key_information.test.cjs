const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const context = { console, Date, Map, Set, URL, URLSearchParams };
vm.runInNewContext(`${source.slice(0, source.indexOf('// Initialize the app when the page loads'))}\nglobalThis.App = DatingApp;`, context);
const app = Object.create(context.App.prototype);
const records = app.parseCsvRows(fs.readFileSync(path.join(root, 'data/scraped-listings.csv'), 'utf8'));
const vehicles = records.filter(row => row.country === 'Ghana' && row.status === 'published' && row.app_subcategory === 'vehicles');

test('published Ghana vehicle profiles retain every imported source specification', () => {
    assert.ok(vehicles.length > 0);
    for (const record of vehicles) {
        const item = app.normalizeCsvScrapedListingRow(record).item;
        const rows = app.mergeVehicleKeyInformationRows(item, [
            { label: 'Condition', value: item.condition },
            { label: 'Location', value: [item.city, item.country].join(', ') },
            { label: 'Phone', value: item.contactPhone }
        ]);
        const specs = JSON.parse(record.attributes).sourceSpecifications;
        assert.equal(rows[0].label, 'Category');
        assert.equal(rows[0].value, 'Vehicles');
        assert.equal(rows[1].label, 'Item');
        assert.equal(rows[1].value, record.title);
        assert.ok(Array.isArray(specs), record.title);
        for (const spec of specs) {
            assert.equal(rows.find(row => row.label === spec.label)?.value, spec.value, `${record.title}: ${spec.label}`);
        }
        assert.equal(rows.filter(row => row.label === 'Condition').length, 1, 'Condition is not duplicated');
        assert.equal(rows.at(-1).label, 'Phone', 'Contact details stay after the specifications');
        assert.equal(app.getMarketplaceFullDescription(item), app.decodeScrapedDescription(record.description));
    }
});

test('the RAV4 shows make, model, year, body type, and the actual source condition', () => {
    const record = {
        id: 'ghana-rav4-specifications-regression', status: 'published',
        title: '2018 Toyota RAV4 XLE DV', country: 'Ghana', city: 'Adenta',
        target_surface: 'vehicles', app_category: 'vehicles', app_subcategory: 'vehicles',
        source_url: 'https://oxglow.com.gh/listing/2018-toyota-rav4-xle-dv-8xlceZ',
        phone: '0240000000', image_urls: 'https://oxglow.com.gh/uploads/original/rav4.jpg',
        attributes: JSON.stringify({ sourceSpecifications: [
            { label: 'Make', value: 'Toyota' }, { label: 'Model', value: 'RAV4' },
            { label: 'Year', value: '2018' }, { label: 'Condition', value: 'Foreign used' },
            { label: 'Body type', value: 'Sedan' }
        ] })
    };
    const item = app.normalizeCsvScrapedListingRow(record).item;
    const rows = app.mergeVehicleKeyInformationRows(item, [{ label: 'Condition', value: 'GOOD' }]);
    const byLabel = new Map(rows.map(row => [row.label, row.value]));
    assert.equal(byLabel.get('Category'), 'Vehicles');
    assert.equal(byLabel.get('Item'), '2018 Toyota RAV4 XLE DV');
    assert.equal(byLabel.get('Make'), 'Toyota');
    assert.equal(byLabel.get('Model'), 'RAV4');
    assert.equal(byLabel.get('Year'), '2018');
    assert.equal(byLabel.get('Condition'), 'Foreign used');
    assert.equal(byLabel.get('Body type'), 'Sedan');
    assert.ok(!rows.some(row => row.label === 'Year' && row.value === '285000'));
});

test('vehicles without source specifications keep their existing details', () => {
    const rows = [{ label: 'Mileage', value: '12,500 km' }, { label: 'Phone', value: '0240000000' }];
    assert.deepEqual(JSON.parse(JSON.stringify(app.mergeVehicleKeyInformationRows({}, rows))), rows);
    assert.equal(app.mergeVehicleKeyInformationRows({ specifications: [{ label: 'Mileage', value: '7,767 miles' }] }, rows)[0].value, '7,767 miles');
    assert.equal(rows[0].value, '12,500 km', 'The input rows are not mutated');
});
