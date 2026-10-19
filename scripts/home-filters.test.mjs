import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const classSource = source.slice(source.indexOf('class DatingApp'), source.indexOf('// Initialize the app when the page loads'));
const elements = new Map();
const context = { console, window: {}, document: { getElementById: id => elements.get(id) || null, querySelectorAll: () => [] } };
vm.runInNewContext(`${classSource}\nglobalThis.DatingApp = DatingApp;`, context);
const createApp = () => Object.create(context.DatingApp.prototype);
const entry = (id, type, raw = {}, priceText = '', postedAt = new Date().toISOString()) => ({ id, type, raw, priceText, postedAt });
const ids = list => Array.from(list, item => item.id);

test('Home price limits apply to formatted property and service prices and exclude unknown prices', () => {
    const app = createApp();
    const listings = [entry('basement', 'realestate', {}, '$1,450 / month'), entry('house', 'realestate', {}, '$2,500 / month'), entry('quote', 'service', {}, 'Contact for pricing'), entry('free', 'marketplace', { category: 'home' }, '$0')];
    assert.deepEqual(ids(app.filterHomeUiEntries(listings, { minPrice: 1000, maxPrice: 1500 })), ['basement']);
    assert.deepEqual(ids(app.filterHomeUiEntries(listings, { maxPrice: 0 })), ['free']);
});

test('Buy n Sell excludes specialist feeds and job ads', () => {
    const app = createApp();
    const listings = [entry('phone', 'marketplace', { category: 'electronics' }), entry('chair', 'marketplace', { category: 'home' }), entry('job', 'marketplace', { category: 'jobs' }), entry('rent', 'realestate'), entry('cleaner', 'service')];
    assert.deepEqual(ids(app.filterHomeUiEntries(listings, { category: 'buy_sell' })), ['phone', 'chair']);
});

test('Property filters combine listing type, bedrooms and explicit pet information', () => {
    const app = createApp();
    const listings = [
        entry('allowed', 'realestate', { listingType: 'for_rent', bedrooms: 2, bathrooms: 1, pets: true }),
        entry('denied', 'realestate', { listingType: 'for_rent', bedrooms: 2, pets: true, description: 'No pets allowed' }),
        entry('small', 'realestate', { listingType: 'for_rent', bedrooms: 1, pets: true }),
        entry('sale', 'realestate', { listingType: 'for_sale', bedrooms: 3, pets: true }),
        entry('unknown', 'realestate', { listingType: 'for_rent', pets: true })
    ];
    assert.deepEqual(ids(app.filterHomeUiEntries(listings, { category: 'real_estate', advanced: { listingType: 'rent', bedrooms: '2', pets: true } })), ['allowed']);
    assert.equal(app.matchesHomeCategoryFilters(entry('unfurnished', 'realestate', { description: 'Unfurnished apartment', furnished: true }), { furnished: true }, 'real_estate'), false);
});

test('Product filters use condition aliases, brand and category-specific fields', () => {
    const app = createApp();
    const listings = [entry('new', 'marketplace', { category: 'electronics', condition: 'Brand new', brand: 'Samsung' }), entry('used', 'marketplace', { category: 'electronics', condition: 'good', brand: 'Samsung' }), entry('open', 'marketplace', { category: 'electronics', condition: 'Open box', brand: 'Samsung' })];
    assert.deepEqual(ids(app.filterHomeUiEntries(listings, { category: 'electronics', advanced: { condition: 'used', brand: 'samsung' } })), ['used']);
    assert.deepEqual(ids(app.filterHomeUiEntries(listings, { category: 'electronics', advanced: { condition: 'like_new' } })), ['open']);
    assert.equal(app.matchesHomeCategoryFilters(listings[0], { bedrooms: '9' }, 'electronics'), true, 'Incompatible property fields must not restrict products.');
});

test('Vehicles filter structured and imported attributes, including year bounds', () => {
    const app = createApp();
    const listings = [entry('car', 'vehicle', { make: 'Toyota', year: 2022, transmission: 'Automatic', fuelType: 'Gasoline' }), entry('old', 'vehicle', { make: 'Toyota', year: 2005 }), entry('import', 'vehicle', { title: 'Toyota Corolla', attributes: { modelYear: 2021, transmission: 'Automatic', fuel: 'Petrol' } })];
    assert.deepEqual(ids(app.filterHomeUiEntries(listings, { category: 'vehicles', advanced: { make: 'Toyota', yearMin: '2020', yearMax: '2023', transmission: 'automatic', fuel: 'gas' } })), ['car', 'import']);
});

