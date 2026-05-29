import Stripe from 'https://esm.sh/stripe@14.25.0?target=denonext';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8';

const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY') || '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

if (!STRIPE_SECRET_KEY) {
  console.error('Missing STRIPE_SECRET_KEY secret.');
}

const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

const supabaseAdmin = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

const USD_PRICING: Record<string, number> = {
  arrive_plus: 5.99,
  premium: 1.99,
  dating_featured: 1.99,
  companionship_featured: 6.99,
  home_featured: 6.99,
  marketplace_featured: 6.99,
  community_featured: 6.99,
  services_featured: 6.99,
  vehicles_featured: 6.99,
  realestate_featured: 6.99,
  electronics_featured: 6.99,
};

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

type PromoValidation = {
  promoCodeId: number;
  code: string;
  discountType: string;
  discountValue: number;
  discountCents: number;
  amountBeforeCents: number;
  amountAfterCents: number;
};

type ShortTermBookingRow = {
  id: string;
  public_id: string;
  listing_public_id: string;
  guest_user_id: string | null;
  host_user_id: string;
  guest_name: string;
  guest_email: string;
  status: string;
  payment_status: string;
  stripe_payment_intent_id: string | null;
  total: number | string;
  currency: string | null;
  booking_payload: Record<string, unknown> | null;
  payment_payload: Record<string, unknown> | null;
};

type VehicleRentalBookingRow = {
  id: string;
  public_id: string;
  listing_public_id: string;
  guest_user_id: string | null;
  host_user_id: string | null;
  guest_name: string;
  guest_email: string;
  status: string;
  payment_status: string;
  stripe_payment_intent_id: string | null;
  pickup_date: string;
  return_date: string;
  total: number | string;
  currency: string | null;
  booking_payload: Record<string, unknown> | null;
  payment_payload: Record<string, unknown> | null;
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
  const next = String(value || 'USD').trim().toLowerCase();
  return next || 'usd';
}

