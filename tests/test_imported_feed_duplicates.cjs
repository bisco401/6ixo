'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(process.env.APP_TEST_SOURCE || path.join(root, 'app.js'), 'utf8');
const classSource = source.slice(source.indexOf('class DatingApp'), source.indexOf('// Initialize the app when the page loads'));
const context = { console, URL, window: { location: { origin: 'https://6ixo.com' } } };
vm.createContext(context);
vm.runInContext(`${classSource}\nglobalThis.App = DatingApp;`, context);

const loaderNames = ['loadCsvScrapedListings', 'loadKijijiGtaListings', 'loadOxglowElectronicsListings', 'loadOxglowAutoPartsListings', 'loadOxglowRealestateListings'];
const feedNames = ['marketplaceItems', 'vehicleListings', 'serviceProfiles', 'realestateListings'];
const expectedUrl = 'https://www.kijiji.ca/v-renovation-contracting-handyman/hamilton/home-renovations-services/1741530896';
const originalUrl = (item) => item.source?.url || item.sourceUrl || '';
const screenshotRow = {
    id: 'kijiji-1741530896', status: 'published', target_surface: 'marketplace',
    app_category: 'services', app_subcategory: 'other', title: 'Home Renovations Services',
    city: 'Hamilton', country: 'Canada', phone: '9055550100',
    description: 'Home renovation and contracting service. Licensed and insured.',
    source_site: 'Kijiji', source_url: expectedUrl, source_availability: 'active',
    scraped_at: '2026-09-06T06:01:35.000Z',
    image_urls: [1, 2, 3, 4].map(n => `https://images.example/renovation-${n}.jpg`).join('|')
};
const legacyScreenshotRow = {
    id: screenshotRow.id, title: screenshotRow.title, city: screenshotRow.city,
    description: screenshotRow.description, url: expectedUrl, phone_numbers: screenshotRow.phone,
    sorting_date: screenshotRow.scraped_at, image_urls: 'https://images.example/renovation-1.jpg'
};

function feedText(url) {
    const file = url.split('?')[0];
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const fixture = file === 'data/scraped-listings.csv' ? screenshotRow
        : file === 'data/kijiji-gta-recent-with-phones.csv' ? legacyScreenshotRow : null;
    if (!fixture) return text;
    const rows = context.App.prototype.parseCsvRows(text)
        .filter(row => row.source_url !== expectedUrl && row.url !== expectedUrl);
    rows.push(fixture);
    const headers = [...new Set(rows.flatMap(row => Object.keys(row)))];
    const escape = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
    return [headers.join(','), ...rows.map(row => headers.map(key => escape(row[key])).join(','))].join('\n');
}

function newApp() {
    const app = Object.create(context.App.prototype);
    for (const name of feedNames) app[name] = [];
    app.activeScreen = 'test';
    app.csvScrapedListingIds = new Set();
    app.syncScrapedHomeFeaturedAds = () => [];
    app.renderHomeTodayDeals = () => {};
    return app;
}

function checkFeeds(app, scenario) {
    for (const name of feedNames) {
        const seen = new Set();
        for (const item of app[name]) {
            const url = originalUrl(item);
            if (!url) continue;
            assert.ok(!seen.has(url), `${scenario}: ${name} repeats ${url}`);
            seen.add(url);
        }
    }
    const service = app.serviceProfiles.filter(item => item.title === 'Home Renovations Services');
    assert.equal(service.length, 1, `${scenario}: screenshot ad must appear exactly once in Services`);
    assert.equal(service[0].photos.length, 4, `${scenario}: keep the complete gallery`);
    assert.equal(originalUrl(service[0]), expectedUrl);
    const marketplace = app.marketplaceItems.filter(item => item.title === 'Home Renovations Services');
    assert.equal(marketplace.length, 1, `${scenario}: screenshot ad must appear exactly once in Market`);
    const searchEntries = [
        ...marketplace.map(raw => ({ type: 'marketplace', id: raw.id, raw })),
        ...service.map(raw => ({ type: 'service', id: raw.id, raw })),
    ];
    const results = app.dedupeHomeSearchResults(searchEntries);
    assert.equal(results.length, 1, `${scenario}: Home search must merge service and marketplace copies`);
    assert.equal(results[0].type, 'service', `${scenario}: Home retains the service profile card`);
    const html = results.map(entry => app.renderServiceFeedCard(entry.raw)).join('');
    assert.equal((html.match(/data-service-title="Home Renovations Services"/g) || []).length, 1);
}

async function run() {
    for (const reverse of [false, true]) {
        context.fetch = async (url) => ({ ok: true, text: async () => feedText(url) });
        const app = newApp();
        const loaders = reverse ? [...loaderNames].reverse() : loaderNames;
        for (const name of loaders) await app[name]();
        checkFeeds(app, reverse ? 'legacy first' : 'main first');
        // A periodic refresh must not reintroduce the second copy.
        for (const name of [...loaders].reverse()) await app[name]();
        checkFeeds(app, 'after refresh');
    }
    for (const reverse of [false, true]) {
        const waiting = [];
        context.fetch = (url) => new Promise(resolve => waiting.push(() => resolve({ ok: true, text: async () => feedText(url) })));
        const app = newApp();
        const pending = loaderNames.map(name => app[name]());
        (reverse ? waiting.reverse() : waiting).forEach(resolve => resolve());
        await Promise.all(pending);
        checkFeeds(app, reverse ? 'concurrent reverse' : 'concurrent forward');
    }
    const app = newApp();
    const primary = app.normalizeCsvScrapedListingRow(screenshotRow).item;
    const legacy = app.normalizeKijijiGtaRow(legacyScreenshotRow).item;
    const distinctSeller = { ...primary, id: 3, sourceRowId: 'kijiji-distinct', phone: '9055550199', source: { ...primary.source, url: 'https://www.kijiji.ca/another-ad/1741530897' } };
    const userPost = { id: 'user-post', title: primary.title, city: primary.city, country: primary.country };
    app.marketplaceItems = [legacy, primary, distinctSeller, userPost];
    app.deduplicateImportedListingFeeds();
    assert.equal(app.marketplaceItems.length, 3, 'retain distinct sellers and user posts');
    assert.ok(app.marketplaceItems.includes(userPost));
    assert.ok(app.marketplaceItems.includes(distinctSeller));
    const aliases = [{ type: 'marketplace', id: legacy.id, raw: legacy }, { type: 'service', id: primary.id, raw: app.buildServiceProfileEntryFromMarketplaceItem(primary) }];
    assert.equal(app.dedupeHomeSearchResults(aliases).length, 1, 'Home must merge differently prefixed source IDs');
    console.log('Imported feed duplicates: screenshot ad, five loaders, both load orders, concurrent loads, refreshes, distinct ads, and Home cards passed.');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
