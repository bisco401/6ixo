import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {createRentalTestDatabase,asUser} from './lib/rental-test-db.mjs';

// Real schema, RLS, SQL functions, and edge handlers; only Stripe is simulated.
const ids={host:'20000000-0000-4000-8000-000000000001',guest:'20000000-0000-4000-8000-000000000002',other:'20000000-0000-4000-8000-000000000003',admin:'20000000-0000-4000-8000-000000000004'};
const ident=s=>{assert.match(s,/^[a-z_][a-z0-9_]*$/);return `"${s}"`;};
function adapter(pg,actor){
 return {
  auth:{getUser:async()=>({data:{user:{id:actor,email:`${actor}@example.test`}}})},
  async rpc(name,args={}){try {const entries=Object.entries(args);const sql=`select to_jsonb(public.${ident(name)}(${entries.map(([k],i)=>`${ident(k)} => $${i+1}`).join(',')})) as result`;
   const rows=await asUser(pg,null,()=>pg.query(sql,entries.map(([,v])=>v)),'service_role');return {data:rows.rows[0]?.result,error:null};
  }catch(error){return {data:null,error};}},
  from(table){let patch=null,single=false;const filters=[];const q={select(){return q;},update(value){patch=value;return q;},
   maybeSingle(){single=true;return q;},single(){single=true;return q;},
   then(resolve,reject){return (async()=>{try {const values=[];let sql=patch?`update public.${ident(table)} set ${Object.entries(patch).map(([k,v])=>{values.push(typeof v==='object'&&v!==null?JSON.stringify(v):v);return `${ident(k)}=$${values.length}`;}).join(',')}`:`select * from public.${ident(table)}`;
    if(filters.length)sql+=' where '+filters.map(([k,op,v])=>{values.push(v);return `${ident(k)} ${op==='in'?'= any':op}($${values.length})`;}).join(' and ');
    if(patch)sql+=' returning *';const rows=await asUser(pg,null,()=>pg.query(sql,values),'service_role');const data=JSON.parse(JSON.stringify(rows.rows));return {data:single?(data[0]||null):data,error:null};
   }catch(error){return {data:null,error};}})().then(resolve,reject);}};
   for(const [name,op] of Object.entries({eq:'=',neq:'<>',lt:'<',gt:'>',lte:'<=',gte:'>=',in:'in'}))q[name]=(k,v)=>{filters.push([k,op,v]);return q;};return q;
  }
 };
}
function handler(name,db,stripe){const ctx={Request,Response,Headers,URL,Date,Set,Map,Error,crypto,AbortSignal,console,createClient:()=>db,Stripe:function(){return stripe;},PROMOTION_PRICING_USD:{},Deno:{env:{get:()=> 'test-only'},serve:fn=>ctx.handler=fn}};
 for(const file of ['_shared/rental-payout.ts','_shared/rental-payment-lock.ts','_shared/rental-settlement.ts',name]){
  const source=readFileSync(new URL(`../supabase/functions/${file}`,import.meta.url),'utf8').replace(/^import[\s\S]*?from ['"][^'"]+['"];?\s*$/gm,'').replace(/^export /gm,'');vm.runInNewContext(stripTypeScriptTypes(source,{mode:'transform'}),ctx);
 }return ctx;
}
const request=body=>new Request('https://test/functions',{method:'POST',headers:{authorization:'Bearer fixture',origin:'https://6ixo.com','content-type':'application/json'},body:JSON.stringify(body)});
test('connected rental lifecycle against real PostgreSQL and edge handlers',async t=>{
 const pg=await createRentalTestDatabase();t.after(()=>pg.close());
 const rpc=(who,name,args=[])=>asUser(pg,ids[who],async()=>(await pg.query(`select to_jsonb(public.${ident(name)}(${args.map((_,i)=>`$${i+1}`).join(',')})) result`,args)).rows.map(r=>r.result));
 for(const [role,id] of Object.entries(ids)){
  await pg.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())',[id,`${id}@example.test`]);
  await pg.query('insert into profiles(id,full_name,is_admin) values($1,$2,$3)',[id,role,role==='admin']);
 }
 const application=(await asUser(pg,ids.host,()=>pg.query(`insert into host_applications(user_id,email,legal_name,phone,city,country,property_type,listing_city,hosting_experience,about_host,rules_acknowledged,bedrooms,bathrooms,max_guest_capacity)
 values($1,$2,'TEST Host','123456','Toronto','Canada','apartment','Toronto','Test','Fixture',true,1,1,2) returning *`,[ids.host,`${ids.host}@example.test`]))).rows[0];
 const path=`${ids.host}/${application.id}/TEST-proof.png`;
 await pg.query("insert into storage.objects(bucket_id,name) values('host-documents',$1)",[path]);
 await asUser(pg,ids.host,()=>pg.query("insert into host_application_documents(application_id,user_id,document_type,file_name,storage_path) values($1,$2,'other','TEST-proof.png',$3)",[application.id,ids.host,path]));
 await rpc('host','mark_my_host_application_pending');
 await rpc('admin','review_host_application',[application.id,'approved','Test approval']);
 await pg.query(`insert into stripe_connected_accounts(user_id,stripe_account_id,details_submitted,payouts_enabled,metadata) values($1,'acct_fixture',true,true,'{"capabilities":{"transfers":"active"}}')`,[ids.host]);
 const makeListing=async instant=>{
  const [listing]=await rpc('host','create_short_term_listing',[{title:'TEST stay',description:'Fixture',city:'Toronto',country:'Canada',price:123.45,currency:'CAD',images:['https://example.test/fixture.png'],realestate:{listingType:'for_rent_short',priceTerm:'per_night',cleaningFee:30.25,maxGuests:2,minStayNights:2,instantBook:instant}}]);
  await rpc('admin','configure_rental_listing_finance',[listing.id,'America/Toronto','15:00',[{label:'HST',kind:'percent',rate:13,accommodation:true,cleaning:true,service:true,recipient:'platform'}],'Isolated test tax fixture']);return listing;
 };
 const listing=await makeListing(false),instant=await makeListing(true);
 const payload={guestName:'Test Guest',guests:2,checkin:'2099-03-20',checkout:'2099-03-23'};
 const intents=new Map(),refunds=new Map(),transfers=[];let serial=0;
 const stripe={accounts:{retrieve:async()=>({details_submitted:true,payouts_enabled:true,capabilities:{transfers:'active'}})},
  paymentIntents:{create:async args=>{const intent={...args,id:`pi_${++serial}`,client_secret:'fixture',status:'requires_payment_method',livemode:false};intents.set(intent.id,intent);return intent;},retrieve:async id=>{assert.ok(intents.has(id));return {...intents.get(id)};},capture:async id=>{Object.assign(intents.get(id),{status:'succeeded',amount_received:intents.get(id).amount,latest_charge:`ch_${id}`});return {...intents.get(id)};},cancel:async id=>{intents.get(id).status='canceled';return {...intents.get(id)};}},
  refunds:{create:async args=>{if(!refunds.has(args.payment_intent))refunds.set(args.payment_intent,{id:`re_${args.payment_intent}`,status:'succeeded',amount:intents.get(args.payment_intent).amount});return refunds.get(args.payment_intent);},list:async()=>({data:[]})},
  charges:{retrieve:async id=>({id,refunded:false,amount_refunded:0,disputed:false})},transfers:{list:async()=>({data:transfers}),create:async args=>{const tr={id:'tr_test',...args};transfers.push(tr);return tr;}}
 };
 const guest=handler('create-payment-intent/index.ts',adapter(pg,ids.guest),stripe);
 const host=handler('manage-booking-payment/index.ts',adapter(pg,ids.host),stripe);
 const cancel=handler('manage-booking-payment/index.ts',adapter(pg,ids.guest),stripe);
 const hook=handler('stripe-webhook/index.ts',adapter(pg,null),stripe);
 const row=async id=>(await pg.query('select * from short_term_bookings where public_id=$1',[id])).rows[0];
 const invoke=async(ctx,body)=>{const response=await ctx.handler(request(body));const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result;};
 let booking,intent;
 await t.test('search finds published stay; booking totals and taxes survive guest and host history',async()=>{
  assert.equal((await asUser(pg,null,()=>pg.query('select * from short_term_listings'),'anon')).rows.length,2);
  [booking]=await rpc('guest','create_short_term_booking',[listing.public_id,payload]);
  assert.equal(Number(booking.total),494.53);
  for(const [who,name] of [['guest','get_my_short_term_bookings'],['host','get_host_short_term_bookings']]){const bookings=await rpc(who,name);assert.equal(bookings[0].booking_public_id,booking.public_id);assert.equal(Number(bookings[0].total),494.53);}
  assert.equal((await rpc('other','get_my_short_term_bookings')).length,0);
 });
 await t.test('guest and host share one private conversation and other users cannot join',async()=>{
  const [g]=await rpc('guest','get_or_create_short_term_booking_conversation',[booking.public_id]);const [h]=await rpc('host','get_or_create_short_term_booking_conversation',[booking.public_id]);
  assert.equal(g.conversation_public_id,h.conversation_public_id);
  await assert.rejects(rpc('other','get_or_create_short_term_booking_conversation',[booking.public_id]),/Only the guest and host/);
 });
 await t.test('checkout retries reuse one intent; authorization blocks competitors until host decision',async()=>{
  const a=await invoke(guest,{placement:'short_term_booking',bookingPublicId:booking.public_id});const b=await invoke(guest,{placement:'short_term_booking',bookingPublicId:booking.public_id});assert.equal(a.id,b.id);assert.equal(intents.size,1);
  intent=intents.get(a.id);assert.equal(intent.amount,49453);assert.equal(intent.capture_method,'manual');assert.equal(intent.transfer_data,undefined);
  intent.status='requires_capture';await hook.updateShortTermBookingPaymentFromIntent({...intent});assert.equal((await row(booking.public_id)).payment_status,'authorized');
  await assert.rejects(rpc('other','create_short_term_booking',[listing.public_id,payload]),/temporarily held/);
 });
 await t.test('host accepts, repeated acceptance is safe, and stale webhook cannot undo capture',async()=>{
  await invoke(host,{bookingPublicId:booking.public_id,action:'capture'});await invoke(host,{bookingPublicId:booking.public_id,action:'capture'});
  await hook.updateShortTermBookingPaymentFromIntent({...intent,status:'requires_capture'});assert.equal((await row(booking.public_id)).payment_status,'paid');
 });
 await t.test('guest cancellation refunds exactly once and releases dates for a new guest',async()=>{
  await invoke(cancel,{bookingPublicId:booking.public_id,action:'cancel'});await invoke(cancel,{bookingPublicId:booking.public_id,action:'cancel'});
  assert.equal(refunds.size,1);assert.equal((await row(booking.public_id)).payment_status,'refunded');
  const [next]=await rpc('other','create_short_term_booking',[listing.public_id,payload]);assert.notEqual(next.public_id,booking.public_id);
 });
 await t.test('instant booking captures and host transfer is released once after the due time',async()=>{
  const [stay]=await rpc('guest','create_short_term_booking',[instant.public_id,payload]);const payment=await invoke(guest,{placement:'short_term_booking',bookingPublicId:stay.public_id});const pi=intents.get(payment.id);assert.equal(pi.capture_method,'automatic');
  await stripe.paymentIntents.capture(pi.id);await hook.updateShortTermBookingPaymentFromIntent(pi);const paid=await row(stay.public_id);
  const finance=(await pg.query('select * from rental_booking_finance where booking_id=$1',[stay.id])).rows[0];
  await guest.releaseRentalFunds(adapter(pg,null),stripe,paid,finance,0);assert.equal(transfers.length,0);
  await guest.releaseRentalFunds(adapter(pg,null),stripe,paid,finance,Date.parse(finance.payout_due_at)+1);assert.equal(transfers[0].amount,40060);
  const refreshed=(await pg.query('select * from rental_booking_finance where booking_id=$1',[stay.id])).rows[0];await guest.releaseRentalFunds(adapter(pg,null),stripe,paid,refreshed,Date.parse(finance.payout_due_at)+1);assert.equal(transfers.length,1);
 });
 await t.test('expired checkout cannot charge and late capture is refunded instead of double-booking',async()=>{
  const [stay]=await rpc('guest','create_short_term_booking',[instant.public_id,{...payload,checkin:'2099-04-20',checkout:'2099-04-23'}]);const payment=await invoke(guest,{placement:'short_term_booking',bookingPublicId:stay.public_id});
  await pg.query("update short_term_bookings set hold_expires_at=now()-interval '1 minute' where id=$1",[stay.id]);
  assert.equal((await guest.handler(request({placement:'short_term_booking',bookingPublicId:stay.public_id}))).status,409);
  await stripe.paymentIntents.capture(payment.id);await hook.updateShortTermBookingPaymentFromIntent(intents.get(payment.id));assert.equal((await row(stay.public_id)).payment_status,'refunded');
 });
});
