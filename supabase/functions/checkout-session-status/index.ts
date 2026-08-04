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

function objectId(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'id' in value) return String((value as { id?: unknown }).id || '');
  return '';
}

function epochToIso(value: unknown): string | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? new Date(number * 1000).toISOString() : null;
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
  if (!supabaseAdmin) throw new RequestError(500, 'Checkout authentication is not configured.');
  const token = String(req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) throw new RequestError(401, 'Log in to check this payment.');
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user?.id) throw new RequestError(401, 'Unable to validate your checkout session.');
  return data.user;
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

  try {
    if (!STRIPE_SECRET_KEY || !supabaseAdmin) throw new RequestError(500, 'Stripe is not configured.');
    const payload = await req.json().catch(() => ({}));
    const user = await getAuthenticatedUser(req);
    const sessionId = String(payload.sessionId || '').trim();
    if (!sessionId.startsWith('cs_')) throw new RequestError(400, 'A valid sessionId is required.');

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['subscription', 'payment_intent'],
    });
    const ownerId = String(session.metadata?.user_id || session.client_reference_id || '').trim();
    if (ownerId !== user.id) throw new RequestError(403, 'This checkout session belongs to a different account.');

    if (session.mode === 'subscription') {
      const subscriptionId = objectId(session.subscription);
      if (!subscriptionId) throw new RequestError(409, 'Stripe has not created the subscription yet.');
      const subscription = typeof session.subscription === 'string'
        ? await stripe.subscriptions.retrieve(subscriptionId)
        : session.subscription as Stripe.Subscription;
      const planKey = String(subscription.metadata?.premium_plan || session.metadata?.premium_plan || '').trim();
      const status = String(subscription.status || 'incomplete');
      const active = ['active', 'trialing'].includes(status);
      const customerId = objectId(subscription.customer) || objectId(session.customer);
      const { error } = await supabaseAdmin.from('premium_subscriptions').upsert({
        user_id: user.id,
        stripe_customer_id: customerId || null,
        stripe_subscription_id: subscription.id,
        stripe_checkout_session_id: session.id,
        plan_key: planKey || null,
        status,
        current_period_end: epochToIso(subscription.current_period_end),
        cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
        livemode: Boolean(subscription.livemode),
        metadata: {
          checkout_payment_status: session.payment_status,
          subscription_items: subscription.items?.data?.map((item) => ({
            price_id: item.price?.id || null,
            quantity: item.quantity || 1,
          })) || [],
        },
      }, { onConflict: 'user_id' });
      if (error) throw error;

      return new Response(JSON.stringify({
        ok: true,
        kind: 'premium_subscription',
        active,
        status,
        plan: planKey || null,
        currentPeriodEnd: epochToIso(subscription.current_period_end),
        cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
        sessionId: session.id,
      }), { status: 200, headers });
    }

    const paid = session.status === 'complete' && session.payment_status === 'paid';
    const paymentIntentId = objectId(session.payment_intent);
    if (paid && paymentIntentId) {
      const intent = typeof session.payment_intent === 'string'
        ? await stripe.paymentIntents.retrieve(paymentIntentId)
        : session.payment_intent as Stripe.PaymentIntent;
      const { error } = await supabaseAdmin.from('payment_entitlements').upsert({
        user_id: user.id,
        stripe_payment_intent_id: intent.id,
        placement: String(intent.metadata?.placement || session.metadata?.placement || ''),
        request_id: String(intent.metadata?.request_id || '') || null,
        amount_cents: Number(intent.amount_received || intent.amount || 0),
        currency: String(intent.currency || 'usd').toUpperCase(),
        status: intent.status === 'succeeded' ? 'paid' : 'processing',
        livemode: Boolean(intent.livemode),
        paid_at: intent.status === 'succeeded' ? new Date().toISOString() : null,
        metadata: { checkout_session_id: session.id, intent_metadata: intent.metadata || {} },
      }, { onConflict: 'stripe_payment_intent_id' });
      if (error) throw error;
    }

    return new Response(JSON.stringify({
      ok: true,
      kind: 'one_time_payment',
      paid,
      status: session.status,
      paymentStatus: session.payment_status,
      sessionId: session.id,
      paymentIntentId: paymentIntentId || null,
      amountTotal: session.amount_total,
      currency: session.currency,
      metadata: session.metadata || {},
    }), { status: 200, headers });
  } catch (err) {
    const status = err instanceof RequestError ? err.status : 500;
    const message = err instanceof Error ? err.message : 'Unable to fetch session status.';
    return new Response(JSON.stringify({ error: message }), { status, headers });
  }
});
