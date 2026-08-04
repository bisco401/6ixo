import Stripe from 'https://esm.sh/stripe@14.25.0?target=denonext';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8';

const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY') || '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
const supabaseAdmin = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

const ALLOWED_ORIGINS = new Set([
  'https://6ixo.com',
  'https://www.6ixo.com',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
]);

class RequestError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
  }
}

function normalizeText(value: unknown, max = 160): string {
  return String(value || '').trim().slice(0, max);
}

function corsHeaders(origin: string | null): HeadersInit {
  const allowedOrigin = origin && ALLOWED_ORIGINS.has(origin) ? origin : 'https://6ixo.com';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
    'Vary': 'Origin',
  };
}

async function getAuthenticatedUser(req: Request) {
  if (!supabaseAdmin) throw new RequestError(500, 'Payment verification is not configured.');
  const token = String(req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) throw new RequestError(401, 'Log in to verify this payment.');
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user?.id) throw new RequestError(401, 'Unable to validate your payment session.');
  return data.user;
}

function entitlementStatus(intent: Stripe.PaymentIntent): string {
  const value = String(intent.status || '').toLowerCase();
  if (value === 'succeeded') return 'paid';
  if (value === 'processing') return 'processing';
  if (value === 'canceled') return 'cancelled';
  if (value === 'requires_payment_method') return 'failed';
  return 'pending';
}

