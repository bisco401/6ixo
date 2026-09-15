import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
const root = new URL('../', import.meta.url);
const source = readFileSync(new URL('app.js',root),'utf8');
const html = readFileSync(new URL('index.html',root),'utf8');
const endpoint = readFileSync(new URL('supabase/functions/google-places-search/index.ts',root),'utf8');
for (const text of [source, endpoint]) {
  assert.doesNotMatch(text,/maps\.googleapis\.com|places\.googleapis\.com|geolocation\.googleapis\.com|new google\.maps|google\.maps\.importLibrary/);
}
assert.doesNotMatch(html,/<script[^>]+google-config/);
assert.ok(html.indexOf('local-geography.js') < html.indexOf('src="app.js'));
assert.match(html,/GeoNames/);
assert.doesNotMatch(endpoint,/fetch\(|GOOGLE_MAPS_SERVER_API_KEY/);
let retiredHandler;
vm.runInNewContext(stripTypeScriptTypes(endpoint), {
  Deno:{serve(handler){retiredHandler=handler;}}, Response,
  fetch(){throw new Error('Retired backend must not call Google');}
});
const retiredResponse=retiredHandler(new Request('https://backend.test/google-places-search',{
  method:'POST',headers:{origin:'https://6ixo.com','content-type':'application/json'},body:'{"query":"restaurants"}'
}));
assert.equal(retiredResponse.status,200);
assert.deepEqual(await retiredResponse.json(),{places:[],retired:true});
assert.equal(retiredHandler(new Request('https://backend.test/google-places-search',{
  method:'OPTIONS',headers:{origin:'https://6ixo.com'}
})).status,204);
assert.equal(retiredHandler(new Request('https://backend.test/google-places-search',{
  headers:{origin:'https://unrelated.example'}
})).status,403);
const elements = {
  'main-app':{dataset:{}},
  'site-device-location-status':{textContent:''},
  'site-device-location-help':{hidden:false},
  'home-search-location':{value:'',dataset:{}},
  'home-device-location-status':{textContent:''}
};
let calls=0, fail=false;
const window = {setTimeout,clearTimeout,SIXO_GEOGRAPHY:{lookup:async()=>{
  calls++; if(fail) throw new Error('Offline');
  return {city:'Oakville',country:'Canada',source:'local_geonames',approximate:true};
}}};
const document={visibilityState:'visible',getElementById:id=>elements[id]||null,querySelector:()=>null,querySelectorAll:()=>[]};
const context={window,document,console,navigator:{geolocation:{clearWatch(){}}},URL,URLSearchParams};
vm.runInNewContext(source.slice(0,source.indexOf('// Initialize the app when the page loads'))+'\nglobalThis.App=DatingApp;',context);
const proto=context.App.prototype;
function app() {
  return Object.assign(Object.create(proto),{
    strictDeviceLocation:true,deviceLocationFeedsReady:false,currentUser:{location:{city:'Saved city',country:'Saved country'}},
    reverseGeocodeCache:new Map(),reverseGeocodeInFlight:new Map(),
    hasBrowserGeolocation:false,userLocation:null,googleListingLocationScope:{},
    locationLifecycleGeneration:0,cityLocationMaxAccuracyMeters:1000,
    isHomeLocationClearedByUser:()=>false,updateMarketplaceLocationControls(){},
    applyResolvedLocationDefaults(){this.defaults=this.getCurrentLocationDefaultParts();},
    getHomeSearchLocationSelection:()=>({}),refreshDeviceLocationFeeds:async()=>{},
    updateHomeCurrentLocationDisplay:proto.updateHomeCurrentLocationDisplay
  });
}
const local=app(); local.googleApiKey='an-old-cached-key';
const result=await local.reverseGeocodeLatLng(43.4675,-79.6877);
assert.equal(result.city,'Oakville');
await Promise.all([local.reverseGeocodeLatLng(43.4675,-79.6877),local.reverseGeocodeLatLng(43.4675,-79.6877)]);
assert.equal(calls,1);
local.reverseGeocodeCache.set(local.normalizeLocationKey(1,1),{city:'Old Google city',country:'Canada',source:'google'});
assert.equal((await local.reverseGeocodeLatLng(1,1)).source,'local_geonames');
fail=true; assert.equal(await local.reverseGeocodeLatLng(2,2),null);
assert.equal(local.localGeocodeStatus,'LOAD_ERROR');
fail=false; local.localGeocodeRetryAt=0;
assert.equal((await local.reverseGeocodeLatLng(2,2)).country,'Canada');
local.callSupabaseFunction=()=>{throw new Error('Paid search must never run');};
assert.equal((await local.fetchHomeLivePlaceResults({rawQuery:'restaurants near me',explicitSearch:true,nearMeActive:true})).length,0);
const manual=app(); manual.locationPermissionState='denied';
await manual.applyManualDiscoveryLocation({city:'Oakville',country:'Canada'});
assert.equal(manual.getCurrentLocationDisplayText(),'Oakville, Canada');
assert.equal(manual.getDeviceLocationStatusText(),'Browsing: Oakville, Canada');
assert.equal(manual.getDeviceListingLocationScope().pending,false);
assert.equal(manual.getDeviceListingLocationScope().city,'oakville');
assert.equal(manual.userLocation,null,'Manual selection cannot fabricate GPS coordinates');
assert.equal(manual.hasBrowserGeolocation,false);
assert.equal(manual.currentUser.location.city,'Saved city','Manual selection must not change stored profile location');
assert.equal(manual.getCurrentViewerCoords(),null);
assert.equal(elements['main-app'].dataset.deviceLocationReady,'true');
const gps=app();gps.hasBrowserGeolocation=true;gps.lastDeviceLocationSampleAt=Date.now();
gps.userLocation={lat:43.4675,lng:-79.6877,accuracy:15,timestamp:Date.now()};
const original=JSON.stringify(gps.userLocation);
await gps.applyManualDiscoveryLocation({city:'Toronto',country:'Canada'});
assert.equal(JSON.stringify(gps.userLocation),original);
await gps.applyEntryLocationDefaults();
assert.equal(gps.getCurrentLocationDisplayText(),'Toronto, Canada','GPS labels cannot override a chosen area');
gps.manualDiscoveryLocation=null;
gps.resolvedDeviceLocation={...result,key:gps.normalizeLocationKey(gps.userLocation.lat,gps.userLocation.lng)};
assert.equal(gps.getDeviceLocationStatusText(),'Approximate area: Oakville, Canada');
assert.equal(gps.getAccuracySupportedDeviceLocation(result).approximate,true,'Precise GPS does not make a nearest-city label exact');
assert.match(gps.buildGoogleMapsLink('Oakville, Canada'),/^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=/);
assert.doesNotMatch(gps.buildGoogleMapsLink('Oakville, Canada'),/[?&]key=/);
const draft = app();
delete draft.getHomeSearchLocationSelection;
draft.homeLocationDraft = { city: 'Toronto', region: '', country: 'Canada', text: 'Toronto, Canada' };
elements['home-search-location'].value = 'Atla';
elements['home-search-location'].dataset.autoLocationDefault = '1';
draft.updateHomeCurrentLocationDisplay();
assert.equal(elements['home-search-location'].value, 'Atla', 'GPS UI updates must not replace a typed prefix');
assert.equal(draft.syncHomeLocationHidden().text, 'Toronto, Canada', 'Listings keep the committed location while a prefix is edited');
assert.equal(elements['home-search-location'].value, 'Atla', 'Filter synchronization must not overwrite the draft');
draft.setHomeLocationControls({ city: 'Nairobi', country: 'Kenya', auto: true });
assert.equal(elements['home-search-location'].value, 'Atla', 'Late automatic location defaults must not replace typing');
console.log('Google-free location passed: no paid endpoints, local cache/retries, manual browsing without GPS, coordinate preservation, honest labels, key-free map links and autocomplete draft isolation.');
