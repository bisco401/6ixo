import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
function fixture() {
    const fields = {};
    const add = (id, value = '', type = 'text') => fields[id] = { id, value, type, checked: false, disabled: false, classList: { toggle() {} } };
    add('item-category', 'real_estate');
    add('item-subcategory', 'for_sale');
    add('realestate-listing-type', 'for_sale');
    add('realestate-inquiries-fields');
    add('realestate-viewing-appointment', 'by_appointment', 'checkbox');
    add('realestate-viewing-open-house', 'open_house', 'checkbox');
    add('realestate-viewing-virtual', 'virtual_viewing', 'checkbox');
    add('item-availability', 'Saturdays 10 am–2 pm');
    add('item-contact-method', 'email');
    add('item-contact-email', 'seller@example.com');
    add('posting-promotion-method', 'credit_card');
    add('message-input');
    fields['post-item-form'] = { querySelectorAll: () => Object.values(fields).filter(field => field.type) };
    const storage = new Map();
    const context = { console, URL, URLSearchParams, setTimeout, clearTimeout, window: { localStorage: { getItem: key => storage.get(key) || null } }, document: { getElementById: id => fields[id] || null } };
    vm.runInNewContext(source.slice(0, source.indexOf('// Initialize the app when the page loads')) + '\nglobalThis.App = DatingApp;', context);
    const app = Object.assign(Object.create(context.App.prototype), { getMarketplaceUsername: () => 'Alex', getRealestateDraftBlockedDateEntries: () => [], postItemDraftStorageKey: 'draft' });
    return { app, fields, storage };
}

test('sale, long-term rental and commercial viewings are optional and preserve manual selections', () => {
    const { app, fields } = fixture();
    app.syncRealestateInquiriesUi();
    assert.equal(fields['realestate-inquiries-fields'].hidden, false);
    assert.deepEqual(Array.from(app.getSelectedRealestateViewingOptions()), []);
    fields['realestate-viewing-appointment'].checked = true;
    fields['realestate-viewing-virtual'].checked = true;
    for (const listingType of ['for_sale', 'for_rent_long', 'commercial']) {
        fields['realestate-listing-type'].value = listingType;
        app.syncRealestateInquiriesUi();
        assert.deepEqual(Array.from(app.getSelectedRealestateViewingOptions()), ['by_appointment', 'virtual_viewing']);
        assert.deepEqual(Array.from(app.getRealestatePostingDetails().viewingOptions), ['by_appointment', 'virtual_viewing']);
    }
});

test('short-term rentals hide and clear viewing choices while preserving contact and promotion fields', () => {
    const { app, fields } = fixture();
    fields['realestate-viewing-open-house'].checked = true;
    fields['realestate-listing-type'].value = 'for_rent_short';
    app.syncRealestateInquiriesUi();
    assert.equal(fields['realestate-inquiries-fields'].hidden, true);
    for (const option of app.getRealestateViewingChoices()) {
        assert.equal(fields[option.id].disabled, true);
        assert.equal(fields[option.id].checked, false);
        fields[option.id].checked = true; // A stale or tampered draft still cannot publish viewings.
    }
    assert.deepEqual(Array.from(app.getRealestatePostingDetails().viewingOptions), []);
    assert.equal(fields['item-contact-email'].value, 'seller@example.com');
    assert.equal(fields['posting-promotion-method'].value, 'credit_card');
});

test('leaving property clears viewing choices and does not add them to other categories', () => {
    const { app, fields } = fixture();
    fields['realestate-viewing-open-house'].checked = true;
    fields['item-category'].value = 'jobs';
    app.syncRealestateInquiriesUi();
    assert.equal(fields['realestate-inquiries-fields'].hidden, true);
    assert.equal(fields['realestate-viewing-open-house'].checked, false);
    assert.deepEqual(Array.from(app.getSelectedRealestateViewingOptions()), []);
    assert.equal(fields['item-availability'].value, 'Saturdays 10 am–2 pm');
});

test('viewing data accepts only supported choices, removes duplicates and rejects short-term values', () => {
    const { app } = fixture();
    assert.deepEqual(Array.from(app.getRealestateViewingOptions({ viewingOptions: ['open_house', 'open_house', 'delivery', 'virtual_viewing'] })), ['open_house', 'virtual_viewing']);
    assert.deepEqual(Array.from(app.getRealestateViewingOptions({ viewingOptions: 'open_house' })), []);
    assert.deepEqual(Array.from(app.getRealestateViewingOptions({ realestate: { listingType: 'for_rent_short', viewingOptions: ['open_house'] } })), []);
});

test('saved drafts restore viewing selections with the existing form restoration flow', () => {
    const { app, fields, storage } = fixture();
    fields['realestate-viewing-appointment'].checked = true;
    fields['realestate-viewing-open-house'].checked = true;
    storage.set('draft', JSON.stringify(app.collectPostItemDraftPayload()));
    for (const option of app.getRealestateViewingChoices()) fields[option.id].checked = false;
    app.applyPostItemFulfillmentOptionsFromDeliveryValue = () => {};
    app.syncCrossBorderSponsoredFields = () => {};
    app.updatePostItemCategoryFields = () => app.syncRealestateInquiriesUi();
    assert.equal(app.restorePostItemDraft(), true);
    assert.deepEqual(Array.from(app.getSelectedRealestateViewingOptions()), ['by_appointment', 'open_house']);
});

