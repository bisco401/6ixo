import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
function fixture() {
    const elements = new Map();
    const context = {
        console, URL, URLSearchParams, navigator: {},
        document: { getElementById: id => elements.get(id), querySelectorAll: () => [], addEventListener() {} },
        window: { location: { href: 'https://6ixo.com/?code=private-auth-code#vehicles', search: '' }, prompt() {} }
    };
    vm.runInNewContext(`${source.slice(0, source.indexOf('// Initialize the app when the page loads'))}\nglobalThis.App = DatingApp;`, context);
    const notices = [];
    const app = Object.assign(Object.create(context.App.prototype), {
        showNotification: (...args) => notices.push(args), marketplaceItems: [],
        openExternalListingUrl: url => { context.external = url; return true; }
    });
    return { app, context, notices, elements };
}

test('shared seller URLs retain string IDs and omit auth codes and unrelated navigation', () => {
    const { app } = fixture();
    const url = new URL(app.getCardShareUrl({ source: { type: 'vehicle', id: 'car/a & b' } }, 'marketplace', true));
    assert.equal(url.origin, 'https://6ixo.com');
    assert.equal(url.searchParams.get('id'), 'car/a & b');
    assert.equal(url.searchParams.get('card'), 'vehicle');
    assert.equal(url.searchParams.get('seller'), '1');
    assert.equal(url.searchParams.has('code'), false);
    assert.equal(url.hash, '');
});

test('native sharing receives an absolute link; cancelling never copies or claims success', async () => {
    const { app, context, notices } = fixture();
    let shared;
    context.navigator.share = async data => { shared = data; };
    await app.shareCard({ id: 12, title: 'Car' });
    assert.equal(shared.url, 'https://6ixo.com/?card=marketplace&id=12');
    context.navigator.share = async () => { throw Object.assign(new Error(), { name: 'AbortError' }); };
    context.navigator.clipboard = { writeText() { assert.fail('Must not copy after cancellation'); } };
    await app.shareCard({ id: 12 });
    assert.equal(notices.length, 0);
});

test('clipboard fallback reports success only after a successful write', async () => {
    const { app, context, notices } = fixture();
    let copied;
    context.navigator.clipboard = { writeText: async value => { copied = value; } };
    await app.shareCard({ id: 'listing-1' });
    assert.equal(copied, 'https://6ixo.com/?card=marketplace&id=listing-1');
    assert.match(notices[0][0], /Link copied/);
    notices.length = 0;
    context.navigator.clipboard.writeText = async () => { throw new Error('Denied'); };
    let manual;
    context.window.prompt = (_, value) => { manual = value; };
    await app.shareCard({ id: 'listing-1' });
    assert.equal(manual, copied);
    assert.equal(notices.length, 0);
});

test('missing share identity does not fabricate a link or success', async () => {
    const { app, notices } = fixture();
    await app.shareCard({ name: 'Unpublished profile' });
    assert.match(notices[0][0], /does not have a public link/);
});

test('call uses the exact seller source and first published number', () => {
    const { app, context } = fixture();
    app.marketplaceItems = [{ id: 'x', contact: { phone: '+233 24 123 4567 | +233 55 765 4321' } }];
    app.callCard({ source: { type: 'marketplace', id: 'x' } });
    assert.equal(context.window.location.href, 'tel:+233241234567');
});

test('missing phone produces feedback without dialing', () => {
    const { app, context, notices } = fixture();
    const before = context.window.location.href;
    app.callCard({ phone: '123' });
    assert.equal(context.window.location.href, before);
    assert.match(notices[0][0], /No phone number/);
});

test('message routes imported listings to SMS, email, WhatsApp, or original listing', () => {
    const { app, context } = fixture();
    app.openPublishedContact({ contact: { phone: '+1 416 555 0123' } }, 'Is it available?');
    assert.equal(context.window.location.href, 'sms:+14165550123?body=Is%20it%20available%3F');
    app.openPublishedContact({ contact: { method: 'email', email: 'seller@example.com', phone: '+14165550123' } }, 'Hello');
    assert.equal(context.window.location.href, 'mailto:seller%40example.com?body=Hello');
    app.openPublishedContact({ contact: { method: 'whatsapp', phone: '+233241234567' } }, 'Hello');
    assert.equal(context.external, 'https://wa.me/233241234567?text=Hello');
    app.openPublishedContact({ sourceUrl: 'https://example.com/listing/42' });
    assert.equal(context.external, 'https://example.com/listing/42');
});

