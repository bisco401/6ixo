import type Stripe from 'https://esm.sh/stripe@14.25.0?target=denonext';
import { PROMOTION_TAX_CODE, promotionRequiresTax } from './monetization-catalog.ts';

export class PromotionTaxError extends Error {
  status = 400;
}

export function normalizePromotionBillingAddress(value: unknown) {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const clean = (key: string, max = 120) => String(source[key] || '').trim().slice(0, max);
  const address = {
    country: clean('country', 2).toUpperCase(),
    line1: clean('line1'),
    line2: clean('line2'),
    city: clean('city'),
    state: clean('state', 80),
    postal_code: clean('postal_code', 20),
  };
  if (!/^[A-Z]{2}$/.test(address.country) || !address.line1
    || (address.country === 'US' && !address.postal_code)
    || (address.country === 'CA' && !address.postal_code && !address.state)) {
    throw new PromotionTaxError('Enter a complete billing address to calculate tax.');
  }
  return address;
}

export async function calculatePromotionTax(
  stripe: Stripe,
  { placement, subtotalCents, billingAddress, requestKey, currency = 'usd' }: {
    placement: string; subtotalCents: number; billingAddress: unknown; requestKey: string; currency?: string;
  },
) {
  if (!promotionRequiresTax(placement)) return null;
  const address = normalizePromotionBillingAddress(billingAddress);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([currency, subtotalCents, address])));
  const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const calculation = await stripe.tax.calculations.create({
    currency,
    customer_details: { address, address_source: 'billing' },
    line_items: [{ amount: subtotalCents, reference: placement, tax_behavior: 'exclusive', tax_code: PROMOTION_TAX_CODE }],
  }, { idempotencyKey: `promotion-tax:${requestKey}:${fingerprint}` });
  const taxAmountCents = calculation.tax_amount_exclusive;
  const totalCents = calculation.amount_total;
  if (!Number.isSafeInteger(taxAmountCents) || taxAmountCents < 0
    || !Number.isSafeInteger(totalCents) || totalCents !== subtotalCents + taxAmountCents
    || calculation.currency !== currency || !calculation.id) {
    throw new Error('Unable to verify the tax total. Please try again.');
  }
  return { calculationId: calculation.id, taxAmountCents, totalCents, fingerprint };
}

export async function recordPromotionTaxTransaction(stripe: Stripe, intent: Stripe.PaymentIntent) {
  if (intent.status !== 'succeeded' || !intent.metadata?.tax_calculation_id) return null;
  // Retrieve current metadata because webhook deliveries can arrive out of order.
  const current = await stripe.paymentIntents.retrieve(intent.id);
  if (current.metadata?.tax_transaction_id) return current.metadata.tax_transaction_id;
  const transaction = await stripe.tax.transactions.createFromCalculation({
    calculation: current.metadata.tax_calculation_id,
    reference: current.id,
  }, { idempotencyKey: `promotion-tax-transaction:${current.id}` });
  await stripe.paymentIntents.update(current.id, { metadata: { tax_transaction_id: transaction.id } });
  return transaction.id;
}

export async function reversePromotionTaxRefunds(stripe: Stripe, charge: Stripe.Charge) {
  const intentId = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
  if (!intentId) return;
  const intent = await stripe.paymentIntents.retrieve(intentId);
  if (!intent.metadata?.tax_calculation_id) return; // Checkout handles its own tax records.
  const transactionId = await recordPromotionTaxTransaction(stripe, intent);
  if (!transactionId) return;
  let after: string | undefined;
  do {
    const refunds = await stripe.refunds.list({ charge: charge.id, limit: 100, ...(after ? { starting_after: after } : {}) });
    for (const refund of refunds.data) {
      if (refund.status !== 'succeeded' || refund.metadata?.tax_reversal_id) continue;
      // A flat reversal also handles a full refund without doubling earlier partial refunds.
      const reversal = await stripe.tax.transactions.createReversal({
        mode: 'partial', original_transaction: transactionId, reference: refund.id,
        flat_amount: -refund.amount, metadata: { refund_id: refund.id },
      }, { idempotencyKey: `promotion-tax-refund:${refund.id}` });
      await stripe.refunds.update(refund.id, { metadata: { tax_reversal_id: reversal.id } });
    }
    after = refunds.has_more ? refunds.data.at(-1)?.id : undefined;
  } while (after);
}
