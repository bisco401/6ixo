const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadDatingAppClass() {
    const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    const classList = { add() {}, remove() {}, contains() { return false; } };
    const context = {
        URL,
        URLSearchParams,
        TextEncoder,
        clearInterval,
        clearTimeout,
        console,
        crypto: globalThis.crypto,
        document: {
            addEventListener() {},
            body: { appendChild() {} },
            cookie: '',
            documentElement: { classList },
            getElementById() { return null; },
            querySelectorAll() { return []; }
        },
        localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
        navigator: {},
        requestAnimationFrame(callback) { return callback(); },
        setInterval,
        setTimeout,
        window: {
            addEventListener() {},
            crypto: globalThis.crypto,
            location: { href: 'http://localhost:8000/', hostname: 'localhost', protocol: 'http:' },
            localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
            TextEncoder
        }
    };
    context.window.window = context.window;
    context.window.document = context.document;
    vm.createContext(context);
    vm.runInContext(`${source}\nthis.__DatingApp = DatingApp;`, context, { filename: 'app.js' });
    return context.__DatingApp;
}

const DatingApp = loadDatingAppClass();

test('normalizes persistent marketplace listings without losing the UI id', () => {
    const app = Object.create(DatingApp.prototype);
    const listing = app.normalizeSupabaseMarketplaceListingRow({
        id: '9df41fe5-b79a-4585-8587-54d4f0c389e2',
        public_id: 'ml_example',
        user_id: 'seller-user',
        category: 'electronics',
        subcategory: 'phones',
        title: 'Phone',
        price: '799',
        status: 'published',
        media_urls: ['https://cdn.example/phone.jpg'],
        listing_payload: { id: 1730000000000, seller: 'Alex' }
    });

    assert.equal(listing.id, 1730000000000);
    assert.equal(listing.serverListingPublicId, 'ml_example');
    assert.equal(listing.sellerUserId, 'seller-user');
    assert.equal(listing.images[0], 'https://cdn.example/phone.jpg');
    assert.equal(listing.serverBacked, true);
});

test('creates a marketplace row with durable media and ownership fields', async () => {
    const app = Object.create(DatingApp.prototype);
    let insertedRow = null;
    app.currentUser = { id: 'user-1', marketplaceProfileId: 'profile-1' };
    app.supabase = {
        from(table) {
            assert.equal(table, 'marketplace_listings');
            return {
                insert(row) {
                    insertedRow = row;
                    return {
                        select() {
                            return {
                                async single() {
                                    return { data: { id: 'row-1', public_id: 'ml_1', ...row }, error: null };
                                }
                            };
                        }
                    };
                }
            };
        }
    };

    const result = await app.createSupabaseMarketplaceListing({
        id: 100,
        category: 'services',
        subcategory: 'cleaning',
        title: 'Home cleaning',
        description: 'Two-hour service',
        price: 120,
        city: 'Toronto',
        country: 'Canada',
        images: ['https://cdn.example/cleaning.jpg']
    });

    assert.equal(result.public_id, 'ml_1');
    assert.equal(insertedRow.user_id, 'user-1');
    assert.equal(insertedRow.marketplace_profile_id, 'profile-1');
    assert.equal(Array.from(insertedRow.media_urls).join(','), 'https://cdn.example/cleaning.jpg');
    assert.equal(insertedRow.listing_payload.id, 100);
});

