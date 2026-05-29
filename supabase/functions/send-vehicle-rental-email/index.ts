import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') || '';
const HOST_EMAIL_FROM = Deno.env.get('HOST_EMAIL_FROM') || 'noreply@example.com';

const supabaseAdmin = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

type VehicleRentalBookingRow = {
  id: string;
  public_id: string;
  listing_title: string;
  host_user_id: string | null;
  host_name: string | null;
  host_email: string | null;
  guest_user_id: string | null;
  guest_name: string;
  guest_email: string;
  guest_phone: string | null;
  driver_name: string | null;
  driver_license_number: string | null;
  driver_license_region: string | null;
  pickup_date: string;
  return_date: string;
  total: number | string;
  currency: string | null;
  status: string;
  payment_status: string;
};

type ProfileRow = {
  id: string;
  email: string | null;
  full_name: string | null;
  first_name: string | null;
  is_admin: boolean | null;
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

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizeEventType(value: unknown): string {
  const text = String(value || '').trim().toLowerCase();
  if (['booking_requested', 'booking_confirmed', 'booking_approved', 'booking_declined'].includes(text)) return text;
  return 'booking_requested';
}

function money(value: unknown, currency: unknown): string {
  const amount = Number(value);
  const code = String(currency || 'USD').trim().toUpperCase() || 'USD';
  if (!Number.isFinite(amount)) return `${code} 0`;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: code,
      maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
    }).format(amount);
  } catch {
    return `${code} ${amount.toFixed(2)}`;
  }
}

async function getAuthenticatedUser(req: Request) {
  if (!supabaseAdmin) throw new RequestError(500, 'Supabase admin client is not configured.');
  const authHeader = req.headers.get('authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) throw new RequestError(401, 'Missing authorization token.');
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user?.id) throw new RequestError(401, 'Unable to validate user session.');
  return data.user;
}

async function getProfile(userId: string): Promise<ProfileRow | null> {
  if (!supabaseAdmin || !userId) return null;
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('id, email, full_name, first_name, is_admin')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  return (data as ProfileRow | null) || null;
}

async function getBooking(publicId: string): Promise<VehicleRentalBookingRow> {
  if (!supabaseAdmin) throw new RequestError(500, 'Supabase admin client is not configured.');
  const { data, error } = await supabaseAdmin
    .from('vehicle_rental_bookings')
    .select('id, public_id, listing_title, host_user_id, host_name, host_email, guest_user_id, guest_name, guest_email, guest_phone, driver_name, driver_license_number, driver_license_region, pickup_date, return_date, total, currency, status, payment_status')
    .eq('public_id', publicId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new RequestError(404, 'Vehicle rental booking not found.');
  return data as VehicleRentalBookingRow;
}

async function sendEmail({ to, subject, html, text }: { to: string; subject: string; html: string; text: string }) {
  if (!to) return { delivered: false, skipped: true, reason: 'Missing recipient.' };
  if (!RESEND_API_KEY) return { delivered: false, skipped: true, reason: 'Missing RESEND_API_KEY.' };

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: HOST_EMAIL_FROM,
      to: [to],
      subject,
      html,
      text,
    }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new RequestError(502, `Email delivery failed: ${message || response.statusText}`);
  }

  const payload = await response.json().catch(() => ({}));
  return { delivered: true, skipped: false, provider: 'resend', payload };
}

