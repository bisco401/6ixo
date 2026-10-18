import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../assets/arrive-planner.js', import.meta.url), 'utf8');
function fixture(seed = {}) {
    const values = new Map(Object.entries(seed));
    const storage = { getItem: k => values.get(k) || null, setItem: (k, v) => values.set(k, v) };
    const context = { window: { localStorage: storage, addEventListener() {}, setTimeout, clearTimeout }, document: {}, Date, Intl, Map, Set, console };
    vm.runInNewContext(source, context);
    return { model: context.window.SIXO_ARRIVE_PLANNER.model, values, storage };
}
const trip = (changes = {}) => ({ id: 'trip-a', destination: 'Toronto, Canada', startDate: '2026-10-30', endDate: '2026-11-03', updatedAt: 1, items: [], ...changes });
const item = (changes = {}) => ({ id: 'activity-a', title: 'Museum visit', date: '2026-10-30', time: '14:30', cost: 2500, currency: 'CAD', updatedAt: 1, ...changes });
const plain = value => JSON.parse(JSON.stringify(value));

test('inclusive trip dates handle month/year boundaries, leap days and DST without shifting a day', () => {
    const { model } = fixture();
    assert.deepEqual(plain(model.dates('2026-10-30', '2026-11-03')), ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03']);
    assert.deepEqual(plain(model.dates('2026-12-31', '2027-01-01')), ['2026-12-31', '2027-01-01']);
    assert.equal(model.dates('2028-02-28', '2028-03-01').length, 3);
    assert.equal(model.dates('2026-03-08', '2026-03-08').length, 1);
    for (const [start, end] of [['2026-02-29', '2026-03-01'], ['2026-10-31', '2026-10-30'], ['2026-01-01', '2027-01-02'], ['', '2026-10-30']]) assert.equal(model.dates(start, end).length, 0);
});

test('shrinking trip dates preserves activities and moves only affected items to Unscheduled', () => {
    const { model } = fixture();
    const original = trip({ items: [item(), item({ id: 'b', date: '2026-11-03', notes: 'Keep this note' }), item({ id: 'c', date: '', time: '', notes: 'Decide later' })] });
    const result = model.resizeTrip(original, '2026-10-30', '2026-10-31', 'Toronto, Canada');
    assert.equal(result.moved, 1);
    assert.equal(result.trip.items[0].date, '2026-10-30');
    assert.equal(result.trip.items[1].date, '');
    assert.equal(result.trip.items[1].time, '');
    assert.equal(result.trip.items[1].notes, 'Keep this note');
    assert.equal(result.trip.items[1].cost, 2500);
    assert.equal(result.trip.items[2].notes, 'Decide later');
    assert.equal(original.items[1].date, '2026-11-03');
    assert.throws(() => model.resizeTrip(original, '2026-11-03', '2026-10-30', ''), /valid trip/);
});

test('time determines the day period; out-of-range and unscheduled items do not retain a scheduled time', () => {
    const { model } = fixture();
    assert.equal(model.normalizeItem(item({ time: '00:30' }), trip()).period, 'morning');
    assert.equal(model.normalizeItem(item({ time: '12:00' }), trip()).period, 'afternoon');
    assert.equal(model.normalizeItem(item({ time: '18:00' }), trip()).period, 'evening');
    assert.equal(model.normalizeItem(item({ time: '24:00' }), trip()).time, '');
    assert.equal(model.normalizeItem(item({ date: '2027-02-01' }), trip()).date, '');
    assert.equal(model.normalizeItem(item({ date: '' }), trip()).time, '');
    assert.equal(model.normalizeItem(item({ source: { kind: 'profile', id: 'private' } }), trip()).source, null);
});

test('optional estimates use integer cents, preserve zero, and keep currencies separate', () => {
    const { model } = fixture();
    assert.equal(model.cents('0'), 0);
    assert.equal(model.cents('12.5'), 1250);
    assert.equal(model.cents(''), null);
    for (const value of ['-1', '2.999', '1e4', 'Infinity', '1,000']) assert.ok(Number.isNaN(model.cents(value)));
    assert.deepEqual(plain(model.totals([item({ cost: 10 }), item({ id: 'b', cost: 20 }), item({ currency: 'USD', cost: 500 }), item({ cost: null }), item({ cost: 100000, deleted: true })])), { CAD: 30, USD: 500 });
});

test('merge preserves independent additions, newer edits and deletion tombstones across reloads', () => {
    const { model } = fixture();
    const cached = { trips: [trip({ items: [item(), item({ id: 'b' })] })] };
    const cloud = { trips: [trip({ items: [item({ title: 'Updated museum', updatedAt: 3 }), item({ id: 'b', deleted: true, updatedAt: 4 }), item({ id: 'c', title: 'Cloud activity' })] })] };
    const merged = model.merge(cached, cloud);
    assert.equal(merged.trips[0].items.length, 3);
    assert.equal(merged.trips[0].items[0].title, 'Updated museum');
    assert.equal(merged.trips[0].items[1].deleted, true);
    assert.deepEqual(plain(model.merge(merged, cached)), plain(merged));
});

test('guest plans survive a fresh store without being loaded into a signed-in account', async () => {
    const { model } = fixture();
    const guest = { isSignedIn: false };
    const first = new model.PlanStore(guest);
    await first.ready;
    first.save({ trips: [trip({ items: [item()] })] });
    const second = new model.PlanStore(guest);
    await second.ready;
    assert.equal(second.state.trips[0].items[0].title, 'Museum visit');
    const account = new model.PlanStore({ isSignedIn: true, currentUser: { id: 'account-b' } });
    await account.ready;
    assert.equal(account.state.trips.length, 0);
    assert.equal(second.status(), 'Saved on this device');
});

function cloudFixture({ failWrites = false, seed, waitRead } = {}) {
    const f = fixture();
    const rows = new Map(seed ? [['account-a', seed]] : []), writes = [], reads = [];
    const app = { isSignedIn: true, supabaseEnabled: true, currentUser: { id: 'account-a' } };
    app.supabase = {
        auth: { getUser: async () => ({ data: { user: { id: app.currentUser?.id } } }) },
        from(table) {
            assert.equal(table, 'app_client_state');
            return {
                select() {
                    const filters = {};
                    return { eq(key, value) { filters[key] = value; return this; }, async maybeSingle() {
                        reads.push({ ...filters });
                        if (waitRead) await waitRead;
                        return { data: rows.has(filters.user_id) ? { state_value: rows.get(filters.user_id) } : null };
                    } };
                },
                async upsert(row) {
                    writes.push(plain(row));
                    if (failWrites) return { error: new Error('Provider unavailable') };
                    rows.set(row.user_id, plain(row.state_value)); return {};
                }
            };
        }
    };
    return { ...f, app, rows, writes, reads };
}

test('account plans load from private state and serialized saves retain the latest edit', async () => {
    const f = cloudFixture({ seed: { trips: [trip({ items: [item()] })] } });
    const store = new f.model.PlanStore(f.app);
    await store.ready; await store.queue;
    assert.equal(store.state.trips[0].items.length, 1);
    store.state.trips[0].items.push(item({ id: 'b', title: 'Lunch' }));
    store.save(store.state);
    store.state.trips[0].items[1].title = 'Lunch with friends';
    store.state.trips[0].items[1].updatedAt = 10;
    store.save(store.state);
    await store.queue;
    assert.equal(f.rows.get('account-a').trips[0].items[1].title, 'Lunch with friends');
    assert.equal(store.status(), 'Saved to your account');
    assert.ok(f.reads.every(read => read.user_id === 'account-a' && read.state_key === 'arrive_planner_v1'));
    assert.ok(f.writes.every(write => write.user_id === 'account-a' && write.state_key === 'arrive_planner_v1'));
});

test('a delayed account response cannot hydrate or save after switching accounts', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const f = cloudFixture({ seed: { trips: [trip({ destination: 'Private account A trip' })] }, waitRead: gate });
    const store = new f.model.PlanStore(f.app);
    await Promise.resolve(); await Promise.resolve();
    f.app.currentUser = { id: 'account-b' };
    release(); await store.ready;
    assert.equal(store.state.trips.length, 0);
    assert.equal(store.save({ trips: [trip()] }), false);
    assert.equal(f.writes.length, 0);
    assert.equal(f.values.has('arrive_planner_v1:account-b'), false);
});

