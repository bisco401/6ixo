import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../assets/location-entry.css', import.meta.url), 'utf8');
const elements = {
 'home-search-location': { value: '', dataset: {} },
 'home-device-location-status': { textContent: '' },
 'site-device-location-status': { textContent: '' },
 'site-device-location-help': { hidden: false },
 'main-app': { dataset: {} }
};
let featured = [];
let timerId = 0;
const timers = new Map();
const document = {
 visibilityState: 'visible',
 getElementById(id) { return elements[id] || null; },
 querySelector() { return null; },
 querySelectorAll(selector) { return selector === '#main-app .featured-ad-card' ? featured : []; }
};
const window = { setTimeout(fn, ms) { timers.set(++timerId, {fn,ms}); return timerId; }, clearTimeout(id) { timers.delete(id); } };
const context = {document, window, console, navigator:{geolocation:{clearWatch(){}}}, URL, URLSearchParams};
vm.runInNewContext(source.slice(0, source.indexOf('// Initialize the app when the page loads'))+'\nglobalThis.App=DatingApp;',context);
const App = context.App;
const local = {city:'Oakville',country:'Canada',source:'google'};
const foreign = {city:'Nairobi',country:'Kenya',source:'google'};
const fix = (lat=43.4675,lng=-79.6877) => ({coords:{latitude:lat,longitude:lng,accuracy:20},timestamp:Date.now()});
function makeApp() {
 elements['home-search-location'].value='Saved city, Saved country';
 elements['home-search-location'].dataset={};
 const app = Object.assign(Object.create(App.prototype),{
  strictDeviceLocation:true, deviceLocationFeedsReady:false, didApplyEntryLocationDefaults:false,
  currentUser:{location:{city:'Saved city',country:'Saved country'}}, currentUserLocationSource:'profile',
  hasBrowserGeolocation:false, userLocation:null, cityLocationMaxAccuracyMeters:1000,
  googleListingLocationScope:{}, servicesFeedFilters:{}, companionshipFilters:{}, marketplaceQuickFilters:{},
  updateUserDistances(){}, scheduleLocationAwareResultsRefresh(){}, scheduleLocationFreshnessCheck(){},
  startLocationTracking(){}, showNotification(){}, populateHomeCityDropdown(){},
  getHomeSearchLocationSelection(){return {text:elements['home-search-location'].value};},
  isHomeLocationClearedByUser(){return false;},
  resetScreenLocationsForBrowserRefresh({city,country,label}){this.setHomeLocationControls({city,country,text:label,auto:true});},
  applyVehicleGeoLocationDefaults(){}, applyHomeFilters(){}, renderHomePersonalizedRows(){}, renderHomeTodayDeals(){},
  renderServicesFeed(){}, filterCommunityPosts(){}, applyDatingLocationFeed(){},
  applyVisitorLocalFeedDefaults(){}, syncCompanionshipMiniLocationFromFilters(){}, applyActiveScreenLocationDefaults(){},
  reverseGeocodeLatLng:async()=>local
 });
 return app;
}
const app=makeApp();
app.updateHomeCurrentLocationDisplay();
assert.equal(elements['main-app'].dataset.deviceLocationReady,'false');
for(const options of [{},{city:'Saved city',country:'Saved country'},{useDefaultCountry:false},{useGoogleFallback:true}]) {
 const scope=app.getEffectiveListingLocationScope(options);
 assert.equal(scope.pending,true);
 assert.equal(app.matchesListingLocationScope({city:'Saved city',country:'Saved country'},scope),false);
}
app.applyPreciseBrowserLocation(fix());
await app.locationDefaultsPromise;
assert.equal(elements['main-app'].dataset.deviceLocationReady,'true');
assert.equal(elements['home-search-location'].value,'Oakville, Canada');
assert.equal(elements['site-device-location-status'].textContent,'Device location: Oakville, Canada');
assert.equal(elements['site-device-location-help'].hidden,true);
const scope=app.getDefaultListingCountryScope();
assert.equal(scope.city,'oakville');
assert.equal(app.matchesListingLocationScope(local,scope),true);
assert.equal(app.matchesListingLocationScope({city:'Toronto',country:'Canada'},scope),false,'Same country alone cannot pass the local filter');
assert.equal(app.matchesListingLocationScope(foreign,scope),false);
assert.equal(app.matchesListingLocationScope({city:'Oakville East',country:'Canada'},scope),false,'A similarly named city is not the device city');
assert.equal(app.matchesListingLocationScope({city:'Oakville',country:'United States'},scope),false,'A same-named city in another country is excluded');
assert.equal(app.matchesListingLocationScope({label:'Oakville, Ontario, Canada'},scope),true);
assert.equal(app.matchesOtherLocation({location:local},{}),true);
assert.equal(app.matchesOtherLocation({location:foreign},{}),false);
assert.equal(app.matchesListingLocationScope(foreign,app.getEffectiveListingLocationScope(foreign)),true,'A deliberate different-area search remains supported after device entry');
const card=(location)=>({dataset:{adLocation:location},excluded:false,classList:{toggle(_,excluded){this.owner.excluded=excluded;}}});
featured=[card('Oakville, Canada'),card('Toronto, Canada'),card('Nairobi, Kenya'),card('')];
featured.forEach(c=>c.classList.owner=c);
app.filterFeaturedCardsForDeviceLocation();
assert.deepEqual(featured.map(c=>c.excluded),[false,true,true,true]);
app.marketplaceItems=[local,foreign,{city:'Toronto',country:'Canada'}].map((location,i)=>({...location,id:i+1,title:'Discount deal',price:10,postedDate:new Date()}));
app.isRealMarketplaceListing=()=>true;
assert.equal(app.getHomeTodayDeals().length,1);
let finishLookup;
app.reverseGeocodeLatLng=()=>new Promise(resolve=>{finishLookup=resolve;});
app.applyPreciseBrowserLocation(fix(-1.2921,36.8219));
const moving=app.locationDefaultsPromise;
assert.equal(elements['main-app'].dataset.deviceLocationReady,'false');
assert.match(elements['site-device-location-status'].textContent,/Last confirmed: Oakville/);
finishLookup(foreign); await moving;
assert.equal(elements['main-app'].dataset.deviceLocationReady,'true');
assert.equal(elements['home-search-location'].value,'Nairobi, Kenya');
assert.deepEqual(featured.map(c=>c.excluded),[true,true,false,true]);
app.lastDeviceLocationSampleAt=Date.now()-90001;
app.handleLocationError({code:2});
assert.equal(elements['main-app'].dataset.deviceLocationReady,'false');
assert.equal(app.getEffectiveListingLocationScope(foreign).pending,true);
assert.match(elements['site-device-location-status'].textContent,/Last confirmed: Nairobi/);
app.handleLocationError({code:1});
assert.equal(app.lastConfirmedDeviceLocation,null);
assert.match(elements['site-device-location-status'].textContent,/Location access is off/);
app.reverseGeocodeLatLng=async()=>local;
app.applyPreciseBrowserLocation(fix()); await app.locationDefaultsPromise;
assert.equal(elements['main-app'].dataset.deviceLocationReady,'true');
assert.equal(elements['home-search-location'].value,'Oakville, Canada');
const rendering=makeApp();
let finishRender;
rendering.applyHomeFilters=()=>new Promise(resolve=>{finishRender=resolve;});
rendering.applyPreciseBrowserLocation(fix());
const awaitingRender=rendering.locationDefaultsPromise;
await new Promise(setImmediate);
assert.equal(elements['main-app'].dataset.deviceLocationReady,'false','Do not reveal old results while local results are rendering');
finishRender(); await awaitingRender;
assert.equal(elements['main-app'].dataset.deviceLocationReady,'true');
assert.match(html,/id="main-app"[^>]*data-device-location-ready="false"/);
assert.match(html,/id="site-device-location-status"[^>]*role="status"/);
assert.match(css,/data-device-location-ready="false"/);
assert.match(css,/device-location-excluded/);
console.log('Strict device location passed: first paint, stored-profile isolation, local-only filters/deals/featured cards, movement, render ordering, expiration, denial and recovery.');

app.otherFilters={country:'Saved country',city:'Saved city'};
app.restoreOtherLocationFilter();
assert.equal(app.otherFilters.city,'Oakville');
assert.equal(app.otherFilters.country,'Canada');
assert.match(source,/this.strictDeviceLocation = true/);
const failedRender=makeApp();
failedRender.refreshDeviceLocationFeeds=async()=>{throw new Error('Temporary feed failure');};
failedRender.applyPreciseBrowserLocation(fix()); await failedRender.locationDefaultsPromise;
assert.equal(elements['main-app'].dataset.deviceLocationReady,'false');
assert.ok(failedRender.locationLabelRetryTimer,'A feed failure must schedule recovery instead of leaving the gate stuck');
failedRender.refreshDeviceLocationFeeds=async()=>{};
await failedRender.applyEntryLocationDefaults();
assert.equal(elements['main-app'].dataset.deviceLocationReady,'true');
