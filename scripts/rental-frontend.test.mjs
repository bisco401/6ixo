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
  assert.equal(quote.serviceFee,44.44);assert.equal(quote.total,445.04);assert.equal(quote.taxes,0);
  assert.match(app.formatShortTermMoney(445.04,'CAD'),/445\.04/);
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
