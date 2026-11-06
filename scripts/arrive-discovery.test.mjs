import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
const source = readFileSync(new URL('../assets/arrive-discovery.js', import.meta.url), 'utf8');
function fixture(seed = {}) {
    const values = new Map(Object.entries(seed));
    const window = { localStorage: { getItem: k => values.get(k) || null, setItem: (k, v) => values.set(k, v) }, setTimeout, clearTimeout };
    vm.runInNewContext(source, { window, document: {}, Date, Map, Set, AbortController });
    return { model: window.SIXO_ARRIVE_DISCOVERY.model, values };
}
const plain = value => JSON.parse(JSON.stringify(value));
const entry = changes => ({ kind: 'service', id: 'one', title: 'Restaurant', country: 'Ghana', city: 'Accra', categories: ['Restaurants'], image: 'https://example.com/one.jpg', price: 'GHS 50', updatedAt: 1, ...changes });
test('country browsing combines selected categories and a city narrows results strictly', () => {
    const { model } = fixture();
    const app = { getCountryAliasLabel: s => s === 'GH' ? 'Ghana' : s };
    const records = [
        { ...entry({ id: 'kumasi', city: 'Kumasi' }), postedAt: 100 },
        { ...entry({ id: 'accra' }), postedAt: 1 },
        { ...entry({ id: 'wrong-country', country: 'Canada' }), postedAt: 1000 },
        { ...entry({ id: 'car', categories: ['Car rental'], city: 'Accra' }), postedAt: 2 },
        { ...entry({ id: 'plumber', categories: ['Plumbing'] }), postedAt: 2000 }
    ];
    const prefs = { country: 'GH', city: 'Accra', categories: ['Restaurants', 'Car rental'] };
    assert.deepEqual(plain(model.discover(app, records, prefs).map(x => x.id)), ['car', 'accra']);
    assert.deepEqual(plain(model.discover(app, records, { ...prefs, categories: ['Restaurants'] }).map(x => x.id)), ['accra']);
    assert.deepEqual(plain(model.discover(app, records, { ...prefs, city: '' }).map(x => x.id)), ['kumasi', 'car', 'accra']);
    assert.equal(model.discover(app, records, { ...prefs, categories: [] }).length, 0);
    assert.equal(model.discover(app, records, { ...prefs, country: '' }).length, 0);
});
test('ordinary businesses, jobs, for-sale cars and monthly rentals do not become travel categories', () => {
    const { model } = fixture();
    assert.deepEqual(plain(model.categoriesFor('service', { category: 'home_services', title: 'Plumber in Accra' })), []);
    assert.deepEqual(plain(model.categoriesFor('marketplace', { category: 'jobs', title: 'Restaurant hiring' })), []);
    assert.deepEqual(plain(model.categoriesFor('vehicle', { category: 'cars', title: 'Car for sale' })), []);
    assert.deepEqual(plain(model.categoriesFor('realestate', { categories: ['rental'] })), []);
    assert.deepEqual(plain(model.categoriesFor('vehicle', { category: 'rentals' })), ['Car rental']);
    assert.deepEqual(plain(model.categoriesFor('service', { category: 'travel', title: 'Airport pickup and walking tour' })), ['Airport pickup', 'City tours']);
});
test('event dates are filtered inclusively and an unknown date never claims to match a stay', () => {
    const { model } = fixture();
    const records = ['2026-11-06', '2026-11-13', '2026-11-14', ''].map((eventDate, i) => ({ ...entry({ id: String(i), categories: ['Events'], eventDate }), postedAt: i }));
    const prefs = { country: 'Ghana', city: 'Accra', categories: ['Events'], startDate: '2026-11-06', endDate: '2026-11-13' };
    assert.deepEqual(plain(model.discover({}, records, prefs).map(x => x.id)), ['1', '0']);
    assert.equal(model.discover({}, records, { ...prefs, endDate: '2026-11-05' }).length, 0);
    assert.equal(model.dateKey('2026-02-30'), '');
});
test('unchecking an interest or changing country does not remove saved listings; removal tombstones survive merge', () => {
    const { model } = fixture();
    const saved = entry({ updatedAt: 2 });
    const a = { preferences: { country: 'Ghana', categories: ['Restaurants'], updatedAt: 1 }, saved: [saved] };
    const b = { preferences: { country: 'Canada', categories: [], updatedAt: 3 }, saved: [] };
    const result = model.merge(a, b);
    assert.equal(result.preferences.country, 'Canada');
    assert.equal(result.saved[0].title, 'Restaurant');
    const removed = model.merge(result, { saved: [entry({ deleted: true, updatedAt: 4 })] });
    assert.equal(model.merge(removed, a).saved[0].deleted, true);
});
test('reload restores the guest shortlist while another account starts with its own data', async () => {
    const { model } = fixture();
    const guest = { isSignedIn: false };
    const a = new model.Store(guest); await a.ready;
    a.state.saved.push(entry()); a.save();
    const b = new model.Store(guest); await b.ready;
    assert.equal(b.state.saved.length, 1);
    const account = new model.Store({ isSignedIn: true, currentUser: { id: 'another' } }); await account.ready;
    assert.equal(account.state.saved.length, 0);
    assert.equal(b.status(), 'Saved on this device');
});
function cloudFixture({ readGate, failWrites = false } = {}) {
    const f = fixture(), rows = new Map(), writes = [], reads = [];
    const app = { isSignedIn: true, supabaseEnabled: true, currentUser: { id: 'account-a' } };
    app.supabase = {
        auth: { getUser: async () => ({ data: { user: { id: app.currentUser.id } } }) },
        from(name) {
            assert.equal(name, 'app_client_state');
            return {
                select() {
                    const filters = {};
                    return { eq(key, value) { filters[key] = value; return this; }, async maybeSingle() {
                        reads.push(filters);
                        if (readGate) await readGate;
                        return { data: { state_value: rows.get(filters.user_id) } };
                    } };
                },
                async upsert(row) {
                    writes.push(plain(row));
                    if (failWrites) return { error: new Error('Unavailable') };
                    rows.set(row.user_id, plain(row.state_value)); return {};
                }
            };
        }
    };
    return { ...f, app, rows, writes, reads };
}
test('account sync uses an authenticated owner scope and serialized writes retain additions and removals', async () => {
    const f = cloudFixture();
    f.rows.set('account-a', { saved: [entry({ id: 'remote', updatedAt: 5 })] });
    const store = new f.model.Store(f.app); await store.ready;
    store.state.saved.push(entry({ id: 'local', updatedAt: 10 })); store.save();
    store.state.saved.find(x => x.id === 'remote').deleted = true;
    store.state.saved.find(x => x.id === 'remote').updatedAt = 11;
    store.save(); await store.queue;
    const reloaded = new f.model.Store(f.app); await reloaded.ready;
    assert.equal(reloaded.state.saved.find(x => x.id === 'remote').deleted, true);
    assert.equal(reloaded.state.saved.find(x => x.id === 'local').title, 'Restaurant');
    assert.ok(f.reads.every(x => x.user_id === 'account-a' && x.state_key === 'arrive_discovery_v1'));
    assert.ok(f.writes.every(x => x.user_id === 'account-a' && x.state_key === 'arrive_discovery_v1'));
    assert.equal(store.status(), 'Saved to your account');
});
test('delayed cloud responses and retired stores cannot reveal or save a previous account shortlist', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const f = cloudFixture({ readGate: gate });
    f.rows.set('account-a', { saved: [entry({ title: 'Private A' })] });
    const store = new f.model.Store(f.app);
    await Promise.resolve(); await Promise.resolve();
    f.app.currentUser = { id: 'account-b' };
    release(); await store.ready;
    assert.equal(store.state.saved.length, 0);
    assert.equal(store.save(), false);
    assert.equal(f.writes.length, 0);
    store.retire(); f.app.currentUser = { id: 'account-a' };
    assert.equal(store.current(), false);
    assert.equal(store.save(), false);
});
test('failed account sync retains the device shortlist and reports the actual save scope', async () => {
    const f = cloudFixture({ failWrites: true });
    const store = new f.model.Store(f.app); await store.ready;
    store.state.saved.push(entry()); store.save(); await store.queue;
    assert.equal(JSON.parse(f.values.get(store.key)).saved.length, 1);
    assert.match(store.status(), /Saved on this device/);
    assert.doesNotMatch(store.status(), /^Saved to your account$/);
});
test('collect rejects sold, unpublished, unsafe and unrelated entries while keeping real matching categories', () => {
    const { model } = fixture();
    const app = {
        serviceProfiles: [
            { id: 'active', category: 'food', name: 'A real restaurant', country: 'Ghana', city: 'Accra' },
            { id: 'sold', category: 'food', country: 'Ghana', sold: true },
            { id: 'draft', category: 'food', country: 'Ghana', status: 'draft' },
            { id: 'plumbing', category: 'home_services', title: 'Plumber', country: 'Ghana' },
            { id: 'held', category: 'food', country: 'Ghana' }
        ],
        isImportedListingPublishable: item => item.id !== 'held'
    };
    assert.deepEqual(plain(model.collect(app).map(x => x.id)), ['active']);
    assert.equal(model.snapshot(entry({ image: 'javascript:alert(1)' })).image, 'assets/ad-placeholder.svg');
});


