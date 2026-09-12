import { isRentalPayoutReady } from './rental-payout.ts';

export function usesDelayedRentalTransfer(booking: any, intent?: any) {
 return booking?.booking_payload?.payoutMode === 'delayed_transfer' || intent?.metadata?.payout_mode === 'delayed_transfer';
}
export async function getRentalFinance(db: any, publicId: string) {
 const {data,error}=await db.from('rental_booking_finance').select('*').eq('booking_public_id',publicId).maybeSingle();
 if(error)throw error;if(!data)throw Error('Booking financial record is missing.');return data;
}
async function saveFinance(db:any, publicId:string, patch:any) {
 const {error}=await db.from('rental_booking_finance').update(patch).eq('booking_public_id',publicId);if(error)throw error;
}
export async function reverseRentalTransfer(db:any,stripe:any,finance:any) {
 if(!finance.stripe_transfer_id||finance.payout_status==='reversed')return;
 const transfer=await stripe.transfers.retrieve(finance.stripe_transfer_id);
 if(!transfer.reversed)await stripe.transfers.createReversal(transfer.id,{}, {idempotencyKey:`rental-reversal:${transfer.id}`});
 await saveFinance(db,finance.booking_public_id,{payout_status:'reversed',reversed_at:new Date().toISOString(),last_error:null});
}
export async function refundRentalPayment(db:any,stripe:any,booking:any,intent:any,reason:string) {
 const delayed=usesDelayedRentalTransfer(booking,intent);
 const refund=await stripe.refunds.create({payment_intent:intent.id,
  ...(delayed?{}:{reverse_transfer:true,refund_application_fee:true}),
  metadata:{app:'marketplace_2026',booking_public_id:booking.public_id,refund_reason:reason}
 },{idempotencyKey:`rental-full-refund:${intent.id}`});
 if(delayed && !['failed','canceled'].includes(refund.status)) {
  const finance=await getRentalFinance(db,booking.public_id);
  try {
   if(finance.stripe_transfer_id)await reverseRentalTransfer(db,stripe,finance);
   else await saveFinance(db,booking.public_id,{payout_status:'cancelled',last_error:null});
  } catch(error) {
   // Guest refunds do not wait for recovery of funds from a host's bank.
   await saveFinance(db,booking.public_id,{last_error:`Host funds recovery: ${error.message}`,next_attempt_at:new Date().toISOString()});
  }
 }
 return refund;
}
export async function releaseRentalFunds(db:any,stripe:any,booking:any,finance:any,now=Date.now()) {
 const closed=['cancelled','declined'].includes(booking.status)||['refunded','disputed'].includes(booking.payment_status);
 if(closed){await reverseRentalTransfer(db,stripe,finance);return;}
 if(booking.status!=='confirmed'||booking.payment_status!=='paid'||new Date(finance.payout_due_at).getTime()>now)return;
 if(['cancelled','reversed'].includes(finance.payout_status))return;
 const intent=await stripe.paymentIntents.retrieve(booking.stripe_payment_intent_id);
 if(intent.status!=='succeeded'||!usesDelayedRentalTransfer(booking,intent))throw Error('Captured platform payment is required.');
 if(intent.amount_received!==Number(finance.total_cents)||intent.currency.toUpperCase()!==finance.currency.toUpperCase())throw Error('Payment amount or currency does not match the booking.');
 const charge=await stripe.charges.retrieve(typeof intent.latest_charge==='string'?intent.latest_charge:intent.latest_charge?.id);
 if(charge.refunded||charge.amount_refunded>0||charge.disputed) {
  await reverseRentalTransfer(db,stripe,finance);
  await saveFinance(db,booking.public_id,{payout_status:finance.stripe_transfer_id?'reversed':'held',last_error:'Payment refunded or disputed. Release blocked.'});return;
 }
 const refunds=await stripe.refunds.list({charge:charge.id,limit:100});
 if(refunds.data.some((r:any)=>!['failed','canceled'].includes(r.status))) {
  await reverseRentalTransfer(db,stripe,finance);
  await saveFinance(db,booking.public_id,{payout_status:finance.stripe_transfer_id?'reversed':'held',last_error:'A refund is pending or completed. Release blocked.'});return;
 }
 const destination=String(intent.metadata?.payout_destination||'');
 if(!destination)throw Error('Host destination is missing.');
 const {data:host,error:hostError}=await db.from('stripe_connected_accounts').select('stripe_account_id').eq('user_id',booking.host_user_id).maybeSingle();
 if(hostError)throw hostError;
 if(host?.stripe_account_id!==destination)throw Error('Host payout account changed. Admin review required.');
 const account=await stripe.accounts.retrieve(destination);
 if(!isRentalPayoutReady(account))throw Error('Host payout account needs attention.');
 const group=`rental:${booking.public_id}`;
 // Recovery also works after Stripe's idempotency retention window.
 const prior=await stripe.transfers.list({transfer_group:group,limit:100});
 let transfer=prior.data.find((t:any)=>t.metadata?.booking_public_id===booking.public_id);
 if(transfer&&(transfer.destination!==destination||transfer.amount!==Number(finance.host_amount_cents)||transfer.reversed))throw Error('Existing transfer needs administrator review.');
 if(!transfer)transfer=await stripe.transfers.create({amount:Number(finance.host_amount_cents),currency:finance.currency.toLowerCase(),destination,
  source_transaction:charge.id,transfer_group:group,metadata:{booking_public_id:booking.public_id,app:'marketplace_2026'}
 },{idempotencyKey:`rental-release:${booking.public_id}`});
 await saveFinance(db,booking.public_id,{stripe_transfer_id:transfer.id,stripe_charge_id:charge.id,stripe_destination:destination,payout_status:'transferred',transferred_at:new Date().toISOString(),last_error:null});
 // A provider refund/dispute could arrive while the transfer request was in flight.
 const latest=await stripe.charges.retrieve(charge.id);
 const latestRefunds=await stripe.refunds.list({charge:charge.id,limit:100});
 const {data:current,error}=await db.from('short_term_bookings').select('status,payment_status').eq('public_id',booking.public_id).maybeSingle();
 if(error)throw error;
 if(latestRefunds.data.some((r:any)=>!['failed','canceled'].includes(r.status))||latest.refunded||latest.amount_refunded>0||latest.disputed||['cancelled','declined'].includes(current?.status)||['refunded','disputed'].includes(current?.payment_status)) {
  await reverseRentalTransfer(db,stripe,{...finance,stripe_transfer_id:transfer.id,payout_status:'transferred'});
 }
}
