import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
function fixture() {
    const fields = {};
    function field(id, value = '', type = 'text') {
        const classes = new Set();
        const group = { classList: { toggle: (key, enabled) => enabled ? classes.add(key) : classes.delete(key) } };
        return fields[id] = { id, value, type, checked: type === 'checkbox', disabled: false, required: id === 'realestate-bedrooms', dataset: {}, group, classes, closest: () => group, getAttribute: () => fields[id].placeholder || '', setAttribute: (name, value) => { fields[id][name] = value; }, removeAttribute: name => { if (name === 'required') fields[id].required = false; } };
    }
    field('item-category', 'real_estate');
    field('item-subcategory', 'land');
    field('realestate-listing-type', 'land');
    field('realestate-property-type', 'apartment');
    field('realestate-bedrooms', '2');
    field('realestate-bathrooms', '1.5');
    field('realestate-furnished', '', 'checkbox');
    field('realestate-pets', '', 'checkbox');
    field('realestate-sqft', '5000');
    field('realestate-address', 'Example Road');
    field('realestate-amenities', 'Road access and water connection');
    field('item-category-badges', 'Furnished|Road access');
    field('item-availability', 'By appointment');
    field('posting-promotion-method', 'credit_card');
    const areaLabel = { textContent: 'Square Feet', dataset: {} };
    const featuresLabel = { textContent: 'Amenities', dataset: {} };
    const context = { console, URL, URLSearchParams, setTimeout, clearTimeout, window: {}, document: { getElementById: id => fields[id] || null, querySelector: selector => selector.includes('realestate-sqft') ? areaLabel : featuresLabel, querySelectorAll: () => [] } };
    vm.runInNewContext(source.slice(0, source.indexOf('// Initialize the app when the page loads')) + '\nglobalThis.App = DatingApp;', context);
    const app = Object.assign(Object.create(context.App.prototype), { getMarketplaceUsername: () => 'Seller' });
    return { app, fields, areaLabel };
}

test('ordinary property posting offers rent, sale, land and commercial while short-term posting remains in the host flow', () => {
    const { app } = fixture();
    const choices = app.getPostItemSubcategoryConfig('real_estate').options;
    assert.deepEqual(Array.from(choices, choice => Array.from(choice)), [['for_rent_long', 'For rent'], ['for_sale', 'For sale'], ['land', 'Land'], ['commercial', 'Commercial']]);
    app.lastPostItemOpenContext = { source: 'host_short_term' };
    assert.deepEqual(Array.from(app.getPostItemSubcategoryConfig('real_estate').options, choice => Array.from(choice)), [['for_rent_short', 'Short-term rental']]);
});

test('selecting Land sets the land property type and removes stale residential details without changing area, address or promotion', () => {
    const { app, fields, areaLabel } = fixture();
    app.syncRealestateFormPropertyTypeOptions('land');
    assert.equal(fields['realestate-property-type'].value, 'land');
    for (const id of ['realestate-bedrooms', 'realestate-bathrooms', 'realestate-furnished', 'realestate-pets']) {
        assert.equal(fields[id].disabled, true);
        assert.equal(fields[id].classes.has('hidden'), true);
        assert.equal(fields[id].required, false);
        if (fields[id].type === 'checkbox') assert.equal(fields[id].checked, false);
        else assert.equal(fields[id].value, '');
    }
    assert.equal(areaLabel.textContent, 'Land area (sq ft)');
    assert.equal(fields['realestate-sqft'].value, '5000');
    assert.equal(fields['realestate-address'].value, 'Example Road');
    assert.equal(fields['posting-promotion-method'].value, 'credit_card');
});

test('returning from land to an apartment restores residential fields and validation; commercial keeps them hidden', () => {
    const { app, fields, areaLabel } = fixture();
    app.syncRealestateFormPropertyTypeOptions('land');
    fields['realestate-listing-type'].value = 'for_rent_long';
    fields['realestate-property-type'].value = 'apartment';
    app.syncRealestateFormPropertyTypeOptions('for_rent_long');
    assert.equal(fields['realestate-bedrooms'].disabled, false);
    assert.equal(fields['realestate-bedrooms'].required, true);
    assert.equal(fields['realestate-bedrooms'].classes.has('hidden'), false);
    assert.equal(areaLabel.textContent, 'Square Feet');
    fields['realestate-listing-type'].value = 'commercial';
    app.syncRealestateLandPostingFields();
    assert.equal(fields['realestate-bedrooms'].required, false);
    assert.equal(fields['realestate-bedrooms'].classes.has('hidden'), true);
});

