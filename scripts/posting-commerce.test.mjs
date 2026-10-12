import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
function fixture(category = 'real_estate', subcategory = 'for_rent_long') {
    const fields = {};
    for (const [id, value] of Object.entries({ 'item-category': category, 'item-subcategory': subcategory, 'item-delivery': 'domestic_shipping', 'item-shipping-fee': '12.00', 'item-payment': 'cash', 'item-availability': 'Viewings Saturday', 'item-price': '2800', 'item-contact-phone': 'public demo contact', 'posting-promotion-method': 'credit_card', 'item-featured': '1' })) {
        const group = { hidden: false, classList: { toggle() {} } };
        fields[id] = { value, disabled: false, required: id === 'item-payment', closest: () => group, group };
    }
    const options = [{ value: 'pickup', checked: true }, { value: 'domestic_shipping', checked: true }];
    const context = { console, URL, URLSearchParams, setTimeout, clearTimeout, window: {}, document: {
        getElementById: id => fields[id] || null,
        querySelectorAll: () => options
    } };
    vm.runInNewContext(source.slice(0, source.indexOf('// Initialize the app when the page loads')) + '\nglobalThis.App = DatingApp;', context);
    return { app: Object.create(context.App.prototype), fields, options };
}

test('all property listing types exclude goods fulfillment and buyer payment', () => {
    const { app } = fixture();
    for (const subcategory of ['for_sale', 'for_rent_long', 'for_rent_short', 'commercial']) {
        const state = app.getPostItemCommerceUiState({ category: 'real_estate', subcategory });
        assert.equal(state.fulfillment, false);
        assert.equal(state.buyerPayment, false);
    }
});

test('jobs and services exclude parcel fulfillment; repairs and detailing do too', () => {
    const { app } = fixture();
    for (const category of ['jobs', 'services', 'dating', 'community']) assert.equal(app.getPostItemCommerceUiState({ category }).fulfillment, false);
    for (const subcategory of ['repairs', 'detailing']) assert.equal(app.getPostItemCommerceUiState({ category: 'vehicles', subcategory }).fulfillment, false);
    for (const category of ['electronics', 'clothing', 'buy_sell', 'other']) assert.equal(app.getPostItemCommerceUiState({ category }).fulfillment, true);
    for (const subcategory of ['vehicles', 'auto_parts', 'tires_rims']) assert.equal(app.getPostItemCommerceUiState({ category: 'vehicles', subcategory }).fulfillment, true);
});

test('changing from goods to property clears hidden delivery data and releases payment validation', () => {
    const { app, fields, options } = fixture();
    app.syncPostItemCommerceFields();
    for (const id of ['item-delivery', 'item-shipping-fee', 'item-payment']) {
        assert.equal(fields[id].group.hidden, true);
        assert.equal(fields[id].disabled, true);
        assert.equal(fields[id].value, '');
    }
    assert.equal(fields['item-payment'].required, false);
    assert.ok(options.every(field => !field.checked && field.disabled));
    for (const [id, value] of [['item-availability', 'Viewings Saturday'], ['item-price', '2800'], ['item-contact-phone', 'public demo contact'], ['posting-promotion-method', 'credit_card'], ['item-featured', '1']]) assert.equal(fields[id].value, value);
    fields['item-category'].value = 'buy_sell';
    app.syncPostItemCommerceFields();
    assert.equal(fields['item-payment'].required, true);
    assert.equal(fields['item-payment'].disabled, false);
    assert.equal(fields['item-shipping-fee'].group.hidden, false);
    assert.ok(options.every(field => !field.checked && !field.disabled));
});

test('stale draft or injected goods values cannot enter property previews or publication data', () => {
    const { app, fields } = fixture();
    assert.deepEqual(Array.from(app.collectPostItemFulfillmentOptions()), []);
    assert.equal(app.collectPostItemDelivery(), null);
    assert.equal(app.getPostItemBuyerPaymentMethod(), '');
    assert.deepEqual(Array.from(app.syncPostItemDeliveryFromOptions(['international_shipping'])), []);
    assert.equal(fields['item-delivery'].value, '');
});

test('physical goods retain the selected delivery methods, shipping fee and buyer payment', () => {
    const { app } = fixture('buy_sell', 'furniture');
    const delivery = app.collectPostItemDelivery();
    assert.equal(delivery.method, 'pickup');
    assert.deepEqual(Array.from(delivery.options), ['pickup', 'domestic_shipping']);
    assert.equal(delivery.shippingFee, 12);
    assert.equal(app.getPostItemBuyerPaymentMethod(), 'cash');
});
