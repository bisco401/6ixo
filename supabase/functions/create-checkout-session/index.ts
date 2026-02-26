import Stripe from 'https://esm.sh/stripe@14.25.0?target=denonext';

const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY') || '';

if (!STRIPE_SECRET_KEY) {
  console.error('Missing STRIPE_SECRET_KEY secret.');
}

const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

const USD_PRICING: Record<string, number> = {
  arrive_plus: 5.99,
};

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

function amountToCents(amount: number): number {
  return Math.round((Number(amount) || 0) * 100);
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
  const requestedAmount = Number(payload.amount || 0);
  const configuredAmount = USD_PRICING[placement];
  const amount = Number.isFinite(configuredAmount) ? configuredAmount : requestedAmount;

  if (!placement) {
    return new Response(JSON.stringify({ error: 'Missing placement.' }), {
      status: 400,
      headers,
    });
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    return new Response(JSON.stringify({ error: 'Invalid amount.' }), {
      status: 400,
      headers,
    });
  }

  if (currency !== 'usd') {
    return new Response(JSON.stringify({ error: 'Only USD payments are supported in Stripe checkout.' }), {
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

  const host = req.headers.get('origin') || payload.returnOrigin || 'http://localhost:3000';
  const baseUrl = String(host).replace(/\/$/, '');
  const title = String(payload.title || 'Promotion fee').slice(0, 120);
  const subtitle = String(payload.subtitle || '').slice(0, 280);
  const paymentMethod = String(payload.paymentMethod || '').trim().toLowerCase();

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      success_url: `${baseUrl}/?stripe_checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/?stripe_checkout=cancelled`,
      line_items: [
        {
          price_data: {
            currency,
            product_data: {
              name: title,
              description: subtitle || undefined,
            },
            unit_amount: amountToCents(amount),
          },
          quantity: 1,
        },
      ],
      metadata: {
        app: 'marketplace_2026',
        placement,
        payment_method: paymentMethod,
      },
      payment_intent_data: {
        metadata: {
          app: 'marketplace_2026',
          placement,
        },
      },
    });

    return new Response(JSON.stringify({
      ok: true,
      id: session.id,
      url: session.url,
      status: session.status,
      payment_status: session.payment_status,
    }), {
      status: 200,
      headers,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Stripe session creation failed.';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers,
    });
  }
});
