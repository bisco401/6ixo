import type Stripe from 'https://esm.sh/stripe@14.25.0?target=denonext';

// A succeeded PaymentIntent stays succeeded after a refund. The current charge
// is authoritative, including when an older success webhook arrives late.
export async function promotionPaymentStatus(stripe: Stripe, intent: Stripe.PaymentIntent): Promise<string> {
  if (intent.status === 'processing') return 'processing';
  if (intent.status === 'canceled') return 'cancelled';
  if (intent.status === 'requires_payment_method') return 'failed';
  if (intent.status !== 'succeeded') return 'pending';
  const chargeId = typeof intent.latest_charge === 'string' ? intent.latest_charge : intent.latest_charge?.id;
  if (!chargeId) return 'pending';
  const charge = await stripe.charges.retrieve(chargeId);
  if (charge.refunded || charge.amount_refunded > 0) return 'refunded';
  if (charge.disputed) return 'disputed';
  return charge.paid && charge.captured ? 'paid' : 'pending';
}