test('stale residential details cannot enter a land publication payload', () => {
    const { app } = fixture();
    const details = app.getRealestatePostingDetails();
    assert.equal(details.listingType, 'land');
    assert.equal(details.propertyType, 'land');
    assert.equal(details.bedrooms, null);
    assert.equal(details.bathrooms, null);
    assert.equal(details.furnished, false);
    assert.equal(details.pets, false);
    assert.equal(details.sqft, 5000);
});

test('land badges describe land for the Land category and for land offered under rent or sale', () => {
    const { app, fields } = fixture();
    for (const listingType of ['land', 'for_rent_long', 'for_sale']) {
        fields['item-subcategory'].value = listingType;
        fields['realestate-property-type'].value = 'land';
        const badges = app.getMarketplaceCategoryBadgeOptions('real_estate', { realestate: { listingType, propertyType: 'land' } });
        for (const label of ['Road access', 'Utilities available', 'Survey available', 'By appointment']) assert.ok(badges.includes(label));
        for (const label of ['Furnished', 'Pet friendly', 'Laundry available', 'Instant book']) assert.equal(badges.includes(label), false);
        assert.deepEqual(Array.from(app.getSelectedMarketplaceCategoryBadges()), ['Road access']);
    }
});

test('land publication survives server reload and appears in the Land feed with the correct public category', async () => {
    const { app, fields } = fixture();
    app.syncRealestateFormPropertyTypeOptions('land');
    app.currentUser = { id: 'seller' };
    let inserted;
    app.supabase = { from: table => {
        assert.equal(table, 'marketplace_listings');
        return { insert: row => {
            inserted = JSON.parse(JSON.stringify(row));
            return { select: () => ({ single: async () => ({ data: { ...inserted, id: 'row', public_id: 'land-ad' }, error: null }) }) };
        } };
    } };
    const realestate = app.getRealestatePostingDetails();
    const row = await app.createSupabaseMarketplaceListing({ id: 'land-ad', category: 'real_estate', subcategory: 'land', title: 'Residential plot', price: 50000, city: 'Toronto', country: 'Canada', realestate, categoryBadges: app.getSelectedMarketplaceCategoryBadges() });
    assert.equal(inserted.subcategory, 'land');
    const listing = app.buildRealestateFeedEntryFromMarketplaceItem(app.normalizeSupabaseMarketplaceListingRow(row));
    assert.deepEqual(Array.from(listing.categories), ['land']);
    assert.equal(listing.propertyType, 'land');
    assert.equal(app.getRealestateProfileSummary(listing).category, 'Land');
    assert.equal(listing.bedrooms, null);
    assert.ok(listing.categoryBadges.includes('Road access'));
    assert.equal(listing.categoryBadges.includes('Furnished'), false);
    assert.equal(app.buildRealestateDetailRows(listing).find(row => row.label === 'Land features').value, 'Road access and water connection');
    assert.equal(fields['item-availability'].value, 'By appointment');
});

test('For rent and For sale retain the established feed routing and data values', () => {
    const { app } = fixture();
    assert.deepEqual(Array.from(app.buildRealestateListingCategories('for_rent_long', 'apartment')), ['for_rent', 'long_term', 'apartment']);
    assert.deepEqual(Array.from(app.buildRealestateListingCategories('for_sale', 'house')), ['for_sale', 'house']);
    assert.deepEqual(Array.from(app.buildRealestateListingCategories('for_rent_short', 'studio')), ['for_rent', 'short_term', 'studio']);
});

test('posting furnished and pet details stay separate from the property search filters', () => {
    const { app, fields } = fixture();
    fields['realestate-filter-furnished'] = { checked: true };
    fields['realestate-filter-pets'] = { checked: true };
    app.syncCountryCityHidden = () => {};
    app.syncRealestateFormPropertyTypeOptions('land');
    const filters = app.getRealestateUiFilterValues();
    assert.equal(filters.furnished, true);
    assert.equal(filters.pets, true);
    assert.equal(app.getRealestatePostingDetails().furnished, false);
    assert.equal(app.getRealestatePostingDetails().pets, false);
    const index = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    for (const id of ['realestate-furnished', 'realestate-pets', 'realestate-filter-furnished', 'realestate-filter-pets']) {
        assert.equal(index.split(`id="${id}"`).length - 1, 1, `${id} must identify one control.`);
    }
});
