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
