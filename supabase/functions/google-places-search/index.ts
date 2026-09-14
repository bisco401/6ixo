// Retired endpoint: older clients must not create paid Google Places requests.
Deno.serve((req) => {
  const origin = req.headers.get('origin') || '';
  const allowed = ['https://6ixo.com', 'https://www.6ixo.com'].includes(origin)
    || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Vary': 'Origin',
  };
  if (allowed) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Headers'] = 'authorization, x-client-info, apikey, content-type';
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
  }
  if (req.method === 'OPTIONS') return new Response(null, { status: allowed ? 204 : 403, headers });
  return new Response(JSON.stringify({ places: [], retired: true }), { status: allowed ? 200 : 403, headers });
});
