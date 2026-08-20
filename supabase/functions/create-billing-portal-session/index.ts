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

async function resolvePortalConfiguration(): Promise<string> {
  const configurations = await stripe.billingPortal.configurations.list({ active: true, limit: 100 });
  const existing = configurations.data.find((configuration) => (
    String(configuration.metadata?.app || '') === 'marketplace_2026'
    && String(configuration.metadata?.purpose || '') === 'premium_self_service'
  ));
  if (existing?.id) return existing.id;

  const configuration = await stripe.billingPortal.configurations.create({
    business_profile: {
      headline: 'Manage your 6ixo subscriptions',
      privacy_policy_url: 'https://6ixo.com/?legal=privacy',
      terms_of_service_url: 'https://6ixo.com/?legal=terms',
    },
    default_return_url: 'https://6ixo.com/?open=profile',
    features: {
      customer_update: { enabled: true, allowed_updates: ['address', 'name'] },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: {
        enabled: true,
        mode: 'at_period_end',
        cancellation_reason: {
          enabled: true,
          options: ['missing_features', 'too_expensive', 'unused', 'other'],
        },
      },
    },
    metadata: { app: 'marketplace_2026', purpose: 'premium_self_service' },
  }, { idempotencyKey: '6ixo-premium-portal-configuration-v1' });
  return configuration.id;
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
    if (!STRIPE_SECRET_KEY || !supabaseAdmin) throw new Error('Subscription billing is not configured.');
    const token = String(req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) {
      return new Response(JSON.stringify({ error: 'Log in to manage billing.' }), { status: 401, headers });
    }
    const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(token);
    const userId = String(authData?.user?.id || '').trim();
    if (authError || !userId) {
      return new Response(JSON.stringify({ error: 'Unable to validate your billing session.' }), { status: 401, headers });
    }

    const payload = await req.json().catch(() => ({}));
    const kind = String(payload.kind || 'premium').trim().toLowerCase();
    const isSeller = kind === 'seller' || kind === 'seller_pro';
    const subscriptionTable = isSeller ? 'seller_subscriptions' : 'premium_subscriptions';
    const { data, error } = await supabaseAdmin
      .from(subscriptionTable)
      .select('stripe_customer_id')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw error;
    const customerId = String(data?.stripe_customer_id || '').trim();
    if (!customerId) {
      return new Response(JSON.stringify({ error: `No ${isSeller ? 'Seller Pro' : 'Premium'} billing account was found.` }), { status: 404, headers });
    }

    const returnOrigin = origin && ALLOWED_ORIGINS.has(origin) ? origin : 'https://6ixo.com';
    const configurationId = await resolvePortalConfiguration();
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      configuration: configurationId,
      return_url: `${returnOrigin}/?open=${isSeller ? 'profile' : 'premium'}`,
    });
    return new Response(JSON.stringify({ ok: true, url: session.url }), { status: 200, headers });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unable to open billing management.';
    return new Response(JSON.stringify({ error: message }), { status: 500, headers });
  }
});
