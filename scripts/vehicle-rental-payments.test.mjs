import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {stripTypeScriptTypes} from 'node:module';import {readFileSync} from 'node:fs';
const read=n=>readFileSync(new URL(`../supabase/functions/${n}`,import.meta.url),'utf8');
function load(name,db,stripe,extra={}){const ctx={console:{warn(){},error(){},log(){}},Request,Response,Headers,URL,Date,Set,Map,Error,crypto,AbortSignal,Deno:{env:{get:()=> 'configured'},serve:h=>ctx.handler=h},createClient:()=>db,Stripe:function(){return stripe;},PROMOTION_PRICING_USD:{},...extra};for(const part of ['_shared/rental-payout.ts','_shared/rental-payment-lock.ts','_shared/rental-settlement.ts',name]){const src=read(part).replace(/^import[\s\S]*?from ['"][^'"]+['"];?\s*$/gm,'').replace(/^export /gm,'');vm.runInNewContext(stripTypeScriptTypes(src,{mode:'transform'}),ctx);}return ctx;}
const booking=()=>({id:'car-row',public_id:'vrb_test',listing_public_id:'ml_car',host_user_id:'host',guest_user_id:'guest',guest_email:'guest@example.test',status:'requested',payment_status:'unpaid',stripe_payment_intent_id:null,pickup_date:'2099-01-01',return_date:'2099-01-03',total:276.85,service_fee:20,currency:'CAD',hold_expires_at:new Date(Date.now()+1800000).toISOString(),booking_payload:{rentalType:'vehicle_rental',payoutMode:'delayed_transfer',pickupAt:'2099-01-01T10:00:00Z',returnAt:'2099-01-03T10:00:00Z',cancellationDeadline:'2098-12-31T10:00:00Z'},payment_payload:{}});
const finance=()=>({booking_type:'vehicle_rental',booking_public_id:'vrb_test',total_cents:27685,service_fee_cents:2000,tax_cents:3185,host_amount_cents:22500,currency:'CAD',payout_due_at:'2020-01-01T00:00:00Z',payout_status:'pending'});
function fixture(b=booking(),actor='guest'){
 const f=finance(),updates=[],locks=[],state={driver_review_status:'approved',picked_up_at:'2020-01-01T00:00:00Z'},docs=[{id:'proof'}],issues=[];
 const db={auth:{getUser:async()=>({data:{user:{id:actor,email:`${actor}@example.test`}}})},rpc:async(name,args)=>{locks.push({name,args});return {data:name.startsWith('claim')?'lease':null};},from(table){let patch;const single=()=>table==='profiles'?{is_admin:false}:table==='stripe_connected_accounts'?{stripe_account_id:'acct_host',details_submitted:true,payouts_enabled:true}:table==='vehicle_booking_finance'?f:table==='vehicle_trip_state'?state:b;
 const q={select(){return q;},eq(){return q;},neq(){return q;},in(){return q;},lte(){return q;},gte(){return q;},limit(){return q;},lt(){return q;},gt(){return q;},update(p){patch=p;updates.push({table,patch:p});return q;},maybeSingle:async()=>{if(patch)Object.assign(single(),patch);return {data:single()};},single:async()=>{if(patch)Object.assign(single(),patch);return {data:single()};},then(resolve){if(patch)Object.assign(single(),patch);resolve({data:patch?single():table==='vehicle_rental_booking_documents'?docs:table==='vehicle_trip_issues'?issues:[]});}};return q;}};
 return {db,b,f,updates,locks,state,docs,issues};
}
const request=body=>new Request('https://example.test',{method:'POST',headers:{authorization:'Bearer test','content-type':'application/json',origin:'https://6ixo.com'},body:JSON.stringify(body)});
const checkout={placement:'vehicle_rental_booking',vehicleRentalBookingPublicId:'vrb_test',amount:1,serviceFee:0,hostUserId:'attacker'};
const account={details_submitted:true,payouts_enabled:true,capabilities:{transfers:'active'}};
test('car checkout uses the server quote, a card authorization, private driver evidence and a vehicle payment lease',async()=>{
 const x=fixture();let args;const stripe={accounts:{retrieve:async()=>account},paymentIntents:{create:async p=>{args=p;return {id:'pi_car',client_secret:'test',amount:p.amount,currency:p.currency,status:'requires_payment_method'};}}};
 let ctx=load('create-payment-intent/index.ts',x.db,stripe);let res=await ctx.handler(request(checkout));assert.equal(res.status,200);assert.equal(args.amount,27685);assert.equal(args.capture_method,'manual');assert.equal(args.transfer_data,undefined);assert.equal(args.application_fee_amount,undefined);assert.equal(args.metadata.payout_destination,'acct_host');assert.equal(x.locks[0].name,'claim_vehicle_payment_action');assert.equal(x.locks.at(-1).name,'release_vehicle_payment_action');
 x.b.stripe_payment_intent_id=null;x.docs.length=0;res=await ctx.handler(request(checkout));assert.equal(res.status,409);
});
test('car checkout never replaces an uncertain or already successful Stripe payment',async()=>{
 for(const status of ['network_failure','succeeded','processing','requires_capture']){
 const x=fixture();x.b.stripe_payment_intent_id='pi_existing';let creates=0;
 const ctx=load('create-payment-intent/index.ts',x.db,{accounts:{retrieve:async()=>account},paymentIntents:{retrieve:async()=>{if(status==='network_failure')throw Error('Network failure');return {id:'pi_existing',status};},create:async()=>{creates++;}}});
 assert.equal((await ctx.handler(request(checkout))).status,status==='network_failure'?503:409);assert.equal(creates,0);
 }
});
test('car approval requires host access and a reviewed driver; repeat capture is idempotent',async()=>{
 const b=booking();b.payment_status='authorized';b.stripe_payment_intent_id='pi_car';let captures=0;
 const stripe={paymentIntents:{retrieve:async()=>({id:'pi_car',status:'requires_capture'}),capture:async()=>{captures++;return {id:'pi_car',status:'succeeded'};}}};
 let x=fixture(b,'guest'),ctx=load('manage-booking-payment/index.ts',x.db,stripe);assert.equal((await ctx.handler(request({bookingType:'vehicle_rental',bookingPublicId:b.public_id,action:'capture'}))).status,403);
 x=fixture(b,'host');x.state.driver_review_status='pending';ctx=load('manage-booking-payment/index.ts',x.db,stripe);assert.equal((await ctx.handler(request({bookingType:'vehicle_rental',bookingPublicId:b.public_id,action:'capture'}))).status,409);
 x.state.driver_review_status='approved';assert.equal((await ctx.handler(request({bookingType:'vehicle_rental',bookingPublicId:b.public_id,action:'capture'}))).status,200);assert.equal((await ctx.handler(request({bookingType:'vehicle_rental',bookingPublicId:b.public_id,action:'capture'}))).status,200);assert.equal(captures,1);
});
test('a captured car cancellation refunds the complete guest payment and updates only the vehicle ledger',async()=>{
 const x=fixture();Object.assign(x.b,{status:'confirmed',payment_status:'paid',stripe_payment_intent_id:'pi_car'});let refundArgs;
 const stripe={paymentIntents:{retrieve:async()=>({id:'pi_car',status:'succeeded'})},refunds:{create:async args=>{refundArgs=args;return {id:'re_car',status:'succeeded'};}}};const ctx=load('manage-booking-payment/index.ts',x.db,stripe);
 assert.equal((await ctx.handler(request({bookingType:'vehicle_rental',bookingPublicId:'vrb_test',action:'cancel'}))).status,200);assert.equal(refundArgs.reverse_transfer,undefined);assert.equal(refundArgs.refund_application_fee,undefined);assert.equal(x.f.payout_status,'cancelled');assert.equal(x.b.payment_status,'refunded');assert.ok(!x.updates.some(r=>r.table==='rental_booking_finance'));
});
test('car funds wait for the release deadline, verified pickup, and issue resolution, and never transfer twice',async()=>{
 const x=fixture();Object.assign(x.b,{status:'confirmed',payment_status:'paid',stripe_payment_intent_id:'pi_car'});let transfers=[];
 const charge={id:'ch_car',refunded:false,amount_refunded:0,disputed:false};
 const stripe={accounts:{retrieve:async()=>account},paymentIntents:{retrieve:async()=>({status:'succeeded',amount_received:27685,currency:'cad',latest_charge:'ch_car',metadata:{payout_mode:'delayed_transfer',payout_destination:'acct_host'}})},charges:{retrieve:async()=>charge},refunds:{list:async()=>({data:[]})},transfers:{list:async()=>({data:transfers}),create:async args=>{const transfer={...args,id:'tr_car',reversed:false};transfers.push(transfer);return transfer;}}};
 const ctx=load('_shared/rental-payout.ts',x.db,stripe);x.f.payout_due_at='2099-01-01T00:00:00Z';await ctx.releaseRentalFunds(x.db,stripe,x.b,x.f);assert.equal(transfers.length,0);
 x.f.payout_due_at='2020-01-01T00:00:00Z';x.state.picked_up_at=null;await assert.rejects(ctx.releaseRentalFunds(x.db,stripe,x.b,x.f),/pickup/);
 x.state.picked_up_at='2020-01-01T00:00:00Z';x.issues.push({id:'issue'});await assert.rejects(ctx.releaseRentalFunds(x.db,stripe,x.b,x.f),/issue/);x.issues.length=0;
 await ctx.releaseRentalFunds(x.db,stripe,x.b,x.f);await ctx.releaseRentalFunds(x.db,stripe,x.b,x.f);assert.equal(transfers.length,1);assert.equal(transfers[0].amount,22500);assert.equal(transfers[0].source_transaction,'ch_car');assert.equal(x.f.payout_status,'transferred');assert.ok(!x.updates.some(r=>r.table==='rental_booking_finance'));
});
test('car refund recovery reverses the connected transfer and keeps the stay ledger untouched',async()=>{
 const x=fixture();x.f.stripe_transfer_id='tr_car';let reversals=0;
 const stripe={refunds:{create:async()=>({id:'re_car',status:'succeeded'})},transfers:{retrieve:async()=>({id:'tr_car',reversed:false}),createReversal:async()=>{reversals++;}}};const ctx=load('_shared/rental-payout.ts',x.db,stripe);
 await ctx.refundRentalPayment(x.db,stripe,x.b,{id:'pi_car'},'cancelled');assert.equal(reversals,1);assert.equal(x.f.payout_status,'reversed');assert.ok(!x.updates.some(r=>r.table==='rental_booking_finance'));
});
test('late car payment guard checks same-day timestamps and rejects an overlapping active trip',async()=>{
 const b={...booking(),pickup_date:'2099-01-01',return_date:'2099-01-01',booking_payload:{pickupAt:'2099-01-01T10:00:00Z',returnAt:'2099-01-01T14:00:00Z'}};
 const competitor={...b,public_id:'other',payment_status:'paid',booking_payload:{pickupAt:'2099-01-01T13:00:00Z',returnAt:'2099-01-01T15:00:00Z'}};
 const db={from(){const q={select(){return q;},eq(){return q;},neq(){return q;},in(){return q;},lte(){return q;},gte(){return q;},maybeSingle:async()=>({data:b}),then:r=>r({data:[competitor]})};return q;}};
 const ctx=load('stripe-webhook/index.ts',db,{}, {PROMOTION_DURATION_HOURS:24,SUBSCRIPTION_PLANS:{},isSubscriptionPlanKey:()=>false});assert.equal((await ctx.getRentalPaymentGuardState('vehicle_rental_bookings',b.public_id)).reject,true);
 competitor.booking_payload.pickupAt='2099-01-01T14:00:00Z';assert.equal((await ctx.getRentalPaymentGuardState('vehicle_rental_bookings',b.public_id)).reject,false);
 b.status='cancelled';assert.equal((await ctx.getRentalPaymentGuardState('vehicle_rental_bookings',b.public_id)).reject,true);
});
