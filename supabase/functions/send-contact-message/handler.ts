type ContactConfig = {
  supabaseUrl: string;
  serviceRoleKey: string;
  resendApiKey: string;
  sender: string;
};

class ContactError extends Error {
  constructor(public status: number, message: string, public retryAfter = 0) {
    super(message);
  }
}

const MAX_BODY_BYTES = 24_000;
const ALLOWED_ORIGINS = new Set(['https://6ixo.com', 'https://www.6ixo.com']);

async function readPayload(req: Request): Promise<Record<string, unknown>> {
  if (!req.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new ContactError(415, 'Send the contact form as JSON.');
  }
  if (Number(req.headers.get('content-length')) > MAX_BODY_BYTES) {
    throw new ContactError(413, 'Your message is too long. Please shorten it and try again.');
  }
  const reader = req.body?.getReader();
  if (!reader) throw new ContactError(400, 'Please complete the contact form.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new ContactError(413, 'Your message is too long. Please shorten it and try again.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error();
    return payload;
  } catch { throw new ContactError(400, 'Please complete the contact form and try again.'); }
}

function field(payload: Record<string, unknown>, key: string, label: string, max: number): string {
  const value = typeof payload[key] === 'string' ? payload[key].trim() : '';
  if (!value || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ContactError(400, `Enter a valid ${label} (up to ${max} characters).`);
  }
  return value;
}

async function digest(value: string, secret?: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const result = secret
    ? await crypto.subtle.sign('HMAC', await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    ), bytes)
    : await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function createContactHandler(config: ContactConfig, request = fetch) {
  return async (req: Request): Promise<Response> => {
    const origin = req.headers.get('origin') || '';
    const headers = new Headers({
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Vary': 'Origin',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type, apikey, authorization, x-client-info',
      'Access-Control-Expose-Headers': 'Retry-After',
    });
    if (ALLOWED_ORIGINS.has(origin)) headers.set('Access-Control-Allow-Origin', origin);
    const respond = (body: Record<string, unknown>, status: number) => new Response(JSON.stringify(body), { status, headers });
    try {
      if (!ALLOWED_ORIGINS.has(origin)) throw new ContactError(403, 'Please use the contact form on 6ixo.com.');
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
      if (req.method !== 'POST') { headers.set('Allow', 'POST, OPTIONS'); throw new ContactError(405, 'Use the contact form to send a message.'); }
      const payload = await readPayload(req);
      if (payload.website) throw new ContactError(400, 'Please refresh the contact form and try again.');
      const name = field(payload, 'name', 'name', 100);
      const email = field(payload, 'email', 'email address', 254).toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ContactError(400, 'Enter a valid email address.');
      const subject = field(payload, 'subject', 'subject', 150);
      const message = typeof payload.message === 'string' ? payload.message.trim() : '';
      if (!message || message.length > 5000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(message)) {
        throw new ContactError(400, 'Enter a message of up to 5,000 characters.');
      }
      const requestId = String(payload.requestId || '');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
        throw new ContactError(400, 'Please refresh the contact form and try again.');
      }
      if (!config.supabaseUrl || !config.serviceRoleKey || !config.resendApiKey || !config.sender) {
        throw new ContactError(503, 'Contact support is temporarily unavailable. Your message has not been sent.');
      }
      // IP is only a supplementary limit; the email and global limits also apply.
      // Store keyed daily hashes, never the visitor's IP or email, in quota records.
      const clientIp = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
      const day = new Date().toISOString().slice(0, 10);
      const quotaResponse = await request(`${config.supabaseUrl}/rest/v1/rpc/consume_contact_message_quota`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: config.serviceRoleKey, Authorization: `Bearer ${config.serviceRoleKey}` },
        body: JSON.stringify({
          p_ip_hash: await digest(`ip:${day}:${clientIp}`, config.serviceRoleKey),
          p_email_hash: await digest(`email:${day}:${email}`, config.serviceRoleKey),
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!quotaResponse.ok) throw new ContactError(503, 'Contact support is temporarily unavailable. Please try again shortly.');
      const quotaData = await quotaResponse.json();
      const quota = Array.isArray(quotaData) ? quotaData[0] : quotaData;
      if (quota?.allowed !== true) {
        throw new ContactError(429, 'Too many messages have been sent. Please wait before trying again.', Math.max(1, Number(quota?.retry_after_seconds) || 3600));
      }
      const idempotencyKey = await digest(JSON.stringify([requestId, name, email, subject, message]));
      const emailResponse = await request('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `6ixo-contact/${idempotencyKey}` },
        body: JSON.stringify({
          from: config.sender,
          to: ['contact@6ixo.com'],
          reply_to: email,
          subject: `[6ixo Contact] ${subject}`,
          text: `Name: ${name}\nEmail: ${email}\n\n${message}\n\nReference: ${requestId}`,
        }),
        signal: AbortSignal.timeout(12000),
      });
      const result = await emailResponse.json().catch(() => null);
      if (!emailResponse.ok || typeof result?.id !== 'string' || !result.id) {
        throw new ContactError(502, 'We could not confirm your message was sent. Please try again shortly.');
      }
      return respond({ accepted: true, reference: requestId }, 200);
    } catch (error) {
      const known = error instanceof ContactError;
      if (known && error.retryAfter) headers.set('Retry-After', String(error.retryAfter));
      // Do not expose provider responses, credentials or message content in errors.
      return respond({ accepted: false, error: known ? error.message : 'We could not confirm your message was sent. Please try again shortly.' }, known ? error.status : 503);
    }
  };
}
