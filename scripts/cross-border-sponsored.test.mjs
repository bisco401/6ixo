import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

const root = resolve(import.meta.dirname, '..');
const source = readFileSync(resolve(root, 'app.js'), 'utf8');
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const css = readFileSync(resolve(root, 'styles.css'), 'utf8');
const classEnd = source.indexOf('// Initialize the app when the page loads');
assert.ok(classEnd > 0, 'Could not isolate DatingApp.');

for (const id of ['item-cross-border-fields', 'item-destination-country', 'item-transit-status', 'item-expected-arrival', 'luxury-ad-offer']) {
    assert.ok(html.includes(`id="${id}"`), `Missing cross-border form control: ${id}`);
}
assert.ok(!html.includes('Certified pre-owned'), 'Certified pre-owned must not appear in the seller form.');
assert.ok(!html.includes('Warranty included'), 'Warranty included must not appear in the seller form.');
for (const contract of [
    '.cross-border-featured-badge',
    '.shipping-status-badge.shipping-status--shipping-soon',
    '.shipping-status-badge.shipping-status--in-transit',
    '.shipping-status-badge.shipping-status--arriving-soon',
    '#d97706',
    '#2563eb',
    '#16a34a'
]) {
    assert.ok(css.includes(contract), `Missing shipping badge styling: ${contract}`);
}

const context = {
    console,
    document: {},
    navigator: {},
    window: { location: { search: '', hash: '' } },
    Date,
    Map,
    Set,
    URL,
    URLSearchParams
};
vm.createContext(context);
vm.runInContext(`${source.slice(0, classEnd)}\nglobalThis.TestDatingApp = DatingApp;`, context);
const app = Object.create(context.TestDatingApp.prototype);

assert.equal(app.getFeaturedPlacementForStoredListing({ category: 'vehicles' }), 'vehicles_featured');
assert.equal(app.getFeaturedPlacementForStoredListing({ category: 'electronics' }), 'electronics_featured');
assert.equal(app.getFeaturedPlacementForStoredListing({ category: 'services' }), 'services_featured');
assert.equal(app.getFeaturedPlacementForStoredListing({ category: 'real_estate' }), 'realestate_featured');
assert.equal(app.getFeaturedPlacementForStoredListing({ category: 'clothing' }), 'marketplace_featured');
assert.equal(app.getVehicleTransitBadgeText('in_transit', 'Guyana'), 'On its way to Guyana');
assert.equal(app.getVehicleTransitBadgeText('shipping_soon', 'Jamaica'), 'Shipping to Jamaica');
assert.equal(app.getVehicleTransitBadgeText('arriving_soon', 'Barbados'), 'Arriving soon in Barbados');

const future = new Date(Date.now() + 86_400_000).toISOString();
const past = new Date(Date.now() - 86_400_000).toISOString();
const paidItem = {
    id: 'arrival-1',
    category: 'vehicles',
    title: 'Toyota Crown',
    country: 'United States',
    city: 'New York',
    seller: 'Seller',
    featured: true,
    featuredUntil: future,
    promotionTarget: { country: 'Guyana', city: 'Georgetown' },
    shipping: { destinationCountry: 'Guyana', transitStatus: 'in_transit', expectedArrival: '2026-09-20' }
};
assert.equal(app.isCrossBorderSponsoredListing(paidItem), true, 'Paid active arrivals must receive sponsored treatment.');
assert.equal(app.isCrossBorderSponsoredListing({ ...paidItem, featured: false }), false, 'Unpaid arrivals must not receive sponsored treatment.');
assert.equal(app.isCrossBorderSponsoredListing({ ...paidItem, featuredUntil: past }), false, 'Expired arrivals must not receive sponsored treatment.');
assert.equal(app.isSponsoredListingVisibleToAudience(paidItem, { country: 'Guyana', city: 'Georgetown', region: '' }), true);
assert.equal(app.isSponsoredListingVisibleToAudience(paidItem, { country: 'Jamaica', city: 'Kingston', region: '' }), false);

app.getMarketplaceCategoryBadges = () => [];
app.getImportedListingSellerName = (item) => item.seller || 'Seller';
const attrs = app.buildFeaturedAdDataAttrs(paidItem, {
    title: paidItem.title,
    priceLine: '$24,000',
    details: { category: 'Vehicles', seller: 'Seller' }
});
assert.equal(attrs.adTargetCountry, 'Guyana');
assert.equal(attrs.adTransitStatus, 'in_transit');
assert.equal(attrs.adCanOffer, '1');
assert.equal(attrs.adResourceId, 'arrival-1');

app.buildFeaturedAdCarouselHtml = () => '<div class="image-carousel"></div>';
const preview = app.buildDefaultFeaturedPreviewCardMarkup({
    category: 'vehicles',
    title: paidItem.title,
    priceLine: '$24,000',
    transitStatus: 'in_transit',
    destinationCountry: 'Guyana'
});
assert.ok(preview.includes('cross-border-featured-badge'));
assert.ok(preview.includes('On its way to Guyana'));

const fields = {
    'item-category': { value: 'electronics' },
    'item-destination-country': { value: 'Jamaica' },
    'item-transit-status': { value: 'shipping_soon' },
    'item-target-country': { value: '' },
    'item-placement': { value: 'market' },
    'item-featured': { checked: false }
};
context.document.getElementById = (id) => fields[id] || null;
app.syncCrossBorderSponsoredFields('item-destination-country');
assert.equal(fields['item-target-country'].value, 'Jamaica');
assert.equal(fields['item-placement'].value, 'electronics_featured');
assert.equal(fields['item-featured'].checked, true);

console.log('Cross-border sponsored test passed: paid gating, targeting, form, labels, colors, placement, and offer data are wired.');
