const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const context = { console, URL, URLSearchParams, window: { location: { href: 'https://6ixo.com/' } }, document: {}, localStorage: { getItem: () => null } };
vm.runInNewContext(`${source.slice(0, source.indexOf('// Initialize the app when the page loads'))}\nglobalThis.App = DatingApp;`, context);
const fixture = () => Object.assign(Object.create(context.App.prototype), { marketplaceItems: [], vehicleListings: [], scrapedListingIntegrityRepairs: {} });
const photos = Array.from({ length: 30 }, (_, n) => `https://example.com/photo-${n}.jpg?label=a&other=b`);

test('feeds show no more than four existing images without changing the full gallery', () => {
    const app = fixture();
    for (const count of [0, 1, 3, 4, 5, 14, 30]) {
        const gallery = photos.slice(0, count);
        assert.deepEqual(Array.from(app.getFeedPreviewImages(gallery)), gallery.slice(0, 4));
        assert.equal(gallery.length, count);
    }
    const markup = app.buildFeaturedAdCarouselHtml(photos, 'Featured listing');
    assert.equal((markup.match(/<img /g) || []).length, 4);
    const savedGallery = markup.match(/data-gallery-photos="([^"]+)"/)[1].replaceAll('&quot;', '"').replaceAll('&amp;', '&');
    const card = { querySelector: () => ({ dataset: { galleryPhotos: savedGallery } }), querySelectorAll: () => { throw new Error('Full galleries must not use the capped feed DOM.'); } };
    assert.deepEqual(Array.from(app.getCardGalleryPhotos(card)), photos);
    assert.equal(app.buildMarketplaceItemGallery({ title: 'Listing', images: photos }).gallery.length, 30);
});

test('full saved galleries survive database loading and saving', async () => {
    const app = fixture();
    const row = { id: 'listing-id', public_id: 'listing-id', title: 'Listing', media_urls: photos, listing_payload: { id: 'listing-id', title: 'Listing', category: 'real_estate', images: photos, city: 'Toronto', country: 'Canada' } };
    assert.equal(app.normalizeSupabaseMarketplaceListingRow(row).images.length, 30);
    app.currentUser = { id: 'owner-id', marketplaceProfileId: 'profile-id' };
    let saved;
    app.supabase = { from: () => ({ insert: data => { saved = data; return { select: () => ({ single: async () => ({ data: { ...data, id: 'listing-id' } }) }) }; } }) };
    await app.createSupabaseMarketplaceListing({ ...row.listing_payload, price: 100 });
    assert.deepEqual(Array.from(saved.media_urls), photos);
    assert.deepEqual(Array.from(saved.listing_payload.images), photos);
});
