import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {PGlite} from '@electric-sql/pglite';
import {stripTypeScriptTypes} from 'node:module';
const moduleUrl=source=>'data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(source,{mode:'transform'})).toString('base64');
const sharedUrl=moduleUrl(readFileSync(new URL('../supabase/functions/_shared/escrow.ts',import.meta.url),'utf8'));
const {ESCROW_POLICY,serviceFeeCents,moneyCents,currencyCode,assertListing,transactionPayload,transactionStatus,validateTransaction,publicOrder,checkoutUrl}=await import(sharedUrl);
const {createEscrowHandler,escrowBackend}=await import(moduleUrl(readFileSync(new URL('../supabase/functions/_shared/escrow-backend.ts',import.meta.url),'utf8').replace("'./escrow.ts'",JSON.stringify(sharedUrl))));
const ids={seller:'10000000-0000-4000-8000-000000000001',buyer:'10000000-0000-4000-8000-000000000002',other:'10000000-0000-4000-8000-000000000003'};
const requestId='20000000-0000-4000-8000-000000000001';
const emails={buyer:'buyer@example.test',seller:'seller@example.test',other:'other@example.test'};
const env={email:'marketplace@example.test',key:'sandbox-fixture-only',base:'https://api.escrow-sandbox.com/2017-09-01'};
const listing={public_id:'ml_test',user_id:ids.seller,title:'Sample camera',description:'Working camera',price:5000,currency:'CAD',category:'electronics',subcategory:null,status:'published',listing_payload:{}};
test('service fee preserves cents and applies selected minimum and cap',()=>{
 assert.equal(ESCROW_POLICY.serviceFeeBps,200);
 for(const [amount,fee] of [[1000,20],[5000,100],[25000,500],[100000,500],[1000.25,20.01]])assert.equal(serviceFeeCents(moneyCents(amount)),Math.round(fee*100));
 for(const bad of [null,'',-1,NaN,Infinity,1000.001])assert.throws(()=>moneyCents(bad));
 assert.equal(currencyCode('EUR'),'euro');assert.throws(()=>currencyCode('GHS'));
});
test('escrow excludes self purchase, rentals, auctions, low prices and unsupported currencies',()=>{
 assertListing(listing,ids.buyer);
 for(const item of [{...listing,user_id:ids.buyer},{...listing,price:999.99},{...listing,currency:'GHS'},{...listing,category:'real_estate'},
 {...listing,subcategory:'rentals'},{...listing,listing_payload:{vehicle:{category:'rentals'}}},{...listing,listing_payload:{liveAuction:{enabled:true}}},{...listing,status:'sold'}])assert.throws(()=>assertListing(item,ids.buyer));
});
test('provider payload pays saved seller and 6ixo separately, without hidden commission',()=>{
 const p=transactionPayload(listing,emails.buyer,emails.seller,'fixture');
 assert.equal(p.items[0].schedule[0].amount,5000);assert.equal(p.items[0].schedule[0].beneficiary_customer,emails.seller);
 assert.equal(p.items[1].schedule[0].amount,100);assert.equal(p.items[1].schedule[0].beneficiary_customer,'me');
 assert.equal(p.items[1].type,'broker_fee');assert.equal(p.items[1].visibility,undefined);assert.equal(p.items[0].inspection_period,259200);
 assert.ok(p.parties.some(p=>p.role==='broker' && p.customer==='me'));
});
function transaction(flags={},payment={secured:false}) {
 const p=transactionPayload(listing,emails.buyer,emails.seller,'fixture');p.id=123;
 p.parties=p.parties.map(p=>({...p,customer:p.customer==='me' ? env.email : p.customer,agreed:true}));
 p.items[0].status=flags;p.items[0].schedule[0].status=payment;
 p.items[1].schedule[0].beneficiary_customer=env.email;
 return p;
}
test('provider flags determine funding, inspection and disbursement; acceptance is not payout',()=>{
 for(const [flags,payment,status] of [[{},{},'awaiting_payment'],[{}, {payment_sent:true},'payment_pending'],[{}, {payment_received:true},'payment_review'],
 [{},{secured:true},'funded'],[{shipped:true},{secured:true},'shipped'],[{received:true},{secured:true},'inspection'],[{accepted:true},{secured:true},'accepted'],
 [{accepted:true},{disbursed_to_beneficiary:true},'paid'],[{rejected:true},{secured:true},'return_requested'],[{received_returned:true},{secured:true},'returned'],
 [{rejected_returned:true},{secured:true},'disputed'],[{},{disbursed_to_payer:true},'refunded'],[{canceled:true},{},'cancelled']])assert.equal(transactionStatus(transaction(flags,payment)),status);
 assert.throws(()=>transactionStatus({items:[]}));
});
test('provider transaction identities, amounts and commission must match',()=>{
 const order={escrow_transaction_id:'123',buyer_email:emails.buyer,seller_email:emails.seller,amount:5000,service_fee:100,currency:'cad'};
 validateTransaction(transaction(),order,env.email);
 for(const change of [p=>p.id=456,p=>p.currency='usd',p=>p.parties[1].customer=emails.other,p=>p.items[0].schedule[0].amount=4999,
 p=>p.items[1].schedule[0].amount=1,p=>p.items[1].schedule[0].beneficiary_customer=emails.other,p=>p.items[0].schedule[0].beneficiary_customer=emails.other]){const p=transaction();change(p);assert.throws(()=>validateTransaction(p,order,env.email));}
});
test('public order never leaks provider payloads, email addresses or buyer tokens to seller',()=>{
 const order={public_id:'et_1234567890123456',buyer_user_id:ids.buyer,seller_user_id:ids.seller,buyer_email:emails.buyer,
 amount:5000,service_fee:100,currency:'cad',checkout_url:'https://www.escrow-sandbox.com/pay?token=secret',response_payload:{secret:1}};
 const result=publicOrder(order,ids.seller,true);assert.equal(result.checkoutUrl,null);assert.equal(result.role,'seller');assert.ok(!JSON.stringify(result).includes('secret'));assert.ok(!JSON.stringify(result).includes(emails.buyer));
 assert.equal(publicOrder(order,ids.buyer,true).checkoutUrl,order.checkout_url);
 assert.throws(()=>checkoutUrl('https://www.escrow.com.evil.test/pay?token=abc',false));assert.throws(()=>checkoutUrl('https://www.escrow.com/pay?token=abc',true));
});
async function setupDb() {
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
 create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema public,auth to anon,authenticated,service_role;
 create table public.marketplace_listings(public_id text primary key,user_id uuid,title text,description text,price numeric,currency text,category text,subcategory text,status text,listing_payload jsonb);
 grant select,update,delete on public.marketplace_listings to authenticated;`);
 for(const id of Object.values(ids))await db.query('insert into auth.users values($1)',[id]);
 await db.query('insert into marketplace_listings values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',Object.values(listing));
 await db.exec(readFileSync(new URL('../supabase/migrations/20260531100000_create_escrow_transactions.sql',import.meta.url),'utf8').replace('create extension if not exists pgcrypto;',''));
  await db.exec(readFileSync(new URL('../supabase/migrations/20261014153000_escrow_checkout_service_fee.sql',import.meta.url),'utf8'));
  await db.exec(readFileSync(new URL('../supabase/migrations/20261014160000_escrow_checkout_retry_guard.sql',import.meta.url),'utf8'));
 return db;
}
const orderInput=(overrides={})=>({buyer_user_id:ids.buyer,seller_user_id:ids.seller,listing_public_id:listing.public_id,buyer_email:emails.buyer,seller_email:emails.seller,
 amount:listing.price,currency:'cad',listing_currency:'CAD',service_fee:100,request_id:requestId,reference:`6ixo-${requestId}`,fee_policy_version:ESCROW_POLICY.version,listing_snapshot:listing,request_payload:{},...overrides});
const reserve=async(db,input)=>(await db.query('select public.reserve_escrow_checkout($1::jsonb) as result',[JSON.stringify(input)])).rows[0].result;
test('database reservation prevents duplicate checkouts and competing buyers',async t=>{
 const db=await setupDb();t.after(()=>db.close());
 const first=await reserve(db,orderInput());assert.equal(first.isNew,true);
 const again=await reserve(db,orderInput());assert.equal(again.isNew,false);assert.equal(again.order.id,first.order.id);
 await assert.rejects(reserve(db,orderInput({buyer_user_id:ids.other,request_id:'20000000-0000-4000-8000-000000000002'})),/already has an escrow/);
 await assert.rejects(reserve(db,orderInput({amount:1})),/changed/);
 await assert.rejects(reserve(db,orderInput({seller_user_id:ids.other})),/seller/);
 assert.equal((await db.query('select count(*) as n from escrow_transactions')).rows[0].n,1);
 await db.exec("update escrow_transactions set status='cancelled'");
 assert.equal((await reserve(db,orderInput({buyer_user_id:ids.other,request_id:'20000000-0000-4000-8000-000000000002',reference:'other'}))).isNew,true);
});
test('database blocks browser record access, provider forgery and seller edits during escrow',async t=>{
 const db=await setupDb();t.after(()=>db.close());await reserve(db,orderInput());
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[ids.seller]);await db.exec('set role authenticated');
 for(const sql of ['select * from escrow_transactions',"update escrow_transactions set status='paid'","select reserve_escrow_checkout('{}')",
 "update marketplace_listings set price=1",'delete from marketplace_listings'])await assert.rejects(db.exec(sql),/permission denied|escrow transaction/);
 await db.exec('reset role');await db.exec("update escrow_transactions set status='refunded'");await db.exec('set role authenticated');
 await db.exec('update marketplace_listings set price=4000');await db.exec('reset role');
});
function fakeAdmin() {
 const orders=[];let createCalls=0;
 const admin={orders,auth:{getUser:async token=>({data:{user:token==='valid' ? {id:ids.buyer,email:emails.buyer,email_confirmed_at:'2026-01-01'} : null},error:null}),admin:{getUserById:async()=>({data:{user:{id:ids.seller,email:emails.seller,email_confirmed_at:'2026-01-01'}},error:null})}},
 from(table){let values=null,filters=[];const q={select(){return q;},eq(k,v){filters.push([k,v]);return q;},or(){return q;},order(){return q;},limit(){return q;},update(v){values=v;return q;},
 async single(){return q.maybeSingle();},async maybeSingle(){if(table==='marketplace_listings')return {data:listing,error:null};const row=orders.find(row=>filters.every(([k,v])=>row[k]===v));if(row&&values)Object.assign(row,values);return {data:row||null,error:null};},then(resolve,reject){return Promise.resolve({data:orders,error:null}).then(resolve,reject);}};return q;},
 async rpc(name,{p_order}){const old=orders.find(row=>row.request_id===p_order.request_id);if(old)return {data:{isNew:false,order:old}};const row={...p_order,id:'uuid-order',public_id:'et_1234567890123456',status:'creating'};orders.push(row);createCalls++;return {data:{isNew:true,order:row},error:null};}};
 return admin;
}
const req=body=>new Request('https://example.test/function',{method:'POST',headers:{authorization:'Bearer valid','Content-Type':'application/json',origin:'https://6ixo.com'},body:JSON.stringify(body)});
test('checkout ignores forged amounts and beneficiaries and resumes retries without creating twice',async()=>{
 const admin=fakeAdmin();let payCalls=0;let payload;
 const handler=createEscrowHandler(admin,env,async(url,options)=>{
  if(url.endsWith('/customer/me'))return Response.json({disbursement_methods:[{id:1}]});
  if(url.endsWith('/fees-summary'))return Response.json({buyer_price:5150,broker_proceeds:100});
  payCalls++;payload=JSON.parse(options.body);return Response.json({transaction_id:123,landing_page:'https://www.escrow-sandbox.com/pay?token=abc'});
 });
 let result=await handler(req({action:'quote',listingId:listing.public_id}));const {quote}=await result.json();assert.equal(quote.serviceFee,100);assert.equal(quote.providerFee,50);
 const body={action:'start',listingId:listing.public_id,requestId,quoteToken:quote.quoteToken,agreed:true,amount:1,sellerEmail:emails.other,serviceFee:0};
 result=await handler(req(body));assert.equal(result.status,200);assert.equal(payload.items[0].schedule[0].amount,5000);assert.equal(payload.items[0].schedule[0].beneficiary_customer,emails.seller);assert.equal(payload.items[1].schedule[0].amount,100);
 result=await handler(req(body));assert.equal(result.status,200);assert.equal(payCalls,1);assert.equal(admin.orders.length,1);
 const bad=await handler(req({...body,quoteToken:'forged'}));assert.equal(bad.status,409);
});
test('unknown provider outcome is retained for reconciliation and is not blindly retried',async()=>{
 const admin=fakeAdmin();let payCalls=0;
 const handler=createEscrowHandler(admin,env,async(url)=>{
  if(url.endsWith('/customer/me'))return Response.json({disbursement_methods:[{id:1}]});
  if(url.endsWith('/fees-summary'))return Response.json({buyer_price:5150,broker_proceeds:100});
  if(url.includes('/transaction/reference/'))return Response.json({}, {status:404});
  payCalls++;throw new Error('timeout');
 });
 const {quote}=await (await handler(req({action:'quote',listingId:listing.public_id}))).json();
 const body={action:'start',listingId:listing.public_id,requestId,quoteToken:quote.quoteToken,agreed:true};
 assert.equal((await handler(req(body))).status,503);assert.equal(admin.orders[0].status,'pending_review');
 assert.equal((await handler(req(body))).status,409);assert.equal(payCalls,1);
});
test('anonymous, cross-origin, stale quotes and non-participants cannot start or refresh payments',async()=>{
 const admin=fakeAdmin();const handler=createEscrowHandler(admin,env,()=>{throw new Error('Provider must not be called');});
 assert.equal((await handler(new Request('https://example.test',{method:'POST',body:'{}'}))).status,401);
 assert.equal((await handler(new Request('https://example.test',{method:'POST',headers:{origin:'https://evil.test'},body:'{}'}))).status,403);
 assert.equal((await handler(req({action:'start',listingId:listing.public_id,agreed:false}))).status,400);
 assert.equal((await handler(req({action:'refresh',orderId:'et_1234567890123456'}))).status,404);
});
test('checkout cannot collect buyer funds before the marketplace payout method exists',async()=>{
 const admin=fakeAdmin();let providerCalls=0;
 const handler=createEscrowHandler(admin,env,async url=>{
  providerCalls++;assert.ok(url.endsWith('/customer/me'));
  return Response.json({disbursement_methods:[]});
 });
 const response=await handler(req({action:'quote',listingId:listing.public_id}));
 assert.equal(response.status,503);assert.match((await response.json()).error,/payout setup/);
 assert.equal(admin.orders.length,0);assert.equal(providerCalls,1);
});
test('frontend eligibility matches backend and checkout URLs reject malicious origins',()=>{
 const source=readFileSync(new URL('../app.js',import.meta.url),'utf8');
 const context=vm.createContext({console,Date,Map,Set,Number,String,Boolean,JSON,Math,window:{addEventListener(){}},document:{addEventListener(){}},localStorage:{getItem(){return null;},setItem(){}}});
 vm.runInContext(source.slice(0,source.indexOf('\nlet app;'))+'\nglobalThis.App=DatingApp;',context);
 const instance=Object.create(context.App.prototype),item={category:'electronics',price:5000,currency:'CAD',serverBacked:true,sourceTable:'marketplace_listings',sellerUserId:ids.seller};
 assert.equal(instance.isSecureDealEligible(item),true);for(const item2 of [{...item,sourceTable:'scraped_csv'},{...item,price:999},{...item,currency:'GHS'},{...item,liveAuction:{enabled:true}},{...item,subcategory:'rentals'}])assert.equal(instance.isSecureDealEligible(item2),false);
 vm.runInContext(readFileSync(new URL('../assets/escrow-checkout.js',import.meta.url),'utf8'),context);
 assert.equal(context.window.SixoEscrow.safeUrl('https://evil.test/pay?token=x'),'');
 assert.equal(context.window.SixoEscrow.safeUrl('javascript:alert(1)'),'');
});
test('sign-out clears private escrow UI and discards an in-flight account response',async()=>{
 let authChange,resolveConfig;
 const nodes={title:{textContent:''},body:{innerHTML:''},close:{disabled:false}};
 const dialog={open:false,innerHTML:'',setAttribute(){},addEventListener(){},showModal(){this.open=true;},close(){this.open=false;},querySelector(selector){return selector==='#escrow-dialog-title' ? nodes.title : selector==='#escrow-dialog-body' ? nodes.body : nodes.close;}};
 const context=vm.createContext({console,URL,URLSearchParams,Intl,crypto:globalThis.crypto,window:{location:{search:'',href:'https://6ixo.com/'},history:{}},
 document:{activeElement:null,head:{append(){}},body:{append(){}},createElement(tag){return tag==='dialog' ? dialog : {};},querySelector(){return null;},getElementById(){return null;}}});
 vm.runInContext(readFileSync(new URL('../assets/escrow-checkout.js',import.meta.url),'utf8'),context);
 const app={currentUser:{id:ids.buyer},requireSignedIn(){return true;},supabase:{auth:{onAuthStateChange(fn){authChange=fn;}}},
 callSupabaseFunction(){return new Promise(resolve=>{resolveConfig=resolve;});}};
 context.window.SixoEscrow.attach(app);
 const pending=context.window.SixoEscrow.open(app,{id:'ml_test'});assert.equal(dialog.open,true);
 authChange('SIGNED_OUT',null);assert.equal(dialog.open,false);assert.equal(nodes.body.innerHTML,'');
 resolveConfig({connected:true,payoutReady:true});await pending;
 assert.equal(dialog.open,false);assert.equal(nodes.body.innerHTML,'');
});
