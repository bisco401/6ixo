import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
function fixture() {
    const storage = new Map();
    const context = { console, URL, URLSearchParams, window: { location: { href: 'https://6ixo.com/' } }, document: {}, localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) } };
    vm.runInNewContext(`${source.slice(0, source.indexOf('// Initialize the app when the page loads'))}\nglobalThis.App = DatingApp;`, context);
    const app = Object.assign(Object.create(context.App.prototype), { marketplaceItems: [] });
    return { app, context, storage };
}

test('uses the real listing identity and contact without inventing seller details', () => {
    const { app } = fixture();
    app.marketplaceItems = [{ id: 'uuid-listing', category: 'services', seller: 'Actual provider', contact: { phone: '9055707748' } }];
    const data = app.prepareNativeSponsoredData({ resourceId: 'uuid-listing', sourceType: 'luxury', sellerName: 'Actual provider', details: [{ label: 'Location', value: 'Ancaster, Canada' }] });
    assert.equal(data.listingType, 'service');
    assert.equal(data.source.type, 'marketplace');
    assert.equal(data.source.id, 'uuid-listing');
    assert.equal(data.phone, '9055707748');
    assert.equal(data.sellerName, 'Actual provider');
    assert.ok(data.details.some(detail => detail.label === 'Phone' && detail.value === '9055707748'));
});

test('category chooses contextual headings and phone details retain published numbers', () => {
    const { app } = fixture();
    for (const [category, expected] of [['real_estate', 'property'], ['vehicles', 'vehicle'], ['jobs', 'job'], ['services', 'service'], ['other', 'item']]) {
        const data = app.prepareNativeSponsoredData({ category, details: [{ label: 'Phone', value: '+254 700 000 123' }] });
        assert.equal(data.listingType, expected);
        assert.equal(data.phone, '+254 700 000 123');
    }
    const profile = { sourceType: 'companionship', profileId: 'p1' };
    assert.equal(app.prepareNativeSponsoredData(profile), profile);
});

test('vehicle profiles use the complete vehicle record and align every published specification', () => {
    const { app } = fixture();
    const fullDescription = 'Come visit our Hunt Club Nissan team. Engine: Regular Unleaded V-6 3.8 L/231 ... Transmission: Automatic\nMileage: 42,000 km\n' + 'Complete seller information. '.repeat(40);
    app.vehicleListings = [{ id: 'kijiji-1742282347', category: 'vehicles', title: '2023 Nissan Frontier PRO-4X', contactPhone: '+16135216262', fullDescription, description: 'Short feed summary', specifications: [{ label: 'Transmission', value: '9-speed automatic' }] }];
    const data = app.prepareNativeSponsoredData({ resourceId: 'kijiji-1742282347', category: 'Vehicles', desc: 'Short feed summary', details: [{ label: 'Category', value: 'Vehicles' }] });
    assert.equal(data.source.type, 'vehicle');
    assert.equal(data.listingType, 'vehicle');
    assert.equal(data.desc, fullDescription.trim());
    assert.equal(data.phone, '+16135216262');
    assert.equal(data.details.find(row => row.label === 'Engine').value, 'Regular Unleaded V-6 3.8 L/231');
    assert.equal(data.details.find(row => row.label === 'Mileage').value, '42,000 km');
    assert.equal(data.details.find(row => row.label === 'Transmission').value, '9-speed automatic');
    assert.equal(data.details.filter(row => row.label === 'Transmission').length, 1);
});

test('item, property, and service details retain explicit facts without inventing missing specifications', () => {
    const { app } = fixture();
    const item = app.getNativeSponsoredDetailRows({ brand: 'Sony', model: 'A7', description: 'Dimensions: 127 x 96 mm\nCondition: Used' });
    assert.equal(item.find(row => row.label === 'Dimensions').value, '127 x 96 mm');
    assert.ok(!item.some(row => row.label === 'Engine'));
    const property = app.getNativeSponsoredDetailRows({ realestate: { bedrooms: 2, bathrooms: 1, sqft: 840, amenities: 'Parking, balcony', listingType: 'for_rent_short' } });
    assert.equal(property.find(row => row.label === 'Bedrooms').value, '2');
    assert.equal(property.find(row => row.label === 'Amenities').value, 'Parking, balcony');
    assert.equal(property.find(row => row.label === 'Listing type').value, 'Short-term rental');
    const service = app.getNativeSponsoredDetailRows({ service: { duration: '60 minutes', address: '123 King Street', responseTime: 'Same day' } });
    assert.equal(service.find(row => row.label === 'Duration').value, '60 minutes');
    assert.equal(service.find(row => row.label === 'Address').value, '123 King Street');
});

