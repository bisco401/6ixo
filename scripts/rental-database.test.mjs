import test from 'node:test';
import assert from 'node:assert/strict';
import { createRentalTestDatabase, asUser } from './lib/rental-test-db.mjs';

const ids = { host:'10000000-0000-4000-8000-000000000001', admin:'10000000-0000-4000-8000-000000000002', guest:'10000000-0000-4000-8000-000000000003', other:'10000000-0000-4000-8000-000000000004' };
let db, application, listing, booking;
const user = (who, fn, role) => asUser(db, ids[who], fn, role);
const rpc = async (name, args = []) => (await db.query(`select to_jsonb(public.${name}(${args.map((_,i)=>`$${i+1}`).join(',')})) as result`,args)).rows[0].result;

test('rental database lifecycle and permission boundaries', async t => {
  db = await createRentalTestDatabase();
  t.after(() => db.close());
  for (const [role,id] of Object.entries(ids)) {
    await db.query('insert into auth.users(id,email,email_confirmed_at) values ($1,$2,now())',[id,`${id}@example.test`]);
    await db.query('insert into public.profiles(id,full_name,is_admin) values ($1,$2,$3)',[id,role,role==='admin']);
  }
  await t.test('draft cannot self-approve or reach admin notification queue', async () => {
    application = await user('host', async () => (await db.query(`insert into public.host_applications
      (user_id,email,legal_name,phone,city,country,property_type,listing_city,hosting_experience,about_host,rules_acknowledged,bedrooms,bathrooms,max_guest_capacity,status)
      values ($1,'forged@example.test','Test Host','123456','Toronto','Canada','apartment','Toronto','Ready to host','Clean space',true,1,1,2,'approved') returning *`,[ids.host])).rows[0]);
    assert.equal(application.status,'pending'); assert.equal(application.ready_for_review,false);
    assert.equal(application.email,`${ids.host}@example.test`);
    assert.equal((await db.query('select count(*)::int as n from rental_notification_outbox')).rows[0].n,0);
    await assert.rejects(user('host',()=>rpc('review_host_application',[application.id,'approved',null])), /Administrator/);
    await assert.rejects(user('admin',()=>rpc('review_host_application',[application.id,'approved',null])), /submitted application/);
    await assert.rejects(user('host',()=>rpc('mark_my_host_application_pending')), /Upload/);
  });
  await t.test('proof must belong to the applicant and be backed by an uploaded object', async () => {
    const path=`${ids.host}/${application.id}/proof.jpg`;
    const insert=()=>db.query(`insert into host_application_documents(application_id,user_id,document_type,file_name,storage_path) values ($1,$2,'government_id','proof.jpg',$3)`,[application.id,ids.host,path]);
    await assert.rejects(user('host',insert), /row-level security/);
    await db.query("insert into storage.objects(bucket_id,name) values ('host-documents',$1)",[path]);
    await assert.rejects(user('other',insert), /row-level security/);
    await user('host',insert);
    await user('host',()=>rpc('mark_my_host_application_pending'));
    assert.equal((await db.query('select host_status from profiles where id=$1',[ids.host])).rows[0].host_status,'pending');
    const messages=(await db.query('select recipient_role,event_type from rental_notification_outbox')).rows;
    assert.equal(messages.length,2); assert.deepEqual(messages.map(m=>m.recipient_role).sort(),['admin','host']);
    await user('host',()=>rpc('mark_my_host_application_pending'));
    assert.equal((await db.query('select count(*)::int as n from rental_notification_outbox')).rows[0].n,2);
    await assert.rejects(user('host',()=>db.query("update host_applications set legal_name='Changed' where id=$1",[application.id])), /under review/);
  });
  await t.test('decline, correction, resubmit, approval update both application and profile', async () => {
    await user('admin',()=>rpc('review_host_application',[application.id,'needs_more_info','Please clarify hosting experience']));
    assert.equal((await db.query('select host_status from profiles where id=$1',[ids.host])).rows[0].host_status,'needs_more_info');
    await user('host',()=>db.query("update host_applications set hosting_experience='Experience clarified', status='pending' where id=$1",[application.id]));
    await user('host',()=>rpc('mark_my_host_application_pending'));
    await user('admin',()=>rpc('review_host_application',[application.id,'rejected','Property details need revision']));
    assert.equal((await db.query('select host_status from profiles where id=$1',[ids.host])).rows[0].host_status,'rejected');
    await user('host',()=>db.query("update host_applications set about_host='Revised details', status='pending' where id=$1",[application.id]));
    await user('host',()=>rpc('mark_my_host_application_pending'));
    await user('admin',()=>rpc('review_host_application',[application.id,'approved','Approved']));
    assert.equal((await db.query('select host_status from profiles where id=$1',[ids.host])).rows[0].host_status,'approved');
    await assert.rejects(user('admin',()=>rpc('review_host_application',[application.id,'rejected',null])), /already been reviewed/);
  });
  const payload={title:'Test stay',description:'A clean apartment',city:'Toronto',country:'Canada',price:123.45,currency:'CAD',images:['https://example.test/photo.jpg'],realestate:{listingType:'for_rent_short',priceTerm:'per_night',maxGuests:2,minStayNights:2,cleaningFee:30.25,instantBook:false}};
  await t.test('publishing requires host approval, persistent photos, positive price and active transfers', async () => {
    await assert.rejects(user('guest',()=>rpc('create_short_term_listing',[payload])), /Host approval/);
    await assert.rejects(user('host',()=>rpc('create_short_term_listing',[payload])), /payout/);
    await db.query(`insert into stripe_connected_accounts(user_id,stripe_account_id,details_submitted,payouts_enabled,metadata) values ($1,'acct_test',true,true,'{"capabilities":{"transfers":"pending"}}')`,[ids.host]);
    await assert.rejects(user('host',()=>rpc('create_short_term_listing',[payload])), /payout/);
    await db.query(`update stripe_connected_accounts set metadata='{"capabilities":{"transfers":"active"}}' where user_id=$1`,[ids.host]);
    await assert.rejects(user('host',()=>rpc('create_short_term_listing',[{...payload,images:['blob:temporary']}])), /HTTPS photo/);
    await assert.rejects(user('host',()=>rpc('create_short_term_listing',[{...payload,price:0}])), /greater than zero/);
    listing=await user('host',()=>rpc('create_short_term_listing',[payload]));
    assert.equal(Number(listing.price), 123.45);
    await user('admin',()=>rpc('configure_rental_listing_finance',[listing.id,'America/Toronto','15:00',[],'Test property reviewed, no tax in this fixture']));
    const publicRows=await asUser(db,null,()=>db.query('select * from short_term_listings'),'anon');
    assert.equal(publicRows.rows.length,1);
  });
  const stay={guestName:'Guest',guests:2,checkin:'2099-01-10',checkout:'2099-01-13',total:1,serviceFee:0,guestEmail:'forged@example.test'};
  await t.test('booking uses server prices and identity; rejects anonymous, own, invalid and overlapping dates', async () => {
    await assert.rejects(asUser(db,null,()=>rpc('create_short_term_booking',[listing.public_id,stay]),'anon'), /permission denied/);
    await assert.rejects(user('host',()=>rpc('create_short_term_booking',[listing.public_id,stay])), /own stay/);
    await assert.rejects(user('guest',()=>rpc('create_short_term_booking',[listing.public_id,{...stay,guests:3}])), /up to 2/);
    await assert.rejects(user('guest',()=>rpc('create_short_term_booking',[listing.public_id,{...stay,checkout:'2099-01-11'}])), /at least 2/);
    await assert.rejects(user('guest',()=>rpc('create_short_term_booking',[listing.public_id,{...stay,checkin:'2020-01-01',checkout:'2020-01-03'}])), /past/);
    booking=await user('guest',()=>rpc('create_short_term_booking',[listing.public_id,stay]));
    assert.equal(Number(booking.service_fee),37.04); assert.equal(Number(booking.total),437.64);
    assert.equal(booking.guest_email,`${ids.guest}@example.test`);
    await assert.rejects(user('other',()=>rpc('create_short_term_booking',[listing.public_id,stay])), /temporarily held/);
    const otherRows=await user('other',()=>db.query('select * from short_term_bookings'));
    assert.equal(otherRows.rows.length,0);
  });
  await t.test('expired holds release dates and host blocks are enforced', async () => {
    await db.query("update short_term_bookings set hold_expires_at=now()-interval '1 minute' where id=$1",[booking.id]);
    const replacement=await user('other',()=>rpc('create_short_term_booking',[listing.public_id,stay]));
    assert.notEqual(replacement.id,booking.id);
    await user('host',()=>rpc('manage_my_rental_listing',['short_term',listing.public_id,'update_availability',{availabilityStart:'2099-01-01',availabilityEnd:'2099-12-31',blockedDates:[{start:'2099-02-10',end:'2099-02-15'}]}]));
    await assert.rejects(user('guest',()=>rpc('create_short_term_booking',[listing.public_id,{...stay,checkin:'2099-02-11',checkout:'2099-02-13'}])), /blocked/);
    await assert.rejects(user('guest',()=>rpc('manage_my_rental_listing',['short_term',listing.public_id,'pause',{}])), /not found/);
    await user('host',()=>rpc('manage_my_rental_listing',['short_term',listing.public_id,'pause',{}]));
    assert.equal((await asUser(db,null,()=>db.query('select * from short_term_listings'),'anon')).rows.length,0);
    await user('host',()=>rpc('manage_my_rental_listing',['short_term',listing.public_id,'publish',{}]));
  });
  await t.test('payment action locks cannot be called by browsers and serialize conflicting actions', async () => {
    await assert.rejects(user('guest',()=>rpc('claim_short_term_payment_action',[booking.public_id,ids.guest])), /permission denied/);
    const token=await asUser(db,null,()=>rpc('claim_short_term_payment_action',[booking.public_id,ids.guest]),'service_role');
    await assert.rejects(asUser(db,null,()=>rpc('claim_short_term_payment_action',[booking.public_id,ids.host]),'service_role'),/in progress/);
    await asUser(db,null,()=>rpc('release_short_term_payment_action',[token]),'service_role');
    assert.ok(await asUser(db,null,()=>rpc('claim_short_term_payment_action',[booking.public_id,ids.host]),'service_role'));
  });
  await t.test('late payment events cannot downgrade capture or refund; audit metadata is retained', async () => {
    await db.query(`update short_term_bookings set stripe_payment_intent_id='pi_test',payment_status='paid',payment_payload='{"capturedBy":"host"}' where id=$1`,[booking.id]);
    await db.query(`update short_term_bookings set payment_status='authorized',payment_payload='{}' where id=$1`,[booking.id]);
    assert.equal((await db.query('select payment_status from short_term_bookings where id=$1',[booking.id])).rows[0].payment_status,'paid');
    await db.query(`update short_term_bookings set payment_status='refunded',payment_payload='{"refundId":"re_test"}' where id=$1`,[booking.id]);
    await db.query(`update short_term_bookings set payment_status='paid' where id=$1`,[booking.id]);
    const row=(await db.query('select payment_status,payment_payload from short_term_bookings where id=$1',[booking.id])).rows[0];
    assert.equal(row.payment_status,'refunded'); assert.equal(row.payment_payload.capturedBy,'host');assert.equal(row.payment_payload.refundId,'re_test');
  });
  await t.test('property tax setup is admin-only and snapshots taxes, host share, local time, and cancellation rules',async()=>{
    const rules=[{label:'HST',kind:'percent',rate:13,accommodation:true,cleaning:true,service:true,recipient:'platform'}];
    await assert.rejects(user('host',()=>rpc('configure_rental_listing_finance',[listing.id,'America/Toronto','15:00',rules,'Verified registration and Ontario tax treatment'])),/Administrator/);
    await user('admin',()=>rpc('configure_rental_listing_finance',[listing.id,'America/Toronto','15:00',rules,'Verified registration and Ontario tax treatment']));
    const taxed=await user('guest',()=>rpc('create_short_term_booking',[listing.public_id,{...stay,checkin:'2099-03-20',checkout:'2099-03-23'}]));
    assert.equal(Number(taxed.total),494.53);assert.equal(taxed.booking_payload.taxAmountCents,5689);assert.equal(taxed.booking_payload.hostAmountCents,40060);
    const f=(await db.query('select * from rental_booking_finance where booking_id=$1',[taxed.id])).rows[0];
    assert.equal(Number(f.total_cents),49453);assert.equal(Number(f.service_fee_cents),3704);
    assert.equal(new Date(f.payout_due_at)-new Date(f.checkin_at),86400000);assert.equal(new Date(f.checkin_at)-new Date(f.cancellation_deadline),86400000);
    assert.equal(new Intl.DateTimeFormat('en-CA',{timeZone:'America/Toronto',hour:'2-digit',hourCycle:'h23'}).format(new Date(f.checkin_at)),'15');
    await assert.rejects(db.query('update short_term_bookings set total=1 where id=$1',[taxed.id]),/immutable/);
    const admin=await user('admin',()=>rpc('get_rental_finance_admin'));assert.ok(admin.listings.some(l=>l.id===listing.id));
    await assert.rejects(user('guest',()=>rpc('get_rental_maintenance_bookings')),/permission denied/);
    await db.query("update short_term_bookings set payment_status='paid',status='confirmed' where id=$1",[taxed.id]);
    await db.query(`update short_term_bookings set payment_status='processing',status='cancelled',payment_payload='{"stripeRefundId":"re_pending"}' where id=$1`,[taxed.id]);
    const pending=(await db.query('select status,payment_status from short_term_bookings where id=$1',[taxed.id])).rows[0];assert.equal(pending.status,'cancelled');assert.equal(pending.payment_status,'processing');
  });

});
