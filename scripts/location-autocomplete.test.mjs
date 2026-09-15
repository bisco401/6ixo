import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const requests = [];
let failKey = '';
const context = {
    setTimeout, clearTimeout, AbortController,
    fetch: async (url, options) => {
        assert.match(url, /^\/data\/geography\/search\/(catalog|[0-9a-f]+(?:-[0-9a-f]+)?)\.json\?v=[\w-]+$/);
        assert.equal(options.credentials, 'omit');
        requests.push(url);
        if (failKey && url.includes(failKey)) throw new Error('Simulated offline shard');
        return { ok: true, json: async () => JSON.parse(readFileSync(new URL(url.slice(1).split('?')[0], root), 'utf8')) };
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
assert.equal((await search('Atlanta, Kenya')).length, 0, 'Qualifiers cannot silently switch countries');
assert.equal((await search('zzzzzzzzzz')).length, 0);
assert.ok((await search('')).length > 240, 'An empty field offers the country dropdown');
assert.ok((await search('a')).every(row => row.type === 'country'), 'Cities need two letters');
assert.ok((await search('sa', { limit: 7 })).length <= 7);

failKey = '/61-63.json';
await assert.rejects(search('Accr'), /offline/);
failKey = '';
assert.equal((await search('Accr'))[0].label, 'Accra, Ghana', 'Failed requests can be retried');
assert.ok(requests.every(url => !url.includes('Atla') && !url.includes('Atlanta')), 'Full queries are not sent in data URLs');
console.log('City autocomplete passed: Atlanta prefix, population ranking, regions/countries, accents, typed qualifiers, country fallback, local-only shards, caching and retries.');
