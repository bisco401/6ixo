// Durable car-rental notifications. Recipients come only from verified account records.
export function vehicleNotificationCopy(message: any, application: any, booking: any) {
  const event=message.event_type;
  if(application) {
    if(message.recipient_role==='admin')return {subject:'New car rental host application to review',text:`${application.legal_name} submitted a car rental application for ${application.rental_city}, ${application.country}. Open Admin → Host applications in 6ixo to review the private documents and approve, decline, or request more information.`};
    const notes=application.review_notes?` Review notes: ${application.review_notes}`:'';
    if(event==='submitted')return {subject:'Car rental application received',text:'Your application is in the admin review inbox. Check its status in your 6ixo profile.'};
    if(event==='approved')return {subject:'Car rental application approved',text:'Your car rental application is approved. Open your 6ixo profile and choose Continue Stripe setup to add your payout details. Then add your vehicle, photos, daily price, availability, mileage, and trip rules. Each vehicle needs an insurance and tax review before bookings open.'};
    return {subject:event==='rejected'?'Car rental application update':'More information needed for your car rental application',text:`Your car rental application ${event==='rejected'?'was declined':'needs more information'}.${notes} Update your application in 6ixo and resubmit.`};
  }
  const titles:Record<string,string>={booking_requested:'Car rental request received',booking_confirmed:'Car rental booking confirmed',booking_declined:'Car rental request declined',booking_cancelled:'Car rental booking cancelled',booking_refunded:'Car rental refund completed',trip_issue:'Car rental issue needs review'};
  const guidance:Record<string,string>={booking_requested:message.recipient_role==='host'?'Review the driver licence in Trip details, then approve or decline from the booking card.':'Your payment is authorized while the host reviews the request.',booking_confirmed:'Open Trip details for pickup and return instructions, driver review, condition photos, and messaging.',booking_declined:'Open the booking to check whether the authorization was released or the refund is still processing.',booking_cancelled:'Open the booking for the latest payment and refund status.',booking_refunded:'The payment provider has confirmed the refund. Your bank determines when it appears on your statement.',trip_issue:'Open Admin → Car rental operations to review the reported issue. No extra charge has been made.'};
  return {subject:titles[event]||'Car rental update',text:`${booking.listing_title} · ${booking.public_id}\nTrip: ${booking.pickup_date} to ${booking.return_date}\nPayment status: ${booking.payment_status}\n${guidance[event]||'Open your 6ixo booking for details.'}`};
}
export async function deliverVehicleNotifications({db,from,apiKey,applicationId,bookingId,send=fetch,limit=6}:any) {
 let query=db.from('vehicle_notification_outbox').select('*').is('sent_at',null).lte('next_attempt_at',new Date().toISOString()).order('next_attempt_at').limit(limit);
 if(applicationId)query=query.eq('application_id',applicationId);
 if(bookingId)query=query.eq('booking_id',bookingId);
 const {data:messages,error}=await query;if(error)throw error;
 const results=[];
 const escape=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
 for(const message of messages||[]) {
  try {
   if(!apiKey||!from||from.endsWith('@example.com'))throw Error('Car rental email delivery is not configured.');
   let application=null,booking=null;
   if(message.application_id) {
    const r=await db.from('vehicle_host_applications').select('*').eq('id',message.application_id).single();if(r.error)throw r.error;application=r.data;
    const version=message.event_type==='submitted'?application.submitted_at:application.reviewed_at;
    if(!application.ready_for_review || new Date(version).getTime()!==new Date(message.event_version).getTime() || application.status!==(message.event_type==='submitted'?'pending':message.event_type)) {
     const {error}=await db.from('vehicle_notification_outbox').update({sent_at:new Date().toISOString(),last_error:'Superseded by the current application.'}).eq('id',message.id);if(error)throw error;continue;
    }
   }else {
    const r=await db.from('vehicle_rental_bookings').select('*').eq('id',message.booking_id).single();if(r.error)throw r.error;booking=r.data;
    const valid=message.event_type==='trip_issue' || (message.event_type==='booking_requested'&&booking.status==='requested'&&booking.payment_status==='authorized')
     ||(message.event_type==='booking_confirmed'&&booking.status==='confirmed'&&booking.payment_status==='paid')
     ||(message.event_type==='booking_declined'&&booking.status==='declined')||(message.event_type==='booking_cancelled'&&booking.status==='cancelled')
     ||(message.event_type==='booking_refunded'&&booking.payment_status==='refunded');
    if(!valid){const {error}=await db.from('vehicle_notification_outbox').update({sent_at:new Date().toISOString(),last_error:'Superseded by the current booking.'}).eq('id',message.id);if(error)throw error;continue;}
   }
   const {data,error}=await db.auth.admin.getUserById(message.recipient_user_id);
   if(error||!data?.user?.email_confirmed_at||!data.user.email)throw Error('Recipient needs a verified account email.');
   const copy=vehicleNotificationCopy(message,application,booking);
   const response=await send('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json','Idempotency-Key':`vehicle-notification-${message.id}`},signal:AbortSignal.timeout(10000),
    body:JSON.stringify({from,to:[data.user.email],subject:copy.subject,text:copy.text,html:`<p>${escape(copy.text).replaceAll('\n','<br>')}</p><p><a href="https://6ixo.com/">Open 6ixo</a></p>`})});
   if(!response.ok)throw Error(`Email provider returned ${response.status}.`);
   const {error:saveError}=await db.from('vehicle_notification_outbox').update({sent_at:new Date().toISOString(),last_error:null,attempts:message.attempts+1,last_attempt_at:new Date().toISOString()}).eq('id',message.id);if(saveError)throw saveError;
   results.push({delivered:true});
  }catch(error){
   const reason=error instanceof Error?error.message:'Email delivery failed.';
   const {error:saveError}=await db.from('vehicle_notification_outbox').update({last_error:reason,attempts:message.attempts+1,last_attempt_at:new Date().toISOString(),next_attempt_at:new Date(Date.now()+Math.min(3600,60*2**Math.min(message.attempts,6))*1000).toISOString()}).eq('id',message.id);
   if(saveError)throw saveError;results.push({delivered:false,reason});
  }
 }
 return {delivered:results.length>0&&results.every(r=>r.delivered),pending:results.filter(r=>!r.delivered).length,results};
}