test('publication and server reload retain viewing choices, availability and preferred contact in public property details', async () => {
    const { app, fields } = fixture();
    fields['realestate-viewing-appointment'].checked = true;
    fields['realestate-viewing-virtual'].checked = true;
    let storedRow;
    app.currentUser = { id: 'seller' };
    app.supabase = { from: table => {
        assert.equal(table, 'marketplace_listings');
        return { insert: row => {
            storedRow = JSON.parse(JSON.stringify(row));
            return { select: () => ({ single: async () => ({ data: { ...storedRow, id: 'server-row', public_id: 'property' }, error: null }) }) };
        } };
    } };
    const realestate = app.getRealestatePostingDetails();
    const row = await app.createSupabaseMarketplaceListing({ id: 'property', category: 'real_estate', subcategory: 'for_sale', title: 'Family home', description: 'Three bedrooms.', city: 'Toronto', country: 'Canada', price: 800000, realestate, availability: fields['item-availability'].value, contact: { method: 'email', email: fields['item-contact-email'].value } });
    assert.deepEqual(storedRow.listing_payload.realestate.viewingOptions, ['by_appointment', 'virtual_viewing']);
    const listing = app.buildRealestateFeedEntryFromMarketplaceItem(app.normalizeSupabaseMarketplaceListingRow(row));
    assert.deepEqual(Array.from(listing.viewingOptions), ['by_appointment', 'virtual_viewing']);
    const details = app.buildRealestateDetailRows(listing);
    assert.equal(details.find(row => row.label === 'Viewings').value, 'By appointment · Virtual viewing');
    assert.equal(details.find(row => row.label === 'Viewing availability').value, 'Saturdays 10 am–2 pm');
    assert.equal(details.find(row => row.label === 'Preferred contact').value, 'Email · seller@example.com');
});

test('existing properties retain published phone contacts without inventing viewing options', () => {
    const { app } = fixture();
    const details = app.buildRealestateDetailRows({ listingType: 'for_sale', title: 'Existing property', contactPhone: '+1 555 123 4567' });
    assert.equal(details.find(row => row.label === 'Preferred contact').value, '+1 555 123 4567');
    assert.equal(details.some(row => row.label === 'Viewings'), false);
});

test('requesting a viewing opens the native conversation with an unsent viewing request', () => {
    const { app } = fixture();
    app.activeRealestateListing = { id: 'property', title: 'Family home', seller: 'Alex', serverBacked: true, sourceTable: 'marketplace_listings', listingType: 'for_sale' };
    let safety;
    let conversation;
    app.openSafetyModal = options => { safety = options; };
    app.closeRealestateModal = () => {};
    app.openServerBackedListingConversation = (listing, options) => { conversation = { listing, options }; };
    app.sendMessage = () => assert.fail('Opening a request must not send a message.');
    app.openRealestateSellerChat();
    assert.equal(conversation, undefined);
    safety.onContinue();
    assert.equal(conversation.listing.id, 'property');
    assert.match(conversation.options.prefill, /Could we arrange a viewing\?/);
    assert.match(conversation.options.prefill, /Family home/);
});

test('viewing requests preserve an existing chat draft and published-contact fallback', () => {
    const { app, fields } = fixture();
    app.activeRealestateListing = { id: 'property', title: 'Home', seller: 'Alex', listingType: 'for_sale' };
    let contacted;
    app.openPublishedContact = listing => { contacted = listing.id; };
    app.openRealestateSellerChat();
    assert.equal(contacted, 'property');
    app.authBypassEnabled = true;
    fields['message-input'].value = 'My existing message';
    app.openSafetyModal = options => options.onContinue();
    app.closeRealestateModal = () => {};
    app.openChatModal = () => {};
    app.openRealestateSellerChat();
    assert.equal(fields['message-input'].value, 'My existing message');
});

test('short-term host messaging retains its booking request and excludes viewing details', () => {
    const { app } = fixture();
    app.activeRealestateListing = { id: 'stay', title: 'Guest suite', seller: 'Alex', serverBacked: true, sourceTable: 'short_term_listings', listingType: 'for_rent_short' };
    let prefill;
    app.buildShortTermBookingRequestMessage = () => 'Native stay booking request with dates and guest count';
    app.openSafetyModal = options => options.onContinue();
    app.closeRealestateModal = () => {};
    app.openServerBackedListingConversation = (listing, options) => { prefill = options.prefill; };
    app.openRealestateSellerChat();
    assert.equal(prefill, 'Native stay booking request with dates and guest count');
    const details = app.buildRealestateDetailRows({ ...app.activeRealestateListing, viewingOptions: ['open_house'] });
    assert.equal(details.some(row => row.label === 'Viewings' || row.label === 'Viewing availability'), false);
});
