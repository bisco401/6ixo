import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const heading = { textContent: '' };
const context = {
    console, Date, Map, Set, URL, URLSearchParams,
    navigator: { language: 'en-US' }, window: {},
    document: { getElementById: (id) => id === 'services-featured-title' ? heading : null }
};
vm.runInNewContext(`${source.slice(0, source.indexOf('// Initialize the app when the page loads'))}\nglobalThis.App = DatingApp;`, context);
const app = Object.create(context.App.prototype);
let confirmed = {};
app.getCurrentLocationDefaultParts = () => confirmed;
app.servicesFeedFilters = {};

app.syncServicesFeaturedHeading();
assert.equal(heading.textContent, 'Featured Services', 'Browser locale must not invent a city or country.');
confirmed = { country: 'Canada' };
app.syncServicesFeaturedHeading();
assert.equal(heading.textContent, 'Featured Services in Canada');
confirmed = { city: 'Toronto', country: 'Canada' };
app.syncServicesFeaturedHeading();
assert.equal(heading.textContent, 'Featured Services near Toronto, Canada');
app.servicesFeedFilters = { citySelect: 'Hamilton', country: 'Canada' };
app.syncServicesFeaturedHeading();
assert.equal(heading.textContent, 'Featured Services near Hamilton, Canada', 'An explicitly selected city takes precedence.');
app.servicesFeedFilters = { citySelect: 'all', country: 'United Kingdom' };
assert.equal(app.getServicesFeaturedLocation().city, '', 'Browsing another country must discard the previous city.');
confirmed = { city: 'Toronto' };
assert.equal(app.getServicesFeaturedLocation().city, '', 'A city without a known country must not be attached to another country.');

confirmed = { city: 'Toronto', country: 'Canada' };
app.servicesFeedFilters = { country: 'Canada', citySelect: 'all' };
app.companionshipCityGeo = {
    'Toronto|Canada': { lat: 43.6532, lng: -79.3832 },
    'Brampton|Canada': { lat: 43.7315, lng: -79.7624 },
    'Hamilton|Canada': { lat: 43.2557, lng: -79.8711 },
    'Vancouver|Canada': { lat: 49.2827, lng: -123.1207 }
};
const service = (id, city, postedAt, extra = {}) => ({ id, city, postedAt, sourceRowId: `csv-${id}`, sourceTable: 'csv_scraped_listings', country: 'Canada', photos: ['photo.jpg'], category: 'home_services', ...extra });
const rows = [
    service('vancouver-new', 'Vancouver', '2026-10-06'),
    service('hamilton', 'Hamilton', '2026-10-05'),
    service('brampton', 'Brampton', '2026-10-04'),
    service('toronto-old', 'Toronto', '2026-09-01'),
    service('foreign', 'Toronto', '2026-10-06', { country: 'United States' }),
    service('no-photo', 'Toronto', '2026-10-06', { photos: [] }),
    service('paid', 'Toronto', '2026-10-06')
];
const ids = (picks) => Array.from(picks, (entry) => entry.id);
assert.deepEqual(ids(app.getServicesFeaturedPicks(rows, { excludedIds: ['paid'] })), ['toronto-old', 'brampton', 'hamilton', 'vancouver-new'], 'Local city comes first; nearby cities precede a newer distant city.');
app.servicesFeedFilters.citySelect = 'Hamilton';
assert.deepEqual(ids(app.getServicesFeaturedPicks(rows, { excludedIds: ['paid'] })), ['hamilton', 'brampton', 'toronto-old', 'vancouver-new'], 'Distances must follow the selected city rather than a previous city.');
confirmed = { country: 'Canada' };
app.servicesFeedFilters.citySelect = 'all';
assert.deepEqual(ids(app.getServicesFeaturedPicks(rows, { excludedIds: ['paid'] })), ['vancouver-new', 'hamilton', 'brampton', 'toronto-old'], 'Country-only browsing keeps newest-first ordering.');
assert.equal(app.getServicesFeaturedCoordinates({ city: 'Unknown', country: 'Canada' }), null);
assert.equal(app.getServicesFeaturedCoordinates({ lat: null, lng: null }), null, 'Missing coordinates must not become zero coordinates.');

confirmed = { city: 'Toronto', country: 'Canada' };
const manyDistant = Array.from({ length: 12 }, (_, index) => service(`distant-${index}`, 'Vancouver', '2026-10-06'));
const picks = app.getServicesFeaturedPicks([...manyDistant, rows[3]]);
assert.equal(picks.length, 10);
assert.equal(picks[0].id, 'toronto-old', 'City priority must apply before the ten-card limit.');

app.strictDeviceLocation = false;
app.servicesFeedFilters = { country: 'Canada', citySelect: 'Toronto', category: 'home_services' };
app.serviceProfiles = [...rows.slice(0, 5), service('other-category', 'Toronto', '2026-10-06', { category: 'health_beauty' })];
assert.deepEqual(ids(app.getFilteredServiceProfiles()), ['toronto-old'], 'The ordinary feed still respects its city filter.');
assert.deepEqual(ids(app.getFilteredServiceProfiles({ skipCity: true })), ['vancouver-new', 'hamilton', 'brampton', 'toronto-old'], 'Featured candidates retain country and category filters while allowing nearby cities.');

console.log('Services featured location tests passed: city headings, manual locations, nearby ordering, country fallback, and filter isolation.');
