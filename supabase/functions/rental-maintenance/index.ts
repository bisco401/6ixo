import Stripe from 'https://esm.sh/stripe@14.25.0?target=denonext';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8';
import { acquireRentalPaymentLock, releaseRentalPaymentLock } from '../_shared/rental-payment-lock.ts';
import { getRentalFinance, releaseRentalFunds } from '../_shared/rental-settlement.ts';
import { deliverHostNotifications } from '../_shared/host-notifications.ts';
const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const stripe=new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!,{apiVersion:'2024-06-20',timeout:10000,maxNetworkRetries:0});
Deno.serve(async req=>{
 const secret=Deno.env.get('RENTAL_WORKER_SECRET');
 if(req.method!=='POST'||!secret||req.headers.get('authorization')!==`Bearer ${secret}`)return new Response('Unauthorized',{status:401});
 const report={notifications:0,payouts:0,errors:[] as string[]};
 try {
  const {data:jobs,error}=await db.rpc('get_rental_maintenance_bookings');if(error)throw error;
  for(const job of (jobs||[]).slice(0,1)) {
   let token=null;
   try{
    token=await acquireRentalPaymentLock(db,job.public_id,job.host_user_id);
    const {data:booking,error}=await db.from('short_term_bookings').select('*').eq('public_id',job.public_id).single();if(error)throw error;
    const finance=await getRentalFinance(db,job.public_id);
    await releaseRentalFunds(db,stripe,booking,finance);report.payouts++;
   }catch(error){
    report.errors.push(`Booking ${job.public_id}: ${error.message}`);
    const {error:saveError}=await db.from('rental_booking_finance').update({attempts:(job.finance.attempts||0)+1,last_error:String(error.message).slice(0,500),next_attempt_at:new Date(Date.now()+15*60000).toISOString()}).eq('booking_public_id',job.public_id);
    if(saveError)throw saveError;
   }finally{await releaseRentalPaymentLock(db,token);}
  }
  const {data:messages,error:mailError}=await db.from('rental_notification_outbox').select('*').is('sent_at',null).lte('next_attempt_at',new Date().toISOString()).order('next_attempt_at').limit(3);if(mailError)throw mailError;
  const seen=new Set();
  for(const message of messages||[]) {
   const group=`${message.application_id}:${message.event_type}:${message.event_version}`;if(seen.has(group))continue;seen.add(group);
   const {data:application,error}=await db.from('host_applications').select('*').eq('id',message.application_id).single();if(error)throw error;
   const currentVersion=message.event_type==='submitted'?application.submitted_at:application.reviewed_at;
   if(new Date(currentVersion).getTime()!==new Date(message.event_version).getTime() || (message.event_type==='submitted'?application.status!=='pending':application.status!==message.event_type)) {
    await db.from('rental_notification_outbox').update({sent_at:new Date().toISOString(),last_error:'Superseded by a newer application status.'}).eq('id',message.id);continue;
   }
   const result=await deliverHostNotifications({db,application,eventType:message.event_type,from:Deno.env.get('HOST_EMAIL_FROM'),apiKey:Deno.env.get('RESEND_API_KEY')});
   report.notifications+=result.results.length;
  }
  return Response.json(report);
 }catch(error){return Response.json({error:error.message,...report},{status:500});}
});
