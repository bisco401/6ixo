import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(process.env.RENTAL_FUNCTION_ROOT ? `${process.env.RENTAL_FUNCTION_ROOT}/${name}` : new URL(`../supabase/functions/${name}`, import.meta.url),'utf8');
function load(name, { db = {}, stripe = {}, globals = {} } = {}) {
  const context = { console: { warn(){},log(){},error(){} }, Request, Response, Headers, URL, Date, Set, Map, Error, crypto,
    Deno: {env:{get:()=> 'configured'},serve:handler=>{context.handler=handler;}},
    createClient:()=>db, Stripe:function(){return stripe;}, PROMOTION_PRICING_USD:{}, ...globals };
  const parts=['_shared/rental-payout.ts','_shared/rental-payment-lock.ts',name];
  for(const part of parts) {
    const code=read(part).replace(/^import[\s\S]*?from ['"][^'"]+['"];?\s*$/gm,'').replace(/^export /gm,'');
    vm.runInNewContext(stripTypeScriptTypes(code,{mode:'transform'}),context);
  }
  return context;
}
function bookingDb(booking, actor='guest') {
  const updates=[],locks=[];
  const db={ auth:{getUser:async()=>({data:{user:{id:actor,email:`${actor}@example.test`}}})},
    rpc:async(name,args)=>{locks.push({name,args});return {data:name.startsWith('claim')?'lock':null,error:null};},
    from(table){const q={ select(){return q;},eq(){return q;},maybeSingle:async()=>({data:table==='profiles'?{is_admin:false}:table==='stripe_connected_accounts'?{stripe_account_id:'acct_host',details_submitted:true,payouts_enabled:true}:{...booking}}),
      update(patch){updates.push({table,patch});Object.assign(booking,patch);return q;}, then(resolve){resolve({data:booking,error:null});} };return q;} };
  return {db,updates,locks};
}
const request = body => new Request('https://test/functions', {method:'POST',headers:{authorization:'Bearer test','content-type':'application/json',origin:'https://6ixo.com'},body:JSON.stringify(body)});
const newBooking = overrides => ({id:'row',public_id:'stay',listing_public_id:'listing',host_user_id:'host',guest_user_id:'guest',guest_email:'guest@example.test',status:'requested',payment_status:'unpaid',stripe_payment_intent_id:null,checkin_date:'2099-01-10',total:445.04,service_fee:44.44,currency:'CAD',hold_expires_at:new Date(Date.now()+1800000).toISOString(),payment_payload:{},...overrides});

