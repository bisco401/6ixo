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

function normalizeCountryCode(value: unknown): string {
  const raw = normalizeText(value, 80).toUpperCase().replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^[A-Z]{2}$/.test(raw)) return raw;
  const aliases: Record<string, string> = {
    CANADA: 'CA',
    'UNITED STATES': 'US',
    'UNITED STATES OF AMERICA': 'US',
    USA: 'US',
    MEXICO: 'MX',
    'UNITED KINGDOM': 'GB',
    UK: 'GB',
    AUSTRALIA: 'AU',
    FRANCE: 'FR',
    GERMANY: 'DE',
    ITALY: 'IT',
    SPAIN: 'ES',
  };
  return aliases[raw] || '';
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
  if (!supabaseAdmin) throw new RequestError(500, 'Payout setup is not configured.');
  const token = String(req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) throw new RequestError(401, 'Log in to manage payouts.');
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user?.id || !data.user.email) throw new RequestError(401, 'Unable to validate your payout session.');
  return data.user;
}

async function requireApprovedHost(userId: string) {
  if (!supabaseAdmin) throw new RequestError(500, 'Payout setup is not configured.');
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('host_status, full_name, first_name, last_name, country')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  if (!data || String(data.host_status || '') !== 'approved') {
    throw new RequestError(403, 'Host approval is required before payout onboarding.');
  }
  return data;
}

async function upsertAccount(userId: string, account: Stripe.Account) {
  if (!supabaseAdmin) throw new RequestError(500, 'Payout setup is not configured.');
  const payoutsEnabled = Boolean(account.payouts_enabled);
  const detailsSubmitted = Boolean(account.details_submitted);
  const { data, error } = await supabaseAdmin
    .from('stripe_connected_accounts')
    .upsert({
      user_id: userId,
      stripe_account_id: account.id,
      account_type: String(account.type || 'express'),
      country: account.country || null,
      charges_enabled: Boolean(account.charges_enabled),
      payouts_enabled: payoutsEnabled,
      details_submitted: detailsSubmitted,
      onboarding_completed_at: payoutsEnabled && detailsSubmitted ? new Date().toISOString() : null,
      metadata: {
        requirements_currently_due: account.requirements?.currently_due || [],
        requirements_eventually_due: account.requirements?.eventually_due || [],
        requirements_disabled_reason: account.requirements?.disabled_reason || null,
        capabilities: account.capabilities || {},
      },
    }, { onConflict: 'user_id' })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function getOrCreateAccount(user: { id: string; email?: string }, profile: Record<string, unknown>) {
  if (!supabaseAdmin) throw new RequestError(500, 'Payout setup is not configured.');
  const { data, error } = await supabaseAdmin
    .from('stripe_connected_accounts')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) throw error;

  let account: Stripe.Account;
  if (data?.stripe_account_id) {
    account = await stripe.accounts.retrieve(String(data.stripe_account_id)) as Stripe.Account;
  } else {
    const displayName = normalizeText(
      profile.full_name || [profile.first_name, profile.last_name].filter(Boolean).join(' '),
      120,
    );
    const country = normalizeCountryCode(profile.country);
    account = await stripe.accounts.create({
      type: 'express',
      country: country || undefined,
      email: user.email || undefined,
      business_profile: displayName ? { name: displayName } : undefined,
      capabilities: {
        transfers: { requested: true },
      },
      metadata: {
        app: 'marketplace_2026',
        user_id: user.id,
      },
    }, {
      idempotencyKey: `6ixo-connect-account:${user.id}`,
    });
  }
  const row = await upsertAccount(user.id, account);
  return { account, row };
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
    if (!STRIPE_SECRET_KEY || !supabaseAdmin) throw new RequestError(500, 'Payout setup is not configured.');
    const user = await getAuthenticatedUser(req);
    const profile = await requireApprovedHost(user.id);
    const payload = await req.json().catch(() => ({}));
    const action = normalizeText(payload.action || 'status', 24).toLowerCase();
    if (!['status', 'onboard', 'dashboard'].includes(action)) {
      throw new RequestError(400, 'Unsupported payout action.');
    }

    const { account, row } = await getOrCreateAccount(user, profile);
    const ready = Boolean(account.details_submitted && account.payouts_enabled);
    const response: Record<string, unknown> = {
      ok: true,
      ready,
      accountId: account.id,
      chargesEnabled: Boolean(account.charges_enabled),
      payoutsEnabled: Boolean(account.payouts_enabled),
      detailsSubmitted: Boolean(account.details_submitted),
      requirementsCurrentlyDue: account.requirements?.currently_due || [],
      country: account.country || row.country || null,
    };

    const returnOrigin = origin && ALLOWED_ORIGINS.has(origin) ? origin : 'https://6ixo.com';
    if (action === 'onboard') {
      const link = await stripe.accountLinks.create({
        account: account.id,
        type: 'account_onboarding',
        refresh_url: `${returnOrigin}/?connect=refresh`,
        return_url: `${returnOrigin}/?connect=return`,
        collection_options: {
          fields: 'eventually_due',
          future_requirements: 'include',
        },
      });
      response.url = link.url;
    } else if (action === 'dashboard') {
      if (!ready) throw new RequestError(409, 'Complete payout onboarding before opening the payout dashboard.');
      const link = await stripe.accounts.createLoginLink(account.id);
      response.url = link.url;
    }

    return new Response(JSON.stringify(response), { status: 200, headers });
  } catch (err) {
    const status = err instanceof RequestError ? err.status : 500;
    const message = err instanceof Error ? err.message : 'Unable to manage payout setup.';
    return new Response(JSON.stringify({ error: message }), { status, headers });
  }
});
