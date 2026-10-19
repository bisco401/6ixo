import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source=readFileSync(process.env.RENTAL_APP_SOURCE || new URL('../app.js',import.meta.url),'utf8');
function fixture(fields={}) {
  const elements=Object.fromEntries(Object.entries(fields).map(([key,value])=>[key,{value,checked:true,disabled:false,textContent:'',classList:{add(){},remove(){},toggle(){}},focus(){}}]));
  class DataTransfer { files=[]; items={add:file=>this.files.push(file)}; }
  const context={document:{getElementById:id=>elements[id]||null,querySelector:()=>null,querySelectorAll:()=>[],addEventListener(){}},window:{prompt:()=>null},console:{warn(){},log(){},error(){}},Date,Intl,URL,Set,Map,DataTransfer,setTimeout,clearTimeout};
  vm.runInNewContext(source.slice(0,source.indexOf('// Initialize the app when the page loads'))+'\nglobalThis.App=DatingApp;',context);
  const notices=[];
  const app=Object.assign(Object.create(context.App.prototype),{hostApplicationMinPropertyPhotos:Number(source.match(/this.hostApplicationMinPropertyPhotos = (\d+);/)[1]),hostApplicationMaxPropertyPhotos:Number(source.match(/this.hostApplicationMaxPropertyPhotos = (\d+);/)[1]),hostApplicationMaxPropertyPhotoBytes:10*1024*1024,isSignedIn:true,supabaseEnabled:true,currentUser:{id:'host',email:'host@example.test',emailVerified:true},showNotification:m=>notices.push(m),isHostAdmin:()=>false,updateHostEntryPoint(){},renderAdminDashboard(){},closeHostApplicationModal(){}});
  return {app,context,elements,notices};
}
test('admin cancelling the review prompt performs no writes or email calls',async()=>{
  const f=fixture();let calls=0;f.app.isHostAdmin=()=>true;f.app.supabase={rpc:async()=>{calls++;}};
  await f.app.reviewHostApplication('application','approved');assert.equal(calls,0);
});
test('public stay loading uses the ready-listings RPC and removes stays that became unavailable',async()=>{
 const {app}=fixture();let requested;
 app.supabaseShortTermListingIds=new Set(['st_old']);app.marketplaceItems=[{id:'st_old'},{id:'st_pending',sourceTable:'short_term_listings'},{id:'unrelated'}];app.realestateListings=[{id:'st_old'},{id:'st_pending',sourceTable:'short_term_listings'},{id:'unrelated'}];
 app.supabase={rpc(name){requested=name;const q={order(){return q;},limit:async()=>({data:[],error:null})};return q;}};
 await app.loadSupabaseShortTermListings();assert.equal(requested,'get_bookable_short_term_listings');
 assert.deepEqual(app.marketplaceItems.map(r=>r.id),['unrelated']);assert.deepEqual(app.realestateListings.map(r=>r.id),['unrelated']);
});
test('nightly rates and service fees preserve cents and do not invent taxes',()=>{
  const {app}=fixture();app.parseRealestatePriceAmount=value=>Number(value);
  assert.equal(app.getShortTermNightlyRate({price:123.45}),123.45);
  assert.equal(app.getShortTermNightlyRate({price:1000,priceTerm:'per_month'}),0);
  assert.equal(app.getShortTermNightlyRate({price:1000,priceTerm:'per_week'}),0);
  const quote=app.getShortTermStayInsights({price:123.45,minStayNights:3,cleaningFee:30.25});
  assert.equal(quote.serviceFee,37.04);assert.equal(quote.total,437.64);assert.equal(quote.taxes,0);
  assert.match(app.formatShortTermMoney(437.64,'CAD'),/437\.64/);
});
test('expired unpaid stays cannot advertise a payment retry or an upcoming reservation',()=>{
  const {app}=fixture();const booking={status:'requested',paymentStatus:'unpaid',createdAt:new Date(Date.now()-3600000).toISOString()};
  assert.equal(app.canGuestRetryBookingPayment(booking),false);assert.equal(app.isGuestBookingUpcoming(booking),false);
  assert.equal(app.isRentalCheckoutExpired({...booking,paymentStatus:'authorized'}),false);
});
test('failed application proof upload preserves the entered form and never submits to admin',async()=>{
  const fields={'host-application-email':'host@example.test','host-application-legal-name':'Typed Host','host-application-phone':'123456','host-application-city':'Toronto','host-application-country':'Canada','host-application-property-type':'apartment','host-application-listing-city':'Toronto','host-application-bedrooms':'0','host-application-bathrooms':'1','host-application-guest-capacity':'2','host-application-experience':'Typed experience','host-application-about':'Typed details','host-application-rules':'','host-application-submit':''};
  const f=fixture(fields);let submitted=0,payload;
  Object.assign(f.app,{getHostApplicationPropertyPhotoDocuments:()=>Array.from({length:5},()=>({})),getHostApplicationProofDocuments:()=>[],enforceHostApplicationPropertyPhotoLimit:()=>[],getHostApplicationBooleanValue:()=>false,enforceHostApplicationDocumentLimit:()=>[{name:'proof.jpg'}],getVehicleRentalComplianceDocumentTypes:()=>[],uploadHostApplicationDocuments:async()=>{throw Error('Upload failed');},populateHostApplicationForm:()=>{throw Error('Must not overwrite typed data during submission');}});
  f.app.supabase={from:()=>({upsert:row=>{payload=row;return {select:()=>({single:async()=>({data:{...row,id:'application'},error:null})})};}}),rpc:async()=>{submitted++;}};
  await f.app.submitHostApplication({preventDefault(){},currentTarget:{reportValidity:()=>true}});
  assert.equal(payload.ready_for_review,false);assert.equal(submitted,0);assert.equal(f.elements['host-application-about'].value,'Typed details');assert.equal(f.elements['host-application-submit'].disabled,false);assert.equal(f.app.hostApplicationBusy,false);assert.match(f.notices.at(-1),/Upload failed/);
});

