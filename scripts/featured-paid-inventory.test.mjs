import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
function fixture(id = 'realestate-featured-grid') {
    let cards = [];
    const container = {
        id, get children() { return cards; }, scrollLeft: 0,
        querySelectorAll(selector) {
            if (selector === '.featured-ad-card') return cards;
            const name = selector.match(/\[data-([a-z-]+)/)?.[1]?.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
            return name ? cards.filter(card => card.dataset[name]) : [];
        },
        querySelector() { return null; },
        appendChild(card) { cards = cards.filter(entry => entry !== card); cards.push(card); },
        insertAdjacentHTML(_position, html) {
            for (const article of html.matchAll(/<article\b[^>]*>/g)) {
                const dataset = Object.fromEntries(Array.from(article[0].matchAll(/data-([a-z-]+)="([^"]*)"/g),
                    ([, name, value]) => [name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
                container.add(dataset);
            }
        },
        add(dataset) {
            const card = { dataset, hidden: false, classList: { contains: () => false },
                remove() { cards = cards.filter(entry => entry !== card); } };
            cards.push(card); return card;
        },
    };
    const surface = { hidden: false, querySelector: () => container };
    const context = { console, Date, Map, Set, URL, URLSearchParams, Intl,
        window: { location: { origin: 'https://6ixo.com' } }, navigator: { language: 'en-US' },
        document: { getElementById: name => name === 'home-featured-ads-strip' ? surface : name === id ? container : null } };
    vm.runInNewContext(source.slice(0, source.indexOf('// Initialize the app when the page loads'))
        + '\nglobalThis.App = DatingApp;', context);
    const app = Object.create(context.App.prototype);
    app.getCurrentLocationDefaultParts = () => ({ country: 'Canada' });
    app.getRealestateUiFilterValues = () => ({ country: 'Canada' });
    app.applyFeaturedAdsCountryScope = app.bindImageCarousels = app.bindFeaturedAdCardLightbox = () => {};
    return { app, container, surface };
}
const property = (id, imported = true) => ({
    id, city: 'Toronto', country: 'Canada', title: id, images: ['property.jpg'], date: '2026-10-06',
    ...(imported ? { sourceTable: 'csv_scraped_listings', sourceRowId: 'csv-' + id } : { serverBacked: true }),
});

test('only imported inventory can fill unpaid featured slots; ordinary user properties and services cannot', () => {
    const { app } = fixture();
    const imported = property('imported'), unpaid = property('unpaid', false);
    assert.deepEqual(Array.from(app.getRealestateFeaturedPicks([unpaid, imported]), row => row.id), ['imported']);
    assert.deepEqual(Array.from(app.getServicesFeaturedPicks([
        { ...unpaid, photos: ['service.jpg'] }, { ...imported, photos: ['service.jpg'] },
    ]), row => row.id), ['imported']);
    assert.equal(app.isFeaturedFeedPlaceholder({ ...unpaid, sourceRowId: 'csv-forged' }), false);
});

test('paying properties come first and replace fillers; a fully paid carousel retains no unpaid filler', () => {
    const { app, container } = fixture();
    container.add({ realestateFeaturedPick: '1', realestateId: 'old-filler', featuredPlaceholder: '1' });
    container.add({ postItemId: 'paid-1', realestateId: 'paid-1', adCountry: 'Canada' });
    const imported = Array.from({ length: 15 }, (_, index) => property('import-' + index));
    app.renderRealestateFeatured([...imported, property('unpaid', false)]);
    assert.equal(container.children.length, 10);
    assert.equal(container.children[0].dataset.postItemId, 'paid-1');
    assert.equal(container.children.filter(card => card.dataset.featuredPlaceholder === '1').length, 9);
    for (let index = 2; index <= 10; index++) {
        container.add({ postItemId: 'paid-' + index, realestateId: 'paid-' + index, adCountry: 'Canada' });
    }
    app.renderRealestateFeatured(imported);
    assert.equal(container.children.length, 10);
    assert.equal(container.children.some(card => card.dataset.featuredPlaceholder === '1'), false);
});

test('paid service campaigns are preserved when an imported card becomes a paid creative', () => {
    const { app, container } = fixture('services-featured-grid');
    app.servicesFeedFilters = { country: 'Canada' };
    container.add({ serviceFeaturedPick: '1', serviceId: 'paid-service', promoted: '1', featuredPlaceholder: '1' });
    app.renderServicesFeatured(Array.from({ length: 12 }, (_, index) => ({
        ...property('service-' + index), photos: ['service.jpg'],
    })));
    assert.equal(container.children.length, 10);
    assert.equal(container.children[0].dataset.serviceId, 'paid-service');
    assert.equal(container.children[0].dataset.promoted, '1');
});

test('Home fills only remaining slots, excludes the paid source, and keeps a paid-only strip visible', () => {
    const { app, container, surface } = fixture('home');
    app.strictDeviceLocation = false;
    app.getHomeSearchLocationSelection = () => ({});
    app.buildScrapedHomeFeaturedListing = item => item;
    app.insertFeaturedAdCard = item => { container.add({ postItemId: item.id, scrapedHomeFeatured: '1' }); };
    container.add({ postItemId: 'paid' });
    const inventory = [property('paid'), ...Array.from({ length: 15 }, (_, index) => property('filler-' + index))];
    const selected = app.syncScrapedHomeFeaturedAds(inventory);
    assert.equal(selected.length, 9);
    assert.equal(selected.some(item => item.id === 'paid'), false);
    assert.equal(container.children[0].dataset.postItemId, 'paid');
    app.syncScrapedHomeFeaturedAds([]);
    assert.equal(container.children.length, 1);
    assert.equal(surface.hidden, false);
});

test('a user payload cannot bypass the authoritative featured flag on a platform listing', () => {
    const { app } = fixture();
    const row = { id: 'row', public_id: 'listing', title: 'Unpaid listing', featured: false,
        listing_payload: { featured: true, featuredUntil: '2099-01-01' } };
    const unpaid = app.normalizeSupabaseMarketplaceListingRow(row);
    assert.equal(unpaid.featured, false);
    assert.equal(unpaid.featuredUntil, '');
    const paid = app.normalizeSupabaseMarketplaceListingRow({ ...row, featured: true, featured_until: '2099-01-01' });
    assert.equal(paid.featured, true);
    assert.equal(paid.featuredUntil, '2099-01-01');
    assert.equal(app.normalizeSupabaseShortTermListingRow(row).featured, false);
});