test('retired stores cannot become active after logging back into the same account', async () => {
    const f = cloudFixture(); const store = new f.model.PlanStore(f.app); await store.ready;
    store.state = f.model.normalize({ trips: [trip({ items: [item()] })] });
    store.retire();
    assert.equal(store.state.trips.length, 0);
    assert.equal(store.current(), false);
    assert.equal(store.save({ trips: [trip()] }), false);
    assert.equal(f.writes.length, 0);
});

test('sync failure keeps local plans and accurately reports device-only saving', async () => {
    const f = cloudFixture({ failWrites: true }); const store = new f.model.PlanStore(f.app); await store.ready;
    store.save({ trips: [trip()] }); await store.queue;
    assert.equal(store.state.trips.length, 1);
    assert.equal(JSON.parse(f.values.get(store.key)).trips.length, 1);
    assert.match(store.status(), /Saved on this device.*sync unavailable/);
    f.storage.setItem = () => { throw new Error('Storage full'); };
    const guest = new f.model.PlanStore({ isSignedIn: false }); await guest.ready;
    assert.equal(guest.save({ trips: [trip()] }), false);
    assert.match(guest.status(), /Unable to save/);
});

test('an unanswered sync request is bounded and a late result cannot report success', async () => {
    const { model } = fixture();
    let release;
    const delayed = new Promise(resolve => { release = resolve; });
    const request = model.requestTimeout(delayed, 10);
    await assert.rejects(request, /timed out/);
    release('late response');
    assert.equal(await model.requestTimeout(Promise.resolve('saved'), 100), 'saved');
});