test('saved UUID listings persist and coexist with existing numeric bookmarks', () => {
    const { app, storage } = fixture();
    storage.set('hs_marketplace_saved', '[42]');
    app.marketplaceSaved = app.loadMarketplaceSaved();
    assert.equal(app.isMarketplaceSaved('42'), true);
    assert.equal(app.toggleMarketplaceSaved('579e-actual-uuid'), true);
    app.marketplaceSaved = app.loadMarketplaceSaved();
    assert.equal(app.isMarketplaceSaved('579e-actual-uuid'), true);
    assert.equal(app.isMarketplaceSaved(42), true);
    assert.equal(app.toggleMarketplaceSaved('579e-actual-uuid'), false);
    assert.equal(app.toggleMarketplaceSaved(''), false);
});

test('server message receives its real record even after the sponsored modal closes', () => {
    const { app } = fixture();
    const item = { id: 'uuid', serverBacked: true, sourceTable: 'marketplace_listings', userId: 'real-recipient' };
    app.marketplaceItems = [item];
    app.activeLuxuryAd = { resourceId: 'uuid', source: { type: 'marketplace', id: 'uuid' } };
    app.closeLuxuryAdModal = () => { app.activeLuxuryAd = null; };
    app.openMarketplaceChat = received => assert.equal(received, item);
    app.openNativeSponsoredMessage();
    assert.equal(app.activeLuxuryAd, null);
    const imported = { title: 'Imported listing', phone: '9055707748' };
    app.activeLuxuryAd = imported;
    app.openPublishedContact = received => assert.equal(received, imported);
    app.openNativeSponsoredMessage();
});

test('drag callbacks follow horizontal touch movement and restore on cancel', () => {
    const { app } = fixture();
    const listeners = new Map();
    const classes = new Set();
    const surface = { dataset: {}, style: { setProperty() {} }, classList: { add: value => classes.add(value), remove: value => classes.delete(value) }, addEventListener: (name, fn) => listeners.set(name, fn) };
    app.isModalOpen = () => true;
    let offset = 0, advances = 0, restores = 0;
    app.bindModalSwipeSurface(surface, { onNext: () => advances++, onPrevious() {}, onDrag: value => { offset = value; }, onDragEnd: () => { offset = 0; restores++; } });
    const emit = (name, values = {}) => listeners.get(name)({ target: { closest: () => null }, cancelable: true, preventDefault() {}, ...values });
    const touch = x => ({ clientX: x, clientY: 50, identifier: 1 });
    emit('touchstart', { touches: [touch(250)] });
    emit('touchmove', { touches: [touch(175)] });
    assert.equal(offset, -75);
    assert.ok(classes.has('dragging'));
    emit('touchcancel');
    assert.equal(offset, 0);
    assert.equal(advances, 0);
    assert.ok(!classes.has('dragging'));
    emit('touchstart', { touches: [touch(250)] });
    emit('touchmove', { touches: [touch(130)] });
    emit('touchend', { changedTouches: [touch(130)] });
    assert.equal(advances, 1);
    assert.ok(restores >= 2);
});

test('imported item message action uses its published contact before the source website', () => {
    const { app } = fixture();
    const item = { id: 42, contactPhone: '+16135216262', source: { type: 'scraped_csv', url: 'https://example.com/original' } };
    app.activeMarketplaceItem = item;
    let contacted;
    app.openPublishedContact = record => { contacted = record; };
    app.openExternalListingUrl = () => assert.fail('Must use the published seller contact');
    app.openMarketplaceItemOffer();
    assert.equal(contacted, item);
});