function normalizePromoCode(value: unknown): string {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

function normalizeCustomerRef(value: unknown): string {
  return String(value || '').trim().slice(0, 120);
}

function normalizePublicId(value: unknown): string {
  return String(value || '').trim().slice(0, 80);
}

function normalizeEmail(value: unknown): string {
  return String(value || '').trim().toLowerCase();
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

function isReusablePaymentIntentStatus(status: string): boolean {
  return [
    'requires_payment_method',
    'requires_confirmation',
    'requires_action',
    'processing',
    'requires_capture',
  ].includes(String(status || '').toLowerCase());
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

async function validatePromoCode({
  code,
  placement,
  currency,
  amountBeforeCents,
  customerRef,
}: {
  code: string;
  placement: string;
  currency: string;
  amountBeforeCents: number;
  customerRef: string;
}): Promise<PromoValidation> {
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
  if (promoCurrency && promoCurrency !== currency.toUpperCase()) {
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

  return {
    promoCodeId: Number(row.id),
    code: normalizePromoCode(row.code || code),
    discountType: String(row.discount_type || '').toLowerCase(),
    discountValue: toFiniteNumber(row.discount_value),
    discountCents,
    amountBeforeCents,
    amountAfterCents,
  };
}

async function fetchShortTermBooking(publicId: string): Promise<ShortTermBookingRow> {
  if (!supabaseAdmin) {
    throw new RequestError(500, 'Booking payment backend is not configured.');
  }

  const { data, error } = await supabaseAdmin
    .from('short_term_bookings')
    .select('id, public_id, listing_public_id, guest_user_id, host_user_id, guest_name, guest_email, status, payment_status, stripe_payment_intent_id, total, currency, booking_payload, payment_payload')
    .eq('public_id', publicId)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    throw new RequestError(404, 'Booking not found.');
  }
  return data as ShortTermBookingRow;
}

async function updateBookingPaymentIntent({
  booking,
  paymentIntent,
  paymentStatus,
}: {
  booking: ShortTermBookingRow;
  paymentIntent: Stripe.PaymentIntent;
  paymentStatus: string;
}) {
  if (!supabaseAdmin) return;
  const { error } = await supabaseAdmin
    .from('short_term_bookings')
    .update({
      payment_status: paymentStatus,
      stripe_payment_intent_id: paymentIntent.id,
      stripe_payment_amount_cents: paymentIntent.amount,
      stripe_payment_currency: String(paymentIntent.currency || '').toUpperCase(),
      payment_payload: {
        ...(booking.payment_payload || {}),
        stripePaymentIntentId: paymentIntent.id,
        stripePaymentIntentStatus: paymentIntent.status,
        stripeCaptureMethod: paymentIntent.capture_method || null,
        stripeLivemode: paymentIntent.livemode,
        stripeUpdatedAt: new Date().toISOString(),
      },
    })
    .eq('id', booking.id);

  if (error) throw error;
}

async function fetchVehicleRentalBooking(publicId: string): Promise<VehicleRentalBookingRow> {
  if (!supabaseAdmin) {
    throw new RequestError(500, 'Vehicle rental payment backend is not configured.');
  }

  const { data, error } = await supabaseAdmin
    .from('vehicle_rental_bookings')
    .select('id, public_id, listing_public_id, guest_user_id, host_user_id, guest_name, guest_email, status, payment_status, stripe_payment_intent_id, pickup_date, return_date, total, currency, booking_payload, payment_payload')
    .eq('public_id', publicId)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    throw new RequestError(404, 'Vehicle rental booking not found.');
  }
  return data as VehicleRentalBookingRow;
}

async function assertVehicleRentalDatesStillAvailable(booking: VehicleRentalBookingRow) {
  if (!supabaseAdmin) return;
  const { data, error } = await supabaseAdmin
    .from('vehicle_rental_bookings')
    .select('public_id')
    .eq('listing_public_id', booking.listing_public_id)
    .neq('public_id', booking.public_id)
    .in('status', ['requested', 'confirmed'])
    .in('payment_status', ['authorized', 'paid', 'processing'])
    .lt('pickup_date', booking.return_date)
    .gt('return_date', booking.pickup_date)
    .limit(1);
  if (error) throw error;
  if (Array.isArray(data) && data.length > 0) {
    throw new RequestError(409, 'Those dates are already booked or requested.');
  }
}

async function updateVehicleRentalBookingPaymentIntent({
  booking,
  paymentIntent,
  paymentStatus,
}: {
  booking: VehicleRentalBookingRow;
  paymentIntent: Stripe.PaymentIntent;
  paymentStatus: string;
}) {
  if (!supabaseAdmin) return;
  const { error } = await supabaseAdmin
    .from('vehicle_rental_bookings')
    .update({
      payment_status: paymentStatus,
      stripe_payment_intent_id: paymentIntent.id,
      stripe_payment_amount_cents: paymentIntent.amount,
      stripe_payment_currency: String(paymentIntent.currency || '').toUpperCase(),
      payment_payload: {
        ...(booking.payment_payload || {}),
        stripePaymentIntentId: paymentIntent.id,
        stripePaymentIntentStatus: paymentIntent.status,
        stripeCaptureMethod: paymentIntent.capture_method || null,
        stripeLivemode: paymentIntent.livemode,
        stripeUpdatedAt: new Date().toISOString(),
      },
    })
    .eq('id', booking.id);

  if (error) throw error;
}

async function handleShortTermBookingPayment(payload: Record<string, unknown>, headers: HeadersInit): Promise<Response> {
  const bookingPublicId = normalizePublicId(payload.bookingPublicId || payload.booking_public_id);
  if (!bookingPublicId) {
    throw new RequestError(400, 'Missing bookingPublicId.');
  }

  const booking = await fetchShortTermBooking(bookingPublicId);
  const bookingStatus = String(booking.status || '').toLowerCase();
  if (bookingStatus === 'declined' || bookingStatus === 'cancelled') {
    throw new RequestError(400, 'Closed bookings cannot be paid.');
  }

  const payloadGuestEmail = normalizeEmail(payload.guestEmail);
  const bookingGuestEmail = normalizeEmail(booking.guest_email);
  if (payloadGuestEmail && bookingGuestEmail && payloadGuestEmail !== bookingGuestEmail) {
    throw new RequestError(403, 'Guest email does not match this booking.');
  }

  const amount = toFiniteNumber(booking.total);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new RequestError(400, 'Booking total is invalid.');
  }
  const amountCents = amountToCents(amount);
  if (!Number.isFinite(amountCents) || amountCents < 50) {
    throw new RequestError(400, 'Booking total is below Stripe minimum payment amount.');
  }

  const currency = normalizeCurrency(booking.currency || payload.currency || 'USD');
  if (!/^[a-z]{3}$/.test(currency)) {
    throw new RequestError(400, 'Booking currency is invalid.');
  }

  if (booking.stripe_payment_intent_id) {
    try {
      const existingIntent = await stripe.paymentIntents.retrieve(booking.stripe_payment_intent_id);
      if (
        existingIntent
        && existingIntent.amount === amountCents
        && existingIntent.currency === currency
        && isReusablePaymentIntentStatus(existingIntent.status)
        && existingIntent.client_secret
      ) {
        return new Response(JSON.stringify({
          ok: true,
          id: existingIntent.id,
          clientSecret: existingIntent.client_secret,
          status: existingIntent.status,
          livemode: existingIntent.livemode,
          amount: existingIntent.amount,
          currency: existingIntent.currency,
          amountBeforeCents: amountCents,
          amountAfterCents: amountCents,
          captureMethod: existingIntent.capture_method,
          bookingPublicId: booking.public_id,
          listingPublicId: booking.listing_public_id,
        }), {
          status: 200,
          headers,
        });
      }
    } catch {
      // If the old PaymentIntent cannot be reused, create a fresh one below.
    }
  }

  const captureMethod = bookingStatus === 'confirmed' ? 'automatic' : 'manual';
  const paymentIntent = await stripe.paymentIntents.create({
    amount: amountCents,
    currency,
    capture_method: captureMethod,
    automatic_payment_methods: { enabled: true },
    receipt_email: bookingGuestEmail || undefined,
    metadata: {
      app: 'marketplace_2026',
      placement: 'short_term_booking',
      booking_public_id: booking.public_id,
      listing_public_id: booking.listing_public_id,
      booking_status: bookingStatus,
      capture_method: captureMethod,
    },
  });

  await updateBookingPaymentIntent({
    booking,
    paymentIntent,
    paymentStatus: 'requires_payment_method',
  });

  return new Response(JSON.stringify({
    ok: true,
    id: paymentIntent.id,
    clientSecret: paymentIntent.client_secret,
    status: paymentIntent.status,
    livemode: paymentIntent.livemode,
    amount: paymentIntent.amount,
    currency: paymentIntent.currency,
    amountBeforeCents: amountCents,
    amountAfterCents: amountCents,
    captureMethod,
    bookingPublicId: booking.public_id,
    listingPublicId: booking.listing_public_id,
  }), {
    status: 200,
    headers,
  });
}

async function handleVehicleRentalBookingPayment(payload: Record<string, unknown>, headers: HeadersInit): Promise<Response> {
  const bookingPublicId = normalizePublicId(
    payload.vehicleRentalBookingPublicId
    || payload.vehicle_rental_booking_public_id
    || payload.bookingPublicId
    || payload.booking_public_id
  );
  if (!bookingPublicId) {
    throw new RequestError(400, 'Missing vehicleRentalBookingPublicId.');
  }

  const booking = await fetchVehicleRentalBooking(bookingPublicId);
  const bookingStatus = String(booking.status || '').toLowerCase();
  if (bookingStatus === 'declined' || bookingStatus === 'cancelled') {
    throw new RequestError(400, 'Closed vehicle rental bookings cannot be paid.');
  }

  const payloadGuestEmail = normalizeEmail(payload.guestEmail);
  const bookingGuestEmail = normalizeEmail(booking.guest_email);
  if (payloadGuestEmail && bookingGuestEmail && payloadGuestEmail !== bookingGuestEmail) {
    throw new RequestError(403, 'Guest email does not match this vehicle rental booking.');
  }

  const amount = toFiniteNumber(booking.total);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new RequestError(400, 'Vehicle rental total is invalid.');
  }
  const amountCents = amountToCents(amount);
  if (!Number.isFinite(amountCents) || amountCents < 50) {
    throw new RequestError(400, 'Vehicle rental total is below Stripe minimum payment amount.');
  }

  const currency = normalizeCurrency(booking.currency || payload.currency || 'USD');
  if (!/^[a-z]{3}$/.test(currency)) {
    throw new RequestError(400, 'Vehicle rental currency is invalid.');
  }

  await assertVehicleRentalDatesStillAvailable(booking);

  if (booking.stripe_payment_intent_id) {
    try {
      const existingIntent = await stripe.paymentIntents.retrieve(booking.stripe_payment_intent_id);
      if (
        existingIntent
        && existingIntent.amount === amountCents
        && existingIntent.currency === currency
        && isReusablePaymentIntentStatus(existingIntent.status)
        && existingIntent.client_secret
      ) {
        return new Response(JSON.stringify({
          ok: true,
          id: existingIntent.id,
          clientSecret: existingIntent.client_secret,
          status: existingIntent.status,
          livemode: existingIntent.livemode,
          amount: existingIntent.amount,
          currency: existingIntent.currency,
          amountBeforeCents: amountCents,
          amountAfterCents: amountCents,
          captureMethod: existingIntent.capture_method,
          vehicleRentalBookingPublicId: booking.public_id,
          listingPublicId: booking.listing_public_id,
        }), {
          status: 200,
          headers,
        });
      }
    } catch {
      // If the old PaymentIntent cannot be reused, create a fresh one below.
    }
  }

  const captureMethod = bookingStatus === 'confirmed' ? 'automatic' : 'manual';
  const paymentIntent = await stripe.paymentIntents.create({
    amount: amountCents,
    currency,
    capture_method: captureMethod,
    automatic_payment_methods: { enabled: true },
    receipt_email: bookingGuestEmail || undefined,
    metadata: {
      app: 'marketplace_2026',
      placement: 'vehicle_rental_booking',
      vehicle_rental_booking_public_id: booking.public_id,
      listing_public_id: booking.listing_public_id,
      booking_status: bookingStatus,
      capture_method: captureMethod,
    },
  });

  await updateVehicleRentalBookingPaymentIntent({
    booking,
    paymentIntent,
    paymentStatus: 'requires_payment_method',
  });

  return new Response(JSON.stringify({
    ok: true,
    id: paymentIntent.id,
    clientSecret: paymentIntent.client_secret,
    status: paymentIntent.status,
    livemode: paymentIntent.livemode,
    amount: paymentIntent.amount,
    currency: paymentIntent.currency,
    amountBeforeCents: amountCents,
    amountAfterCents: amountCents,
    captureMethod,
    vehicleRentalBookingPublicId: booking.public_id,
    listingPublicId: booking.listing_public_id,
  }), {
    status: 200,
    headers,
  });
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

  if (!STRIPE_SECRET_KEY) {
    return new Response(JSON.stringify({ error: 'Stripe is not configured.' }), {
      status: 500,
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

  const placement = normalizePlacement(payload.placement);
  const currency = normalizeCurrency(payload.currency);
  if (placement === 'short_term_booking') {
    try {
      return await handleShortTermBookingPayment(payload, headers);
    } catch (err) {
      const status = err instanceof RequestError ? err.status : 500;
      const message = err instanceof Error ? err.message : 'Unable to create booking payment.';
      return new Response(JSON.stringify({ error: message }), {
        status,
        headers,
      });
    }
  }

  if (placement === 'vehicle_rental_booking') {
    try {
      return await handleVehicleRentalBookingPayment(payload, headers);
    } catch (err) {
      const status = err instanceof RequestError ? err.status : 500;
      const message = err instanceof Error ? err.message : 'Unable to create vehicle rental payment.';
      return new Response(JSON.stringify({ error: message }), {
        status,
        headers,
      });
    }
  }

  const requestedAmount = Number(payload.amount || 0);
  const configuredAmount = USD_PRICING[placement];
  const baseAmount = Number.isFinite(configuredAmount) ? configuredAmount : requestedAmount;
  const paymentMethod = String(payload.paymentMethod || '').trim().toLowerCase();
  const promoCode = normalizePromoCode(payload.promoCode);
  const customerRef = normalizeCustomerRef(payload.customerRef);

  if (!placement) {
    return new Response(JSON.stringify({ error: 'Missing placement.' }), {
      status: 400,
      headers,
    });
  }

  if (!Number.isFinite(baseAmount) || baseAmount <= 0) {
    return new Response(JSON.stringify({ error: 'Invalid amount.' }), {
      status: 400,
      headers,
    });
  }

  if (currency !== 'usd') {
    return new Response(JSON.stringify({ error: 'Only USD payments are supported in Stripe payment element.' }), {
      status: 400,
      headers,
    });
  }

  if (Number.isFinite(configuredAmount) && Math.abs(requestedAmount - configuredAmount) > 0.001) {
    return new Response(JSON.stringify({
      error: 'Amount mismatch for placement.',
      expectedAmount: configuredAmount,
    }), {
      status: 400,
      headers,
    });
  }

  const amountBeforeCents = amountToCents(baseAmount);

  let promo: PromoValidation | null = null;
  if (promoCode) {
    try {
      promo = await validatePromoCode({
        code: promoCode,
        placement,
        currency,
        amountBeforeCents,
        customerRef,
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
  }

  const amountAfterCents = promo ? promo.amountAfterCents : amountBeforeCents;
  if (!Number.isFinite(amountAfterCents) || amountAfterCents <= 0) {
    return new Response(JSON.stringify({ error: 'Invalid final amount.' }), {
      status: 400,
      headers,
    });
  }

  try {
    const metadata: Record<string, string> = {
      app: 'marketplace_2026',
      placement,
      amount_before_cents: String(amountBeforeCents),
      amount_after_cents: String(amountAfterCents),
    };
    if (paymentMethod) metadata.payment_method = paymentMethod;
    if (customerRef) metadata.customer_ref = customerRef;

    if (promo) {
      metadata.promo_code = promo.code;
      metadata.promo_code_id = String(promo.promoCodeId);
      metadata.promo_discount_cents = String(promo.discountCents);
      metadata.promo_amount_before_cents = String(promo.amountBeforeCents);
      metadata.promo_amount_after_cents = String(promo.amountAfterCents);
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountAfterCents,
      currency,
      automatic_payment_methods: { enabled: true },
      metadata,
    });

    return new Response(JSON.stringify({
      ok: true,
      id: paymentIntent.id,
      clientSecret: paymentIntent.client_secret,
      status: paymentIntent.status,
      livemode: paymentIntent.livemode,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      amountBeforeCents,
      amountAfterCents,
      discountCents: promo ? promo.discountCents : 0,
      promoCode: promo ? promo.code : null,
      promoCodeId: promo ? promo.promoCodeId : null,
      amountBefore: centsToAmount(amountBeforeCents),
      amountAfter: centsToAmount(amountAfterCents),
      discountAmount: centsToAmount(promo ? promo.discountCents : 0),
    }), {
      status: 200,
      headers,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Stripe payment intent creation failed.';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers,
    });
  }
});
