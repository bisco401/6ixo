import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const heading = { textContent: '' };
const context = {
    console, Date, Map, Set, URL, URLSearchParams,
    navigator: { language: 'en-US' }, window: {},
    document: { getElementById: (id) => id === 'realestate-featured-title' ? heading : null }
};
vm.runInNewContext(`${source.slice(0, source.indexOf('// Initialize the app when the page loads'))}\nglobalThis.App = DatingApp;`, context);
const app = Object.create(context.App.prototype);
let defaults = {};
let filters = {};
app.getCurrentLocationDefaultParts = () => defaults;
app.getRealestateUiFilterValues = () => filters;

app.syncRealestateFeaturedHeading();
assert.equal(heading.textContent, 'Featured Properties', 'An unknown location must not use the browser locale.');
defaults = { country: 'Canada' };
app.syncRealestateFeaturedHeading();
assert.equal(heading.textContent, 'Featured Properties in Canada');
defaults = { city: 'Toronto', country: 'Canada' };
app.syncRealestateFeaturedHeading();
assert.equal(heading.textContent, 'Featured Properties near Toronto, Canada');
filters = { city: 'Hamilton', country: 'Canada' };
app.syncRealestateFeaturedHeading();
assert.equal(heading.textContent, 'Featured Properties near Hamilton, Canada');
filters = { country: 'United Kingdom' };
assert.equal(app.getRealestateFeaturedLocation().city, '', 'Another country must not inherit a stale city.');

filters = { country: 'Canada' };
app.companionshipCityGeo = {
    'Toronto|Canada': { lat: 43.6532, lng: -79.3832 },
    'Brampton|Canada': { lat: 43.7315, lng: -79.7624 },
    'Hamilton|Canada': { lat: 43.2557, lng: -79.8711 },
    'Vancouver|Canada': { lat: 49.2827, lng: -123.1207 }
};
const listing = (id, city, date, extra = {}) => ({
    id, city, date, sourceRowId: `csv-${id}`, sourceTable: 'csv_scraped_listings', country: 'Canada', images: ['property.jpg'],
    title: 'Property', categories: ['for_sale'], listingType: 'for_sale', price: 'CA$ 500,000', ...extra
});
const rows = [
    listing('vancouver-new', 'Vancouver', '2026-10-06'),
    listing('hamilton', 'Hamilton', '2026-10-05'),
    listing('brampton', 'Brampton', '2026-10-04'),
    listing('toronto-old', 'Toronto', '2026-09-01'),
    listing('foreign', 'Toronto', '2026-10-06', { country: 'United States' }),
    listing('no-photo', 'Toronto', '2026-10-06', { images: [] }),
    listing('paid', 'Toronto', '2026-10-06')
];
const ids = (items) => Array.from(items, (item) => item.id);
assert.deepEqual(ids(app.getRealestateFeaturedPicks(rows, { excludedIds: ['paid'] })), ['toronto-old', 'brampton', 'hamilton', 'vancouver-new']);
filters.city = 'Hamilton';
assert.deepEqual(ids(app.getRealestateFeaturedPicks(rows, { excludedIds: ['paid'] })), ['hamilton', 'brampton', 'toronto-old', 'vancouver-new']);
defaults = { country: 'Canada' };
filters = { country: 'Canada' };
assert.deepEqual(ids(app.getRealestateFeaturedPicks(rows, { excludedIds: ['paid'] })), ['vancouver-new', 'hamilton', 'brampton', 'toronto-old'], 'Country-only browsing remains newest first.');
defaults = { city: 'Toronto', country: 'Canada' };
const distant = Array.from({ length: 12 }, (_, i) => listing(`distant-${i}`, 'Vancouver', '2026-10-06'));
const picks = app.getRealestateFeaturedPicks([...distant, rows[3]]);
assert.equal(picks.length, 10);
assert.equal(picks[0].id, 'toronto-old', 'City priority must apply before the card limit.');
assert.equal(app.getRealestateFeaturedPicks([listing('fallback-image', 'Toronto', '2026-10-06', { images: [], image: 'cover.jpg' })]).length, 1);

const propertyHtml = app.renderRealestateFeaturedCard({ ...rows[3], title: '<script>unsafe</script>', meta: '2 beds · 1 bath' });
assert.ok(propertyHtml.includes('data-realestate-id="toronto-old"'));
assert.ok(propertyHtml.includes('&lt;script&gt;unsafe&lt;/script&gt;'));
assert.ok(!propertyHtml.includes('<script>unsafe</script>'));
const opened = [];
app.openRealestateModalById = (id) => opened.push(id);
app.openSharedPostForm = (options) => opened.push(options);
app.openFeaturedAdCardTarget({ dataset: { realestateFeaturedPick: '1', realestateId: 'toronto-old' } });
assert.equal(opened[0], 'toronto-old', 'A featured property must open its full property details.');
app.openFeaturedAdCardTarget({ dataset: { realestatePromotion: '1' } });
assert.equal(opened[1].category, 'real_estate');
assert.equal(opened[1].placement, 'realestate_featured');

if (app.decorateFeaturedProfileCards) {
    const plainCards = [
        { dataset: { realestateFeaturedPick: '1' } },
        { dataset: { realestatePromotion: '1' } }
    ];
    app.decorateFeaturedProfileCards({ querySelectorAll: () => plainCards });
    // These cards intentionally have no paid-profile querySelector interface.
    // The ad decorator must leave ordinary property prices and identity intact.
    assert.equal(plainCards[0].dataset.featuredProfileCard, undefined);
}

console.log('Featured Properties tests passed: location headings, nearby ordering, limits, photo fallbacks, safe cards, and property/promotion targets.');
