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
    assert.match(url, /^\/data\/geography\/(countries|CA-toronto|GH-accra|US-nyc|[A-Z]{2})\.json\?v=\d+$/);
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
  assert.equal(result.source, toronto ? 'local_toronto_boundaries' : 'local_country_boundaries');
  assert.equal(Boolean(result.city), toronto, 'Uncovered cities must not be guessed from nearest points');
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
assert.equal(partialCountry.needsCityRetry, false, 'Missing coverage must not cause endless data retries');
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
  assert.equal((await geo.lookup(lat,lng)).source, 'local_country_boundaries', 'The download bounding box must never assign a Toronto district outside its polygon');
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

// These East Legon points previously all resolved to Medina Estates.
for (const [lat, lng] of [[5.6354803, -0.1617155], [5.626047, -0.171631], [5.64, -0.155]]) {
  const area = await geo.lookup(lat, lng);
  assert.equal(area.city, 'East Legon');
  assert.equal(area.country, 'Ghana');
  assert.equal(area.region, 'Greater Accra');
  assert.equal(area.source, 'local_osm_boundaries');
  assert.equal(area.approximate, false);
}
for (const [lat, lng] of [[5.6658, -0.16307], [5.55602, -0.1969], [5.649, -0.179], [5.69276, -0.10047]]) {
  assert.notEqual((await geo.lookup(lat, lng)).city, 'East Legon', 'Madina, Accra, East Legon Hills and points outside the polygon must not be renamed');
}
const ghRetryContext = { ...context };
vm.runInNewContext(source, ghRetryContext);
failFile = '/GH-accra.json';
const ghPartial = await ghRetryContext.SIXO_GEOGRAPHY.lookup(5.6354803, -0.1617155);
assert.equal(ghPartial.country, 'Ghana');
assert.equal(ghPartial.city, '', 'An unavailable boundary cannot fall back to the known-wrong Medina Estates guess');
assert.equal(ghPartial.needsCityRetry, true);
failFile = '';
assert.equal((await ghRetryContext.SIXO_GEOGRAPHY.lookup(5.6354803, -0.1617155)).city, 'East Legon');
console.log('East Legon passed: three interior samples, surrounding-area isolation, offline fallback and retry.');

const nycSamples = [
  ['Inwood, Manhattan',40.8677,-73.9212], ['Lower Manhattan',40.7128,-74.006],
  ['Times Square',40.758,-73.9855], ['Brooklyn',40.6782,-73.9442],
  ['Queens',40.7282,-73.7949], ['JFK',40.6413,-73.7781],
  ['Bronx',40.8448,-73.8648], ['Staten Island',40.5795,-74.1502]
];
for (const [name,lat,lng] of nycSamples) {
  const area = await geo.lookup(lat,lng);
  assert.equal(area.city,'New York',name);
  assert.equal(area.country,'United States');
  assert.equal(area.source,'local_nyc_boundaries');
  assert.equal(area.cityVerified,true);
  assert.ok(area.boundaryClearanceMeters > 30,name);
}
for (const [name,lat,lng] of [
  ['Inwood, Nassau County',40.622,-73.7468],['Jersey City',40.7178,-74.0431],
  ['Yonkers',40.9312,-73.8988],['Albany',42.6526,-73.7562],
  ['Oakville',43.4675,-79.6877],['Nairobi',-1.2921,36.8219]
]) {
  const area = await geo.lookup(lat,lng);
  assert.equal(area.city,'',`${name} must not borrow a city without a containing boundary`);
  assert.equal(area.cityVerified,false);
  assert.equal(area.needsCityRetry,false,'Missing coverage is not a transient download failure');
}
const nyRetryContext={...context}; vm.runInNewContext(source,nyRetryContext);
failFile='/US-nyc.json';
const nyMissing=await nyRetryContext.SIXO_GEOGRAPHY.lookup(40.8677,-73.9212);
assert.equal(nyMissing.country,'United States');
assert.equal(nyMissing.city,'');
assert.equal(nyMissing.needsCityRetry,true);
failFile='';
assert.equal((await nyRetryContext.SIXO_GEOGRAPHY.lookup(40.8677,-73.9212)).city,'New York');
assert.ok(requests.every(url=>!url.includes('lat=')&&!url.includes('lng=')));
console.log('Strict city coverage passed: all five NYC boroughs, JFK, Inwood, neighbouring cities, unsupported areas and failed-boundary retry.');