test('city search excludes unknown cities and other countries, and expanding preserves categories and dates', () => {
    const { model } = fixture();
    const records = [
        { ...entry({ id: 'unknown', city: '' }), postedAt: 50 },
        { ...entry({ id: 'other-city', city: 'Kumasi' }), postedAt: 10 },
        { ...entry({ id: 'other-country', country: 'Canada' }), postedAt: 30 },
        { ...entry({ id: 'pickup', city: 'Kumasi', categories: ['Airport pickup'] }), postedAt: 40 },
        { ...entry({ id: 'dated', city: 'Kumasi', categories: ['Events'], eventDate: '2026-12-01' }), postedAt: 20 }
    ];
    const prefs = { country: 'Ghana', city: 'Accra', categories: ['Restaurants', 'Events'], startDate: '2026-11-06', endDate: '2026-11-13' };
    assert.equal(model.discover({}, records, prefs).length, 0);
    assert.deepEqual(plain(model.discover({}, records, { ...prefs, city: '' }).map(x => x.id)), ['unknown', 'other-city']);
});

test('complete city names match with accents and Unicode while partial and similarly named cities stay separate', () => {
    const { model } = fixture();
    const app = { isLooseLocationMatch: () => true };
    assert.equal(model.matchesCity(app, ' Montréal ', 'montreal'), true);
    assert.equal(model.matchesCity(app, 'Adenta, Greater Accra', 'Adenta'), true);
    assert.equal(model.matchesCity(app, 'Adenta, Greater Accra', 'Accra'), false);
    assert.equal(model.matchesCity(app, 'Toronto, Ontario', 'Toronto'), true);
    assert.equal(model.matchesCity({ getHomeSearchCityAliases: city => city === 'New York City' ? [city, 'NYC', 'New York'] : [city] }, 'New York City', 'NYC'), true);
    assert.equal(model.matchesCity(app, '北京', '北京'), true);
    for (const [city, target] of [['York', 'New York'], ['London', 'Londonderry'], ['Accra', 'Acc'], ['北京', '上海'], ['', 'Accra']]) {
        assert.equal(model.matchesCity(app, city, target), false, city + ' vs ' + target);
    }
});

test('events appear without dates or a trip submission and are refined when dates are supplied', () => {
    const { model } = fixture();
    const records = [
        { ...entry({ id: 'event', categories: ['Events'], eventDate: '2026-11-08' }), postedAt: 1 },
        { ...entry({ id: 'unknown-date', categories: ['Events'] }), postedAt: 0 }
    ];
    const prefs = { country: 'Ghana', city: 'Accra', categories: ['Events'] };
    assert.deepEqual(plain(model.discover({}, records, prefs).map(x => x.id)), ['event', 'unknown-date']);
    assert.deepEqual(plain(model.discover({}, records, { ...prefs, startDate: '2026-11-06' }).map(x => x.id)), ['event']);
});