test('Services and jobs expose and match their own categories', () => {
    const app = createApp();
    const listings = [entry('cleaner', 'service', { category: 'home_services' }), entry('trainer', 'service', { category: 'fitness' }), entry('job', 'marketplace', { category: 'jobs', employmentType: 'part_time' })];
    assert.deepEqual(ids(app.filterHomeUiEntries(listings, { category: 'services', advanced: { serviceCategory: 'home_services' } })), ['cleaner']);
    assert.deepEqual(ids(app.filterHomeUiEntries(listings, { category: 'jobs', advanced: { employmentType: 'part_time' } })), ['job']);
    const places = [entry('open', 'live_place', { openNow: true }), entry('closed', 'live_place', { openNow: false })];
    assert.deepEqual(ids(app.filterHomeUiEntries(places, { category: 'services', advanced: { openNow: true } })), ['open']);
});

test('Date filters exclude stale and undated records', () => {
    const app = createApp();
    const listings = [entry('today', 'marketplace'), entry('old', 'marketplace', {}, '', '2020-01-01'), entry('unknown', 'marketplace', {}, '', 'not a date')];
    assert.deepEqual(ids(app.filterHomeUiEntries(listings, { dateFilter: 'today' })), ['today']);
});

test('Invalid price and vehicle year ranges cannot be applied', () => {
    const app = createApp();
    assert.match(app.getHomeFilterValidation({ min: '200', max: '100' }), /price range/);
    assert.match(app.getHomeFilterValidation({ min: '-1', max: '' }), /price range/);
    assert.match(app.getHomeFilterValidation({ min: '', max: '', advanced: { yearMin: '2024', yearMax: '2020' } }), /Year to/);
    assert.match(app.getHomeFilterValidation({ min: '', max: '', advanced: { yearMin: '2024.5' } }), /vehicle year/);
    assert.equal(app.getHomeFilterValidation({ min: '0', max: '100', advanced: {} }), '');
});

test('Changing Home category clears incompatible choices and synchronizes selectors without routing', () => {
    elements.clear();
    for (const id of ['home-filter-category', 'global-category-select', 'home-search-category', 'home-top-category']) elements.set(id, { value: 'real_estate' });
    elements.set('home-filter-price-min', { value: '1000' });
    elements.set('home-filter-price-max', { value: '2000' });
    const app = createApp();
    app.homeCategoryFilters = { bedrooms: '2', pets: true };
    app.homeQuickFilters = { nearMe: true, postedToday: true, openNow: true };
    app.syncHomeCategoryNav = value => { app.lastCategory = value; };
    app.switchScreen = () => assert.fail('Home filter category must not navigate.');
    app.setHomeFilterCategory('electronics', { reset: true });
    assert.equal(app.lastCategory, 'electronics');
    assert.equal(elements.get('global-category-select').value, 'electronics');
    assert.equal(elements.get('home-filter-price-max').value, '');
    assert.equal(Object.keys(app.homeCategoryFilters).length, 0);
    assert.equal(app.homeQuickFilters.openNow, false);
    assert.equal(app.homeQuickFilters.nearMe, true);
    assert.equal(app.homeQuickFilters.postedToday, true);
    elements.clear();
});

test('preview includes featured listings when a category is selected and omits them only for general browsing', () => {
    elements.clear();
    for (const id of ['home-filter-price-error', 'home-filter-price-label', 'home-search-what', 'home-apply-filters', 'home-filter-more', 'home-filter-more-label']) elements.set(id, { value: '', open: false });
    const app = createApp();
    const values = { category: 'real_estate', min: '', max: '', quick: { dateFilter: 'all' }, advanced: {} };
    app.homeFilterDialogOpen = true;
    app.homeFilterCandidates = [entry('regular', 'realestate', { price: 1000 }), entry('featured', 'realestate', { price: 1200, featured: true })];
    app.homeFilterPreviewContext = { rawQuery: '', nearMe: false, canExcludeFeatured: true };
    app.getHomeFilterDialogValues = () => values;
    app.getImportedListingIdentityKeys = () => [];
    app.isScrapedHomeFeaturedListing = raw => Boolean(raw.featured);
    app.updateHomeFilterPreview();
    assert.equal(elements.get('home-apply-filters').textContent, 'Show 2 listings');
    values.category = '';
    app.updateHomeFilterPreview();
    assert.equal(elements.get('home-apply-filters').textContent, 'Show 1 listing');
    elements.clear();
});