function buildCopy(eventType: string, booking: VehicleRentalBookingRow, recipientName: string, recipientRole: 'host' | 'guest') {
  const hostName = String(booking.host_name || 'Host').trim();
  const guestName = String(booking.guest_name || 'Guest').trim();
  const range = `${booking.pickup_date} to ${booking.return_date}`;
  const total = money(booking.total, booking.currency);
  const driverLine = `Driver: ${booking.driver_name || guestName}; license: ${booking.driver_license_number || 'not provided'} (${booking.driver_license_region || 'region not provided'})`;
  const contactLine = `Guest contact: ${booking.guest_email}${booking.guest_phone ? `, ${booking.guest_phone}` : ''}`;

  if (recipientRole === 'guest') {
    const approved = eventType === 'booking_approved';
    return {
      subject: approved ? 'Your vehicle rental was approved' : 'Vehicle rental request update',
      html: `
        <p>Hi ${escapeHtml(recipientName || guestName)},</p>
        <p>Your request for <strong>${escapeHtml(booking.listing_title)}</strong> was ${approved ? 'approved' : 'declined'}.</p>
        <p>Trip: ${escapeHtml(range)} · Total: ${escapeHtml(total)}</p>
        ${approved ? '<p>The host has approved the trip and payment has been captured.</p>' : '<p>The host declined the request and any authorization was released or refunded.</p>'}
      `,
      text: `Hi ${recipientName || guestName},\n\nYour request for ${booking.listing_title} was ${approved ? 'approved' : 'declined'}.\nTrip: ${range}\nTotal: ${total}`,
    };
  }

  const instant = eventType === 'booking_confirmed';
  return {
    subject: instant ? 'New paid vehicle rental booking' : 'New vehicle rental request',
    html: `
      <p>Hi ${escapeHtml(recipientName || hostName)},</p>
      <p>${escapeHtml(guestName)} ${instant ? 'booked' : 'requested'} <strong>${escapeHtml(booking.listing_title)}</strong>.</p>
      <p>Trip: ${escapeHtml(range)} · Total: ${escapeHtml(total)} · Payment: ${escapeHtml(booking.payment_status)}</p>
      <p>${escapeHtml(contactLine)}</p>
      <p>${escapeHtml(driverLine)}</p>
      ${instant ? '' : '<p>Open your host dashboard to approve or decline this request.</p>'}
    `,
    text: `Hi ${recipientName || hostName},\n\n${guestName} ${instant ? 'booked' : 'requested'} ${booking.listing_title}.\nTrip: ${range}\nTotal: ${total}\nPayment: ${booking.payment_status}\n${contactLine}\n${driverLine}${instant ? '' : '\n\nOpen your host dashboard to approve or decline this request.'}`,
  };
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  const headers = corsHeaders(origin);

  if (req.method === 'OPTIONS') return new Response('ok', { headers });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed.' }), { status: 405, headers });
  }

  try {
    const user = await getAuthenticatedUser(req);
    const payload = await req.json().catch(() => ({}));
    const bookingPublicId = String(payload.bookingPublicId || payload.booking_public_id || '').trim();
    const eventType = normalizeEventType(payload.eventType);
    if (!bookingPublicId) throw new RequestError(400, 'bookingPublicId is required.');

    const booking = await getBooking(bookingPublicId);
    const callerProfile = await getProfile(String(user.id || '').trim());
    const callerIsAdmin = callerProfile?.is_admin === true;
    const callerIsGuest = String(booking.guest_user_id || '') === String(user.id || '');
    const callerIsHost = String(booking.host_user_id || '') === String(user.id || '');
    if (!callerIsGuest && !callerIsHost && !callerIsAdmin) {
      throw new RequestError(403, 'Booking participant access required.');
    }

    const hostProfile = booking.host_user_id ? await getProfile(booking.host_user_id) : null;
    const guestProfile = booking.guest_user_id ? await getProfile(booking.guest_user_id) : null;
    const notifyGuest = eventType === 'booking_approved' || eventType === 'booking_declined';
    const recipient = notifyGuest
      ? String(booking.guest_email || guestProfile?.email || '').trim()
      : String(booking.host_email || hostProfile?.email || '').trim();
    const recipientName = notifyGuest
      ? String(guestProfile?.full_name || guestProfile?.first_name || booking.guest_name || '').trim()
      : String(hostProfile?.full_name || hostProfile?.first_name || booking.host_name || '').trim();
    const copy = buildCopy(eventType, booking, recipientName, notifyGuest ? 'guest' : 'host');
    const delivery = await sendEmail({
      to: recipient,
      subject: copy.subject,
      html: copy.html,
      text: copy.text,
    });

    return new Response(JSON.stringify({
      ok: true,
      bookingPublicId,
      eventType,
      recipient: recipient ? 'resolved' : 'missing',
      delivery,
    }), { status: 200, headers });
  } catch (error) {
    const status = error instanceof RequestError ? error.status : 500;
    const message = error instanceof Error ? error.message : 'Unexpected error.';
    return new Response(JSON.stringify({ error: message }), { status, headers });
  }
});
