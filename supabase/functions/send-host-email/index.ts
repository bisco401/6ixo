import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') || '';
const HOST_EMAIL_FROM = Deno.env.get('HOST_EMAIL_FROM') || 'noreply@example.com';

const supabaseAdmin = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

type HostApplicationRow = {
  id: string;
  user_id: string;
  email: string;
  legal_name: string | null;
  city: string | null;
  country: string | null;
  listing_city: string | null;
  property_type: string | null;
  rental_city?: string | null;
  applicant_type?: string | null;
  status: string;
  submitted_at: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
};

type ProfileRow = {
  id: string;
  full_name: string | null;
  first_name: string | null;
  email: string | null;
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

function normalizeEventType(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function getAuthenticatedUser(req: Request) {
  if (!supabaseAdmin) {
    throw new RequestError(500, 'Supabase admin client is not configured.');
  }
  const authHeader = req.headers.get('authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) throw new RequestError(401, 'Missing authorization token.');
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) {
    throw new RequestError(401, 'Unable to validate user session.');
  }
  return data.user;
}

async function getProfile(userId: string): Promise<ProfileRow | null> {
  if (!supabaseAdmin) throw new RequestError(500, 'Supabase admin client is not configured.');
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('id, full_name, first_name, email, is_admin')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  return (data as ProfileRow | null) || null;
}

async function getHostApplication(applicationId: string, applicationType: string): Promise<HostApplicationRow> {
  if (!supabaseAdmin) throw new RequestError(500, 'Supabase admin client is not configured.');
  const table = applicationType === 'vehicle_rental' ? 'vehicle_host_applications' : 'host_applications';
  const { data, error } = await supabaseAdmin
    .from(table)
    .select('*')
    .eq('id', applicationId)
    .single();
  if (error || !data) throw new RequestError(404, 'Host application not found.');
  return data as HostApplicationRow;
}

function buildEmailCopy(eventType: string, application: HostApplicationRow, profile: ProfileRow | null, applicationType: string) {
  const displayName = String(
    application.legal_name
    || profile?.full_name
    || profile?.first_name
    || 'there'
  ).trim();
  const isVehicleApplication = applicationType === 'vehicle_rental';
  const listingLocation = [isVehicleApplication ? application.rental_city : application.listing_city, application.country].filter(Boolean).join(', ');
  const applicationLabel = isVehicleApplication ? 'car rental application' : 'host application';
  const listingLabel = isVehicleApplication ? 'your rental vehicle operation' : 'your short-term rental listing';
  const approvalOutcome = isVehicleApplication ? 'You can now publish rental vehicle listings.' : 'You can now publish short-term rental listings.';
  const reviewNotes = String(application.review_notes || '').trim();

  if (eventType === 'submitted') {
    return {
      subject: isVehicleApplication ? 'Car rental application received' : 'Host application received',
      html: `
        <p>Hi ${escapeHtml(displayName)},</p>
        <p>We received your ${escapeHtml(applicationLabel)} for ${escapeHtml(listingLocation || listingLabel)}.</p>
        <p>Our team will review your details and email you once a decision is made.</p>
        <p>Status: <strong>Pending review</strong></p>
      `,
      text: `Hi ${displayName},\n\nWe received your ${applicationLabel} for ${listingLocation || listingLabel}. Our team will review it and email you when a decision is made.\n\nStatus: Pending review`,
    };
  }

  if (eventType === 'approved') {
    return {
      subject: isVehicleApplication ? 'Car rental application approved' : 'Host application approved',
      html: `
        <p>Hi ${escapeHtml(displayName)},</p>
        <p>Your ${escapeHtml(applicationLabel)} has been approved. ${escapeHtml(approvalOutcome)}</p>
        ${reviewNotes ? `<p>Review notes: ${escapeHtml(reviewNotes)}</p>` : ''}
      `,
      text: `Hi ${displayName},\n\nYour ${applicationLabel} has been approved. ${approvalOutcome}${reviewNotes ? `\n\nReview notes: ${reviewNotes}` : ''}`,
    };
  }

  if (eventType === 'rejected') {
    return {
      subject: isVehicleApplication ? 'Car rental application update' : 'Host application update',
      html: `
        <p>Hi ${escapeHtml(displayName)},</p>
        <p>Your ${escapeHtml(applicationLabel)} was not approved at this time.</p>
        ${reviewNotes ? `<p>Review notes: ${escapeHtml(reviewNotes)}</p>` : ''}
        <p>You can update your application and apply again.</p>
      `,
      text: `Hi ${displayName},\n\nYour ${applicationLabel} was not approved at this time.${reviewNotes ? `\n\nReview notes: ${reviewNotes}` : ''}\n\nYou can update your application and apply again.`,
    };
  }

  if (eventType === 'needs_more_info') {
    return {
      subject: `More information needed for your ${applicationLabel}`,
      html: `
        <p>Hi ${escapeHtml(displayName)},</p>
        <p>We need more information before approving your ${escapeHtml(applicationLabel)}.</p>
        ${reviewNotes ? `<p>Review notes: ${escapeHtml(reviewNotes)}</p>` : ''}
        <p>Please update your application and resubmit it.</p>
      `,
      text: `Hi ${displayName},\n\nWe need more information before approving your ${applicationLabel}.${reviewNotes ? `\n\nReview notes: ${reviewNotes}` : ''}\n\nPlease update your application and resubmit it.`,
    };
  }

  throw new RequestError(400, 'Unsupported host email event type.');
}

async function sendEmail({ to, subject, html, text }: { to: string; subject: string; html: string; text: string; }) {
  if (!RESEND_API_KEY) {
    return { delivered: false, skipped: true, reason: 'Missing RESEND_API_KEY.' };
  }

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

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON payload.' }), {
      status: 400,
      headers,
    });
  }

  try {
    const user = await getAuthenticatedUser(req);
    const applicationId = String(body.applicationId || '').trim();
    const eventType = normalizeEventType(body.eventType);
    const applicationType = normalizeEventType(body.applicationType) === 'vehicle_rental' ? 'vehicle_rental' : 'short_term';

    if (!applicationId) throw new RequestError(400, 'applicationId is required.');
    if (!['submitted', 'approved', 'rejected', 'needs_more_info'].includes(eventType)) {
      throw new RequestError(400, 'Unsupported host email event type.');
    }

    const application = await getHostApplication(applicationId, applicationType);
    const callerProfile = await getProfile(String(user.id || '').trim());
    const targetProfile = await getProfile(String(application.user_id || '').trim());
    const callerIsAdmin = callerProfile?.is_admin === true;
    const callerOwnsApplication = String(application.user_id || '').trim() === String(user.id || '').trim();

    if (eventType === 'submitted') {
      if (!callerOwnsApplication && !callerIsAdmin) {
        throw new RequestError(403, 'You can only send a submission email for your own application.');
      }
    } else if (!callerIsAdmin) {
      throw new RequestError(403, 'Admin access required for review emails.');
    }

    const emailCopy = buildEmailCopy(eventType, application, targetProfile, applicationType);
    const recipient = String(application.email || targetProfile?.email || '').trim();
    if (!recipient) throw new RequestError(400, 'Application email is missing.');

    const delivery = await sendEmail({
      to: recipient,
      subject: emailCopy.subject,
      html: emailCopy.html,
      text: emailCopy.text,
    });

    return new Response(JSON.stringify({
      ok: true,
      applicationId,
      eventType,
      applicationType,
      delivery,
    }), {
      status: 200,
      headers,
    });
  } catch (error) {
    const status = error instanceof RequestError ? error.status : 500;
    const message = error instanceof Error ? error.message : 'Unexpected error.';
    return new Response(JSON.stringify({ error: message }), {
      status,
      headers,
    });
  }
});
