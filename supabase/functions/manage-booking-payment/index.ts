import { refundRentalPayment } from '../_shared/rental-settlement.ts';
import { acquireRentalPaymentLock, releaseRentalPaymentLock } from '../_shared/rental-payment-lock.ts';
import Stripe from 'https://esm.sh/stripe@14.25.0?target=denonext';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8';

const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY') || '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
  timeout: 15000,
  maxNetworkRetries: 1,
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
  guest_user_id: string | null;
  checkin_date: string | null;
  pickup_date: string | null;
  status: string;
  payment_status: string;
  stripe_payment_intent_id: string | null;
  payment_payload: Record<string, unknown> | null;
  booking_payload?: Record<string, unknown>;
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
  const dateField = bookingType === 'vehicle_rental' ? 'pickup_date' : 'checkin_date, booking_payload';
  const { data, error } = await supabaseAdmin
    .from(table)
    .select(`id, public_id, host_user_id, guest_user_id, ${dateField}, status, payment_status, stripe_payment_intent_id, payment_payload`)
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

  let lockToken: string | null = null;
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

    let booking = await fetchBooking(bookingPublicId, bookingType);
    const admin = await isAdminUser(user.id);
    const isHost = booking.host_user_id === user.id;
    const isGuest = booking.guest_user_id === user.id;
    if (!isHost && !isGuest && !admin) {
      throw new RequestError(403, 'Booking participant access required.');
    }
    if (bookingType === 'short_term') {
      lockToken = await acquireRentalPaymentLock(supabaseAdmin, bookingPublicId, user.id);
      booking = await fetchBooking(bookingPublicId, bookingType);
    }
    if (action === 'cancel' && ['cancelled', 'declined'].includes(booking.status) && ['refunded', 'cancelled'].includes(booking.payment_status)) {
      return new Response(JSON.stringify({ ok: true, action, booking }), { status: 200, headers });
    }
    if (action === 'capture' && (isHost || admin) && booking.status === 'confirmed' && booking.payment_status === 'paid') {
      return new Response(JSON.stringify({ ok: true, action, booking }), { status: 200, headers });
    }
    if (action === 'capture' && !isHost && !admin) {
      throw new RequestError(403, 'Host access required to capture a booking payment.');
    }
    if (action === 'capture') {
      if (normalizeAction(booking.status) !== 'requested') {
        throw new RequestError(409, 'Only an open booking request can be approved.');
      }
      if (!['authorized', 'paid'].includes(normalizeAction(booking.payment_status))) {
        throw new RequestError(409, 'Wait for a successful guest payment authorization before approving this booking.');
      }
    }
    if (action === 'cancel' && isGuest && !isHost && !admin) {
      const startDate = normalizeText(bookingType === 'vehicle_rental' ? booking.pickup_date : booking.checkin_date);
      const deadline = bookingType === 'short_term' ? booking.booking_payload?.cancellationDeadline : null;
      const startTime = deadline ? new Date(String(deadline)).getTime() + 24 * 60 * 60 * 1000 : startDate ? new Date(`${startDate}T00:00:00Z`).getTime() : NaN;
      const paymentStatus = normalizeAction(booking.payment_status);
      const hasCapturedPayment = ['paid', 'processing'].includes(paymentStatus);
      if (hasCapturedPayment && Number.isFinite(startTime) && startTime - Date.now() < 24 * 60 * 60 * 1000) {
        throw new RequestError(409, 'Online cancellation closes 24 hours before the booking starts. Contact support for help.');
      }
    }

    const intentId = normalizeText(booking.stripe_payment_intent_id);
    if (!intentId && action === 'capture') {
      throw new RequestError(400, 'Booking has no Stripe payment to capture.');
    }

    if (action === 'capture') {
      const intent = await stripe.paymentIntents.retrieve(intentId);
      let finalIntent = intent;
      if (intent.status === 'requires_capture') {
        finalIntent = await stripe.paymentIntents.capture(intent.id, {}, { idempotencyKey: `booking-capture:${intent.id}` });
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

    const resolvedNextStatus = isGuest && !isHost && !admin
      ? 'cancelled'
      : (nextStatus === 'cancelled' ? 'cancelled' : 'declined');
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
        const refund = bookingType === 'short_term'
          ? await refundRentalPayment(supabaseAdmin, stripe, booking, intent, resolvedNextStatus)
          : await stripe.refunds.create({
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
          idempotencyKey: `booking-refund:${booking.booking_type || 'short_term'}:${booking.public_id}:${intent.id}`,
        });
        refundId = refund.id;
        if (refund.status === 'failed' || refund.status === 'canceled') throw new RequestError(502, 'The refund could not be completed. Please contact support.');
        paymentStatus = refund.status === 'succeeded' ? 'refunded' : 'processing';
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
          stripePaymentCancelledByRole: isGuest && !isHost && !admin ? 'guest' : (admin ? 'admin' : 'host'),
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
    const status = err instanceof RequestError ? err.status : (err as { status?: number })?.status || 500;
    const message = err instanceof Error ? err.message : 'Unable to manage booking payment.';
    return new Response(JSON.stringify({ error: message }), {
      status,
      headers,
    });
  } finally {
    await releaseRentalPaymentLock(supabaseAdmin, lockToken);
  }
});
