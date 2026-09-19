import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const root = new URL('../', import.meta.url);
const source = readFileSync(new URL('local-geography.js', root), 'utf8');
const requests = [];
let failFile = '';
const context = {
  setTimeout, clearTimeout, AbortController,
  fetch: async url => {
    assert.match(url, /^\/data\/geography\/(countries|CA-toronto|[A-Z]{2})\.json\?v=\d+$/);
    requests.push(url);
    if (url.includes(failFile) && failFile) throw new Error('Simulated offline data file');
    return { ok: true, json: async () => JSON.parse(readFileSync(new URL(url.slice(1).split('?')[0], root), 'utf8')) };
  }
};
vm.runInNewContext(source, context);
const geo = context.SIXO_GEOGRAPHY;
for (const [lat,lng,country] of [
  [43.6532,-79.3832,'Canada'], [43.4675,-79.6877,'Canada'],
  [42.3149,-83.0364,'Canada'], [42.3314,-83.0458,'United States'],
  [-1.2921,36.8219,'Kenya'], [5.6037,-.187,'Ghana'],
  [6.8013,-58.1551,'Guyana'], [18.0179,-76.8099,'Jamaica'],
  [51.5074,-.1278,'United Kingdom'], [-18.1416,178.4419,'Fiji'],
  [-36.8485,174.7633,'New Zealand'], [1.3521,103.8198,'Singapore']
]) {
  const result = await geo.lookup(lat,lng);
  assert.equal(result?.country,country, `Wrong country for ${lat}, ${lng}`);
  const toronto = lat === 43.6532 && lng === -79.3832;
  assert.equal(result.approximate, !toronto);
  assert.equal(result.source, toronto ? 'local_toronto_boundaries' : 'local_geonames');
  assert.ok(result.city);
  console.log(`${country}: ${result.city} (${result.distanceToCityKm} km from city point)`);
}
for (const coords of [[null,0],['43',-79],[NaN,0],[91,0],[0,181],[0,Infinity]]) {
  assert.equal(await geo.lookup(...coords),null);
}
assert.equal(await geo.lookup(0,-140),null,'Ocean must not borrow a city or country');
assert.ok(geo.distance(43.6532,-79.3832,43.4675,-79.6877) > 30);
assert.equal(geo.distance(0,0,0,0),0);
const donut = {type:'Polygon',coordinates:[[[0,0],[10,0],[10,10],[0,10],[0,0]],[[2,2],[4,2],[4,4],[2,4],[2,2]]]};
assert.equal(geo.contains(donut,1,1),true);
assert.equal(geo.contains(donut,3,3),false,'Country holes must be excluded');
const before=requests.length;
await Promise.all([geo.lookup(43.6532,-79.3832),geo.lookup(43.65,-79.38)]);
assert.equal(requests.length,before,'City and boundary files stay cached in memory');
failFile='/AU.json';
const partialCountry = await geo.lookup(-33.8688,151.2093);
assert.equal(partialCountry.country, 'Australia');
assert.equal(partialCountry.city, '');
assert.equal(partialCountry.needsCityRetry, true);
failFile='';
assert.equal((await geo.lookup(-33.8688,151.2093)).country,'Australia','Failed data loads are retryable');
await assert.rejects(geo.cities('../private'));
assert.ok((await geo.countries()).length > 240);
assert.ok((await geo.cities('CA')).some(c => c.city === 'Oakville'));
console.log('Local geography passed: real countries and borders, invalid fixes, offshore areas, cache, retries and same-origin requests only.');

const districtSamples = [
  ['Scarborough',43.76,-79.3159], ['Scarborough',43.7731,-79.2578],
  ['Scarborough',43.713,-79.232], ['Scarborough',43.825,-79.19],
  ['North York',43.76,-79.31645], ['North York',43.76672,-79.39909],
  ['East York',43.69,-79.33], ['York',43.69,-79.48],
  ['Etobicoke',43.65,-79.55], ['Toronto',43.6532,-79.3832]
];
for (const [city,lat,lng] of districtSamples) {
  const area = await geo.lookup(lat,lng);
  assert.equal(area.city, city, `Wrong district for ${lat}, ${lng}`);
  assert.equal(area.region, 'Ontario');
  assert.equal(area.country, 'Canada');
  assert.equal(area.source, 'local_toronto_boundaries');
  assert.equal(area.approximate, false, 'An actual containing polygon must be distinguished from a nearest-place guess');
}
for (const [lat,lng] of [[43.85,-79.33],[43.84,-79.08],[43.4675,-79.6877]]) {
  assert.equal((await geo.lookup(lat,lng)).source, 'local_geonames', 'The download bounding box must never assign a Toronto district outside its polygon');
}
const retryContext = { ...context };
vm.runInNewContext(source, retryContext);
failFile = '/CA-toronto.json';
const partialDistrict = await retryContext.SIXO_GEOGRAPHY.lookup(43.76,-79.3159);
assert.equal(partialDistrict.country, 'Canada');
assert.equal(partialDistrict.city, '', 'Missing district data cannot silently restore the wrong nearest town');
assert.equal(partialDistrict.needsCityRetry, true);
failFile = '';
assert.equal((await retryContext.SIXO_GEOGRAPHY.lookup(43.76,-79.3159)).city, 'Scarborough');
assert.ok(requests.every(url => !url.includes('lat=') && !url.includes('lng=')), 'No coordinates may leave the browser for local boundary lookup');
console.log('Toronto boundaries passed: four Scarborough points, all six districts, both sides of Victoria Park, outside-district isolation, offline retry and local-only requests.');
