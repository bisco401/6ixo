import test from 'node:test';
import assert from 'node:assert/strict';
import {createRentalTestDatabase,asUser} from './lib/rental-test-db.mjs';
const ids={host:'20000000-0000-4000-8000-000000000001',admin:'20000000-0000-4000-8000-000000000002',guest:'20000000-0000-4000-8000-000000000003',other:'20000000-0000-4000-8000-000000000004'};
test('car rental lifecycle, immutable quote, and private trip evidence',async t=>{
 const db=await createRentalTestDatabase({vehicles:true});t.after(()=>db.close());
 const as=(who,fn)=>asUser(db,ids[who],fn);
 const rpc=async(name,args=[]) => (await db.query(`select to_jsonb(public.${name}(${args.map((_,i)=>`$${i+1}`).join(',')})) result`,args)).rows[0].result;
 for(const [role,id] of Object.entries(ids)){
  await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())',[id,`${id}@example.test`]);
  await db.query('insert into profiles(id,full_name,is_admin) values($1,$2,$3)',[id,role,role==='admin']);
 }
 const application={user_id:ids.host,email:'forged@example.test',legal_name:'Test car host',phone:'123456',city:'Toronto',country:'Canada',applicant_type:'individual',rental_city:'Toronto',fleet_size:1,years_renting:0,
 owns_vehicles:true,has_rental_authorization:true,has_valid_driver_license:true,vehicles_registered:true,has_rental_insurance:true,insurance_provider:'TEST ONLY',insurance_policy_number:'TEST ONLY',vehicles_roadworthy:true,has_maintenance_plan:true,has_roadside_support:true,complies_local_laws:true,rented_before:false,rental_experience:'Test only',suspended_elsewhere:false,has_relevant_conviction:false,agrees_vehicle_safety:true,agrees_renter_verification:true,agrees_truthful_listing:true,rules_acknowledged:true,status:'pending'};
 let a,l,b;
 await t.test('application is a draft, cannot forge approval or email, and rejects missing uploaded proof',async()=>{
  const keys=Object.keys(application);a=(await as('host',()=>db.query(`insert into vehicle_host_applications(${keys.join(',')}) values(${keys.map((_,i)=>`$${i+1}`).join(',')}) returning *`,Object.values(application)))).rows[0];
  assert.equal(a.ready_for_review,false);assert.equal(a.email,`${ids.host}@example.test`);
  await assert.rejects(as('host',()=>rpc('mark_my_vehicle_host_application_pending')),/Upload/);
  await assert.rejects(as('admin',()=>rpc('review_vehicle_host_application',[a.id,'approved','Reviewed'])),/draft/);
  await assert.rejects(as('host',()=>db.query("update profiles set vehicle_host_status='approved' where id=$1",[ids.host])),/review process|permission denied/);
  const path=`${ids.host}/${a.id}/missing.png`;
  await assert.rejects(as('host',()=>db.query("insert into vehicle_host_application_documents(application_id,user_id,document_type,file_name,storage_path) values($1,$2,'vehicle_photo','missing.png',$3)",[a.id,ids.host,path])),/row-level security/);
 });
 await t.test('submission, admin notification, decline/resubmission, and approval are durable and independent of property hosting',async()=>{
  for(const kind of ['vehicle_driver_license','vehicle_registration','vehicle_rental_insurance','vehicle_photo']){
   const path=`${ids.host}/${a.id}/${kind}.png`;await db.query("insert into storage.objects(bucket_id,name) values('host-documents',$1)",[path]);
   await as('host',()=>db.query('insert into vehicle_host_application_documents(application_id,user_id,document_type,file_name,storage_path) values($1,$2,$3,$4,$5)',[a.id,ids.host,kind,`${kind}.png`,path]));
  }
  await as('host',()=>rpc('mark_my_vehicle_host_application_pending'));await as('host',()=>rpc('mark_my_vehicle_host_application_pending'));
  assert.equal((await db.query('select count(*)::int n from vehicle_notification_outbox')).rows[0].n,2);
  await assert.rejects(as('host',()=>db.query("update vehicle_host_applications set legal_name='Edited' where id=$1",[a.id])),/under review/);
  for(const status of ['needs_more_info','rejected']){
   await as('admin',()=>rpc('review_vehicle_host_application',[a.id,status,'Please clarify the test evidence']));
   await as('host',()=>db.query("update vehicle_host_applications set status='pending',rental_experience='Corrected test' where id=$1",[a.id]));
   await as('host',()=>rpc('mark_my_vehicle_host_application_pending'));
  }
  await as('admin',()=>rpc('review_vehicle_host_application',[a.id,'approved','Reviewed test evidence only']));
  const profile=(await db.query('select host_status,vehicle_host_status from profiles where id=$1',[ids.host])).rows[0];
  assert.equal(profile.vehicle_host_status,'approved');assert.notEqual(profile.host_status,'approved');
 });
 const setup={timeZone:'UTC',pickupTime:'10:00',returnTime:'10:00',taxRules:[{label:'HST test',kind:'percent',rate:13,recipient:'platform',rental:true,delivery:true,service:true}],coverageSummary:'TEST coverage description only',coverageExpiresOn:'2099-12-31',minDriverAge:23,includedDistancePerDay:200,distanceUnit:'km',excessDistanceRate:0.5,deliveryFee:25,pickupInstructions:'Meet host at agreed test pickup',returnInstructions:'Return at the agreed test location',supportContact:'Test support contact',insuranceReviewed:true,enabled:true,reviewNotes:'Test review only, not real coverage'};
 await t.test('vehicle starts as draft and requires payout onboarding plus per-vehicle insurance/tax review',async()=>{
  l=await as('host',()=>rpc('create_vehicle_rental_listing',[{title:'TEST CAR',description:'Not a real listing',city:'Toronto',country:'Canada',make:'Test',model:'Car',dailyRate:100,currency:'CAD',images:['https://example.test/car.png'],minimumTripDays:1,deliveryAvailable:true}]));
  assert.equal(l.status,'draft');
  await assert.rejects(as('host',()=>rpc('manage_my_vehicle_rental_listing',[l.public_id,'publish',{}])),/Stripe payout/);
  await db.query("insert into stripe_connected_accounts(user_id,stripe_account_id,details_submitted,payouts_enabled,metadata) values($1,'acct_test',true,true,'{\"capabilities\":{\"transfers\":\"active\"}}')",[ids.host]);
  await assert.rejects(as('host',()=>rpc('configure_vehicle_listing_finance',[l.id,setup])),/Administrator/);
  await as('admin',()=>rpc('configure_vehicle_listing_finance',[l.id,setup]));
  await as('host',()=>rpc('manage_my_vehicle_rental_listing',[l.public_id,'publish',{}]));
  assert.equal((await as('guest',()=>rpc('get_vehicle_rental_terms',[l.public_id]))).serviceFeeRate,0.1);
 });
 const start=new Date(Date.now()+30*60000),end=new Date(start.getTime()+2*86400000);
 const payload={guestName:'Test Guest',guestEmail:'forged@example.test',guestPhone:'123456',driverName:'Test Guest',driverLicenseNumber:'TEST ONLY',driverLicenseRegion:'ON',driverBirthDate:'1980-01-01',driverLicenseExpiry:'2099-12-31',pickupDate:start.toISOString().slice(0,10),returnDate:end.toISOString().slice(0,10),pickupTime:start.toISOString().slice(11,19),returnTime:end.toISOString().slice(11,19),deliveryRequested:true,total:1,dailyRate:1,serviceFee:0};
 await t.test('server owns trip pricing, 10% fee, delivery, taxes and time-zone deadlines; overlapping holds fail',async()=>{
  b=await as('guest',()=>rpc('create_vehicle_rental_booking',[l.public_id,payload]));
  assert.equal(b.daily_rate,100);assert.equal(b.trip_days,2);assert.equal(b.service_fee,20);assert.equal(b.total,276.85);
  assert.equal(b.guest_email,`${ids.guest}@example.test`);assert.equal(b.booking_payload.payoutMode,'delayed_transfer');
  assert.equal(new Date(b.booking_payload.payoutDueAt)-new Date(b.booking_payload.pickupAt),86400000);
  const f=(await db.query('select * from vehicle_booking_finance where booking_id=$1',[b.id])).rows[0];
  assert.equal(Number(f.host_amount_cents),22500);assert.equal(Number(f.tax_cents),3185);
  await assert.rejects(as('other',()=>rpc('create_vehicle_rental_booking',[l.public_id,payload])),/already booked/);
  const windows=await as('other',()=>rpc('get_vehicle_rental_booking_windows',[l.public_id]));assert.equal(windows.length,1);assert.deepEqual(Object.keys(windows[0]).sort(),['end','start']);
  await assert.rejects(as('host',()=>db.query("update vehicle_rental_bookings set payment_status='paid' where id=$1",[b.id])),/permission denied/);
  await assert.rejects(db.query('update vehicle_rental_bookings set total=1 where id=$1',[b.id]),/immutable/);
 });
 await t.test('driver evidence is private, backed by an upload, and only the host/admin can review it',async()=>{
  const path=`${ids.guest}/${b.id}/license.png`;
  const insert=()=>db.query("insert into vehicle_rental_booking_documents(booking_id,user_id,document_type,storage_path,file_name) values($1,$2,'driver_license',$3,'TEST ONLY.png')",[b.id,ids.guest,path]);
  await assert.rejects(as('guest',insert),/row-level security/);
  await as('guest',()=>db.query("insert into storage.objects(bucket_id,name,metadata) values('vehicle-trip-documents',$1,'{\"mimetype\":\"image/png\"}')",[path]));
  await as('guest',insert);
  assert.equal((await as('other',()=>db.query('select * from vehicle_rental_booking_documents'))).rows.length,0);
  assert.equal((await as('other',()=>db.query("select * from storage.objects where bucket_id='vehicle-trip-documents'"))).rows.length,0);
  await assert.rejects(as('guest',()=>rpc('review_vehicle_trip_driver',[b.public_id,'approved','Self approval forbidden'])),/Host or administrator/);
  await as('host',()=>rpc('review_vehicle_trip_driver',[b.public_id,'approved','Checked test identity and licence evidence']));
 });
 await t.test('paid transitions queue both participants and stale events cannot undo captured/refunded payments',async()=>{
  await db.query("update vehicle_rental_bookings set payment_status='authorized' where id=$1",[b.id]);
  await db.query("update vehicle_rental_bookings set status='confirmed',payment_status='paid' where id=$1",[b.id]);
  await db.query("update vehicle_rental_bookings set payment_status='failed' where id=$1",[b.id]);
  assert.equal((await db.query('select payment_status from vehicle_rental_bookings where id=$1',[b.id])).rows[0].payment_status,'paid');
  assert.equal((await db.query("select count(*)::int n from vehicle_notification_outbox where booking_id=$1 and event_type='booking_confirmed'",[b.id])).rows[0].n,2);
 });
 await t.test('pickup and return record photos, odometer and fuel; trip issues block release until admin resolution',async()=>{
  const photos=[];for(const name of ['front.png','rear.png']){const path=`${ids.host}/${b.id}/${name}`;photos.push(path);await as('host',()=>db.query("insert into storage.objects(bucket_id,name,metadata) values('vehicle-trip-documents',$1,'{\"mimetype\":\"image/png\"}')",[path]));}
  await as('host',()=>rpc('record_vehicle_trip_check',[b.public_id,'pickup',1000,90,'TEST condition',photos]));
  await assert.rejects(as('host',()=>rpc('record_vehicle_trip_check',[b.public_id,'return',900,50,'TEST return',photos])),/below the pickup/);
  await as('host',()=>rpc('record_vehicle_trip_check',[b.public_id,'return',1100,85,'TEST return condition',photos]));
  const details=await as('guest',()=>rpc('get_vehicle_trip_details',[b.public_id]));assert.ok(details.state.picked_up_at);assert.ok(details.state.returned_at);assert.equal(details.checks.length,2);
  await assert.rejects(as('other',()=>rpc('get_vehicle_trip_details',[b.public_id])),/participant/);
  const issue=await as('guest',()=>rpc('report_vehicle_trip_issue',[b.public_id,'TEST issue, no actual damage']));
  assert.equal((await db.query('select payout_status from vehicle_booking_finance where booking_id=$1',[b.id])).rows[0].payout_status,'held');
  await assert.rejects(as('host',()=>rpc('resolve_vehicle_trip_issue',[issue,'Cannot self-resolve'])),/Administrator/);
  await as('admin',()=>rpc('resolve_vehicle_trip_issue',[issue,'Test issue resolved with no extra charge']));
 });
});
