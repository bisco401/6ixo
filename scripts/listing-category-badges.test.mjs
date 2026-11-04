import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
function fixture() {
    const context = { console, URL, URLSearchParams, window: {} };
    vm.runInNewContext(source.slice(0, source.indexOf('// Initialize the app when the page loads'))
        + '\nglobalThis.App = DatingApp;', context);
    return Object.create(context.App.prototype);
}

test('the image badge uses the main category and handles existing label aliases', () => {
    const app = fixture();
    for (const [value, key, label] of [
        ['electronics', 'electronics', 'Electronics'], ['Fashion', 'clothing', 'Fashion'],
        ['Fashion & Accessories', 'clothing', 'Fashion'], ['Vehicles', 'vehicles', 'Vehicles'],
        ['Real Estate', 'real_estate', 'Real Estate'], ['service', 'services', 'Services'],
        ['jobs', 'jobs', 'Jobs'], ['Buy n Sell', 'buy_sell', 'Buy &amp; Sell'],
        ['community', 'community', 'Community'], ['other', 'other', 'Other']
    ]) {
        const badge = app.renderListingCategoryBadge(value);
        assert.ok(badge.includes(`data-listing-category="${key}"`));
        assert.ok(badge.includes(`>${label}</span>`));
    }
    for (const value of ['', undefined, 'Licensed', 'phones_accessories', '<img src=x onerror=alert(1)>']) {
        assert.equal(app.renderListingCategoryBadge(value), '');
    }
});

test('publication and reloading preserve the selected category independently of detail badges', async () => {
    const app = fixture();
    app.currentUser = { id: 'test-user' };
    let inserted;
    app.supabase = { from(table) {
        assert.equal(table, 'marketplace_listings');
        return { insert(row) { inserted = row; return { select() { return { async single() {
            return { data: { ...row, id: 'test-row', public_id: 'test-listing' }, error: null };
        } }; } }; } };
    } };
    for (const category of ['electronics', 'clothing', 'real_estate', 'jobs', 'services', 'buy_sell', 'vehicles', 'other']) {
        const row = await app.createSupabaseMarketplaceListing({
            id: 123, category, subcategory: 'other', title: 'Electronics repair handbook',
            country: 'Canada', price: 25, images: ['https://example.com/photo.jpg'],
            categoryBadges: ['Licensed']
        });
        assert.equal(inserted.category, category);
        assert.equal(inserted.listing_payload.category, category);
        const reloaded = app.normalizeSupabaseMarketplaceListingRow(row);
        assert.equal(reloaded.category, category);
        assert.equal(reloaded.subcategory, 'other');
        assert.ok(app.renderListingCategoryBadge(reloaded.category).includes(`data-listing-category="${category}"`));
        assert.deepEqual(Array.from(reloaded.categoryBadges), ['Licensed']);
    }
});

test('a changed saved category overrides stale cached payload metadata', () => {
    const app = fixture();
    const reloaded = app.normalizeSupabaseMarketplaceListingRow({
        id: 'test-row', category: 'jobs', subcategory: 'skilled_trades',
        listing_payload: { category: 'electronics', subcategory: 'phones_accessories' }
    });
    assert.equal(reloaded.category, 'jobs');
    assert.equal(reloaded.subcategory, 'skilled_trades');
    assert.match(app.renderListingCategoryBadge(reloaded.category), />Jobs<\/span>/);
});
