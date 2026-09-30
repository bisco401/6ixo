import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {readFileSync} from 'node:fs';
const src=readFileSync(new URL('../supabase/functions/_shared/stay-notifications.ts',import.meta.url),'utf8').replace(/^export /gm,'');
function fixture(messages,booking,users={}) {
 const context={Date,Error,JSON,Intl,AbortSignal,fetch};vm.runInNewContext(stripTypeScriptTypes(src,{mode:'transform'}),context);
 const patches=[],sent=[];
 const db={auth:{admin:{getUserById:async id=>({data:{user:users[id]||{email:`verified-${id}@example.test`,email_confirmed_at:'2026-01-01'}}})}},from(table){
  const q={select(){return q;},is(){return q;},lte(){return q;},order(){return q;},limit(){return q;},eq(){return q;},update(patch){patches.push(patch);return q;},single:async()=>({data:booking}),then:r=>r({data:table==='stay_booking_notification_outbox'?messages:booking})};return q;
 }};
 return {context,db,patches,sent,send:async(_url,options)=>{sent.push(options);return {ok:true,status:200,json:async()=>({id:'provider-accepted'})};}};
}
const booking={public_id:'stb_fixture',status:'requested',payment_status:'authorized',host_user_id:'host',guest_user_id:'guest',checkin_date:'2026-10-20',checkout_date:'2026-10-23',guest_count:2,total:494.53,currency:'CAD',short_term_listings:{title:'Fixture stay'},guest_email:'forged@example.test',note:'PRIVATE GUEST NOTE'};
const message=(role,event='booking_requested')=>({id:`${role}-${event}`,booking_id:'booking',recipient_user_id:role,recipient_role:role,event_type:event,attempts:0});
test('stay request emails use verified recipients, preserve cents, and omit private guest notes',async()=>{
 const f=fixture([message('host'),message('guest')],booking);
 const result=await f.context.deliverStayNotifications({db:f.db,from:'contact@6ixo.com',apiKey:'test-not-a-key',send:f.send});
 assert.equal(result.delivered,true);assert.equal(f.sent.length,2);
 assert.equal(JSON.parse(f.sent[0].body).to[0],'verified-host@example.test');
 assert.match(JSON.parse(f.sent[0].body).text,/494\.53/);assert.match(JSON.parse(f.sent[0].body).text,/have not been captured/);
 assert.match(JSON.parse(f.sent[1].body).text,/confirmed only after/);
 assert.ok(!f.sent.some(s=>s.body.includes('forged@example.test')||s.body.includes('PRIVATE GUEST NOTE')));
 assert.ok(f.patches.every(p=>p.sent_at&&p.provider_message_id==='provider-accepted'));
});
test('superseded requests never email a guest after confirmation or cancellation',async()=>{
 const f=fixture([message('host'),message('guest')],{...booking,status:'confirmed',payment_status:'paid'});
 await f.context.deliverStayNotifications({db:f.db,from:'contact@6ixo.com',apiKey:'test-not-a-key',send:f.send});
 assert.equal(f.sent.length,0);assert.ok(f.patches.every(p=>p.skipped_at&&!p.sent_at));
});
test('failed email stays pending for retry using the same idempotency key',async()=>{
 const f=fixture([message('guest')],booking);
 const args={db:f.db,from:'contact@6ixo.com',apiKey:'test-not-a-key',send:async(url,options)=>{f.sent.push(options);return {ok:false,status:503};}};
 const r=await f.context.deliverStayNotifications(args);
 assert.equal(r.pending,1);assert.equal(f.patches[0].attempts,1);assert.ok(f.patches[0].next_attempt_at&&!f.patches[0].sent_at);
 await f.context.deliverStayNotifications({...args,send:f.send});
 assert.equal(f.sent[0].headers['Idempotency-Key'],f.sent[1].headers['Idempotency-Key']);
});
test('unverified or mismatched accounts cannot receive a booking notification',async()=>{
 const f=fixture([message('guest'),{...message('host'),recipient_user_id:'intruder'}],booking,{guest:{email:'unverified@example.test'}});
 const r=await f.context.deliverStayNotifications({db:f.db,from:'contact@6ixo.com',apiKey:'test-not-a-key',send:f.send});
 assert.equal(r.pending,2);assert.equal(f.sent.length,0);assert.ok(f.patches.every(p=>p.last_error&&!p.sent_at));
});
test('cancellation emails distinguish a pending refund from a completed refund',()=>{
 const f=fixture([],booking);
 const pending=f.context.stayNotificationCopy(message('guest','booking_cancelled'),{...booking,status:'cancelled',payment_status:'processing'});
 const refunded=f.context.stayNotificationCopy(message('guest','booking_refunded'),{...booking,status:'cancelled',payment_status:'refunded'});
 assert.match(pending.text,/being processed/);assert.match(refunded.text,/confirmed the refund/);
 assert.equal(f.context.stayNotificationIsCurrent(message('guest','booking_confirmed'),{...booking,status:'confirmed',payment_status:'unpaid'}),false);
});
test('the worker time budget leaves unsent emails available for its next run',async()=>{
 const f=fixture([message('host'),message('guest')],booking);
 await f.context.deliverStayNotifications({db:f.db,from:'contact@6ixo.com',apiKey:'test-not-a-key',send:f.send,deadlineAt:0});
 assert.equal(f.sent.length,0);assert.equal(f.patches.length,0);
});