async function syncEntitlement(intent: Stripe.PaymentIntent, userId: string) {
  if (!supabaseAdmin) throw new RequestError(500, 'Payment verification is not configured.');
  const metadataUserId = normalizeText(intent.metadata?.user_id, 80);
  const placement = normalizeText(intent.metadata?.placement, 80).toLowerCase();
  if (!metadataUserId || metadataUserId !== userId) {
    throw new RequestError(403, 'This payment belongs to a different account.');
  }
  if (!placement || placement.endsWith('_booking')) {
    throw new RequestError(400, 'This payment is not a promotion entitlement.');
  }

  const nextStatus = entitlementStatus(intent);
  const row = {
    user_id: userId,
    stripe_payment_intent_id: intent.id,
    placement,
    request_id: normalizeText(intent.metadata?.request_id, 120) || null,
    amount_cents: Number(intent.amount_received || intent.amount || 0),
    currency: String(intent.currency || 'usd').toUpperCase(),
    status: nextStatus,
    livemode: Boolean(intent.livemode),
    paid_at: nextStatus === 'paid' ? new Date().toISOString() : null,
    metadata: {
      stripe_status: intent.status,
      payment_method_types: intent.payment_method_types || [],
      intent_metadata: intent.metadata || {},
    },
  };

  const { data, error } = await supabaseAdmin
    .from('payment_entitlements')
    .upsert(row, { onConflict: 'stripe_payment_intent_id' })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function consumeEntitlement(
  entitlement: Record<string, unknown>,
  resourceType: string,
  resourceId: string,
) {
  if (!supabaseAdmin) throw new RequestError(500, 'Payment verification is not configured.');
  if (String(entitlement.status || '') !== 'paid') {
    throw new RequestError(409, 'Payment has not completed.');
  }

  const existingConsumedAt = normalizeText(entitlement.consumed_at, 80);
  const existingType = normalizeText(entitlement.resource_type, 80);
  const existingId = normalizeText(entitlement.resource_id, 160);
  if (existingConsumedAt) {
    if (existingType === resourceType && existingId === resourceId) return entitlement;
    throw new RequestError(409, 'This payment has already been used.');
  }

  const { data, error } = await supabaseAdmin
    .from('payment_entitlements')
    .update({
      resource_type: resourceType,
      resource_id: resourceId,
      consumed_at: new Date().toISOString(),
    })
    .eq('id', entitlement.id)
    .is('consumed_at', null)
    .select('*')
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new RequestError(409, 'This payment has already been used.');
  return data;
}

async function refundUnconsumedEntitlement(intent: Stripe.PaymentIntent, userId: string) {
  if (!supabaseAdmin) throw new RequestError(500, 'Payment refunds are not configured.');
  const { data: entitlement, error } = await supabaseAdmin
    .from('payment_entitlements')
    .select('*')
    .eq('stripe_payment_intent_id', intent.id)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  if (!entitlement) throw new RequestError(404, 'Payment entitlement not found.');
  if (entitlement.consumed_at) throw new RequestError(409, 'A used promotion cannot be automatically refunded.');

  let refundId = '';
  let finalStatus = String(intent.status || '').toLowerCase();
  if (intent.status === 'succeeded') {
    const refund = await stripe.refunds.create({
      payment_intent: intent.id,
      reason: 'requested_by_customer',
      metadata: {
        app: 'marketplace_2026',
        user_id: userId,
        purpose: 'unfulfilled_promotion',
      },
    }, {
      idempotencyKey: `promotion-refund:${intent.id}`,
    });
    refundId = refund.id;
    finalStatus = String(refund.status || 'pending');
  } else if (['requires_payment_method', 'requires_confirmation', 'requires_action', 'requires_capture'].includes(intent.status)) {
    const cancelled = await stripe.paymentIntents.cancel(intent.id, {
      cancellation_reason: 'requested_by_customer',
    });
    finalStatus = String(cancelled.status || 'canceled');
  } else {
    throw new RequestError(409, `Payment is ${intent.status}; an automatic refund is not available yet.`);
  }

  const { error: updateError } = await supabaseAdmin
    .from('payment_entitlements')
    .update({
      status: 'refunded',
      refunded_at: new Date().toISOString(),
      metadata: {
        ...(entitlement.metadata || {}),
        stripe_refund_id: refundId || null,
        stripe_refund_status: finalStatus,
      },
    })
    .eq('id', entitlement.id);
  if (updateError) throw updateError;
  return { refundId: refundId || null, refundStatus: finalStatus };
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  const headers = corsHeaders(origin);

  if (req.method === 'OPTIONS') return new Response('ok', { headers });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed.' }), { status: 405, headers });
  }
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed.' }), { status: 403, headers });
  }
  if (!STRIPE_SECRET_KEY || !supabaseAdmin) {
    return new Response(JSON.stringify({ error: 'Payment verification is not configured.' }), { status: 500, headers });
  }

  try {
    const user = await getAuthenticatedUser(req);
    const payload = await req.json().catch(() => ({}));
    const action = normalizeText(payload.action || 'verify', 20).toLowerCase();
    const paymentIntentId = normalizeText(payload.paymentIntentId || payload.payment_intent_id, 120);
    if (!paymentIntentId.startsWith('pi_')) throw new RequestError(400, 'A valid paymentIntentId is required.');

    const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
    const entitlement = await syncEntitlement(intent, user.id);
    const requestedPlacement = normalizeText(payload.placement, 80).toLowerCase();
    if (requestedPlacement && requestedPlacement !== String(entitlement.placement || '')) {
      throw new RequestError(403, 'Payment placement does not match.');
    }

    if (action === 'refund') {
      const refund = await refundUnconsumedEntitlement(intent, user.id);
      return new Response(JSON.stringify({ ok: true, paid: false, status: 'refunded', ...refund }), { status: 200, headers });
    }

    let finalEntitlement = entitlement;
    if (action === 'consume' || payload.consume === true) {
      const resourceType = normalizeText(payload.resourceType || payload.resource_type || entitlement.placement, 80).toLowerCase();
      const resourceId = normalizeText(payload.resourceId || payload.resource_id || entitlement.request_id || intent.id, 160);
      if (!resourceType || !resourceId) throw new RequestError(400, 'Resource type and id are required.');
      finalEntitlement = await consumeEntitlement(entitlement, resourceType, resourceId);
    } else if (action !== 'verify') {
      throw new RequestError(400, 'Unsupported entitlement action.');
    }

    const paid = String(finalEntitlement.status || '') === 'paid';
    return new Response(JSON.stringify({
      ok: true,
      paid,
      status: finalEntitlement.status,
      entitlementId: finalEntitlement.id,
      paymentIntentId: intent.id,
      placement: finalEntitlement.placement,
      amount: intent.amount,
      currency: intent.currency,
      livemode: intent.livemode,
      consumed: Boolean(finalEntitlement.consumed_at),
    }), { status: paid ? 200 : 202, headers });
  } catch (err) {
    const status = err instanceof RequestError ? err.status : 500;
    const message = err instanceof Error ? err.message : 'Unable to verify payment.';
    return new Response(JSON.stringify({ error: message }), { status, headers });
  }
});
