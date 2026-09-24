import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source=readFileSync(process.env.RENTAL_APP_SOURCE || new URL('../app.js',import.meta.url),'utf8');
function fixture(fields={}) {
  const elements=Object.fromEntries(Object.entries(fields).map(([key,value])=>[key,{value,checked:true,disabled:false,textContent:'',classList:{add(){},remove(){},toggle(){}},focus(){}}]));
  const context={document:{getElementById:id=>elements[id]||null,querySelector:()=>null,querySelectorAll:()=>[],addEventListener(){}},window:{prompt:()=>null},console:{warn(){},log(){},error(){}},Date,Intl,URL,Set,Map,setTimeout,clearTimeout};
  vm.runInNewContext(source.slice(0,source.indexOf('// Initialize the app when the page loads'))+'\nglobalThis.App=DatingApp;',context);
  const notices=[];
  const app=Object.assign(Object.create(context.App.prototype),{isSignedIn:true,supabaseEnabled:true,currentUser:{id:'host',email:'host@example.test',emailVerified:true},showNotification:m=>notices.push(m),isHostAdmin:()=>false,updateHostEntryPoint(){},renderAdminDashboard(){},closeHostApplicationModal(){}});
  return {app,context,elements,notices};
}
test('admin cancelling the review prompt performs no writes or email calls',async()=>{
  const f=fixture();let calls=0;f.app.isHostAdmin=()=>true;f.app.supabase={rpc:async()=>{calls++;}};
  await f.app.reviewHostApplication('application','approved');assert.equal(calls,0);
});
test('nightly rates and service fees preserve cents and do not invent taxes',()=>{
  const {app}=fixture();app.parseRealestatePriceAmount=value=>Number(value);
  assert.equal(app.getShortTermNightlyRate({price:123.45}),123.45);
  assert.equal(app.getShortTermNightlyRate({price:1000,priceTerm:'per_month'}),33.33);
  assert.equal(app.getShortTermNightlyRate({price:1000,priceTerm:'per_week'}),142.86);
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
  Object.assign(f.app,{hostApplicationMinPropertyPhotos:3,hostApplicationMaxPropertyPhotos:12,getHostApplicationPropertyPhotoDocuments:()=>[{}, {}, {}],getHostApplicationProofDocuments:()=>[],enforceHostApplicationPropertyPhotoLimit:()=>[],getHostApplicationBooleanValue:()=>false,enforceHostApplicationDocumentLimit:()=>[{name:'proof.jpg'}],getVehicleRentalComplianceDocumentTypes:()=>[],uploadHostApplicationDocuments:async()=>{throw Error('Upload failed');},populateHostApplicationForm:()=>{throw Error('Must not overwrite typed data during submission');}});
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
  for(const photo of payload.images){assert.ok(preview.includes(photo));assert.ok(card.includes(photo));}
  const details=f.app.renderRealestateDetailRowsMarkup(f.app.buildRealestateDetailRows(listing));
  assert.ok(preview.includes(details),'preview details equal the reloaded property profile');
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
