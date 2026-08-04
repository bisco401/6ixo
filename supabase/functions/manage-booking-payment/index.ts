import Stripe from 'https://esm.sh/stripe@14.25.0?target=denonext';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8';

const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY') || '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});
const supabaseAdmin = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

const ALLOWED_ORIGINS = new Set([
  'https://6ixo.com',
  'https://www.6ixo.com',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
]);

type BookingRow = {
  id: string;
  public_id: string;
  host_user_id: string | null;
  status: string;
  payment_status: string;
  stripe_payment_intent_id: string | null;
  payment_payload: Record<string, unknown> | null;
  booking_type?: string;
};

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

class RequestError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
  }
}

function normalizeText(value: unknown): string {
  return String(value || '').trim();
}

function normalizeAction(value: unknown): string {
  return normalizeText(value).toLowerCase();
}

function toJson(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function getAuthenticatedUser(req: Request) {
  if (!supabaseAdmin) throw new RequestError(500, 'Supabase admin client is not configured.');
  const authHeader = req.headers.get('authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) throw new RequestError(401, 'Authentication required.');
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user?.id) throw new RequestError(401, 'Authentication required.');
  return data.user;
}

async function isAdminUser(userId: string): Promise<boolean> {
  if (!supabaseAdmin) return false;
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('is_admin')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  return data?.is_admin === true;
}

function normalizeBookingType(value: unknown): string {
  const text = normalizeText(value).toLowerCase();
  return text === 'vehicle_rental' || text === 'vehicle_rental_booking' ? 'vehicle_rental' : 'short_term';
}

function getBookingTable(bookingType: string): string {
  return bookingType === 'vehicle_rental' ? 'vehicle_rental_bookings' : 'short_term_bookings';
}

async function fetchBooking(publicId: string, bookingType = 'short_term'): Promise<BookingRow> {
  if (!supabaseAdmin) throw new RequestError(500, 'Supabase admin client is not configured.');
  const table = getBookingTable(bookingType);
  const { data, error } = await supabaseAdmin
    .from(table)
    .select('id, public_id, host_user_id, status, payment_status, stripe_payment_intent_id, payment_payload')
    .eq('public_id', publicId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new RequestError(404, 'Booking not found.');
  return { ...(data as BookingRow), booking_type: bookingType };
}

async function updateBooking(booking: BookingRow, patch: Record<string, unknown>) {
  if (!supabaseAdmin) throw new RequestError(500, 'Supabase admin client is not configured.');
  const table = getBookingTable(booking.booking_type || 'short_term');
  const { data, error } = await supabaseAdmin
    .from(table)
    .update(patch)
    .eq('id', booking.id)
    .select('public_id, status, payment_status, stripe_payment_intent_id')
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

function paymentPatch(booking: BookingRow, values: Record<string, unknown>) {
  const payloadValues = toJson(values.payment_payload);
  return {
    ...values,
    payment_payload: {
      ...toJson(booking.payment_payload),
      ...payloadValues,
      managedAt: new Date().toISOString(),
    },
  };
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

  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed.' }), { status: 403, headers });
  }

  try {
    if (!STRIPE_SECRET_KEY) throw new RequestError(500, 'Stripe is not configured.');
    if (!supabaseAdmin) throw new RequestError(500, 'Supabase admin client is not configured.');

    const user = await getAuthenticatedUser(req);
    const payload = await req.json().catch(() => ({}));
    const bookingPublicId = normalizeText(payload.bookingPublicId || payload.booking_public_id);
    const bookingType = normalizeBookingType(payload.bookingType || payload.placement);
    const action = normalizeAction(payload.action);
    const nextStatus = normalizeAction(payload.nextStatus);

    if (!bookingPublicId) throw new RequestError(400, 'Missing bookingPublicId.');
    if (!['capture', 'cancel'].includes(action)) throw new RequestError(400, 'Unsupported booking payment action.');

    const booking = await fetchBooking(bookingPublicId, bookingType);
    const admin = await isAdminUser(user.id);
    if (booking.host_user_id !== user.id && !admin) {
      throw new RequestError(403, 'Host access required.');
    }

    const intentId = normalizeText(booking.stripe_payment_intent_id);
    if (!intentId && action === 'capture') {
      throw new RequestError(400, 'Booking has no Stripe payment to capture.');
    }

    if (action === 'capture') {
      const intent = await stripe.paymentIntents.retrieve(intentId);
      let finalIntent = intent;
      if (intent.status === 'requires_capture') {
        finalIntent = await stripe.paymentIntents.capture(intent.id);
      } else if (intent.status !== 'succeeded') {
        throw new RequestError(400, `Payment is ${intent.status}; it cannot be captured yet.`);
      }

      const paid = finalIntent.status === 'succeeded';
      const updated = await updateBooking(booking, paymentPatch(booking, {
        status: 'confirmed',
        payment_status: paid ? 'paid' : 'processing',
        stripe_payment_captured_at: paid ? new Date().toISOString() : null,
        payment_payload: {
          stripePaymentIntentStatus: finalIntent.status,
          stripePaymentCapturedBy: user.id,
        },
      }));

      return new Response(JSON.stringify({
        ok: true,
        action,
        booking: updated,
        paymentIntentId: finalIntent.id,
        paymentIntentStatus: finalIntent.status,
      }), {
        status: 200,
        headers,
      });
    }

    const resolvedNextStatus = nextStatus === 'cancelled' ? 'cancelled' : 'declined';
    let paymentStatus = 'cancelled';
    let paymentIntentStatus = '';
    let refundId = '';

    if (intentId) {
      const intent = await stripe.paymentIntents.retrieve(intentId);
      paymentIntentStatus = intent.status;
      if (['requires_payment_method', 'requires_confirmation', 'requires_action', 'requires_capture', 'processing'].includes(intent.status)) {
        const cancelled = await stripe.paymentIntents.cancel(intent.id);
        paymentIntentStatus = cancelled.status;
        paymentStatus = 'cancelled';
      } else if (intent.status === 'succeeded') {
        const refund = await stripe.refunds.create({
          payment_intent: intent.id,
          reverse_transfer: true,
          refund_application_fee: true,
          metadata: {
            app: 'marketplace_2026',
            booking_public_id: booking.public_id,
            placement: bookingType === 'vehicle_rental' ? 'vehicle_rental_booking' : 'short_term_booking',
            refund_reason: resolvedNextStatus,
          },
        }, {
          idempotencyKey: `booking-refund:${booking.booking_type || 'short_term'}:${booking.public_id}:${resolvedNextStatus}`,
        });
        refundId = refund.id;
        paymentStatus = 'refunded';
      }
    }

    const updated = await updateBooking(booking, paymentPatch(booking, {
      status: resolvedNextStatus,
      payment_status: paymentStatus,
      stripe_payment_cancelled_at: paymentStatus === 'cancelled' ? new Date().toISOString() : null,
      stripe_payment_refunded_at: paymentStatus === 'refunded' ? new Date().toISOString() : null,
      payment_payload: {
        stripePaymentIntentStatus: paymentIntentStatus,
        stripeRefundId: refundId || null,
        stripePaymentCancelledBy: user.id,
      },
    }));

    return new Response(JSON.stringify({
      ok: true,
      action,
      booking: updated,
      paymentIntentStatus,
      refundId: refundId || null,
    }), {
      status: 200,
      headers,
    });
  } catch (err) {
    const status = err instanceof RequestError ? err.status : 500;
    const message = err instanceof Error ? err.message : 'Unable to manage booking payment.';
    return new Response(JSON.stringify({ error: message }), {
      status,
      headers,
    });
  }
});
