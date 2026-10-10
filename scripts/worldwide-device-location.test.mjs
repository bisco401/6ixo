import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const root=new URL('../',import.meta.url);
const providerSource=readFileSync(new URL('device-geocoder.js',root),'utf8');
const appSource=readFileSync(new URL('app.js',root),'utf8');
const samples=[
 ['Oakville','Canada','CA',43.4675,-79.6877], ['Nairobi','Kenya','KE',-1.2921,36.8219],
 ['London','United Kingdom','GB',51.5074,-.1278], ['Dubai','United Arab Emirates','AE',25.2048,55.2708],
 ['Tokyo','Japan','JP',35.6762,139.6503], ['Sydney','Australia','AU',-33.8688,151.2093],
 ['Kumasi','Ghana','GH',6.6885,-1.6244], ['São Paulo','Brazil','BR',-23.5505,-46.6333],
 ['Georgetown','Guyana','GY',6.8013,-58.1551]
];
function harness() {
 let now=Date.now(),id=0;const timers=new Map(), requests=[];
 const setTimer=(fn,ms)=>{timers.set(++id,{fn,ms});return id;};
 const elements={'home-search-location':{value:'',dataset:{}},'home-device-location-status':{textContent:''},'main-app':{dataset:{}}};
 const document={visibilityState:'visible',getElementById:id=>elements[id]||null,querySelector:()=>null,querySelectorAll:()=>[]};
 const window={setTimeout:setTimer,clearTimeout:id=>timers.delete(id)};
 const state={mode:'ok',sample:samples[0],respond:null};
 const context={window,document,URL,URLSearchParams,AbortController,console,navigator:{geolocation:{clearWatch(){}}},
  Date:class extends Date {static now(){return now;}},setTimeout:setTimer,clearTimeout:window.clearTimeout,
  fetch:async(url,options)=>{
   if(url.startsWith('/'))return{ok:true,json:async()=>JSON.parse(readFileSync(new URL(url.slice(1).split('?')[0],root),'utf8'))};
   const u=new URL(url);assert.equal(u.origin,'https://api.bigdatacloud.net');assert.equal(u.pathname,'/data/reverse-geocode-client');
   assert.equal(options.credentials,'omit');assert.equal(options.cache,'no-store');assert.equal(options.referrerPolicy,'no-referrer');
   assert.ok(u.searchParams.has('latitude')&&u.searchParams.has('longitude'),'Never invoke IP fallback');
   requests.push({url,options});
   if(state.mode==='offline')throw new Error('offline');
   if(state.mode==='rate')return{ok:false,status:429};
   if(state.mode==='deferred')await new Promise((resolve,reject)=>{state.respond=resolve;options.signal.addEventListener('abort',()=>reject(new Error('aborted')));});
   const [city,country,countryCode]=state.sample;
   const result={city,locality:'Nearby neighbourhood',countryName:country,countryCode,principalSubdivision:'Region',latitude:Number(u.searchParams.get('latitude')),longitude:Number(u.searchParams.get('longitude')),lookupSource:'reverseGeocoding'};
   if(state.mode==='ip')result.lookupSource='ipGeolocation';
   if(state.mode==='legacy')result.lookupSource='coordinates';
   if(state.mode==='mismatch')result.latitude+=1;
   if(state.mode==='missing')delete result.lookupSource;
   if(state.mode==='no-country')delete result.countryName;
   if(state.mode==='village'){result.city='';result.locality='Sample village';}
   return{ok:true,json:async()=>result};
  }};
 vm.runInNewContext(providerSource,context);
 vm.runInNewContext(readFileSync(new URL('local-geography.js',root),'utf8'),context);
 vm.runInNewContext(appSource.slice(0,appSource.indexOf('// Initialize the app when the page loads'))+'\nglobalThis.App=DatingApp;',context);
 const app=Object.assign(Object.create(context.App.prototype),{
  strictDeviceLocation:true,locationPermissionState:'granted',locationLifecycleGeneration:0,
  currentUser:{location:{}},googleListingLocationScope:{},reverseGeocodeCache:new Map(),reverseGeocodeInFlight:new Map(),
  cityLocationMaxAccuracyMeters:1000,hasBrowserGeolocation:true,deviceLocationFeedsReady:false,
  populateHomeCityDropdown(){},isHomeLocationClearedByUser:()=>false,
  getHomeSearchLocationSelection:()=>({}),updateMarketplaceLocationControls(){},
  applyResolvedLocationDefaults(){this.defaults=this.getCurrentLocationDefaultParts();},refreshDeviceLocationFeeds:async()=>{}
 });
 const setFix=(lat=state.sample[3],lng=state.sample[4],accuracy=15)=>{app.userLocation={lat,lng,accuracy,timestamp:now};app.lastDeviceLocationSampleAt=now;return app.userLocation;};
 setFix();return {context,window,document,app,elements,requests,state,timers,setFix,advance:ms=>{now+=ms;}};
}
// Fixtures model the documented provider schema. Do not send simulated or
// third-party coordinates to the actual free client-only endpoint.
for(const sample of samples){
 const h=harness();h.state.sample=sample;const original=h.setFix();
 await h.app.applyEntryLocationDefaults();
 assert.equal(h.elements['home-search-location'].value,`${sample[0]}, ${sample[1]}`);
 assert.equal(h.app.userLocation,original,'Resolving a place name cannot move device coordinates');
 assert.equal(h.requests.length,1);assert.match(h.elements['home-device-location-status'].textContent,/GPS accuracy ±15 m/);
 await h.app.applyEntryLocationDefaults();assert.equal(h.requests.length,1,'Use the exact-coordinate in-memory cache');
 h.advance(300001);h.setFix();await h.app.applyEntryLocationDefaults();assert.equal(h.requests.length,2,'Provider cache expires');
}
for(const mode of ['ip','mismatch','missing','no-country','offline','rate']){
 const h=harness();h.state.mode=mode;await h.app.applyEntryLocationDefaults();
 assert.equal(h.app.getCurrentLocationDisplayText(),'Canada',`${mode}: keep only local country`);
 assert.match(h.elements['home-device-location-status'].textContent,/GPS 43\.46750, -79\.68770/);
 assert.equal(h.app.resolvedDeviceLocation.needsCityRetry,true);
 await h.app.applyEntryLocationDefaults();assert.equal(h.requests.length,1,'Back off failed requests');
 h.advance(mode==='rate'?300001:16000);h.setFix();h.state.mode='ok';await h.app.applyEntryLocationDefaults();
 assert.equal(h.app.getCurrentLocationDisplayText(),'Oakville, Canada','Recovery must not need a page reload');
}
for(const mode of ['legacy','village']){
 const h=harness();h.state.mode=mode;await h.app.applyEntryLocationDefaults();
 assert.equal(h.app.resolvedDeviceLocation.city,mode==='village'?'Sample village':'Oakville');
}
for(const scenario of ['denied','manual','hidden','stale','foreign-coordinates']){
 const h=harness();
 if(scenario==='denied')h.app.locationPermissionState='denied';
 if(scenario==='manual')h.app.manualDiscoveryLocation={city:'London',country:'United Kingdom'};
 if(scenario==='hidden')h.document.visibilityState='hidden';
 if(scenario==='stale')h.advance(30001);
 await h.app.reverseGeocodeLatLng(scenario==='foreign-coordinates'?51.5:h.app.userLocation.lat,h.app.userLocation.lng);
 assert.equal(h.requests.length,0,scenario+': never send non-current/non-consented coordinates');
}
for(const [lat,lng,city] of [[40.8677,-73.9212,'New York'],[5.6354803,-.1617155,'East Legon'],[43.6532,-79.3832,'Toronto']]){
 const h=harness();h.setFix(lat,lng);await h.app.applyEntryLocationDefaults();
 assert.equal(h.app.resolvedDeviceLocation.city,city);assert.equal(h.requests.length,0,'Covered boundaries stay local');
}
{
 const h=harness();h.setFix(43.4675,-79.6877,3000);await h.app.applyEntryLocationDefaults();
 assert.equal(h.app.resolvedDeviceLocation.city,'');assert.match(h.elements['home-device-location-status'].textContent,/±3000 m.*Precise Location/);
 h.setFix();await h.app.applyEntryLocationDefaults();assert.equal(h.app.resolvedDeviceLocation.city,'Oakville');
}
{
 const h=harness();h.state.mode='deferred';const pending=h.app.applyEntryLocationDefaults();
 while(!h.state.respond)await new Promise(setImmediate);
 h.app.locationPermissionState='denied';h.app.stopLocationTracking();await pending;
 assert.equal(h.app.resolvedDeviceLocation,undefined,'Revocation discards a late provider response');
 assert.equal(h.requests[0].options.signal.aborted,true);
}
{
 const h=harness();h.state.mode='deferred';const pending=h.app.applyEntryLocationDefaults();
 while(!h.state.respond)await new Promise(setImmediate);
 const timer=[...h.timers.values()].find(t=>t.ms===8000);assert.ok(timer);timer.fn();await pending;
 assert.equal(h.app.getCurrentLocationDisplayText(),'Canada','Provider timeout preserves device/country fallback');
}
{
 const h=harness();h.state.mode='deferred';const pending=h.app.applyEntryLocationDefaults();
 while(!h.state.respond)await new Promise(setImmediate);
 h.state.mode='ok';h.state.sample=samples[1];h.setFix();const latest=h.app.applyEntryLocationDefaults();h.state.respond();await Promise.all([latest,pending]);
 assert.equal(h.app.getCurrentLocationDisplayText(),'Nairobi, Kenya','Late old city cannot overwrite movement');
}
{
 const h=harness();h.state.mode='deferred';const pending=h.app.applyEntryLocationDefaults();
 while(!h.state.respond)await new Promise(setImmediate);
 h.setFix(43.4681,-79.6877);const middle=h.app.applyEntryLocationDefaults();
 h.setFix(43.4687,-79.6877);const latest=h.app.applyEntryLocationDefaults();
 assert.equal(h.requests.length,1,'Driving must share one active city lookup');
 h.state.respond();await new Promise(setImmediate);
 assert.equal(h.app.getCurrentLocationDisplayText(),'Oakville, Canada','Movement during a nearby lookup must not starve the label');
 assert.equal(h.requests.length,2,'Check the newest GPS fix once the active lookup completes');
 const query=new URL(h.requests[1].url);
 assert.equal(Number(query.searchParams.get('latitude')),43.4687,'Skip intermediate GPS fixes');
 h.state.mode='ok';h.state.respond();await Promise.all([pending,middle,latest]);
 assert.equal(h.app.userLocation.lat,43.4687);
 assert.equal(h.app.deviceLocationFeedsReady,true);
}
assert.doesNotMatch(providerSource,/localStorage|sessionStorage|document\.cookie/);
const html=readFileSync(new URL('index.html',root),'utf8');
assert.ok(html.indexOf('src="device-geocoder.js')<html.indexOf('src="app.js'));
assert.match(readFileSync(new URL('location-entry.js',root),'utf8'),/coordinates may be sent to BigDataCloud/);
assert.match(readFileSync(new URL('privacy/index.html',root),'utf8'),/anonymised coordinate-to-IP pairings/);
console.log('Worldwide device location passed: nine city fixtures, local overrides, GPS-only requests, cache expiry, denial/manual/background guards, malformed/IP responses, timeouts, rate limits, retries, movement/revocation races and accuracy disclosure.');