function checkoutFixture(overrides = {}) {
  const f = fixture(Object.fromEntries(['modal','amount','placement','sub','submit','cancel','element','status'].map(x=>[`stripe-payment-${x}`, ''])));
  const callbacks = {};
  const classes = new Set(['hidden']);
  f.elements['stripe-payment-modal'].classList = {add:x=>classes.add(x),remove:x=>classes.delete(x)};
  f.context.window.setTimeout = () => {};
  f.context.window.STRIPE_PUBLISHABLE_KEY = 'pk_test_fixture';
  const element = {on:(name,fn)=>callbacks[name]=fn,mount(){callbacks.ready();},unmount(){}};
  const stripe = {elements:()=>({create:()=>element,submit:async()=>({})}),confirmPayment:async()=>({paymentIntent:{id:'pi_test',status:'requires_capture'}})};
  Object.assign(f.app, {getStripeClient:()=>stripe,callSupabaseFunction:async()=>({clientSecret:'test_secret',amount:49453,currency:'cad',captureMethod:'manual',livemode:false,financialTerms:{taxAmountCents:5689,taxBreakdown:[{label:'HST',amountCents:5689}],cancellationDeadline:'2099-03-19T19:00:00Z'}}),...overrides});
  return {...f, stripe, classes, booking:{id:'stay',total:494.53,serviceFee:37.04,currency:'CAD',listingTitle:'Test stay'}};
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('stay checkout shows server totals, taxes, deadline, and completes an authorization', async()=>{
  const f=checkoutFixture();const result=f.app.startStripeBookingCheckout({booking:f.booking});await tick();
  assert.equal(f.classes.has('hidden'),false);assert.match(f.elements['stripe-payment-sub'].textContent,/HST:.*56\.89/);
  assert.match(f.elements['stripe-payment-sub'].textContent,/Full refund until/);
  assert.equal(f.elements['stripe-payment-submit'].disabled,false);
  assert.match(f.elements['stripe-payment-submit'].textContent,/Authorize.*494\.53/);
  await f.app.submitStripePaymentModal();assert.equal((await result).reason,'authorized');assert.equal(f.classes.has('hidden'),true);
});
test('instant checkout, decline retry, processing, and duplicate clicks never claim early success',async()=>{
  const f=checkoutFixture();const original=f.app.callSupabaseFunction;
  f.app.callSupabaseFunction=async()=>({...await original(),captureMethod:'automatic'});
  let finish,calls=0;f.stripe.confirmPayment=async()=>{calls++;return new Promise(resolve=>finish=resolve);};
  const checkout=f.app.startStripeBookingCheckout({booking:f.booking});await tick();
  assert.match(f.elements['stripe-payment-submit'].textContent,/Pay/);
  const submission=f.app.submitStripePaymentModal();await tick();await f.app.submitStripePaymentModal();
  assert.equal(calls,1);f.app.closeStripePaymentModal();assert.equal(f.classes.has('hidden'),false);
  finish({error:{message:'Card declined'}});await submission;
  assert.ok(f.app.pendingStripePayment);assert.match(f.elements['stripe-payment-status'].textContent,/Card declined/);
  f.stripe.confirmPayment=async()=>({paymentIntent:{id:'pi_test',status:'processing'}});
  await f.app.submitStripePaymentModal();assert.ok(f.app.pendingStripePayment);
  f.stripe.confirmPayment=async()=>({paymentIntent:{id:'pi_test',status:'succeeded'}});
  await f.app.submitStripePaymentModal();assert.equal((await checkout).paid,true);
});
test('closing while checkout prepares cannot reopen or mount a stale payment form',async()=>{
  let finish;const f=checkoutFixture({callSupabaseFunction:()=>new Promise(resolve=>finish=resolve)});
  const checkout=f.app.startStripeBookingCheckout({booking:f.booking});await tick();
  f.app.closeStripePaymentModal();finish({clientSecret:'late_secret',amount:49453});
  assert.equal((await checkout).paid,false);assert.equal(f.classes.has('hidden'),true);assert.equal(f.app.stripePaymentElement,null);
});
test('checkout preparation failure closes the overlay and supports a fresh retry',async()=>{
  const f=checkoutFixture({callSupabaseFunction:async()=>{throw new Error('Host payout setup required');}});
  await assert.rejects(f.app.startStripeBookingCheckout({booking:f.booking}),/Host payout/);
  assert.equal(f.classes.has('hidden'),true);assert.equal(f.app.pendingStripePayment,null);
  await assert.rejects(f.app.startStripeBookingCheckout({booking:{...f.booking,total:0}}),/valid total/);
});
test('calendar expires local unpaid holds but never expires server occupancy or host blocks by guessing payment status',async()=>{
  const {app}=fixture();const listing={id:'st_test'};
  const row={public_id:'stay',listing_public_id:listing.id,checkin_date:'2099-01-10',checkout_date:'2099-01-13',status:'requested',payment_status:'unpaid',created_at:new Date().toISOString(),hold_expires_at:new Date(0).toISOString()};
  app.realestateBookings=[app.normalizeSupabaseShortTermBookingRow(row,listing)];
  const selection={listingId:listing.id,startDate:'2099-01-11',endDate:'2099-01-12'};
  assert.equal(app.hasRealestateBookingConflict(selection),false);assert.equal(app.getRealestateBlockedDateEntries(listing).length,0);
  assert.equal(app.normalizeHostShortTermBookingRow(row).holdExpiresAt,row.hold_expires_at);
  app.supabase={rpc:async()=>({data:[{...row,payment_status:undefined,created_at:new Date(0).toISOString()}]})};app.saveRealestateBookings=()=>{};
  await app.loadSupabaseShortTermBookingsForListing(listing);
  assert.equal(app.hasRealestateBookingConflict(selection),true);assert.equal(app.getRealestateBlockedDateEntries(listing).length,1);
  app.realestateBookings[0].status='blocked';assert.equal(app.getRealestateBlockedDateEntries(listing).length,1);
  app.supabase.rpc=async()=>({error:{message:'offline'}});
  await assert.rejects(app.loadSupabaseShortTermBookingsForListing(listing,{throwOnError:true}),/live availability/);
});
test('booking submission serializes clicks and always restores the button after errors',async()=>{
  const f=fixture({'realestate-short-term-booking-preview-btn':'Reserve'});let calls=0,finish;
  f.app.setRealestateShortTermBookingStatus=()=>{};
  f.app.performRealestateShortTermBookingRequest=async()=>{calls++;await new Promise(resolve=>finish=resolve);throw new Error('Availability offline');};
  const first=f.app.submitRealestateShortTermBookingRequest();await f.app.submitRealestateShortTermBookingRequest();
  assert.equal(calls,1);finish();await first;assert.equal(f.app.shortTermBookingSubmitting,false);assert.equal(f.elements['realestate-short-term-booking-preview-btn'].disabled,false);
  assert.match(f.notices.at(-1),/Availability offline/);
});

test('destination selection returns a guest to short-term stays after the location is applied',async()=>{
  const f=fixture({'home-search-location':''});let selected=0,opened=0;
  f.app.getActiveRealestateCategory=()=> 'short_term';
  f.elements['home-search-location'].scrollIntoView=()=>{};
  f.app.switchScreen=name=>{assert.equal(name,'home');selected++;};
  f.app.chooseShortTermDestination();assert.equal(selected,1);assert.equal(f.app.returnToShortTermAfterDestination,true);
  Object.assign(f.app,{applyResolvedLocationDefaults(){},refreshDeviceLocationFeeds:async()=>{},updateHomeCurrentLocationDisplay(){},updateMarketplaceLocationControls(){},switchScreen(name){assert.equal(name,'realestate');opened++;}});
  await f.app.applyManualDiscoveryLocation({city:'Toronto',country:'Canada'});
  assert.equal(opened,1);assert.equal(f.app.returnToShortTermAfterDestination,false);assert.equal(f.app.manualDiscoveryLocation.city,'Toronto');
});

 test('unpaid instant-book holds never display a confirmed status',()=>{
  const {app}=fixture();
  assert.equal(app.getRentalBookingDisplayStatus({status:'confirmed',paymentStatus:'unpaid',createdAt:new Date().toISOString()}),'Payment needed');
  assert.equal(app.getRentalBookingDisplayStatus({status:'requested',paymentStatus:'authorized'}),'Awaiting host approval');
  assert.equal(app.getRentalBookingDisplayStatus({status:'confirmed',paymentStatus:'processing'}),'Payment processing');
  assert.equal(app.getRentalBookingDisplayStatus({status:'confirmed',paymentStatus:'paid'}),'Confirmed');
 });

test('posting and profile share property details, ordered photos, host photo, and exact prices after reload',()=>{
  const f=fixture({'realestate-listing-type':'for_rent_short','realestate-property-type':'apartment','item-title':'Studio & terrace','item-description':'Quiet studio with a terrace.','item-city':'Toronto','item-country':'Canada','item-price':'123.45','realestate-price-term':'per_night','realestate-bedrooms':'0','realestate-bathrooms':'1.5','realestate-sqft':'420','realestate-host-name':'Test Host','realestate-host-languages':'English, French','realestate-max-guests':'2','realestate-min-stay':'3','realestate-cleaning-fee':'30.25','realestate-checkin-time':'15:00','realestate-checkout-time':'11:00','realestate-house-rules':'No parties.','realestate-amenities':'WiFi, Kitchen','realestate-calendar-start':'2099-01-01','realestate-calendar-end':'2099-12-31','realestate-parking':''});
  Object.assign(f.app,{getMarketplaceUsername:()=> 'Account Name',getMarketplaceProfilePhoto:()=> 'https://example.test/host.jpg',isHostApproved:()=>true,realestateShortTermBlockedDates:[],marketplaceUploads:Array.from({length:12},(_,i)=>({src:`https://example.test/photo-${i+1}.jpg`}))});
  const realestate=f.app.getRealestatePostingDetails();
  assert.equal(realestate.bedrooms,0);assert.equal(realestate.bathrooms,1.5);assert.equal(realestate.cleaningFee,30.25);
  const payload={id:'st_fixture',category:'real_estate',title:'Studio & terrace',description:'Quiet studio with a terrace.',city:'Toronto',country:'Canada',price:123.45,currency:'USD',seller:realestate.hostName,sellerPhoto:f.app.getMarketplaceProfilePhoto(),images:f.app.marketplaceUploads.map(x=>x.src),realestate};
  const row={id:'row_fixture',host_application_id:'approved_application',public_id:payload.id,user_id:'host',price:123.45,currency:'USD',listing_payload:JSON.parse(JSON.stringify(payload))};
  const listing=f.app.buildRealestateFeedEntryFromMarketplaceItem(f.app.normalizeSupabaseShortTermListingRow(row));
  assert.equal(listing.bedrooms,0);assert.equal(listing.bathrooms,1.5);assert.equal(listing.currency,'USD');assert.equal(listing.sellerPhoto,payload.sellerPhoto);assert.equal(listing.seller,'Test Host');
  assert.deepEqual(Array.from(listing.images),payload.images);assert.equal(listing.houseRules,'No parties.');
  assert.ok(f.app.buildShortTermAmenityTokens(listing).includes('Parking'));
  const preview=f.app.buildShortTermCardPreviewMarkup();const card=f.app.buildShortTermCardMarkup(listing);
  for(const photo of payload.images) assert.ok(preview.includes(photo));
  for(const photo of payload.images.slice(0,4)) assert.ok(card.includes(photo));
  assert.ok(!card.includes(payload.images[4]),'feed previews four images; full profile retains all uploaded images');
  const details=f.app.renderRealestateDetailRowsMarkup(f.app.buildRealestateDetailRows(listing));
  const sections=f.app.buildShortTermSignatureSectionsMarkup(listing);
  for(const value of ['Studio','1.5 baths','3-night minimum','No parties.','Test Host']) { assert.ok(preview.includes(value),value); assert.ok((sections+f.app.buildShortTermSignatureFactsMarkup(listing)).includes(value),value); }
  assert.match(details,/123\.45/);assert.match(details,/30\.25/);assert.match(preview,/Cover photo/);
  f.app.marketplaceUploads.splice(0,1);
  const changed=f.app.buildShortTermCardPreviewMarkup();assert.ok(!changed.includes('photo-1.jpg'));assert.ok(changed.indexOf('photo-2.jpg')<changed.indexOf('photo-3.jpg'));
});

test('published stay preserves CAD currency through feed and profile rows',()=>{
  const {app}=fixture();const listing=app.buildRealestateFeedEntryFromMarketplaceItem({id:'st_cad',category:'real_estate',currency:'CAD',price:185.75,realestate:{listingType:'for_rent_short',priceTerm:'per_night',cleaningFee:45.25}});
  const rate=app.buildRealestateDetailRows(listing).find(x=>x.label==='Nightly rate');
  assert.equal(listing.currency,'CAD');assert.equal(rate.value,`${app.formatShortTermMoney(185.75,'CAD')} / night`);
  assert.ok(rate.meta.includes(app.formatShortTermMoney(45.25,'CAD')));
});

test('expanded amenities resolve independently, including similar appliance and parking names',()=>{
  const {app}=fixture();const options=app.getShortTermAmenityOptions();
  assert.equal(options.length,55);assert.equal(new Set(options.map(x=>x.category)).size,9);
  const icons=options.map(option=>app.buildShortTermAmenityIcon(option.icon));
  assert.equal(new Set(icons).size,55,'every amenity has a distinct SVG, rather than a fallback check');
  for(const option of options) assert.equal(app.getShortTermAmenityMeta(option.label).option?.label,option.label);
  for(const [text,label] of [['Fast wifi – 435 Mbps','Wifi'],['65-inch HDTV with standard cable','TV'],['Free washer – In unit','Washer'],['Free dryer – In unit','Dryer'],['Hair dryer in bathroom','Hair dryer'],['Microwave oven','Microwave'],['Paid parking nearby','Paid parking'],['Free parking on premises','Free parking'],['Outdoor dining table','Outdoor dining'],['CO detector','Carbon monoxide alarm'],['Step-free access','Step-free entrance']]) {
    assert.equal(app.getShortTermAmenityMeta(text).option?.label,label,text);
  }
  assert.equal(app.getShortTermAmenityMeta('Parking').option,undefined,'unspecified parking must not claim to be free');
});

test('expanded amenities and custom details survive the posting payload and public listing reload',()=>{
  const f=fixture({'realestate-listing-type':'for_rent_short','realestate-amenities':'Microwave, Dishwasher, Hot tub, High chair, EV charger, Bathroom grab bars, No Carbon monoxide alarm, Fast wifi – 435 Mbps, Beach access, Crib'});
  Object.assign(f.app,{getMarketplaceUsername:()=> 'Host',realestateShortTermBlockedDates:[]});
  const realestate=f.app.getRealestatePostingDetails();
  const payload=JSON.parse(JSON.stringify({id:'st_amenities',category:'real_estate',realestate}));
  const listing=f.app.buildRealestateFeedEntryFromMarketplaceItem(f.app.normalizeSupabaseShortTermListingRow({id:'amenities',public_id:payload.id,listing_payload:payload}));
  assert.equal(listing.amenities,realestate.amenities);
  const tokens=Array.from(f.app.buildShortTermAmenityTokens({...listing,parking:true,pets:true}));
  assert.ok(tokens.includes('Fast wifi – 435 Mbps'));assert.ok(tokens.includes('Beach access'));
  const markup=f.app.buildShortTermOffersMarkup(listing);
  assert.match(markup,/Show all 10 amenities/);assert.match(markup,/Other amenities/);
  assert.match(markup,/is-unavailable/);assert.match(markup,/Not available/);
  assert.ok(!markup.includes('Smoke alarm'),'unspecified safety amenities stay absent');
  assert.ok(!markup.includes('Pool'),'unselected amenities stay absent');
  assert.ok(markup.includes('Fast wifi – 435 Mbps'));
});

test('legacy flags avoid duplicate offers and unavailable amenities remain explicit',()=>{
  const {app}=fixture();
  assert.deepEqual(Array.from(app.buildShortTermAmenityTokens({amenities:'Paid parking, No Pets allowed',parking:true,pets:true})),['Paid parking','No Pets allowed']);
  assert.equal(app.getShortTermAmenityMeta('Fire extinguisher (not provided)').unavailable,true);
  assert.equal(app.getShortTermAmenityMeta('No stairs').unavailable,false);
  const markup=app.buildShortTermOffersMarkup({amenities:'First aid kit, Beach <script>alert(1)</script>'});
  assert.ok(!markup.includes('<script>'));assert.match(markup,/&lt;script&gt;/);
  assert.ok(!markup.includes('is-unavailable'));
});

test('paid or unspecified parking cannot match the free parking guest filter',()=>{
  const {app}=fixture();const filters={stayAmenities:['free_parking']};
  for(const amenities of ['Paid parking','Parking','No Free parking']) {
    assert.equal(app.matchesRealestateUiFilters({amenities,parking:true},filters,{isAirbnb:true}),false,amenities);
  }
  assert.equal(app.matchesRealestateUiFilters({amenities:'Free parking'},filters,{isAirbnb:true}),true);
});

test('stay badges use explicit accommodation and policies without inventing missing details',()=>{
  const {app}=fixture();
  const labels=listing=>Array.from(app.getShortTermListingBadges(listing),badge=>badge.label);
  assert.deepEqual(labels({propertyType:'apartment'}),[]);
  assert.deepEqual(labels({propertyType:'Private room',minStayNights:1}),['Private room','1-night minimum']);
  assert.deepEqual(labels({realestate:{roomType:'entire_home',instantBook:true,minStayNights:2,amenities:'Self check-in, Pets allowed, Free parking, Wifi, Kitchen'}}),['Entire place','Instant book','Self check-in','2-night minimum','Pet friendly','Free parking','Wi-Fi','Kitchen']);
  assert.ok(!labels({instantBook:'false',minStayNights:0}).includes('Instant book'));
});

test('stay badges honor unavailable amenities and do not treat paid parking as free',()=>{
  const {app}=fixture();
  const labels=Array.from(app.getShortTermListingBadges({pets:true,parking:true,amenities:'Paid parking, No Pets allowed, No Self check-in, Pool (not provided), Hot tub, Workspace'}),badge=>badge.label);
  assert.deepEqual(labels,['Hot tub','Workspace']);
  const conflicting=Array.from(app.getShortTermListingBadges({amenities:'Free parking, No Free parking, Wifi, No Wifi'}),badge=>badge.label);
  assert.deepEqual(conflicting,[]);
});

test('stay reputation badges require review thresholds and approved host status',()=>{
  const {app}=fixture();
  const labels=listing=>Array.from(app.getShortTermListingBadges(listing),badge=>badge.label);
  assert.deepEqual(labels({badge:'Guest favorite',rating:4.99,reviews:39,hostStatus:'pending'}),[]);
  assert.deepEqual(labels({rating:4.84,reviews:100}),[]);
  assert.deepEqual(labels({rating:4.85,reviews:40,hostStatus:'approved'}),['Guest favorite','Verified host']);
});

test('saved stay details produce the same badges after public listing reload',()=>{
  const {app}=fixture();
  const listing=app.buildRealestateFeedEntryFromMarketplaceItem({id:'st_badges',category:'real_estate',price:185,currency:'CAD',realestate:{listingType:'for_rent_short',priceTerm:'per_night',propertyType:'Shared room',minStayNights:3,instantBook:true,amenities:'Self check-in, Free parking'}});
  const labels=Array.from(app.getShortTermListingBadges(listing),badge=>badge.label);
  assert.deepEqual(labels,['Shared room','Instant book','Self check-in','3-night minimum','Free parking']);
  const markup=app.buildShortTermCardMarkup(listing,{preview:true});
  assert.match(markup,/Short stay/);
  assert.ok(markup.includes('Shared room')&&markup.includes('3-night minimum'));
});

test('guest space choices stay aligned from the form preview through public feed and profile',()=>{
  for (const [roomType,label] of [['entire_place','Entire place'],['private_room','Private room'],['shared_room','Shared room']]) {
    const f=fixture({'realestate-listing-type':'for_rent_short','realestate-property-type':'house','realestate-room-type':roomType,'item-title':'Form stay','item-price':'185','realestate-price-term':'per_night','realestate-min-stay':'2','realestate-amenities':'Self check-in, Free parking, Wifi, Kitchen','realestate-instant-book':'on'});
    Object.assign(f.app,{getMarketplaceUsername:()=> 'Host',getMarketplaceProfilePhoto:()=>'',isHostApproved:()=>false,realestateShortTermBlockedDates:[],marketplaceUploads:[]});
    const realestate=f.app.getRealestatePostingDetails();
    const payload=JSON.parse(JSON.stringify({id:'st_space',category:'real_estate',title:'Form stay',price:185,currency:'CAD',realestate}));
    const listing=f.app.buildRealestateFeedEntryFromMarketplaceItem(f.app.normalizeSupabaseShortTermListingRow({id:'row_space',public_id:'st_space',listing_payload:payload}));
    assert.equal(listing.roomType,roomType);
    assert.equal(f.app.getShortTermGuestSpaceLabel(listing),label);
    assert.equal(f.app.buildRealestateDetailRows(listing).find(row=>row.label==='Guest space').value,label);
    const labels=Array.from(f.app.getShortTermListingBadges(listing),badge=>badge.label);
    const preview=f.app.buildShortTermCardPreviewMarkup();
    for(const badge of labels) assert.ok(preview.includes(badge),`${roomType}: preview includes ${badge}`);
    assert.ok(f.app.buildShortTermCardMarkup(listing,{compact:true}).includes(label));
    assert.ok(f.app.buildShortTermListingBadgesMarkup(listing,{profile:true}).includes(label));
  }
});

test('legacy form stay types have truthful labels and explicit privacy choices take priority',()=>{
  const {app}=fixture();
  assert.equal(app.getShortTermGuestSpaceLabel({propertyType:'full_apartment'}),'Entire place');
  assert.equal(app.getShortTermGuestSpaceLabel({propertyType:'shared'}),'Shared stay');
  assert.equal(app.getShortTermGuestSpaceLabel({propertyType:'full_apartment',realestate:{roomType:'private_room'}}),'Private room');
  assert.equal(app.getShortTermGuestSpaceLabel({propertyType:'house'}),'');
  const f=fixture({'realestate-listing-type':'for_rent_long','realestate-room-type':'shared_room'});
  f.app.getMarketplaceUsername=()=> 'Host';
  assert.equal(f.app.getRealestatePostingDetails().roomType,'');
});

function hostListingFixture() {
  const f=fixture({'item-title':'Independent stay','item-category':'real_estate','item-price':'185','item-country':'Canada','item-city':'Toronto','item-description':'A complete sample stay.','realestate-listing-type':'for_rent_short','realestate-property-type':'apartment','realestate-calendar-start':'2099-01-01','realestate-calendar-end':'2099-12-31','realestate-amenities':'Kitchen, Hot tub, EV charger','realestate-rating':'5','realestate-reviews':'999','realestate-badge':'Guest favorite','realestate-contact':'private phone','item-payment':'cash_on_delivery','item-condition':'used','item-brand':'Old ad brand','item-destination-country':'Guyana','item-transit-status':'in_transit','item-featured':'','item-placement':'today_deals_featured','item-multi-locations':'London, UK'});
  Object.assign(f.app,{lastPostItemOpenContext:{source:'host_short_term'},supabase:{},marketplaceUploads:Array.from({length:5},(_,i)=>({src:`https://example.test/photo-${i+1}.jpg`,file:{name:`photo-${i+1}.jpg`,type:'image/jpeg',size:1024}})),realestateShortTermBlockedDates:[],getMarketplaceUsername:()=> 'Host',getMarketplaceProfilePhoto:()=> 'https://example.test/host.jpg',ensureCanPostShortTermRental:async()=>true,loadSupabaseShortTermListings:async()=>{},loadHostRentalListings:async()=>{},hidePostItemModal(){}});
  return f;
}

test('stay submission uses only the rental backend and excludes stale advertising and product fields',async()=>{
  const f=hostListingFixture();let payload,options,closed=false;
  Object.assign(f.app,{uploadMarketplaceListingMedia:async(_,opts)=>{options=opts;return {publicUrls:f.app.marketplaceUploads.map(x=>x.src),uploadedPaths:['new-photo']};},createSupabaseShortTermListing:async item=>{payload=item;return {id:'saved-stay'};},createSupabaseMarketplaceListing:()=>{throw Error('Must not create a marketplace ad');},requirePromotionFee:()=>{throw Error('Must not request advertising payment');},hidePostItemModal(){closed=true;},marketplaceItems:[],discoveryPosts:[]});
  const result=await f.app.publishPostItem({preventDefault(){}});
  assert.equal(result.id,'saved-stay');assert.equal(options.folder,'stays');assert.equal(closed,true);
  assert.equal(payload.placement,'short_term');assert.equal(payload.featured,false);assert.equal(payload.images.length,5);
  assert.equal(payload.realestate.amenities,'Kitchen, Hot tub, EV charger');assert.equal(payload.realestate.priceTerm,'per_night');
  assert.equal(payload.realestate.rating,null);assert.equal(payload.realestate.reviews,null);assert.equal(payload.realestate.contactPhone,'');
  for(const key of ['shipping','promotionTarget','condition','brand','model','quantity','delivery','paymentMethod','liveAuction','storyText','video','categoryBadges']) assert.equal(key in payload,false,key);
  assert.equal(f.app.marketplaceItems.length,0);assert.equal(f.app.discoveryPosts.length,0);
});

test('failed stay creation removes newly uploaded photos and preserves the form for retry',async()=>{
  const f=hostListingFixture();let removed,closed=false;
  Object.assign(f.app,{uploadMarketplaceListingMedia:async()=>({publicUrls:f.app.marketplaceUploads.map(x=>x.src),uploadedPaths:['new-photo']}),createSupabaseShortTermListing:async()=>{throw Error('Save failed');},removeMarketplaceListingMedia:async paths=>{removed=paths;},hidePostItemModal(){closed=true;}});
  await f.app.publishPostItem({preventDefault(){}});
  assert.deepEqual(removed,['new-photo']);assert.equal(closed,false);assert.equal(f.elements['item-title'].value,'Independent stay');assert.match(f.notices.at(-1),/Save failed/);
});

test('the host entry cannot be redirected into an ad by stale category or listing type fields',async()=>{
  const f=hostListingFixture();let payload;
  f.elements['item-category'].value='electronics';f.elements['realestate-listing-type'].value='for_sale';
  Object.assign(f.app,{uploadMarketplaceListingMedia:async()=>({publicUrls:f.app.marketplaceUploads.map(x=>x.src),uploadedPaths:[]}),createSupabaseShortTermListing:async item=>{payload=item;return {id:'saved-stay'};}});
  await f.app.publishPostItem({preventDefault(){}});
  assert.equal(payload.category,'real_estate');assert.equal(payload.realestate.listingType,'for_rent_short');
  assert.equal(payload.realestate.rating,null);assert.equal(payload.realestate.reviews,null);assert.equal(payload.realestate.contactPhone,'');
});

test('a saved stay is not removed or retried when refreshing Host listings fails',async()=>{
  const f=hostListingFixture();let creates=0,removes=0;
  Object.assign(f.app,{uploadMarketplaceListingMedia:async()=>({publicUrls:f.app.marketplaceUploads.map(x=>x.src),uploadedPaths:['saved-photo']}),createSupabaseShortTermListing:async()=>{creates++;return {id:'saved-stay'};},removeMarketplaceListingMedia:async()=>{removes++;},loadHostRentalListings:async()=>{throw Error('Refresh failed');}});
  await f.app.publishPostItem({preventDefault(){}});
  assert.equal(creates,1);assert.equal(removes,0);assert.match(f.notices.at(-1),/stay is saved/);
});

test('rental drafts have their own storage scope and marketplace shipping cannot enable a rental promotion',()=>{
  const f=hostListingFixture();let saves=0,resets=0;
  f.elements['post-item-form']={reset(){resets++;}};
  Object.assign(f.app,{postItemDraftStorageKey:'hs_post_item_draft_v1',flushPostItemDraftSave(){saves++;},clearPostItemStoryPreview(){}});
  f.app.setPostItemDraftScope('host_short_term');
  assert.equal(f.app.postItemDraftStorageKey,'hs_short_term_host_draft_v1');assert.equal(saves,1);assert.equal(resets,1);assert.equal(f.app.marketplaceUploads.length,0);
  f.app.syncCrossBorderSponsoredFields('item-destination-country');
  assert.equal(f.elements['item-placement'].value,'today_deals_featured');
  f.app.setPostItemDraftScope('global_header');assert.equal(f.app.postItemDraftStorageKey,'hs_post_item_draft_v1');
});

test('hidden marketplace requirements are disabled for hosts and restored when returning to ads',()=>{
  const f=fixture({'item-payment':'','item-condition':''});
  const controls=[f.elements['item-payment'],f.elements['item-condition']];
  controls.forEach(control=>{control.dataset={};control.required=true;});
  controls[1].disabled=true;
  const group={dataset:{},querySelectorAll:()=>controls};
  f.elements['item-payment'].closest=()=>group;
  f.app.syncShortTermHostPostingForm(true);
  assert.equal(controls[0].disabled,true,'hidden payment method must not block host form validity');
  f.app.syncShortTermHostPostingForm(false);
  assert.equal(controls[0].disabled,false,'the marketplace payment choice must work again');
  assert.equal(controls[1].disabled,true,'an existing disabled state must be preserved');
});

test('switching to a rental after closing an ad preserves the saved ad draft',()=>{
  const f=fixture();let saves=0;
  f.elements['post-item-modal']={classList:{contains:name=>name==='hidden'}};
  Object.assign(f.app,{postItemDraftStorageKey:'hs_post_item_draft_v1',flushPostItemDraftSave(){saves++;},clearPostItemStoryPreview(){}});
  f.app.setPostItemDraftScope('host_short_term');
  assert.equal(saves,0,'the reset form must not overwrite the draft saved when the ad was closed');
  assert.equal(f.app.postItemDraftStorageKey,'hs_short_term_host_draft_v1');
});

test('host application property images become selected files and persistent listing uploads without proof documents',async()=>{
  const f=fixture({'item-category':'real_estate','realestate-listing-type':'for_rent_short'});
  f.context.File=File;
  const application={id:'application',user_id:'host',status:'approved'};
  const photos=Array.from({length:30},(_,i)=>30-i).map(n=>({id:`photo-${n}`,user_id:'host',application_id:'application',document_type:'property_photo',storage_path:`host/application/property-photos/${n}.png`,file_name:`room-${n}.png`,mime_type:'image/png'}));
  Object.assign(f.app,{hostDocumentsBucket:'host-documents',marketplaceUploads:[],hostApplicationDocuments:[...photos,{...photos[0],id:'proof',document_type:'government_id',storage_path:'host/application/proof.png'}],loadCurrentHostApplication:async()=>application,isHostApproved:()=>true,renderMarketplaceUploads(){}});
  const downloaded=[],uploaded=[],publicUrls=[];
  f.app.supabase={storage:{from:bucket=>({
    download:async path=>{assert.equal(bucket,'host-documents');downloaded.push(path);return {data:new Blob([path],{type:'image/png'})};},
    upload:async(path,file)=>{assert.equal(bucket,'marketplace-media');uploaded.push({path,bytes:await file.text()});return {};},
    getPublicUrl:path=>{const publicUrl=`https://example.test/storage/v1/object/public/marketplace-media/${path}`;publicUrls.push(publicUrl);return {data:{publicUrl}};}
  })}};
  await f.app.useHostApplicationPropertyPhotos();
  assert.deepEqual(downloaded,Array.from({length:30},(_,i)=>`host/application/property-photos/${i+1}.png`));
  assert.equal(f.app.marketplaceUploads.length,30);assert.equal(f.app.marketplaceUploads[0].name,'room-1.png');
  assert.equal(f.app.validateShortTermPropertyPhotos().length,30);
  await f.app.useHostApplicationPropertyPhotos();assert.equal(downloaded.length,30,'reuse does not duplicate photos');
  const result=await f.app.uploadMarketplaceListingMedia(f.app.marketplaceUploads,{folder:'stays'});
  assert.deepEqual(uploaded.map(x=>x.bytes),downloaded);
  assert.deepEqual(Array.from(result.publicUrls),publicUrls);
  let sent;
  f.app.supabase.rpc=async(name,args)=>{assert.equal(name,'create_short_term_listing');sent=args.listing_payload;return {data:{id:'listing',listing_payload:sent}};};
  await f.app.createSupabaseShortTermListing({title:'Test property',images:result.publicUrls});
  assert.deepEqual(Array.from(sent.images),publicUrls);
  assert.ok(sent.images.every(url=>!url.includes('host-documents')&&!url.startsWith('blob:')));
  f.app.marketplaceUploads.forEach(x=>URL.revokeObjectURL(x.src));
});

test('host photo import failure and account change never append partial or another host photos',async()=>{
  const f=fixture({'item-category':'real_estate','realestate-listing-type':'for_rent_short'});f.context.File=File;
  Object.assign(f.app,{hostDocumentsBucket:'host-documents',marketplaceUploads:[],isHostApproved:()=>true,loadCurrentHostApplication:async()=>({id:'app',user_id:'host',status:'approved'}),hostApplicationDocuments:[1,2].map(n=>({id:String(n),user_id:'host',application_id:'app',document_type:'property_photo',storage_path:`host/app/${n}.png`,file_name:`${n}.png`})),renderMarketplaceUploads(){}});
  let count=0;f.app.supabase={storage:{from:()=>({download:async()=>++count===1?{data:new Blob(['photo'],{type:'image/png'})}:{error:Error('failed')}})}};
  await f.app.useHostApplicationPropertyPhotos();assert.equal(f.app.marketplaceUploads.length,0);assert.equal(f.app.hostPropertyPhotoImportBusy,false);
  f.app.supabase.storage.from=()=>({download:async()=>{f.app.currentUser={id:'other'};return {data:new Blob(['photo'],{type:'image/png'})};}});
  await f.app.useHostApplicationPropertyPhotos();assert.equal(f.app.marketplaceUploads.length,0);
});

test('host cannot publish a stay with missing, loading or invalid property images',()=>{
  const {app}=fixture();app.marketplaceUploads=[];assert.throws(()=>app.validateShortTermPropertyPhotos(),/Add property photos/);
  app.marketplaceUploads=[{src:'https://example.test/stock.jpg'}];assert.throws(()=>app.validateShortTermPropertyPhotos(),/Add property photos/);
  app.marketplaceUploads=[{file:new File(['photo'],'room.jpg',{type:'image/jpeg'})}];app.hostPropertyPhotoImportBusy=true;assert.throws(()=>app.validateShortTermPropertyPhotos(),/finish loading/);
  app.hostPropertyPhotoImportBusy=false;assert.throws(()=>app.validateShortTermPropertyPhotos(),/at least 5/);
  app.marketplaceUploads=Array.from({length:5},()=>({file:new File(['photo'],'room.txt',{type:'text/plain'})}));assert.throws(()=>app.validateShortTermPropertyPhotos(),/Photos must be/);
});

test('public stay photo requirements follow the listing category and selected count',()=>{
  const f=fixture({'item-category':'real_estate','realestate-listing-type':'for_rent_short','market-upload-label':'','market-upload-help':'','market-upload-photo-count':''});
  f.app.marketplaceUploads=Array.from({length:4},(_,i)=>({file:photo(i)}));
  f.app.syncMarketplacePhotoRequirements();
  assert.match(f.elements['market-upload-label'].textContent,/5–30 required/);
  assert.match(f.elements['market-upload-photo-count'].textContent,/4\/30.*Add 1 more/);
  assert.throws(()=>f.app.validateShortTermPropertyPhotos(),/at least 5/);
  for(const count of [5,30]) {
    f.app.marketplaceUploads=Array.from({length:count},(_,i)=>({file:photo(i)}));
    assert.equal(f.app.validateShortTermPropertyPhotos().length,count);
    f.app.syncMarketplacePhotoRequirements();assert.match(f.elements['market-upload-photo-count'].textContent,/Ready to publish/);
  }
  f.app.marketplaceUploads=Array.from({length:31},(_,i)=>({file:photo(i)}));
  assert.throws(()=>f.app.validateShortTermPropertyPhotos(),/up to 30/);
  f.elements['item-category'].value='electronics';f.app.syncMarketplacePhotoRequirements();
  assert.match(f.elements['market-upload-help'].textContent,/up to 12 photos/);
  assert.equal(f.app.getMarketplacePhotoLimits().maxFiles,12);
});

test('stay feed previews four photos without losing the full property gallery',()=>{
  const {app}=fixture();
  Object.assign(app,{getShortTermStayInsights:()=>({}),getRealestateAvailabilitySummary:()=>'',getRealestatePriceTermMeta:()=>({suffix:''}),formatReviewCountLabel:()=>'',getShortTermOffers:()=>[],getRealestateDetailEntries:()=>[],renderRealestateDetailRowsMarkup:()=>''});
  const images=Array.from({length:30},(_,i)=>`https://example.test/property-${i+1}.jpg`);
  const markup=app.buildShortTermCardMarkup({id:'stay',title:'Test stay',price:100,images});
  assert.match(markup,/property-4\.jpg/);assert.doesNotMatch(markup,/property-5\.jpg/);assert.equal(images.length,30);
});

const photo = (index=0, overrides={}) => ({name:`photo-${index}.jpg`,type:'image/jpeg',size:1024,...overrides});
test('property photo picker caps new and existing images at 30 and excludes invalid files',()=>{
  const f=fixture({'host-application-property-photos-input':''});
  const input=f.elements['host-application-property-photos-input'];
  input.files=Array.from({length:31},(_,i)=>photo(i));
  assert.equal(f.app.enforceHostApplicationPropertyPhotoLimit({notify:true}).length,30);
  assert.match(f.notices.at(-1),/up to 30/);
  f.app.hostApplicationDocuments=Array.from({length:28},()=>({document_type:'property_photo'}));
  input.files=Array.from({length:5},(_,i)=>photo(i));
  assert.equal(f.app.enforceHostApplicationPropertyPhotoLimit().length,2);
  f.app.hostApplicationDocuments=[];
  input.files=[photo(0),photo(1,{type:'application/pdf'}),photo(2,{size:0}),photo(3,{size:10*1024*1024+1})];
  assert.deepEqual(Array.from(f.app.enforceHostApplicationPropertyPhotoLimit(),file=>file.name),['photo-0.jpg']);
});

test('30 property photos leave the three proof document slots available',()=>{
  const f=fixture({'host-application-documents-input':''});
  f.app.hostApplicationDocuments=Array.from({length:30},()=>({document_type:'property_photo'}));
  f.elements['host-application-documents-input'].files=[photo(0),photo(1),photo(2)];
  assert.equal(f.app.getHostApplicationProofDocuments().length,0);
  assert.equal(f.app.enforceHostApplicationDocumentLimit().length,3);
});

test('host applications submit only with 5–30 combined existing and selected photos',async t=>{
  const fields={'host-application-email':'host@example.test','host-application-legal-name':'Test Host','host-application-phone':'123456','host-application-city':'Toronto','host-application-country':'Canada','host-application-property-type':'apartment','host-application-listing-city':'Toronto','host-application-bedrooms':'0','host-application-bathrooms':'1','host-application-guest-capacity':'2','host-application-experience':'Hosting experience','host-application-about':'Clean space','host-application-rules':'','host-application-submit':'','host-application-property-photos-input':''};
  for (const [existing,selected,expected] of [[0,4,false],[0,5,true],[2,3,true],[0,30,true],[30,0,true],[31,0,false]]) {
    await t.test(`${existing} existing + ${selected} selected`,async()=>{
      const f=fixture(fields);let submitted=0,writes=0;
      f.elements['host-application-property-photos-input'].files=Array.from({length:selected},(_,i)=>photo(i));
      Object.assign(f.app,{hostApplicationDocuments:[{document_type:'government_id'},...Array.from({length:existing},()=>({document_type:'property_photo'}))],getHostApplicationBooleanValue:()=>false,uploadHostApplicationDocuments:async()=>[],uploadHostApplicationPropertyPhotos:async()=>[],sendHostEmailNotification:async()=>({delivery:{delivered:true}}),populateHostApplicationForm(){}});
      f.app.supabase={from:()=>({upsert:row=>{writes++;return {select:()=>({single:async()=>({data:{...row,id:'application'},error:null})})};}}),rpc:async()=>{submitted++;return {error:null};}};
      await f.app.submitHostApplication({preventDefault(){},currentTarget:{reportValidity:()=>true}});
      assert.equal(submitted,expected?1:0);assert.equal(writes,expected?1:0);
      if (!expected) assert.match(f.notices.at(-1),existing>30?/up to 30/:/at least 5/);
    });
  }
});

test('failed photo upload removes partial files and records and keeps the selection for retry',async()=>{
  const f=fixture({'host-application-property-photos-input':''});
  const files=[photo(0),photo(1)];f.elements['host-application-property-photos-input'].files=files;
  let inserts=0;const uploaded=[],deleted=[],removed=[];
  f.app.supabase={storage:{from:()=>({upload:async path=>{uploaded.push(path);return {error:null};},remove:async paths=>{removed.push(...paths);return {error:null};}})},from:()=>({insert:row=>({select:()=>({single:async()=>++inserts===1?{data:{...row,id:'photo-row'},error:null}:{data:null,error:Error('Photo upload failed')}})}),delete:()=>({in:async(key,ids)=>{deleted.push(...ids);return {error:null};}})})};
  await assert.rejects(f.app.uploadHostApplicationPropertyPhotos('application'),/Photo upload failed/);
  assert.deepEqual(deleted,['photo-row']);assert.deepEqual(removed,uploaded);assert.equal(files.length,2);
  assert.equal(f.elements['host-application-property-photos-input'].files,files);
});

test('compact stay cards show a nightly rate in the listing currency without dropping cents',()=>{
  const {app}=fixture();
  const html=app.buildShortTermCardMarkup({id:'stay',title:'Downtown suite',location:'Private street address',city:'Toronto',country:'Canada',price:123.45,priceTerm:'per_night',currency:'CAD',images:['suite.jpg']},{compact:true});
  assert.match(html,/CA\$123\.45 \/ night/);
  assert.match(html,/Toronto, Canada/);
  assert.match(html,/src="suite.jpg"/);
});
test('stay cards never relabel monthly rent as a nightly price',()=>{
  const {app}=fixture();
  const monthly=app.buildShortTermCardMarkup({price:3000,priceTerm:'per_month',currency:'USD'},{compact:true});
  assert.match(monthly,/Contact host for nightly price/);
  assert.doesNotMatch(monthly,/Est\.|\$100 \/ night/);
  const missing=app.buildShortTermCardMarkup({price:0},{compact:true});
  assert.match(missing,/Contact host for nightly price/);
  assert.doesNotMatch(missing,/<div class="realestate-airbnb-price">\$0<\/div>/);
});
test('monthly rent cannot pass a positive nightly-price filter',()=>{
  const {app}=fixture();
  const item={price:3000,priceTerm:'per_month'};
  assert.equal(app.matchesRealestateUiFilters(item,{minPrice:90,maxPrice:110},{isAirbnb:true}),false);
  assert.equal(app.matchesRealestateUiFilters(item,{minPrice:110},{isAirbnb:true}),false);
});


test('nightly stay admission excludes stale monthly and imported regular room rentals',()=>{
  const {app}=fixture();
  const base={listingType:'for_rent_short',categories:['short_term'],price:800};
  assert.equal(app.isRealestateShortTermListing({...base,priceTerm:'per_month'}),false);
  assert.equal(app.isRealestateShortTermListing({...base,priceTerm:'per_week'}),false);
  assert.equal(app.isRealestateShortTermListing({...base,sourceTable:'scraped_csv'}),false);
  assert.equal(app.isRealestateShortTermListing({...base,sourceTable:'scraped_csv',priceTerm:'per_night'}),true);
  assert.equal(app.isRealestateShortTermListing({...base,sourceTable:'short_term_listings',priceTerm:'per_night'}),true);
});

test('feed entries preserve map coordinates, currency and nested review scores',()=>{
  const {app}=fixture();
  const entry=app.buildRealestateFeedEntryFromMarketplaceItem({id:'st_1',category:'real_estate',price:185.25,currency:'CAD',city:'Toronto',country:'Canada',realestate:{listingType:'for_rent_short',priceTerm:'per_night',latitude:43.65,longitude:-79.38,rating:'4.92',reviews:'27'}});
  assert.equal(entry.currency,'CAD');assert.equal(entry.priceValue,185.25);
  assert.equal(entry.lat,43.65);assert.equal(entry.lng,-79.38);
  assert.equal(entry.rating,4.92);assert.equal(entry.reviews,27);
  assert.match(app.buildShortTermCardMarkup(entry,{compact:true}),/4.92/);
  assert.match(app.buildShortTermCardMarkup(entry,{compact:true}),/\(27\)/);
  assert.match(app.buildShortTermCardMarkup(entry,{compact:true}),/CA\$185.25 \/ night/);
  assert.match(app.buildShortTermCardMarkup(entry,{compact:true}),/data-shortstay-location-id="st_1"/);
});

test('cards show New when review data is missing or invalid and never invent guests',()=>{
  const {app}=fixture();
  for(const item of [{},{rating:4.9,reviews:0},{rating:8,reviews:12},{rating:4.9,reviews:-2}]) {
    const html=app.buildShortTermCardMarkup(item,{compact:true});
    assert.match(html,/New stay, no reviews yet/);
    assert.doesNotMatch(html,/2 guests/);
  }
});

test('map coordinates expose a coarse vicinity or city area, group overlaps, and reject empty coordinates',()=>{
  const {app}=fixture();app.companionshipCityGeo={'Toronto|Canada':{lat:43.6532,lng:-79.3832}};
  const property={id:'one',latitude:'43.66241',longitude:'-79.41049'};
  const city={id:'two',city:'Toronto',country:'Canada',lat:null,lng:null};
  assert.equal(app.getShortTermMapLocation(property).lat,43.66);
  assert.equal(app.getShortTermMapLocation(property).precision,'vicinity');
  assert.equal(app.getShortTermMapLocation(city).precision,'city');
  assert.equal(app.getShortTermMapLocation({lat:'',lng:''}),null);
  assert.equal(app.getShortTermMapLocation({lat:91,lng:181}),null);
  const groups=app.getShortTermMapGroups([property,city,{...city,id:'three'}]);
  assert.equal(groups.length,2);assert.equal(groups[1].items.length,2);
  assert.match(app.buildShortTermProfileLocationMarkup(city),/City area shown/);
  assert.match(app.buildShortTermProfileLocationMarkup(property),/Approximate stay vicinity/);
  assert.match(app.buildShortTermProfileLocationMarkup(property),/data-shortstay-area-map/);
  assert.doesNotMatch(app.buildShortTermProfileLocationMarkup(property),/iframe|marker=|43\.66241/);
});


test('direct stay publication rejects monthly prices before calling the backend',async()=>{
  const {app}=fixture();let calls=0;app.supabase={rpc:async()=>{calls++;return {data:[{id:'st_nightly'}],error:null};}};
  await assert.rejects(app.createSupabaseShortTermListing({price:800,realestate:{priceTerm:'per_month'}}),/nightly price/);
  assert.equal(calls,0);
  await app.createSupabaseShortTermListing({price:180,realestate:{priceTerm:'per_night'}});
  assert.equal(calls,1);
});


test('Signature profile, form preview and persisted listing agree on currency, fees, rules and public vicinity',()=>{
 const f=fixture({'realestate-listing-type':'for_rent_short','realestate-stay-currency':'CAD','item-country':'Canada','item-city':'Toronto','item-title':'Signature sample','item-price':'185.25','item-description':'Quiet <script>stay</script>','realestate-host-name':'Alex','realestate-cleaning-fee':'35.25','realestate-checkin-time':'16:00','realestate-checkout-time':'11:00','realestate-min-stay':'2','realestate-max-guests':'4','realestate-bedrooms':'2','realestate-bathrooms':'1.5','realestate-address':'123 Private Street','realestate-postal':'A1A 1A1','realestate-stay-lat':'43.66241','realestate-stay-lng':'-79.41049','realestate-house-rules':'No parties.'});
 Object.assign(f.app,{getMarketplaceUsername:()=> 'Alex',getMarketplaceProfilePhoto:()=>'',isHostApproved:()=>true,realestateShortTermBlockedDates:[]});
 const draft=f.app.getRealestatePostingDetails();assert.equal(draft.currency,'CAD');assert.equal(draft.address,'123 Private Street');
 const preview=f.app.buildShortTermCardPreviewMarkup();
 const listing=f.app.buildRealestateFeedEntryFromMarketplaceItem({id:'st_signature',category:'real_estate',title:'Signature sample',price:185.25,currency:draft.currency,city:'Toronto',country:'Canada',description:'Quiet <script>stay</script>',realestate:JSON.parse(JSON.stringify(draft))});
 const profile=f.app.buildShortTermSignatureSectionsMarkup(listing);const card=f.app.buildShortTermCardMarkup(listing);
 for(const html of [preview,profile,card]) {assert.match(html,/CA\$185\.25/);assert.doesNotMatch(html,/123 Private Street|A1A 1A1|43\.66241|<script>/);}
 assert.equal(listing.cleaningFee,35.25);assert.match(preview,/35\.25/);
 for(const html of [preview,profile]) {assert.match(html,/No parties/);assert.match(html,/New stay/);assert.match(html,/Approximate area/);}
 assert.equal((profile.match(/id="realestate-short-term-booking-checkin"/g)||[]).length,1);
 assert.doesNotMatch(preview,/id="realestate-short-term-booking-checkin"/);
 f.elements['realestate-stay-currency'].value='USD';assert.ok(f.app.buildShortTermCardPreviewMarkup().includes(f.app.formatShortTermMoney(185.25,'USD')));assert.equal(f.app.getRealestatePostingDetails().currency,'USD');
 assert.equal(f.app.getShortTermPublicAreaLabel({location:'123 Private Street'}),'Area to be confirmed with host');
});

test('first-time hosts can submit without essays, residence city, or irrelevant owner-permission answers',async()=>{
  const f=fixture({'host-application-email':'host@example.test','host-application-legal-name':'Test Host','host-application-phone':'123456','host-application-country':'Canada','host-application-property-type':'studio','host-application-listing-city':'Toronto','host-application-bedrooms':'0','host-application-bathrooms':'1','host-application-guest-capacity':'2','host-application-rules':'','host-application-submit':''});
  let payload,submitted=0;
  Object.assign(f.app,{hostApplicationDocuments:[{document_type:'government_id'},...Array.from({length:5},()=>({document_type:'property_photo'}))],getHostApplicationBooleanValue:name=>name==='host-application-owner-permission'?null:name==='host-application-owns-property',uploadHostApplicationDocuments:async()=>[],uploadHostApplicationPropertyPhotos:async()=>[],sendHostEmailNotification:async()=>({delivery:{delivered:true}}),populateHostApplicationForm(){}});
  f.app.supabase={from:()=>({upsert:row=>{payload=row;return {select:()=>({single:async()=>({data:{...row,id:'application'},error:null})})};}}),rpc:async()=>{submitted++;return {error:null};}};
  await f.app.submitHostApplication({preventDefault(){}});
  assert.equal(submitted,1);assert.equal(payload.hosting_experience,'');assert.equal(payload.about_host,'');assert.equal(payload.city,'');assert.equal(payload.bedrooms,0);assert.equal(payload.has_owner_permission,null);assert.equal(payload.has_relevant_conviction,null);
  for(const key of ['rules_acknowledged','provides_house_rules','maintains_cleanliness','responds_timely','agrees_guest_safety','agrees_truthful_listing','meets_health_safety_standards','complies_local_laws']) assert.equal(payload[key],true,key);
  assert.equal(Object.hasOwn(payload,'doc_government_id'),false,'proof flags are determined by actual server uploads');
});

test('blank application notes never bypass identity, consent, proof or gallery requirements',async()=>{
  const f=fixture({'host-application-email':'host@example.test','host-application-legal-name':'Test Host','host-application-phone':'123456','host-application-country':'Canada','host-application-property-type':'studio','host-application-listing-city':'Toronto','host-application-bedrooms':'0','host-application-bathrooms':'1','host-application-guest-capacity':'2','host-application-rules':'','host-application-submit':''});
  let writes=0;
  Object.assign(f.app,{getHostApplicationBooleanValue:()=>false,hostApplicationDocuments:Array.from({length:5},()=>({document_type:'property_photo'}))});
  f.app.supabase={from(){writes++;throw Error('Must not write');}};
  await f.app.submitHostApplication({preventDefault(){}});assert.equal(writes,0);assert.match(f.notices.at(-1),/proof/);
  f.app.hostApplicationDocuments.push({document_type:'government_id'});f.elements['host-application-rules'].checked=false;
  await f.app.submitHostApplication({preventDefault(){}});assert.equal(writes,0);assert.match(f.notices.at(-1),/Complete/);
});

test('application details fill blank listing fields and preserve typed details and zero bedrooms',()=>{
  const f=fixture({'item-city':'My chosen city','item-country':'','realestate-property-type':'','realestate-bedrooms':'','realestate-bathrooms':'2','realestate-max-guests':''});
  f.context.Event=class {constructor(type){this.type=type;}};
  for(const field of Object.values(f.elements)) field.dispatchEvent=()=>{};
  f.app.fillEmptyStayFieldsFromApplication({listing_city:'Toronto',country:'Canada',property_type:'studio',bedrooms:0,bathrooms:1,max_guest_capacity:3});
  assert.equal(f.elements['item-city'].value,'My chosen city');assert.equal(f.elements['item-country'].value,'Canada');assert.equal(f.elements['realestate-bedrooms'].value,'0');assert.equal(f.elements['realestate-bathrooms'].value,'2');assert.equal(f.elements['realestate-max-guests'].value,'3');
});

test('host drafts stay scoped to the account, omit files and expire after submission changes',()=>{
  const f=fixture({'host-application-draft-status':''});const saved=new Map();
  f.context.window.sessionStorage={getItem:key=>saved.get(key),setItem:(key,value)=>saved.set(key,value)};
  const fields=[{id:'host-application-legal-name',type:'text',value:'Draft Host'},{id:'host-application-property-photos-input',type:'file',value:'private-path',files:[{name:'private.jpg'}]},{name:'host-application-hosted-before',type:'radio',value:'no',checked:true},{id:'host-application-rules',type:'checkbox',checked:false}];
  f.elements['host-application-form']={querySelectorAll:()=>fields};f.app.hostApplicationStep=2;
  f.app.saveHostApplicationDraft();const key=f.app.getHostApplicationDraftKey();const draft=JSON.parse(saved.get(key));
  assert.equal(draft.step,2);assert.equal(draft.fields['host-application-hosted-before'],'no');assert.equal(Object.keys(draft.fields).length,3);assert.doesNotMatch(saved.get(key),/private/);
  fields[0].value='';f.app.restoreHostApplicationDraft();assert.equal(fields[0].value,'Draft Host');
  f.app.currentUser.id='another-user';fields[0].value='Other account';f.app.restoreHostApplicationDraft();assert.equal(fields[0].value,'Other account');
  f.app.currentUser.id='host';f.app.currentHostApplication={submitted_at:'newer-version'};fields[0].value='Server copy';f.app.restoreHostApplicationDraft();assert.equal(fields[0].value,'Server copy');
});
