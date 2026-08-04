import Stripe from 'https://esm.sh/stripe@14.25.0?target=denonext';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8';

const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY') || '';
const STRIPE_WEBHOOK_SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET') || '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});
const supabaseAdmin = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

function toText(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function asObjectId(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return toText(value);
  if (typeof value === 'object' && value && 'id' in value) {
    return toText((value as { id?: unknown }).id);
  }
  return null;
}

function toIsoFromEpochSeconds(value: unknown): string | null {
  if (!Number.isFinite(Number(value))) return null;
  const ms = Number(value) * 1000;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function toCurrency(value: unknown): string | null {
  const text = toText(value);
  return text ? text.toUpperCase() : null;
}

function toInteger(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.trunc(parsed);
}

function buildPaymentRow(event: Stripe.Event) {
  const base = {
    stripe_event_id: toText(event.id),
    stripe_event_type: toText(event.type),
    stripe_event_created_at: toIsoFromEpochSeconds(event.created),
    stripe_session_id: null as string | null,
    stripe_payment_intent_id: null as string | null,
    stripe_customer_id: null as string | null,
    stripe_customer_email: null as string | null,
    placement: null as string | null,
    app: null as string | null,
    payment_method: null as string | null,
    amount_total_cents: null as number | null,
    currency: null as string | null,
    status: null as string | null,
    payment_status: null as string | null,
    raw_event: event as unknown as Record<string, unknown>,
  };

  if (event.type.startsWith('checkout.session.')) {
    const session = event.data.object as Stripe.Checkout.Session;
    return {
      ...base,
      stripe_session_id: toText(session.id),
      stripe_payment_intent_id: asObjectId(session.payment_intent),
      stripe_customer_id: asObjectId(session.customer),
      stripe_customer_email: toText(session.customer_details?.email),
      placement: toText(session.metadata?.placement),
      app: toText(session.metadata?.app),
      payment_method: toText(session.metadata?.payment_method),
      amount_total_cents: Number.isFinite(Number(session.amount_total)) ? Number(session.amount_total) : null,
      currency: toCurrency(session.currency),
      status: toText(session.status),
      payment_status: toText(session.payment_status),
    };
  }

  if (event.type === 'payment_intent.succeeded') {
    const intent = event.data.object as Stripe.PaymentIntent;
    return {
      ...base,
      stripe_payment_intent_id: toText(intent.id),
      stripe_customer_id: asObjectId(intent.customer),
      placement: toText(intent.metadata?.placement),
      app: toText(intent.metadata?.app),
      payment_method: toText(intent.metadata?.payment_method),
      amount_total_cents: Number.isFinite(Number(intent.amount_received))
        ? Number(intent.amount_received)
        : (Number.isFinite(Number(intent.amount)) ? Number(intent.amount) : null),
      currency: toCurrency(intent.currency),
      status: toText(intent.status),
      payment_status: intent.status === 'succeeded' ? 'paid' : toText(intent.status),
    };
  }

  return base;
}

async function persistPaymentEvent(event: Stripe.Event) {
  if (!supabaseAdmin) {
    throw new Error('Supabase admin client is not configured for webhook persistence.');
  }
  const row = buildPaymentRow(event);
  const { error } = await supabaseAdmin
    .from('promotion_payments')
    .upsert(row, { onConflict: 'stripe_event_id' });
  if (error) throw error;
}

async function persistPromoRedemptionFromPaymentIntent(event: Stripe.Event, intent: Stripe.PaymentIntent) {
  if (!supabaseAdmin) {
    throw new Error('Supabase admin client is not configured for promo redemption persistence.');
  }

  const promoCode = toText(intent.metadata?.promo_code)?.toUpperCase() || '';
  if (!promoCode) return;

  const promoCodeId = toInteger(intent.metadata?.promo_code_id);
  const amountBeforeCents = toInteger(intent.metadata?.promo_amount_before_cents)
    ?? toInteger(intent.metadata?.amount_before_cents)
    ?? toInteger(intent.amount);
  const discountCents = toInteger(intent.metadata?.promo_discount_cents)
    ?? (amountBeforeCents !== null ? Math.max(0, amountBeforeCents - Number(intent.amount_received || intent.amount || 0)) : null);
  const amountAfterCents = toInteger(intent.metadata?.promo_amount_after_cents)
    ?? toInteger(intent.metadata?.amount_after_cents)
    ?? toInteger(intent.amount_received)
    ?? toInteger(intent.amount);

  const row = {
    promo_code_id: promoCodeId,
    promo_code: promoCode,
    customer_ref: toText(intent.metadata?.customer_ref) || toText(intent.receipt_email) || asObjectId(intent.customer),
    stripe_event_id: toText(event.id),
    stripe_payment_intent_id: toText(intent.id),
    stripe_session_id: toText(intent.metadata?.stripe_session_id),
    amount_before_cents: amountBeforeCents,
    discount_cents: discountCents,
    amount_after_cents: amountAfterCents,
    currency: toCurrency(intent.currency),
    placement: toText(intent.metadata?.placement),
    status: intent.status === 'succeeded' ? 'succeeded' : toText(intent.status) || 'succeeded',
    metadata: {
      event_type: event.type,
      intent_status: intent.status,
      livemode: intent.livemode,
      intent_metadata: intent.metadata || {},
    } as Record<string, unknown>,
  };

  const { error } = await supabaseAdmin
    .from('promo_redemptions')
    .upsert(row, { onConflict: 'stripe_event_id' });

  if (error) throw error;
}

function paymentEntitlementStatus(intent: Stripe.PaymentIntent): string {
  const status = String(intent.status || '').toLowerCase();
  if (status === 'succeeded') return 'paid';
  if (status === 'processing') return 'processing';
  if (status === 'canceled') return 'cancelled';
  if (status === 'requires_payment_method') return 'failed';
  return 'pending';
}

async function syncPaymentEntitlementFromIntent(event: Stripe.Event, intent: Stripe.PaymentIntent) {
  if (!supabaseAdmin) throw new Error('Supabase admin client is not configured for entitlement persistence.');
  const userId = toText(intent.metadata?.user_id);
  const placement = toText(intent.metadata?.placement)?.toLowerCase() || '';
  if (!userId || !placement || placement.endsWith('_booking')) return;

  const status = paymentEntitlementStatus(intent);
  const { error } = await supabaseAdmin.from('payment_entitlements').upsert({
    user_id: userId,
    stripe_payment_intent_id: intent.id,
    placement,
    request_id: toText(intent.metadata?.request_id),
    amount_cents: Number(intent.amount_received || intent.amount || 0),
    currency: toCurrency(intent.currency) || 'USD',
    status,
    livemode: Boolean(intent.livemode),
    paid_at: status === 'paid' ? new Date().toISOString() : null,
    metadata: {
      stripe_event_id: event.id,
      stripe_event_type: event.type,
      stripe_status: intent.status,
      payment_method_types: intent.payment_method_types || [],
      intent_metadata: intent.metadata || {},
    },
  }, { onConflict: 'stripe_payment_intent_id' });
  if (error) throw error;
}

async function findPremiumUserId(subscription: Stripe.Subscription): Promise<string> {
  const metadataUserId = toText(subscription.metadata?.user_id);
  if (metadataUserId) return metadataUserId;
  if (!supabaseAdmin) return '';
  const customerId = asObjectId(subscription.customer);
  const { data } = await supabaseAdmin
    .from('premium_subscriptions')
    .select('user_id')
    .or(`stripe_subscription_id.eq.${subscription.id},stripe_customer_id.eq.${customerId || ''}`)
    .maybeSingle();
  return toText(data?.user_id) || '';
}

async function syncPremiumSubscription(subscription: Stripe.Subscription, checkoutSessionId = '') {
  if (!supabaseAdmin) throw new Error('Supabase admin client is not configured for subscription persistence.');
  const userId = await findPremiumUserId(subscription);
  if (!userId) throw new Error(`Unable to resolve the 6ixo user for subscription ${subscription.id}.`);
  const customerId = asObjectId(subscription.customer);
  const currentPeriodEnd = toIsoFromEpochSeconds(subscription.current_period_end);
  const { error } = await supabaseAdmin.from('premium_subscriptions').upsert({
    user_id: userId,
    stripe_customer_id: customerId,
    stripe_subscription_id: subscription.id,
    stripe_checkout_session_id: checkoutSessionId || undefined,
    plan_key: toText(subscription.metadata?.premium_plan),
    status: String(subscription.status || 'incomplete'),
    current_period_end: currentPeriodEnd,
    cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
    livemode: Boolean(subscription.livemode),
    metadata: {
      cancel_at: toIsoFromEpochSeconds(subscription.cancel_at),
      canceled_at: toIsoFromEpochSeconds(subscription.canceled_at),
      price_ids: subscription.items?.data?.map((item) => item.price?.id).filter(Boolean) || [],
    },
  }, { onConflict: 'user_id' });
  if (error) throw error;
}

async function syncConnectedAccount(account: Stripe.Account) {
  if (!supabaseAdmin) throw new Error('Supabase admin client is not configured for connected accounts.');
  let userId = toText(account.metadata?.user_id) || '';
  if (!userId) {
    const { data } = await supabaseAdmin
      .from('stripe_connected_accounts')
      .select('user_id')
      .eq('stripe_account_id', account.id)
      .maybeSingle();
    userId = toText(data?.user_id) || '';
  }
  if (!userId) return;
  const ready = Boolean(account.details_submitted && account.payouts_enabled);
  const { error } = await supabaseAdmin.from('stripe_connected_accounts').upsert({
    user_id: userId,
    stripe_account_id: account.id,
    account_type: String(account.type || 'express'),
    country: account.country || null,
    charges_enabled: Boolean(account.charges_enabled),
    payouts_enabled: Boolean(account.payouts_enabled),
    details_submitted: Boolean(account.details_submitted),
    onboarding_completed_at: ready ? new Date().toISOString() : null,
    metadata: {
      requirements_currently_due: account.requirements?.currently_due || [],
      requirements_eventually_due: account.requirements?.eventually_due || [],
      requirements_disabled_reason: account.requirements?.disabled_reason || null,
      capabilities: account.capabilities || {},
    },
  }, { onConflict: 'user_id' });
  if (error) throw error;
}

async function updateRefundOrDisputeState(paymentIntentId: string, status: 'refunded' | 'disputed', event: Stripe.Event) {
  if (!supabaseAdmin || !paymentIntentId) return;
  const patch: Record<string, unknown> = {
    status,
    metadata: {
      stripe_event_id: event.id,
      stripe_event_type: event.type,
      updated_by_webhook_at: new Date().toISOString(),
    },
  };
  if (status === 'refunded') patch.refunded_at = new Date().toISOString();
  const { error } = await supabaseAdmin
    .from('payment_entitlements')
    .update(patch)
    .eq('stripe_payment_intent_id', paymentIntentId);
  if (error) throw error;

  if (status === 'refunded') {
    for (const table of ['short_term_bookings', 'vehicle_rental_bookings']) {
      const { error: bookingError } = await supabaseAdmin
        .from(table)
        .update({
          payment_status: 'refunded',
          stripe_payment_refunded_at: new Date().toISOString(),
        })
        .eq('stripe_payment_intent_id', paymentIntentId);
      if (bookingError) throw bookingError;
    }
  }
}

async function updateShortTermBookingPaymentFromIntent(intent: Stripe.PaymentIntent) {
  if (!supabaseAdmin) {
    throw new Error('Supabase admin client is not configured for booking payment persistence.');
  }

  const bookingPublicId = toText(intent.metadata?.booking_public_id);
  const placement = toText(intent.metadata?.placement);
  if (!bookingPublicId || placement !== 'short_term_booking') return;

  const status = String(intent.status || '').toLowerCase();
  const patch: Record<string, unknown> = {
    stripe_payment_intent_id: toText(intent.id),
    stripe_payment_amount_cents: toInteger(intent.amount_received) ?? toInteger(intent.amount),
    stripe_payment_currency: toCurrency(intent.currency),
    payment_payload: {
      stripePaymentIntentId: intent.id,
      stripePaymentIntentStatus: status,
      stripeLivemode: intent.livemode,
      stripeWebhookUpdatedAt: new Date().toISOString(),
    },
  };

  if (status === 'requires_capture') {
    patch.payment_status = 'authorized';
    patch.stripe_payment_authorized_at = new Date().toISOString();
  } else if (status === 'succeeded') {
    patch.payment_status = 'paid';
    patch.stripe_payment_captured_at = new Date().toISOString();
  } else if (status === 'processing') {
    patch.payment_status = 'processing';
  } else if (status === 'canceled') {
    patch.payment_status = 'cancelled';
    patch.stripe_payment_cancelled_at = new Date().toISOString();
  } else if (status === 'requires_payment_method') {
    patch.payment_status = 'failed';
  }

  const { error } = await supabaseAdmin
    .from('short_term_bookings')
    .update(patch)
    .eq('public_id', bookingPublicId);

  if (error) throw error;
}

async function updateVehicleRentalBookingPaymentFromIntent(intent: Stripe.PaymentIntent) {
  if (!supabaseAdmin) {
    throw new Error('Supabase admin client is not configured for vehicle rental payment persistence.');
  }

  const bookingPublicId = toText(intent.metadata?.vehicle_rental_booking_public_id);
  const placement = toText(intent.metadata?.placement);
  if (!bookingPublicId || placement !== 'vehicle_rental_booking') return;

  const status = String(intent.status || '').toLowerCase();
  const patch: Record<string, unknown> = {
    stripe_payment_intent_id: toText(intent.id),
    stripe_payment_amount_cents: toInteger(intent.amount_received) ?? toInteger(intent.amount),
    stripe_payment_currency: toCurrency(intent.currency),
    payment_payload: {
      stripePaymentIntentId: intent.id,
      stripePaymentIntentStatus: status,
      stripeLivemode: intent.livemode,
      stripeWebhookUpdatedAt: new Date().toISOString(),
    },
  };

  if (status === 'requires_capture') {
    patch.payment_status = 'authorized';
    patch.stripe_payment_authorized_at = new Date().toISOString();
  } else if (status === 'succeeded') {
    patch.payment_status = 'paid';
    patch.stripe_payment_captured_at = new Date().toISOString();
  } else if (status === 'processing') {
    patch.payment_status = 'processing';
  } else if (status === 'canceled') {
    patch.payment_status = 'cancelled';
    patch.stripe_payment_cancelled_at = new Date().toISOString();
  } else if (status === 'requires_payment_method') {
    patch.payment_status = 'failed';
  }

  const { error } = await supabaseAdmin
    .from('vehicle_rental_bookings')
    .update(patch)
    .eq('public_id', bookingPublicId);

  if (error) throw error;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET) {
    return new Response('Stripe webhook not configured', { status: 500 });
  }
  if (!supabaseAdmin) {
    return new Response('Supabase admin env not configured', { status: 500 });
  }

  const signature = req.headers.get('stripe-signature') || '';
  if (!signature) {
    return new Response('Missing stripe-signature header', { status: 400 });
  }

  const body = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, signature, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid signature';
    return new Response(`Webhook Error: ${message}`, { status: 400 });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        console.log('checkout.session.completed', {
          id: session.id,
          placement: session.metadata?.placement || '',
          amount_total: session.amount_total,
          currency: session.currency,
          payment_status: session.payment_status,
        });
        if (session.mode === 'subscription') {
          const subscriptionId = asObjectId(session.subscription);
          if (subscriptionId) {
            const subscription = await stripe.subscriptions.retrieve(subscriptionId);
            await syncPremiumSubscription(subscription, session.id);
          }
        }
        break;
      }
      case 'checkout.session.expired': {
        const session = event.data.object as Stripe.Checkout.Session;
        console.log('checkout.session.expired', { id: session.id });
        break;
      }
      case 'payment_intent.succeeded': {
        const intent = event.data.object as Stripe.PaymentIntent;
        console.log('payment_intent.succeeded', {
          id: intent.id,
          amount: intent.amount,
          currency: intent.currency,
        });
        await persistPromoRedemptionFromPaymentIntent(event, intent);
        await syncPaymentEntitlementFromIntent(event, intent);
        await updateShortTermBookingPaymentFromIntent(intent);
        await updateVehicleRentalBookingPaymentFromIntent(intent);
        break;
      }
      case 'payment_intent.amount_capturable_updated':
      case 'payment_intent.payment_failed':
      case 'payment_intent.canceled':
      case 'payment_intent.processing': {
        const intent = event.data.object as Stripe.PaymentIntent;
        await syncPaymentEntitlementFromIntent(event, intent);
        await updateShortTermBookingPaymentFromIntent(intent);
        await updateVehicleRentalBookingPaymentFromIntent(intent);
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        await syncPremiumSubscription(event.data.object as Stripe.Subscription);
        break;
      }
      case 'invoice.paid':
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionId = asObjectId(invoice.subscription);
        if (subscriptionId) {
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          await syncPremiumSubscription(subscription);
        }
        break;
      }
      case 'account.updated': {
        await syncConnectedAccount(event.data.object as Stripe.Account);
        break;
      }
      case 'charge.refunded': {
        const charge = event.data.object as Stripe.Charge;
        await updateRefundOrDisputeState(asObjectId(charge.payment_intent) || '', 'refunded', event);
        break;
      }
      case 'charge.dispute.created': {
        const dispute = event.data.object as Stripe.Dispute;
        const chargeId = asObjectId(dispute.charge);
        const charge = chargeId ? await stripe.charges.retrieve(chargeId) : null;
        await updateRefundOrDisputeState(charge ? asObjectId(charge.payment_intent) || '' : '', 'disputed', event);
        break;
      }
      case 'charge.dispute.closed': {
        const dispute = event.data.object as Stripe.Dispute;
        const chargeId = asObjectId(dispute.charge);
        const charge = chargeId ? await stripe.charges.retrieve(chargeId) : null;
        const paymentIntentId = charge ? asObjectId(charge.payment_intent) || '' : '';
        if (String(dispute.status || '') === 'won' && paymentIntentId && supabaseAdmin) {
          const { error } = await supabaseAdmin
            .from('payment_entitlements')
            .update({ status: 'paid' })
            .eq('stripe_payment_intent_id', paymentIntentId);
          if (error) throw error;
        } else {
          await updateRefundOrDisputeState(paymentIntentId, 'disputed', event);
        }
        break;
      }
      default:
        break;
    }
    await persistPaymentEvent(event);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unable to persist payment event.';
    console.error('stripe-webhook persistence error', message);
    return new Response(message, { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