test('checkout ignores client money and sends the server total, 12% fee and host destination to Stripe',async()=>{
  const f=bookingDb(newBooking());let createArgs;
  const stripe={accounts:{retrieve:async()=>({details_submitted:true,payouts_enabled:true,capabilities:{transfers:'active'}})},paymentIntents:{create:async(args)=>{createArgs=args;return {id:'pi_new',client_secret:'test_secret',amount:args.amount,currency:args.currency,status:'requires_payment_method'};}}};
  const ctx=load('create-payment-intent/index.ts',{...f,stripe});
  const response=await ctx.handler(request({placement:'short_term_booking',bookingPublicId:'stay',amount:1,serviceFee:0,hostUserId:'attacker'}));
  assert.equal(response.status,200);assert.equal(createArgs.amount,44504);assert.equal(createArgs.application_fee_amount,4444);
  assert.equal(createArgs.transfer_data.destination,'acct_host');assert.equal(createArgs.capture_method,'manual');assert.deepEqual(Array.from(createArgs.payment_method_types),['card']);
  assert.equal(f.locks.at(-1).name,'release_short_term_payment_action');
});
test('expired checkout holds and disabled transfers never create a payment',async()=>{
  for (const expired of [true,false]) {
    const f=bookingDb(newBooking(expired?{hold_expires_at:new Date(0).toISOString()}:{}));let created=0;
    const stripe={accounts:{retrieve:async()=>({details_submitted:true,payouts_enabled:true,capabilities:{transfers:'pending'}})},paymentIntents:{create:async()=>{created++;}}};
    const ctx=load('create-payment-intent/index.ts',{...f,stripe});
    assert.equal((await ctx.handler(request({placement:'short_term_booking',bookingPublicId:'stay'}))).status,409);assert.equal(created,0);
  }
});
test('a failed lookup of an existing Stripe intent cannot create a second charge',async()=>{
  const f=bookingDb(newBooking({stripe_payment_intent_id:'pi_existing'}));let created=0;
  const stripe={accounts:{retrieve:async()=>({details_submitted:true,payouts_enabled:true,capabilities:{transfers:'active'}})},paymentIntents:{retrieve:async()=>{throw Error('Network unavailable');},create:async()=>{created++;}}};
  const ctx=load('create-payment-intent/index.ts',{...f,stripe});
  assert.equal((await ctx.handler(request({placement:'short_term_booking',bookingPublicId:'stay'}))).status,503);assert.equal(created,0);
});
test('only the host can capture, and a repeated approval never captures twice',async()=>{
  const booking=newBooking({payment_status:'authorized',stripe_payment_intent_id:'pi_hold'});let captures=0;
  const stripe={paymentIntents:{retrieve:async()=>({id:'pi_hold',status:'requires_capture'}),capture:async()=>{captures++;return {id:'pi_hold',status:'succeeded'};}}};
  let f=bookingDb(booking,'guest'),ctx=load('manage-booking-payment/index.ts',{...f,stripe});
  assert.equal((await ctx.handler(request({bookingPublicId:'stay',action:'capture'}))).status,403);
  f=bookingDb(booking,'host');ctx=load('manage-booking-payment/index.ts',{...f,stripe});
  assert.equal((await ctx.handler(request({bookingPublicId:'stay',action:'capture'}))).status,200);
  assert.equal(booking.status,'confirmed');assert.equal(booking.payment_status,'paid');
  assert.equal((await ctx.handler(request({bookingPublicId:'stay',action:'capture'}))).status,200);assert.equal(captures,1);
});
test('declining an authorization releases it; captured cancellation refunds the guest and reverses host and platform funds',async()=>{
  for(const paid of [false,true]) {
    const booking=newBooking({payment_status:paid?'paid':'authorized',stripe_payment_intent_id:'pi_hold'}),f=bookingDb(booking,'host');let cancelled=0,refundArgs,refunds=0;
    const stripe={paymentIntents:{retrieve:async()=>({id:'pi_hold',status:paid?'succeeded':'requires_capture'}),cancel:async()=>{cancelled++;return {status:'canceled'};}},refunds:{create:async(args)=>{refundArgs=args;refunds++;return {id:'re_refund',status:'succeeded'};}}};
    const ctx=load('manage-booking-payment/index.ts',{...f,stripe});
    assert.equal((await ctx.handler(request({bookingPublicId:'stay',action:'cancel',nextStatus:'declined'}))).status,200);
    assert.equal(booking.payment_status,paid?'refunded':'cancelled');
    if(paid){assert.equal(refundArgs.reverse_transfer,true);assert.equal(refundArgs.refund_application_fee,true);}else assert.equal(cancelled,1);
    assert.equal((await ctx.handler(request({bookingPublicId:'stay',action:'cancel',nextStatus:'cancelled'}))).status,200);
    assert.equal(paid?refunds:cancelled,1);
  }
});
test('opening payout status never creates a connected account and missing country cannot default to another country',async()=>{
  let created=0;
  const db={auth:{getUser:async()=>({data:{user:{id:'host',email:'host@example.test'}}})},from:table=>({select(){return this;},eq(){return this;},maybeSingle:async()=>({data:table==='profiles'?{host_status:'approved',country:'Unknown'}:null})})};
  const ctx=load('connect-account/index.ts',{db,stripe:{accounts:{create:async()=>{created++;}}}});
  const status=await ctx.handler(request({action:'status'}));assert.equal(status.status,200);assert.equal((await status.json()).accountId,null);assert.equal(created,0);
  assert.equal((await ctx.handler(request({action:'onboard'}))).status,400);assert.equal(created,0);
});

