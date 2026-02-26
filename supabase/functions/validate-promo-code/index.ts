import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

const supabaseAdmin = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

type PromoCodeRow = {
  id: number;
  code: string;
  active: boolean;
  discount_type: string;
  discount_value: number | string;
  currency: string | null;
  starts_at: string | null;
  ends_at: string | null;
  max_redemptions: number | null;
  per_customer_limit: number | null;
  placement_scope: string[] | null;
};

class RequestError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
  }
}

function corsHeaders(origin: string | null): HeadersInit {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };
}

function normalizePlacement(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

function normalizeCurrency(value: unknown): string {
  return String(value || 'USD').trim().toUpperCase() || 'USD';
}

function normalizePromoCode(value: unknown): string {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

function normalizeCustomerRef(value: unknown): string {
  return String(value || '').trim().slice(0, 120);
}

function amountToCents(amount: number): number {
  return Math.round((Number(amount) || 0) * 100);
}

function centsToAmount(cents: number): number {
  return Number((Math.max(0, Number(cents) || 0) / 100).toFixed(2));
}

function toFiniteNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toFiniteInt(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.trunc(parsed);
}

function isPromoWithinDateWindow(row: PromoCodeRow, nowMs: number): boolean {
  const startsMs = row.starts_at ? new Date(row.starts_at).getTime() : NaN;
  if (Number.isFinite(startsMs) && nowMs < startsMs) return false;

  const endsMs = row.ends_at ? new Date(row.ends_at).getTime() : NaN;
  if (Number.isFinite(endsMs) && nowMs > endsMs) return false;

  return true;
}

function isPromoPlacementAllowed(row: PromoCodeRow, placement: string): boolean {
  const list = Array.isArray(row.placement_scope)
    ? row.placement_scope.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
    : [];
  if (!list.length) return true;
  return list.includes(placement);
}

function computePromoDiscountCents(row: PromoCodeRow, amountBeforeCents: number): number {
  const type = String(row.discount_type || '').trim().toLowerCase();
  const discountValue = toFiniteNumber(row.discount_value);
  if (!Number.isFinite(discountValue) || discountValue <= 0) return 0;

  if (type === 'percent') {
    const raw = Math.round(amountBeforeCents * (discountValue / 100));
    return Math.max(0, Math.min(amountBeforeCents, raw));
  }

  if (type === 'fixed') {
    const fixedCents = amountToCents(discountValue);
    return Math.max(0, Math.min(amountBeforeCents, fixedCents));
  }

  return 0;
}

async function fetchPromoCodeRow(code: string): Promise<PromoCodeRow | null> {
  if (!supabaseAdmin) {
    throw new RequestError(500, 'Promo code validation is not configured.');
  }

  const { data, error } = await supabaseAdmin
    .from('promo_codes')
    .select('id, code, active, discount_type, discount_value, currency, starts_at, ends_at, max_redemptions, per_customer_limit, placement_scope')
    .ilike('code', code)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  return data as PromoCodeRow;
}

async function countCodeRedemptions(code: string): Promise<number> {
  if (!supabaseAdmin) {
    throw new RequestError(500, 'Promo code validation is not configured.');
  }

  const { count, error } = await supabaseAdmin
    .from('promo_redemptions')
    .select('id', { head: true, count: 'exact' })
    .eq('promo_code', code)
    .eq('status', 'succeeded');

  if (error) throw error;
  return Number(count || 0);
}

async function countCustomerRedemptions(code: string, customerRef: string): Promise<number> {
  if (!supabaseAdmin) {
    throw new RequestError(500, 'Promo code validation is not configured.');
  }

  const { count, error } = await supabaseAdmin
    .from('promo_redemptions')
    .select('id', { head: true, count: 'exact' })
    .eq('promo_code', code)
    .eq('customer_ref', customerRef)
    .eq('status', 'succeeded');

  if (error) throw error;
  return Number(count || 0);
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

  let payload: Record<string, unknown> = {};
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON payload.' }), {
      status: 400,
      headers,
    });
  }

  const code = normalizePromoCode(payload.code);
  const placement = normalizePlacement(payload.placement);
  const currency = normalizeCurrency(payload.currency);
  const amount = Number(payload.amount || 0);
  const customerRef = normalizeCustomerRef(payload.customerRef);

  if (!code) {
    return new Response(JSON.stringify({ error: 'Promo code is required.' }), {
      status: 400,
      headers,
    });
  }
  if (!placement) {
    return new Response(JSON.stringify({ error: 'Placement is required.' }), {
      status: 400,
      headers,
    });
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return new Response(JSON.stringify({ error: 'Amount must be greater than zero.' }), {
      status: 400,
      headers,
    });
  }

  const amountBeforeCents = amountToCents(amount);

  try {
    const row = await fetchPromoCodeRow(code);
    if (!row || !row.active) {
      throw new RequestError(400, 'Promo code is invalid or inactive.');
    }

    const nowMs = Date.now();
    if (!isPromoWithinDateWindow(row, nowMs)) {
      throw new RequestError(400, 'Promo code is not active at this time.');
    }

    if (!isPromoPlacementAllowed(row, placement)) {
      throw new RequestError(400, 'Promo code is not valid for this placement.');
    }

    const promoCurrency = String(row.currency || '').trim().toUpperCase();
    if (promoCurrency && promoCurrency !== currency) {
      throw new RequestError(400, `Promo code is only valid for ${promoCurrency}.`);
    }

    const maxRedemptions = toFiniteInt(row.max_redemptions);
    if (maxRedemptions > 0) {
      const totalRedemptions = await countCodeRedemptions(code);
      if (totalRedemptions >= maxRedemptions) {
        throw new RequestError(400, 'Promo code redemption limit has been reached.');
      }
    }

    const perCustomerLimit = toFiniteInt(row.per_customer_limit);
    if (perCustomerLimit > 0) {
      if (!customerRef) {
        throw new RequestError(400, 'Promo code requires a customer reference.');
      }
      const customerRedemptions = await countCustomerRedemptions(code, customerRef);
      if (customerRedemptions >= perCustomerLimit) {
        throw new RequestError(400, 'Promo code usage limit reached for this account.');
      }
    }

    const discountCents = computePromoDiscountCents(row, amountBeforeCents);
    if (!Number.isFinite(discountCents) || discountCents <= 0) {
      throw new RequestError(400, 'Promo code discount is invalid for this amount.');
    }

    const amountAfterCents = Math.max(0, amountBeforeCents - discountCents);
    if (!Number.isFinite(amountAfterCents) || amountAfterCents <= 0) {
      throw new RequestError(400, 'Promo code cannot reduce this payment below minimum amount.');
    }

    const response = {
      ok: true,
      valid: true,
      promoCodeId: Number(row.id),
      code: normalizePromoCode(row.code || code),
      discountType: String(row.discount_type || '').toLowerCase(),
      discountValue: toFiniteNumber(row.discount_value),
      amountBeforeCents,
      discountCents,
      amountAfterCents,
      amountBefore: centsToAmount(amountBeforeCents),
      discountAmount: centsToAmount(discountCents),
      amountAfter: centsToAmount(amountAfterCents),
      currency,
    };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers,
    });
  } catch (err) {
    if (err instanceof RequestError) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: err.status,
        headers,
      });
    }
    const message = err instanceof Error ? err.message : 'Unable to validate promo code.';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers,
    });
  }
});
