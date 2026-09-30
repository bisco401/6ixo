// Payment-state changes commit notification jobs with the booking. The worker
// retries transient provider failures using a stable idempotency key.
export function stayNotificationIsCurrent(message: any, booking: any) {
 const event=message.event_type;
 return (event==='booking_requested'&&booking.status==='requested'&&booking.payment_status==='authorized')
  ||(event==='booking_confirmed'&&booking.status==='confirmed'&&booking.payment_status==='paid')
  ||(event==='booking_declined'&&booking.status==='declined'&&booking.payment_status!=='refunded')
  ||(event==='booking_cancelled'&&booking.status==='cancelled'&&booking.payment_status!=='refunded')
  ||(event==='booking_refunded'&&booking.payment_status==='refunded')
  ||(event==='payment_disputed'&&booking.payment_status==='disputed');
}
export function stayNotificationCopy(message: any, booking: any) {
 const host=message.recipient_role==='host';
 const titles:Record<string,string>={booking_requested:host?'New stay booking request':'Your stay request was received',booking_confirmed:'Your stay booking is confirmed',booking_declined:'Stay booking request declined',booking_cancelled:'Stay booking cancelled',booking_refunded:'Stay refund completed',payment_disputed:'Stay payment dispute update'};
 const guidance:Record<string,string>={
  booking_requested:host?'Open your 6ixo profile → Host bookings to accept or decline. The guest’s card is authorized; funds have not been captured.':'Your card is authorized while the host reviews your request. The stay is confirmed only after the host accepts and payment succeeds.',
  booking_confirmed:host?'The guest’s payment succeeded. Open Host bookings to view the stay and message your guest. Your payout becomes eligible 24 hours after local check-in.':'Payment succeeded. Open your 6ixo profile → My bookings to view the stay, its cancellation deadline, and message your host.',
  booking_declined:'The host declined this request. Any authorization is released; check your booking for the current payment status.',
  booking_cancelled:booking.payment_status==='processing'?'The stay is cancelled and a refund is being processed. We will email again when the payment provider confirms the refund.':'The stay is cancelled. Open your booking for the current payment status.',
  booking_refunded:'The payment provider has confirmed the refund. Your bank determines when it appears on your statement.',
  payment_disputed:'The payment is disputed and host funds are on hold. Open the booking for details and contact 6ixo support.',
 };
 const currency=String(booking.currency||'CAD').toUpperCase();
 const total=new Intl.NumberFormat('en-CA',{style:'currency',currency}).format(Number(booking.total));
 return {subject:titles[message.event_type]||'Stay booking update',text:`${booking.listing_title} · ${booking.public_id}\nStay: ${booking.checkin_date} to ${booking.checkout_date}\nGuests: ${booking.guest_count}\nBooking total: ${total}\nPayment status: ${booking.payment_status}\n${guidance[message.event_type]||'Open your 6ixo booking for details.'}`};
}
export async function deliverStayNotifications({db,from,apiKey,send=fetch,limit=4,deadlineAt=Infinity}:any) {
 const {data:messages,error}=await db.from('stay_booking_notification_outbox').select('*').is('sent_at',null).is('skipped_at',null)
  .lte('next_attempt_at',new Date().toISOString()).order('next_attempt_at').limit(limit);
 if(error)throw error;
 const results=[];
 const escape=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
 for(const message of messages||[]) {
  if(Date.now()>=deadlineAt)break;
  try {
   const r=await db.from('short_term_bookings').select('*,short_term_listings(title)').eq('id',message.booking_id).single();
   if(r.error)throw r.error;
   const booking={...r.data,listing_title:r.data.short_term_listings?.title||'Your stay'};
   if(!stayNotificationIsCurrent(message,booking)) {
    const {error}=await db.from('stay_booking_notification_outbox').update({skipped_at:new Date().toISOString(),last_error:'Superseded by the current booking.'}).eq('id',message.id);if(error)throw error;continue;
   }
   const expectedUser=message.recipient_role==='host'?booking.host_user_id:booking.guest_user_id;
   if(expectedUser!==message.recipient_user_id)throw Error('Notification recipient does not match the booking.');
   if(!apiKey||!from||from.endsWith('@example.com'))throw Error('Stay email delivery is not configured.');
   const {data,error:userError}=await db.auth.admin.getUserById(message.recipient_user_id);
   if(userError||!data?.user?.email_confirmed_at||!data.user.email)throw Error('Recipient needs a verified account email.');
   const copy=stayNotificationCopy(message,booking);
   const response=await send('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json','Idempotency-Key':`stay-notification-${message.id}`},signal:AbortSignal.timeout(10000),
    body:JSON.stringify({from,to:[data.user.email],subject:copy.subject,text:copy.text,html:`<p>${escape(copy.text).replaceAll('\n','<br>')}</p><p><a href="https://6ixo.com/?open=profile">Open your 6ixo bookings</a></p>`})});
   if(!response.ok)throw Error(`Email provider returned ${response.status}.`);
   const provider=await response.json();
   if(!provider.id)throw Error('Email provider did not confirm message acceptance.');
   const {error:saveError}=await db.from('stay_booking_notification_outbox').update({sent_at:new Date().toISOString(),provider_message_id:provider.id,last_error:null,attempts:message.attempts+1,last_attempt_at:new Date().toISOString()}).eq('id',message.id);if(saveError)throw saveError;
   results.push({delivered:true});
  }catch(error){
   const reason=error instanceof Error?error.message:'Email delivery failed.';
   const {error:saveError}=await db.from('stay_booking_notification_outbox').update({last_error:reason,attempts:message.attempts+1,last_attempt_at:new Date().toISOString(),next_attempt_at:new Date(Date.now()+Math.min(3600,60*2**Math.min(message.attempts,6))*1000).toISOString()}).eq('id',message.id);
   if(saveError)throw saveError;results.push({delivered:false,reason});
  }
 }
 return {delivered:results.length>0&&results.every(r=>r.delivered),pending:results.filter(r=>!r.delivered).length,results};
}
