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

const PREMIUM_PLANS = {
  premium_monthly: { amountCents: 499, interval: 'month' as const, label: '6ixo Premium Monthly' },
  premium_annual: { amountCents: 3499, interval: 'year' as const, label: '6ixo Premium Annual' },
};

const USD_PRICING: Record<string, number> = {
  home: 15,
  nearby: 15,
  dating: 15,
  companionship: 15,
  all: 39,
  arrive_plus: 5.99,
  premium: 1.99,
  dating_featured: 1.99,
  companionship_feed_boost_pass: 4.99,
  companionship_featured: 9.99,
  home_featured: 9.99,
  marketplace_featured: 9.99,
  community_featured: 9.99,
  jobs_featured: 9.99,
  services_featured: 9.99,
  vehicles_featured: 9.99,
  realestate_featured: 9.99,
  electronics_featured: 9.99,
};

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
  if (!supabaseAdmin) throw new RequestError(500, 'Checkout authentication is not configured.');
  const token = String(req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) throw new RequestError(401, 'Log in to continue to checkout.');
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user?.id || !data.user.email) {
    throw new RequestError(401, 'Unable to validate your checkout session.');
  }
  return data.user;
}

function getReturnOrigin(origin: string | null): string {
  if (origin && ALLOWED_ORIGINS.has(origin)) return origin;
  return 'https://6ixo.com';
}

async function resolvePremiumCustomer(user: { id: string; email?: string }) {
  if (!supabaseAdmin) throw new RequestError(500, 'Premium billing is not configured.');
  const { data: existing, error } = await supabaseAdmin
    .from('premium_subscriptions')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) throw error;

  if (['active', 'trialing', 'past_due'].includes(String(existing?.status || '').toLowerCase())) {
    throw new RequestError(409, 'Premium billing already exists for this account. Use Manage billing instead.');
  }

  let customer: Stripe.Customer | Stripe.DeletedCustomer | null = null;
  if (existing?.stripe_customer_id) {
    customer = await stripe.customers.retrieve(String(existing.stripe_customer_id));
  }
  if (!customer || customer.deleted) {
    customer = await stripe.customers.create({
      email: user.email || undefined,
      metadata: { app: 'marketplace_2026', user_id: user.id },
    }, { idempotencyKey: `6ixo-customer:${user.id}` });
  }

  await supabaseAdmin.from('premium_subscriptions').upsert({
    user_id: user.id,
    stripe_customer_id: customer.id,
    status: existing?.status || 'inactive',
    livemode: Boolean(customer.livemode),
    metadata: existing?.metadata || {},
  }, { onConflict: 'user_id' });
  return customer.id;
}

async function resolvePremiumPrice(planKey: keyof typeof PREMIUM_PLANS): Promise<string> {
  const plan = PREMIUM_PLANS[planKey];
  const lookupKey = `6ixo_${planKey}_usd_v1`;
  const existing = await stripe.prices.list({ active: true, lookup_keys: [lookupKey], limit: 1 });
  if (existing.data[0]?.id) return existing.data[0].id;

  const product = await stripe.products.create({
    name: '6ixo Premium',
    description: 'Premium visibility, messaging, and travel-discovery features on 6ixo.',
    metadata: { app: 'marketplace_2026', product_key: 'premium' },
  }, { idempotencyKey: '6ixo-premium-product-v1' });

  const price = await stripe.prices.create({
    product: product.id,
    currency: 'usd',
    unit_amount: plan.amountCents,
    recurring: { interval: plan.interval },
    lookup_key: lookupKey,
    nickname: plan.label,
    metadata: { app: 'marketplace_2026', plan_key: planKey },
  }, { idempotencyKey: `6ixo-premium-price:${planKey}:v1` });
  return price.id;
}

async function createPremiumCheckout(
  user: { id: string; email?: string },
  planKey: keyof typeof PREMIUM_PLANS,
  returnOrigin: string,
  requestId: string,
) {
  if (!supabaseAdmin) throw new RequestError(500, 'Premium billing is not configured.');
  const customerId = await resolvePremiumCustomer(user);
  const priceId = await resolvePremiumPrice(planKey);
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    client_reference_id: user.id,
    success_url: `${returnOrigin}/?stripe_checkout=success&checkout_kind=premium&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${returnOrigin}/?stripe_checkout=cancelled&checkout_kind=premium`,
    line_items: [{ price: priceId, quantity: 1 }],
    billing_address_collection: 'auto',
    customer_update: { address: 'auto', name: 'auto' },
    metadata: {
      app: 'marketplace_2026',
      user_id: user.id,
      kind: 'premium_subscription',
      premium_plan: planKey,
    },
    subscription_data: {
      metadata: {
        app: 'marketplace_2026',
        user_id: user.id,
        premium_plan: planKey,
      },
    },
  }, { idempotencyKey: `6ixo-premium-checkout:${user.id}:${planKey}:${requestId}` });

  await supabaseAdmin.from('premium_subscriptions').update({
    stripe_checkout_session_id: session.id,
    plan_key: planKey,
  }).eq('user_id', user.id);
  return session;
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
    if (!STRIPE_SECRET_KEY) throw new RequestError(500, 'Stripe is not configured.');
    const user = await getAuthenticatedUser(req);
    const payload = await req.json().catch(() => ({}));
    const returnOrigin = getReturnOrigin(origin);
    const planKey = normalizeText(payload.plan || payload.planKey, 40) as keyof typeof PREMIUM_PLANS;
    const requestId = normalizeText(payload.requestId || payload.request_id, 100)
      .replace(/[^a-zA-Z0-9_-]/g, '')
      .slice(0, 80);
    if (!requestId) throw new RequestError(400, 'A payment request id is required.');

    if (planKey && PREMIUM_PLANS[planKey]) {
      const session = await createPremiumCheckout(user, planKey, returnOrigin, requestId);
      return new Response(JSON.stringify({
        ok: true,
        id: session.id,
        url: session.url,
        mode: session.mode,
        status: session.status,
        plan: planKey,
      }), { status: 200, headers });
    }

    const placement = normalizeText(payload.placement, 80).toLowerCase();
    const configuredAmount = USD_PRICING[placement];
    const requestedAmount = Number(payload.amount || 0);
    if (!placement || !Number.isFinite(configuredAmount)) throw new RequestError(400, 'Unsupported checkout item.');
    if (!Number.isFinite(requestedAmount) || Math.abs(requestedAmount - configuredAmount) > 0.001) {
      throw new RequestError(400, 'Amount mismatch for placement.');
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      success_url: `${returnOrigin}/?stripe_checkout=success&checkout_kind=promotion&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${returnOrigin}/?stripe_checkout=cancelled&checkout_kind=promotion`,
      customer_email: user.email || undefined,
      client_reference_id: user.id,
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: normalizeText(payload.title || '6ixo promotion', 120) },
          unit_amount: Math.round(configuredAmount * 100),
        },
        quantity: 1,
      }],
      metadata: { app: 'marketplace_2026', user_id: user.id, placement, request_id: requestId },
      payment_intent_data: { metadata: { app: 'marketplace_2026', user_id: user.id, placement, request_id: requestId } },
    }, { idempotencyKey: `6ixo-promotion-checkout:${user.id}:${placement}:${requestId}` });

    return new Response(JSON.stringify({ ok: true, id: session.id, url: session.url, mode: session.mode }), {
      status: 200,
      headers,
    });
  } catch (err) {
    const status = err instanceof RequestError ? err.status : 500;
    const message = err instanceof Error ? err.message : 'Unable to create checkout.';
    return new Response(JSON.stringify({ error: message }), { status, headers });
  }
});
