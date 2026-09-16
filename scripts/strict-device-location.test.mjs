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
assert.ok(!html.includes('id="site-device-location-status"'));
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

// GPS refreshes within the same city must preserve the existing listing DOM,
// pagination and carousel position while still validating the fresh coordinate.
const scrolling=makeApp();
let feedRefreshes=0;
let prematureRefreshes=0;
scrolling.refreshDeviceLocationFeeds=async()=>{feedRefreshes++;};
scrolling.scheduleLocationAwareResultsRefresh=()=>{prematureRefreshes++;};
scrolling.applyPreciseBrowserLocation(fix());
await scrolling.locationDefaultsPromise;
assert.equal(feedRefreshes,1);
assert.equal(elements['main-app'].dataset.deviceLocationInitialized,'true');
let finishSameCity;
scrolling.reverseGeocodeLatLng=()=>new Promise(resolve=>{finishSameCity=resolve;});
const exclusionsBefore=featured.map(c=>c.excluded);
scrolling.applyPreciseBrowserLocation(fix(43.4705,-79.6877));
const sameCityLookup=scrolling.locationDefaultsPromise;
assert.equal(elements['main-app'].dataset.deviceLocationReady,'false');
assert.equal(elements['main-app'].dataset.deviceLocationInitialized,'true');
assert.deepEqual(featured.map(c=>c.excluded),exclusionsBefore,'Pending GPS must not collapse featured card layout');
assert.equal(prematureRefreshes,0,'Pending GPS must not empty results against an unresolved city');
finishSameCity(local);
await sameCityLookup;
assert.equal(feedRefreshes,1,'A confirmed unchanged city must keep the existing listing DOM');
assert.equal(elements['main-app'].dataset.deviceLocationReady,'true');
assert.equal(elements['home-search-location'].value,'Oakville, Canada');
scrolling.reverseGeocodeLatLng=async()=>foreign;
scrolling.applyPreciseBrowserLocation(fix(-1.2921,36.8219));
await scrolling.locationDefaultsPromise;
assert.equal(feedRefreshes,2,'Moving to a different city must still refresh results');
await scrolling.applyEntryLocationDefaults({forceBrowserLocation:true});
assert.equal(feedRefreshes,3,'An explicit location refresh must still rebuild the feed');
assert.doesNotMatch(source,/scrollBy\(\{ left: event\.deltaY/,'Vertical wheel input must not be diverted into carousels');
console.log('Scroll stability passed: unchanged-city refreshes preserve feeds, pending GPS preserves cards, and vertical wheel input stays native.');

// Home is an explicit return to GPS, including while already on the Home screen.
elements['home-search-what']={value:'listings in Nairobi, Kenya'};
const home=makeApp();
home.applyPreciseBrowserLocation(fix());
await home.locationDefaultsPromise;
let requests=0;
let requestOptions;
let finishRequest;
home.requestLocationPermission=(options)=>{
 requests++; requestOptions=options;
 return new Promise(resolve=>{finishRequest=resolve;});
};
const navigations=[];
home.switchScreen=(screen)=>{
 home.activeScreen=screen;
 home.updateDeviceLocationUi();
 navigations.push({screen,location:elements['home-search-location'].value,query:elements['home-search-what'].value});
};
for(const screen of ['home','vehicles','other']) {
 home.activeScreen=screen;
 home.setHomeLocationControls({city:'Nairobi',country:'Kenya'});
 elements['home-search-what'].value='listings in Nairobi, Kenya';
 home.homeSearchRequestId=50;
 assert.equal(await home.returnHomeToDeviceLocation(),true);
 assert.equal(home.homeSearchRequestId,51,'A pending foreign search must be invalidated');
 assert.equal(home.activeScreen,'home');
 assert.equal(elements['home-search-location'].value,'Oakville, Canada');
 assert.equal(elements['home-search-location'].dataset.autoLocationDefault,'1');
 assert.equal(elements['home-search-what'].value,'','A query country must not override the device scope');
 assert.deepEqual(navigations.at(-1),{screen:'home',location:'Oakville, Canada',query:''},'Reset before loading the Home feed');
}
assert.equal(requests,0,'A fresh fix restores Home immediately without waiting for another GPS prompt');
home.lastDeviceLocationSampleAt=Date.now()-90001;
home.userLocation.timestamp=home.lastDeviceLocationSampleAt;
home.setHomeLocationControls({city:'Nairobi',country:'Kenya'});
const expiredHome=home.returnHomeToDeviceLocation();
assert.equal(requests,1,'An expired fix must request new device coordinates during the tap');
assert.equal(requestOptions.announce,true);
assert.equal(requestOptions.forceBrowserLocation,true);
assert.equal(home.activeScreen,'home','Navigation must not wait for permission');
assert.equal(elements['home-search-location'].value,'','Neither the foreign search nor expired GPS can be shown as current');
assert.equal(elements['main-app'].dataset.deviceLocationReady,'false');
home.applyPreciseBrowserLocation(fix(),{forceBrowserLocation:true});
await home.locationDefaultsPromise;
finishRequest(true); await expiredHome;
assert.equal(elements['home-search-location'].value,'Oakville, Canada');
assert.equal(elements['main-app'].dataset.deviceLocationReady,'true');
home.handleLocationError({code:1});
const deniedHome=home.returnHomeToDeviceLocation();
assert.equal(home.activeScreen,'home');
assert.equal(elements['home-search-location'].value,'');
assert.equal(elements['main-app'].dataset.deviceLocationReady,'false');
finishRequest(false);
assert.equal(await deniedHome,false);

// Exercise the shared click/keyboard wiring, including duplicate setup calls.
const control=(screen,role=null)=>({
 dataset:screen?{screen}:{},events:{},
 getAttribute(name){return name==='role'?role:null;},
 addEventListener(event,handler){(this.events[event] ||= []).push(handler);}
});
const controls=[control('home'),control(),control(null,'button'),control('vehicles')];
const originalQueryAll=document.querySelectorAll;
document.querySelectorAll=()=>controls;
let homeReturns=0;
let otherScreen='';
const navigation=Object.assign(Object.create(App.prototype),{
 returnHomeToDeviceLocation(){homeReturns++;},
 switchScreen(screen){otherScreen=screen;}
});
navigation.bindPrimaryNavigation(); navigation.bindPrimaryNavigation();
controls.forEach(button=>{
 assert.equal(button.events.click.length,1);
 button.events.click[0]();
});
assert.equal(homeReturns,3,'Home nav, Return to Home and logo must all reset location');
assert.equal(otherScreen,'vehicles','Other navigation remains unchanged');
let prevented=0;
for(const key of ['Enter',' ','Escape']) controls[2].events.keydown[0]({key,preventDefault(){prevented++;}});
assert.equal(homeReturns,5);
assert.equal(prevented,2);
assert.equal(controls[0].events.keydown,undefined,'Native buttons must not activate twice on keyboard input');
document.querySelectorAll=originalQueryAll;
console.log('Home GPS reset passed: foreign searches, pending search invalidation, immediate local return, expiration/recovery, denial, and all Home click/keyboard controls.');
