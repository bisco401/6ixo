import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const ESCROW_WEBHOOK_TOKEN = Deno.env.get('ESCROW_WEBHOOK_TOKEN') || '';

const supabaseAdmin = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

function corsHeaders(origin: string | null): HeadersInit {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };
}

function normalizeText(value: unknown, max = 200): string {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function pickTransactionId(payload: Record<string, unknown>): string {
  const direct = payload.transaction_id || payload.transactionId || payload.id;
  if (direct) return normalizeText(direct, 120);

  const transaction = payload.transaction;
  if (transaction && typeof transaction === 'object' && !Array.isArray(transaction)) {
    const next = (transaction as Record<string, unknown>).id
      || (transaction as Record<string, unknown>).transaction_id
      || (transaction as Record<string, unknown>).transactionId;
    if (next) return normalizeText(next, 120);
  }

  return '';
}

function pickStatus(payload: Record<string, unknown>): string {
  const direct = payload.status || payload.transaction_status || payload.event_type || payload.event;
  if (direct) return normalizeText(direct, 120).toLowerCase();

  const transaction = payload.transaction;
  if (transaction && typeof transaction === 'object' && !Array.isArray(transaction)) {
    const next = (transaction as Record<string, unknown>).status
      || (transaction as Record<string, unknown>).transaction_status;
    if (next) return normalizeText(next, 120).toLowerCase();
  }

  return 'webhook_received';
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  const headers = corsHeaders(origin);

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed.' }), {
      status: 405,
      headers,
    });
  }

  if (!ESCROW_WEBHOOK_TOKEN) {
    return new Response(JSON.stringify({ error: 'Escrow webhook is not configured.' }), {
      status: 500,
      headers,
    });
  }
  const url = new URL(req.url);
  const token = url.searchParams.get('token') || req.headers.get('x-escrow-webhook-token') || '';
  if (token !== ESCROW_WEBHOOK_TOKEN) {
    return new Response(JSON.stringify({ error: 'Unauthorized webhook.' }), {
      status: 401,
      headers,
    });
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON payload.' }), {
      status: 400,
      headers,
    });
  }

  const transactionId = pickTransactionId(payload);
  const status = pickStatus(payload);

  if (supabaseAdmin && transactionId) {
    try {
      await supabaseAdmin
        .from('escrow_transactions')
        .update({
          status,
          response_payload: payload,
          updated_at: new Date().toISOString(),
        })
        .eq('escrow_transaction_id', transactionId);
    } catch (err) {
      console.warn('Escrow webhook update failed:', err);
    }
  }

  return new Response(JSON.stringify({
    ok: true,
    transactionId,
    status,
  }), {
    status: 200,
    headers,
  });
});