test('unpublished contacts and unsafe links never open a simulated chat or external URL', () => {
    const { app, context, notices } = fixture();
    app.openChatModal = () => assert.fail('No disconnected chat');
    app.openMarketplaceChat({ id: 1, sourceUrl: 'javascript:alert(1)' });
    assert.equal(context.external, undefined);
    assert.match(notices[0][0], /no connected messaging account/);
});

test('connected seller messaging preserves the server recipient after the modal closes', () => {
    const { app } = fixture();
    const listing = { id: 'uuid', serverBacked: true, sourceTable: 'marketplace_listings' };
    app.marketplaceItems = [listing];
    app.activeSellerProfile = { name: 'Seller', source: { type: 'marketplace', id: 'uuid' } };
    app.openSafetyModal = ({ onContinue }) => onContinue();
    app.closeSellerProfileModal = () => { app.activeSellerProfile = null; };
    let actual;
    app.openServerBackedListingConversation = value => { actual = value; };
    app.openSellerProfileChat();
    assert.equal(actual, listing);
});

test('opening a shared seller link finds the original record including nonnumeric IDs', async () => {
    const { app, context } = fixture();
    context.window.location.search = '?card=marketplace&id=listing-uuid&seller=1';
    const listing = { id: 'listing-uuid' };
    app.marketplaceItems = [listing];
    app.buildSellerProfileData = record => ({ record });
    let opened;
    app.openSellerProfileModal = data => { opened = data; };
    await app.openSharedCardFromUrl();
    assert.equal(opened.record, listing);
});

test('shared links wait for delayed records and handle deleted listings', async () => {
    const { app, context, notices } = fixture();
    context.window.location.search = '?card=vehicle&id=car-2';
    for (const method of ['loadCsvScrapedListings', 'loadCountryFeaturedListings', 'loadKijijiGtaListings', 'loadOxglowRealestateListings', 'loadOxglowElectronicsListings', 'loadOxglowAutoPartsListings', 'loadSupabaseShortTermListings', 'loadSupabaseVehicleRentalListings', 'loadSupabaseFeaturedMarketplaceListings']) app[method] = async () => {};
    app.loadSupabaseVehicleRentalListings = async () => { await Promise.resolve(); app.vehicleListings = [{ id: 'car-2' }]; };
    let opened;
    app.openVehicleModal = value => { opened = value; };
    await app.openSharedCardFromUrl();
    assert.equal(opened.id, 'car-2');
    context.window.location.search = '?card=vehicle&id=deleted';
    await app.openSharedCardFromUrl();
    assert.match(notices[0][0], /no longer available/);
});

test('new share and call controls bind once and use the current profile', () => {
    const { app, elements } = fixture();
    const handlers = new Map();
    const ids = ['profile-modal-share', 'demo-profile-share-btn', 'vehicle-modal-share', 'realestate-modal-share', 'profile-modal-call', 'demo-profile-call', 'seller-profile-call', 'marketplace-item-call', 'vehicle-modal-call', 'realestate-modal-call', 'luxury-ad-call', 'service-modal-message'];
    for (const id of ids) elements.set(id, { addEventListener: (event, handler) => {
        assert.equal(event, 'click');
        assert.equal(handlers.has(id), false, 'must not register twice');
        handlers.set(id, handler);
    } });
    app.setupCardActions();
    app.setupCardActions();
    assert.equal(handlers.size, ids.length);
    let dialed;
    app.callCard = record => { dialed = record; };
    app.activeSellerProfile = { name: 'First seller' };
    app.activeSellerProfile = { name: 'Next seller' };
    handlers.get('seller-profile-call')();
    assert.equal(dialed.name, 'Next seller');
});

test('local trunk numbers remain local instead of receiving an incorrect +1 prefix', () => {
    const { app } = fixture();
    assert.equal(app.getTelHref('024 123 4567'), 'tel:0241234567');
    assert.equal(app.getTelHref('+233 24 123 4567'), 'tel:+233241234567');
    assert.equal(app.getTelHref('416 555 0123'), 'tel:+14165550123');
});

test('imported source metadata produces a reopenable marketplace link and retains contact fallback', () => {
    const { app, context } = fixture();
    const item = { id: 1234, source: { type: 'scraped', id: 'external-1234', url: 'https://example.com/listing/1234' } };
    const url = new URL(app.getCardShareUrl(item));
    assert.equal(url.searchParams.get('card'), 'marketplace');
    assert.equal(url.searchParams.get('id'), '1234');
    app.openPublishedContact(item);
    assert.equal(context.external, 'https://example.com/listing/1234');
});
