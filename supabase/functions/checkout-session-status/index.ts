import Stripe from 'https://esm.sh/stripe@14.25.0?target=denonext';

const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY') || '';
const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

function corsHeaders(origin: string | null): HeadersInit {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
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

  const sessionId = String(payload.sessionId || '').trim();
  if (!sessionId) {
    return new Response(JSON.stringify({ error: 'Missing sessionId.' }), {
      status: 400,
      headers,
    });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const paid = session.status === 'complete' && session.payment_status === 'paid';

    return new Response(JSON.stringify({
      ok: true,
      paid,
      status: session.status,
      payment_status: session.payment_status,
      id: session.id,
      amount_total: session.amount_total,
      currency: session.currency,
      metadata: session.metadata || {},
    }), {
      status: 200,
      headers,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unable to fetch session status.';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers,
    });
  }
});
