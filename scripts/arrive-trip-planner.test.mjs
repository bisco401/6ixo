import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
function fixture() {
    const values = new Map();
    const window = { localStorage: { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) }, setTimeout, clearTimeout };
    const context = { window, document: {}, AbortController };
    vm.runInNewContext(readFileSync(new URL('../assets/arrive-trip-planner.js', import.meta.url), 'utf8'), context);
    vm.runInNewContext(readFileSync(new URL('../assets/arrive-discovery.js', import.meta.url), 'utf8'), context);
    return { trip: window.SIXO_ARRIVE_TRIP, model: window.SIXO_ARRIVE_DISCOVERY.model, values };
}
const item = (key, category, price = 'USD 25', other = {}) => ({ key, id: key, kind: 'service', title: key, country: 'Guyana', city: 'Georgetown', categories: [category], price, postedAt: 1, raw: {}, ...other });
const plain = value => JSON.parse(JSON.stringify(value));
test('trip settings normalize party sizes, currency, budget and essentials without accepting arbitrary fields', () => {
    const { trip } = fixture();
    const result = trip.normalize({ mode: 'family', adults: -10, children: 99, budget: -4, currency: 'GYD', essentials: ['Mobile data', 'Mobile data', 'fake'], planOpen: true });
    assert.equal(result.adults, 1); assert.equal(result.children, 10); assert.equal(result.budget, 0);
    assert.deepEqual(plain(result.essentials), ['Mobile data']); assert.equal(result.currency, 'GYD'); assert.equal(result.planOpen, true);
    assert.equal(trip.normalize({ mode: '__proto__', children: 3 }).mode, 'solo');
    assert.equal(trip.normalize({ mode: 'couple', children: 3 }).children, 0);
    assert.equal(trip.normalize({ mode: 'family' }).adults, 2);
    assert.equal(trip.normalize({ mode: 'family' }).children, 2);
});
test('budget comparison uses stated currency and rate and does not invent a price or conversion', () => {
    const { trip } = fixture();
    assert.deepEqual(plain(trip.quote({}, item('a', 'Short stays', 'CAD 1,250.50 / night'))), { amount: 1250.5, currency: 'CAD' });
    assert.equal(trip.aboveBudget({}, item('a', 'Restaurants', 'CAD 120'), { currency: 'CAD', budget: 100 }), true);
    assert.equal(trip.aboveBudget({}, item('a', 'Restaurants', 'GYD 12000'), { currency: 'USD', budget: 100 }), false);
    for (const price of ['Contact for price', 'Negotiable', 'USD 50–100', 'USD 50 to 100', '$500', 'USD -5', '']) assert.equal(trip.quote({}, item('a', 'Restaurants', price)), null, price);
    assert.equal(trip.quote({}, item('a', 'Events', 'USD 0')).amount, 0);
});
test('budget filters retain other currencies and unknown prices and never change destination matching', () => {
    const { model } = fixture();
    const records = [item('within', 'Restaurants', 'USD 50'), item('above', 'Restaurants', 'USD 150'), item('foreign-currency', 'Restaurants', 'GYD 5000'), item('unknown', 'Restaurants', 'Contact for price'), item('wrong-country', 'Restaurants', 'USD 20', { country: 'Canada' })];
    const prefs = { country: 'Guyana', categories: ['Restaurants'], trip: { currency: 'USD', budget: 100, hideAboveBudget: true } };
    assert.deepEqual(new Set(plain(model.discover({}, records, prefs).map(value => value.key))), new Set(['within', 'foreign-currency', 'unknown']));
    assert.equal(model.categoryPreview({}, records, prefs).aboveBudgetCount, 1);
    assert.equal(model.discover({}, records, { ...prefs, trip: { ...prefs.trip, hideAboveBudget: false } }).length, 4);
});
test('group hints only use explicitly supplied capacity and lower the rank of undersized stays', () => {
    const { trip } = fixture();
    const small = item('small', 'Short stays', 'USD 75', { raw: { maxGuests: 2 } });
    const large = item('large', 'Short stays', 'USD 150', { raw: { realestate: { maxGuests: 6 } } });
    const family = { mode: 'family', adults: 2, children: 2 };
    assert.ok(trip.score(large, family) > trip.score(small, family));
    assert.match(trip.facts({}, small, family).join(' '), /smaller than your group/);
    assert.deepEqual(plain(trip.facts({}, item('unknown', 'Short stays'), family)), []);
});
test('day plans use distinct real activities and leave unmatched parts of the day open', () => {
    const { trip } = fixture();
    const records = [item('tour', 'City tours'), item('beach', 'Beach day'), item('food', 'Restaurants'), item('stay', 'Short stays'), item('car', 'Car rental')];
    const plan = trip.buildDay(records, { mode: 'family' });
    assert.deepEqual(plain(plan.map(slot => slot.item?.key)), ['tour', 'beach', 'food']);
    assert.equal(new Set(plan.map(slot => slot.item.key)).size, 3);
    assert.equal(trip.buildDay([records[3], records[4]], {}).filter(slot => slot.item).length, 0);
    assert.equal(trip.buildDay([], {}).length, 3);
    assert.equal(trip.buildDay([item('used-appliance', 'Shopping', 'CAD 500', { kind: 'marketplace' })], {}).filter(slot => slot.item).length, 0, 'Shopping products are not scheduled as travel stops');
    assert.equal(trip.buildDay([item('chair', 'Spa & Beauty', 'Contact for price', { title: 'Hairstylist Chair Rental At Hair Salon' })], {}).filter(slot => slot.item).length, 0, 'Business-space offers are not consumer appointments');
});
test('saved activities are preferred, trip types change ordering, and family plans exclude nightlife', () => {
    const { trip } = fixture();
    const records = [item('tour', 'City tours'), item('spa', 'Spa & Beauty'), item('saved-tour', 'City tours'), item('club', 'Nightlife')];
    assert.equal(trip.buildDay(records, { mode: 'couple' })[0].item.key, 'spa');
    assert.equal(trip.buildDay(records, { mode: 'solo' })[0].item.key, 'tour');
    assert.equal(trip.buildDay(records, { mode: 'couple' }, ['saved-tour'])[0].item.key, 'saved-tour');
    assert.equal(trip.buildDay(records, { mode: 'family' }).some(slot => slot.item?.key === 'club'), false);
});
test('trip choices, essentials and plan state restore with the same account-scoped preferences', async () => {
    const { model } = fixture();
    const store = new model.Store({ isSignedIn: false }); await store.ready;
    store.state.preferences = { country: 'Guyana', categories: ['Shopping'], activeCategory: 'Shopping', updatedAt: 2, trip: { mode: 'family', adults: 3, children: 1, budget: 5000, currency: 'GYD', hideAboveBudget: true, essentials: ['Airport ride'], planOpen: true, interestsCustomized: true } };
    store.save();
    const reload = new model.Store({ isSignedIn: false }); await reload.ready;
    assert.equal(reload.state.preferences.trip.mode, 'family');
    assert.equal(reload.state.preferences.trip.budget, 5000);
    assert.deepEqual(plain(reload.state.preferences.trip.essentials), ['Airport ride']);
    assert.equal(reload.state.preferences.trip.planOpen, true);
    const other = new model.Store({ isSignedIn: true, currentUser: { id: 'other' } }); await other.ready;
    assert.equal(other.state.preferences.trip.mode, 'solo');
    assert.deepEqual(plain(other.state.preferences.trip.essentials), []);
});