test('outbox delivers separately to verified host and admin and safely retries a failed admin delivery',async()=>{
  const application={id:'application',submitted_at:'version',legal_name:'Test <Host>',listing_city:'Toronto',country:'Canada'};
  const messages=[{id:'host-message',recipient_user_id:'host',recipient_role:'host'},{id:'admin-message',recipient_user_id:'admin',recipient_role:'admin'}];
  const sent=[];let failAdmin=true;
  const db={auth:{admin:{getUserById:async id=>({data:{user:{email:`${id}@example.test`,email_confirmed_at:'yes'}}})}},from:()=>{let id,patch;const q={select(){return q;},eq(k,v){if(k==='id')id=v;return q;},update(p){patch=p;return q;},then(resolve){if(patch)Object.assign(messages.find(m=>m.id===id),patch);resolve({data:messages});}};return q;}};
  const context={Date,fetch,Error};vm.runInNewContext(stripTypeScriptTypes(read('_shared/host-notifications.ts').replace(/^export /gm,''),{mode:'transform'}),context);
  const send=async(_,options)=>{const payload=JSON.parse(options.body);sent.push({payload,key:options.headers['Idempotency-Key']});return new Response('{}',{status:payload.to[0].startsWith('admin')&&failAdmin?503:200});};
  let result=await context.deliverHostNotifications({db,application,eventType:'submitted',from:'host@6ixo.com',apiKey:'test',send});
  assert.equal(result.delivered,false);assert.ok(messages[0].sent_at);assert.ok(messages[1].last_error);assert.equal(sent.length,2);
  assert.match(sent[1].payload.html,/Test &lt;Host&gt;/);assert.match(sent[1].payload.text,/Admin/);
  failAdmin=false;result=await context.deliverHostNotifications({db,application,eventType:'submitted',from:'host@6ixo.com',apiKey:'test',send});
  assert.equal(result.delivered,true);assert.equal(sent.length,3);assert.equal(sent[1].key,sent[2].key);
});

test('a delayed authorization webhook reconciles current capture; an obsolete intent never replaces the new one',async()=>{
  for(const obsolete of [false,true]){
    const booking=newBooking({stripe_payment_intent_id:obsolete?'pi_new':'pi_old',payment_status:'paid'}),f=bookingDb(booking);
    const stripe={paymentIntents:{retrieve:async()=>({id:'pi_old',status:'succeeded',metadata:{placement:'short_term_booking',booking_public_id:'stay'},currency:'cad',amount:44504,amount_received:44504})}};
    const ctx=load('stripe-webhook/index.ts',{...f,stripe,globals:{PROMOTION_DURATION_HOURS:{},PROMOTION_PRICING_USD:{}}});
    await ctx.updateShortTermBookingPaymentFromIntent({id:'pi_old',status:'requires_capture',metadata:{placement:'short_term_booking',booking_public_id:'stay'}});
    if(obsolete) assert.equal(f.updates.length,0);else{assert.equal(booking.payment_status,'paid');assert.equal(booking.status,'confirmed');}
  }
});


test('late-payment refunds remain processing until Stripe confirms success', async()=>{
  for (const status of ['pending','succeeded']) {
    const booking=newBooking({stripe_payment_intent_id:'pi_late'}), f=bookingDb(booking);
    const stripe={refunds:{create:async()=>({id:'re_late',status})}};
    const ctx=load('stripe-webhook/index.ts',{...f,stripe});
    await ctx.rejectLateRentalPayment('short_term_bookings',booking,{id:'pi_late',status:'succeeded'});
    assert.equal(booking.status,'cancelled');
    assert.equal(booking.payment_status,status==='succeeded'?'refunded':'processing');
    assert.equal(Boolean(booking.stripe_payment_refunded_at),status==='succeeded');
  }
});

test('webhook accepts the configured Connect signature and rejects unsigned or invalid events', async()=>{
  const tried=[];
  const stripe={webhooks:{constructEventAsync:async(_,signature,secret)=>{
    tried.push(secret);if(signature!=='connect-signature'||secret!=='connect-secret')throw Error('Invalid signature');
    return {id:'evt_test',type:'ignored.test.event',created:1,data:{object:{}}};
  }}};
  const env={STRIPE_SECRET_KEY:'configured',STRIPE_WEBHOOK_SECRET:'platform-secret',STRIPE_CONNECT_WEBHOOK_SECRET:'connect-secret',SUPABASE_URL:'configured',SUPABASE_SERVICE_ROLE_KEY:'configured'};
  let handler;
  load('stripe-webhook/index.ts',{db:{from:()=>({upsert:async()=>({error:null})})},stripe,globals:{Deno:{env:{get:key=>env[key]},serve:value=>{handler=value;}}}});
  for(const [signature,expected] of [['',400],['invalid',400],['connect-signature',200]]){
    const response=await handler(new Request('https://test/webhook',{method:'POST',headers:{'stripe-signature':signature},body:'{}'}));
    assert.equal(response.status,expected);
  }
  assert.ok(tried.includes('platform-secret'));assert.ok(tried.includes('connect-secret'));
});
