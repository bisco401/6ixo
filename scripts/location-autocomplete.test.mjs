import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const requests = [];
let failKey = '';
const context = {
    setTimeout, clearTimeout, AbortController,
    fetch: async (url, options) => {
        assert.match(url, /^\/data\/geography\/(?:search\/(catalog|[0-9a-f]+(?:-[0-9a-f]+)?)|[A-Z]{2})\.json\?v=[\w-]+$/);
        assert.equal(options.credentials, 'omit');
        requests.push(url);
        if (failKey && url.includes(failKey)) throw new Error('Simulated offline shard');
        const file = new URL(url.slice(1).split('?')[0], root);
        return { ok: existsSync(file), status: existsSync(file) ? 200 : 404, json: async () => JSON.parse(readFileSync(file, 'utf8')) };
    }
};
vm.runInNewContext(readFileSync(new URL('location-autocomplete.js', root), 'utf8'), context);
const search = context.SIXO_LOCATION_AUTOCOMPLETE.search;

const atlanta = await search('Atla');
assert.equal(atlanta[0].label, 'Atlanta, United States');
assert.equal(atlanta[0].region, 'Georgia');
assert.ok(atlanta.some(row => row.city === 'Atlanta' && row.region !== 'Georgia'), 'Same-name cities remain distinct options');
assert.equal(requests.length, 2, 'Only the small catalog and one prefix shard are loaded');
await Promise.all([search('Atlanta'), search('ATLAN')]);
assert.equal(requests.length, 2, 'Typing more letters reuses the same shard');
assert.equal((await search('  Atlanta, georgia, USA '))[0].region, 'Georgia');
assert.ok((await search('Atlanta, united states')).every(row => row.country === 'United States'));
assert.equal((await search('canada'))[0].label, 'Canada');
assert.equal((await search('UK'))[0].country, 'United Kingdom');
assert.equal((await search('Toron'))[0].label, 'Toronto, Canada');
assert.equal((await search('Nair'))[0].label, 'Nairobi, Kenya');
assert.equal((await search('São Pau'))[0].city, 'São Paulo');
assert.equal((await search('sao pau'))[0].city, 'São Paulo');
assert.equal((await search('Montre'))[0].country, 'Canada');
assert.equal((await search('New Yo'))[0].country, 'United States');
assert.equal((await search('East Legon'))[0].label, 'East Legon, Ghana');
assert.equal((await search('east legon, ghana'))[0].region, 'Greater Accra');
assert.equal((await search('East Legon, Canada')).length, 0);
assert.equal((await search('Atlanta, Kenya')).length, 0, 'Qualifiers cannot silently switch countries');
const regions = [{ name: 'Florida', abbr: 'FL', country: 'United States' }, { name: 'Texas', abbr: 'TX', country: 'United States' }, { name: 'New York', abbr: 'NY', country: 'United States' }];
for (const query of ['Florida', 'Florida, United States', 'FL, USA', 'Texas', 'New York']) {
    const match = (await search(query, { regions }))[0];
    assert.equal(match.type, 'region', `${query} must not silently select a similarly named city`);
    assert.equal(match.city, '');
}
assert.equal((await search('Florida, Canada', { regions })).length, 0);
assert.ok((await search('Florida')).every(row => row.type !== 'region'), 'City-only controls retain their existing scope');
assert.equal((await search('zzzzzzzzzz')).length, 0);
assert.ok((await search('')).length > 240, 'An empty field offers the country dropdown');
assert.ok((await search('a')).every(row => row.type === 'country'), 'Cities need two letters');
assert.ok((await search('sa', { limit: 7 })).length <= 7);

const ghanaCities = await search('', { type: 'city', country: 'Ghana' });
assert.ok(ghanaCities.some(row => row.city === 'Accra'), 'An empty Ghana city field offers real cities immediately');
assert.ok(ghanaCities.every(row => row.type === 'city' && row.country === 'Ghana'));
const beforeCountryCache = requests.length;
const initialA = await search('a', { type: 'city', country: 'GH' });
assert.ok(initialA.length > 0 && initialA.every(row => row.city.toLowerCase().startsWith('a') && row.country === 'Ghana'));
assert.equal(requests.length, beforeCountryCache, 'Empty and one-letter searches reuse the country data');
assert.equal((await search('Accr', { type: 'city', country: 'Ghana' }))[0].city, 'Accra');
assert.ok((await search('ca', { type: 'city', country: 'Canada' })).every(row => row.type === 'city' && row.country === 'Canada'));
assert.equal((await search('London', { type: 'city', country: 'Canada', limit: 1 }))[0].country, 'Canada', 'Country filtering precedes ranking and limits');
assert.equal((await search('London, United Kingdom', { type: 'city', country: 'Canada' })).length, 0);
assert.equal((await search('Kenya', { type: 'city', country: 'Ghana' })).length, 0, 'City fields never offer countries');
assert.equal((await search('', { type: 'city', country: 'Gha' })).length, 0, 'An unresolved country draft cannot fall back to global suggestions');
assert.equal((await search('', { type: 'city' })).length, 0, 'An unscoped empty city field never shows countries');
assert.equal((await search('', { type: 'city', country: 'Antarctica' })).length, 0, 'Countries without populated-place data show an empty city list');
assert.ok((await search('ca', { type: 'country' })).every(row => row.type === 'country'));
assert.equal((await search('Toronto', { type: 'country' })).length, 0);
assert.equal((await search('UAE', { type: 'country' }))[0].country, 'United Arab Emirates');
const nearbyDubai = await search('', { type: 'city', country: 'United Arab Emirates', nearCity: 'Dubai', nearRegion: 'Dubai', limit: 50 });
assert.equal(nearbyDubai[0].city, 'Dubai', 'The entered city anchors nearby suggestions');
assert.ok(nearbyDubai.slice(0, 24).some(row => row.city === 'Sharjah'));
assert.ok(nearbyDubai.slice(0, 24).some(row => row.city === 'Ajman'));
assert.ok(nearbyDubai.every(row => row.country === 'United Arab Emirates'), 'Nearby suggestions stay inside the matched country');
assert.ok(nearbyDubai.findIndex(row => row.city === 'Sharjah') < nearbyDubai.findIndex(row => row.city === 'Abu Dhabi'), 'Nearby cities rank before more distant cities');
assert.equal((await search('', { type: 'city', country: 'UAE' }))[0].city, 'Abu Dhabi', 'Distance sorting does not mutate cached country records');
assert.equal((await search('Shar', { type: 'city', country: 'UAE', nearCity: 'Dubai' }))[0].city, 'Sharjah');
assert.equal((await search('', { type: 'city', country: 'Canada', nearCity: 'Hamilton', nearRegion: 'Ontario' }))[0].city, 'Hamilton');
failKey = '/KE.json';
await assert.rejects(search('', { type: 'city', country: 'Kenya' }), /offline/);
failKey = '';
assert.ok((await search('', { type: 'city', country: 'Kenya' })).length > 0, 'Failed country requests can be retried');

failKey = '/6b-75.json';
await assert.rejects(search('Kumasi'), /offline/);
failKey = '';
assert.equal((await search('Kumasi'))[0].label, 'Kumasi, Ghana', 'Failed requests can be retried');
assert.ok(requests.every(url => !url.includes('Atla') && !url.includes('Atlanta')), 'Full queries are not sent in data URLs');
console.log('City autocomplete passed: Atlanta prefix, population ranking, regions/countries, accents, typed qualifiers, country fallback, local-only shards, caching and retries.');
console.log('Nearby cities passed: UAE aliases, Dubai/Sharjah/Ajman order, Hamilton, country isolation and cache preservation.');
