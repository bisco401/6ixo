import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const read=file=>readFileSync(new URL('../'+file,import.meta.url),'utf8');
function fixture({endpoint='payment-entitlement',refunded=0,disputed=false,terminal=null}={}) {
 const intent={id:'pi_test',status:'succeeded',amount:999,amount_received:999,currency:'usd',latest_charge:'ch_test',metadata:{user_id:'owner',placement:'marketplace_featured'},livemode:false};
 const charge={id:'ch_test',amount:999,amount_refunded:refunded,refunded:refunded===999,disputed,paid:true,captured:true};
 let row=terminal?{id:'entitlement',status:terminal}:null;
 const writes=[],filters=[];
 const db={auth:{getUser:async()=>({data:{user:{id:'owner'}}})},from(table){
  const query={select(){return query;},eq(key,value){filters.push([key,value]);return query;},is(){return query;},
   upsert(value){writes.push({table,value});row={id:'entitlement',...row,...value,status:['refunded','disputed'].includes(row?.status)?row.status:value.status};return query;},
   update(value){row={...row,...value};return query;},single:async()=>({data:row,error:null}),maybeSingle:async()=>({data:table==='ad_campaigns'?null:row,error:null}),then(resolve){resolve({data:row,error:null});}};
  return query;
 }};
 const stripe={charges:{retrieve:async id=>{assert.equal(id,'ch_test');return charge;}},paymentIntents:{retrieve:async()=>intent},checkout:{sessions:{retrieve:async()=>({id:'cs_test',mode:'payment',status:'complete',payment_status:'paid',metadata:{user_id:'owner'},payment_intent:intent})}}};
 const ctx={console,Request,Response,Headers,URL,Date,Set,Map,Error,crypto,TextEncoder,Uint8Array,Deno:{env:{get:()=> 'configured'},serve:handler=>ctx.handler=handler},createClient:()=>db,Stripe:function(){return stripe;}};
 for(const name of ['_shared/monetization-catalog.ts','_shared/promotion-payment-state.ts',endpoint+'/index.ts']){const src=read('supabase/functions/'+name).replace(/^import[\s\S]*?from ['"][^'"]+['"];?\s*$/gm,'').replace(/^export /gm,'');vm.runInNewContext(stripTypeScriptTypes(src,{mode:'transform'}),ctx);}
 return {ctx,intent,charge,writes,filters,getRow:()=>row};
}
const request=body=>new Request('https://test/functions',{method:'POST',headers:{authorization:'Bearer test','content-type':'application/json'},body:JSON.stringify({paymentIntentId:'pi_test',sessionId:'cs_test',...body})});
for(const [label,options,status] of [['paid',{},'paid'],['full refund',{refunded:999},'refunded'],['partial refund',{refunded:1},'refunded'],['dispute',{disputed:true},'disputed']]) {
 test(`payment verification uses the current charge for ${label}`,async()=>{const f=fixture(options);const body=await (await f.ctx.handler(request({}))).json();assert.equal(body.status,status);assert.equal(body.paid,status==='paid');});
 test(`checkout return cannot conceal ${label}`,async()=>{const f=fixture({...options,endpoint:'checkout-session-status'});const body=await (await f.ctx.handler(request({}))).json();assert.equal(body.paymentStatus,status);assert.equal(body.paid,status==='paid');});
}
test('a recorded refund stays unpaid even if a concurrent Stripe read was stale',async()=>{for(const endpoint of ['payment-entitlement','checkout-session-status']){const f=fixture({endpoint,terminal:'refunded'});const body=await (await f.ctx.handler(request({}))).json();assert.equal(body.paid,false);}});
test('refunded payments cannot be consumed and valid consumption rechecks paid status',async()=>{const f=fixture({refunded:999});assert.equal((await f.ctx.handler(request({action:'consume',resourceType:'listing',resourceId:'test'}))).status,409);const g=fixture();assert.equal((await g.ctx.handler(request({action:'consume',resourceType:'listing',resourceId:'test'}))).status,200);assert.ok(g.filters.some(([k,v])=>k==='status'&&v==='paid'));});
test('unknown charge state fails closed and provider errors do not grant entitlements',async()=>{const f=fixture();f.intent.latest_charge=null;assert.equal((await (await f.ctx.handler(request({}))).json()).paid,false);const g=fixture();g.ctx.promotionPaymentStatus=async()=>{throw Error('Provider unavailable');};const result=await g.ctx.handler(request({}));assert.equal(result.status,500);assert.equal(g.writes.length,0);});
test('a late success webhook cannot restore a refunded entitlement or campaign',async()=>{const f=fixture({endpoint:'stripe-webhook',refunded:999});f.intent.latest_charge={id:'ch_test',amount_refunded:0,paid:true,captured:true};await f.ctx.syncPaymentEntitlementFromIntent({id:'evt_old',type:'payment_intent.succeeded'},f.intent);await f.ctx.syncAdCampaignFromIntent(f.intent);assert.equal(f.getRow().status,'refunded');assert.equal(f.writes.filter(w=>w.table==='ad_campaigns').length,0);});
test('database guards preserve terminal payment state and revoke featured delivery',async t=>{
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`create table payment_entitlements(stripe_payment_intent_id text primary key,status text,paid_at timestamptz,refunded_at timestamptz);
 create table marketplace_listings(promotion_payment_intent_id text,featured boolean,featured_until timestamptz);
 create table short_term_listings(like marketplace_listings);
 create table ad_campaigns(stripe_payment_intent_id text primary key,status text);`);
 await db.exec(read('supabase/migrations/20261025061000_preserve_refunded_promotion_state.sql'));
 await db.exec(`insert into payment_entitlements values('pi_test','paid',now(),null);
 insert into marketplace_listings values('pi_test',true,now()+interval '7 days');
 insert into short_term_listings select * from marketplace_listings;
 insert into ad_campaigns values('pi_test','active');
 update payment_entitlements set status='refunded' where stripe_payment_intent_id='pi_test';
 insert into payment_entitlements values('pi_test','paid',now(),null) on conflict(stripe_payment_intent_id) do update set status=excluded.status,refunded_at=null;`);
 const p=(await db.query('select * from payment_entitlements')).rows[0];assert.equal(p.status,'refunded');assert.ok(p.refunded_at);
 for(const table of ['marketplace_listings','short_term_listings']){const row=(await db.query('select * from '+table)).rows[0];assert.equal(row.featured,false);assert.equal(row.featured_until,null);}
 await db.exec(`update ad_campaigns set status='active';`);assert.equal((await db.query('select status from ad_campaigns')).rows[0].status,'refunded');
 await db.exec(`insert into payment_entitlements values('pi_dispute','disputed',now(),null);update payment_entitlements set status='paid' where stripe_payment_intent_id='pi_dispute';insert into ad_campaigns values('pi_dispute','active');`);
 assert.equal((await db.query("select status from payment_entitlements where stripe_payment_intent_id='pi_dispute'")).rows[0].status,'disputed');assert.equal((await db.query("select status from ad_campaigns where stripe_payment_intent_id='pi_dispute'")).rows[0].status,'paused');
});