test('uploads listing media to the signed-in user folder and returns a durable URL', async () => {
    const app = Object.create(DatingApp.prototype);
    let uploadedPath = '';
    app.currentUser = { id: 'user-1' };
    app.supabase = {
        storage: {
            from(bucketName) {
                assert.equal(bucketName, 'marketplace-media');
                return {
                    async upload(storagePath, file, options) {
                        uploadedPath = storagePath;
                        assert.equal(file.name, 'front view.jpg');
                        assert.equal(options.contentType, 'image/jpeg');
                        return { error: null };
                    },
                    getPublicUrl(storagePath) {
                        return { data: { publicUrl: `https://cdn.example/${storagePath}` } };
                    },
                    async remove() {}
                };
            }
        }
    };

    const result = await app.uploadMarketplaceListingMedia([{
        file: { name: 'front view.jpg', type: 'image/jpeg', size: 2048 }
    }], { folder: 'listing photos' });

    assert.match(uploadedPath, /^user-1\/listing-photos\//);
    assert.equal(result.uploadedPaths[0], uploadedPath);
    assert.equal(result.publicUrls[0], `https://cdn.example/${uploadedPath}`);
});

test('opens listing conversations through the authenticated RPC', async () => {
    const app = Object.create(DatingApp.prototype);
    let rpcCall = null;
    app.supabaseEnabled = true;
    app.isSignedIn = true;
    app.currentUser = { id: 'buyer-user' };
    app.supabase = {
        async rpc(name, args) {
            rpcCall = { name, args };
            return {
                data: [{
                    conversation_public_id: 'conv_1',
                    listing_public_id: 'ml_1',
                    listing_title: 'Phone',
                    guest_display_name: 'Buyer',
                    host_display_name: 'Seller',
                    other_display_name: 'Seller'
                }],
                error: null
            };
        }
    };

    const conversation = await app.getOrCreateListingConversation({
        serverBacked: true,
        sourceTable: 'marketplace_listings',
        serverListingPublicId: 'ml_1',
        sellerUserId: 'seller-user'
    });

    assert.equal(rpcCall.name, 'get_or_create_listing_conversation');
    assert.equal(rpcCall.args.p_listing_public_id, 'ml_1');
    assert.equal(rpcCall.args.p_listing_source, 'marketplace');
    assert.equal(conversation.id, 'conv_1');
    assert.equal(conversation.otherName, 'Seller');
});

test('vehicle rental booking messages use the vehicle RPC', async () => {
    const app = Object.create(DatingApp.prototype);
    let rpcName = '';
    app.supabaseEnabled = true;
    app.isSignedIn = true;
    app.currentUser = { id: 'guest-user' };
    app.supabase = {
        async rpc(name) {
            rpcName = name;
            return {
                data: [{
                    conversation_public_id: 'conv_vehicle',
                    booking_public_id: 'vrb_1',
                    listing_public_id: 'ml_vehicle',
                    listing_title: 'Convertible',
                    guest_display_name: 'Guest',
                    host_display_name: 'Host',
                    other_display_name: 'Host'
                }],
                error: null
            };
        }
    };

    const conversation = await app.getOrCreateVehicleRentalBookingConversation({ id: 'vrb_1' });
    assert.equal(rpcName, 'get_or_create_vehicle_rental_booking_conversation');
    assert.equal(conversation.id, 'conv_vehicle');
});

test('vehicle rental totals reject same-day returns and calculate valid trips', () => {
    const app = Object.create(DatingApp.prototype);
    assert.equal(app.getVehicleRentalTripTotals({ dailyRate: 150 }, '2026-08-20', '2026-08-20'), null);
    const totals = app.getVehicleRentalTripTotals({ dailyRate: 150, currency: 'CAD' }, '2026-08-20', '2026-08-23');
    assert.equal(totals.tripDays, 3);
    assert.equal(totals.subtotal, 450);
    assert.equal(totals.serviceFee, 54);
    assert.equal(totals.total, 504);
    assert.equal(totals.currency, 'CAD');
});

test('only host-posted short-term stays can enter live booking checkout', () => {
    const app = Object.create(DatingApp.prototype);
    assert.equal(app.isServerBackedShortTermBookingListing({ id: 're-la-shortstay' }), false);
    assert.equal(app.isServerBackedShortTermBookingListing({ id: 'st_public_1' }), true);
    assert.equal(app.isServerBackedShortTermBookingListing({
        id: 'custom-id',
        sourceTable: 'short_term_listings'
    }), true);
});
