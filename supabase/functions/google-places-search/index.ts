import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8';

const GOOGLE_MAPS_SERVER_API_KEY = Deno.env.get('GOOGLE_MAPS_SERVER_API_KEY') || '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

const supabaseAdmin = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

const PRODUCTION_ORIGINS = new Set([
  'https://6ixo.com',
  'https://www.6ixo.com',
]);
const LOCAL_ORIGIN_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;
const GOOGLE_PLACES_URL = 'https://places.googleapis.com/v1/places:searchText';
const GOOGLE_FIELD_MASK = 'places.id,places.displayName,places.formattedAddress,places.location,places.businessStatus';
const MAX_REQUESTS_PER_MINUTE = 5;
const MAX_REQUESTS_PER_DAY = 25;
const MAX_GLOBAL_REQUESTS_PER_DAY = 150;

class RequestError extends Error {
  status: number;
  retryAfter?: number;

  constructor(status: number, message: string, retryAfter?: number) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return true;
  return PRODUCTION_ORIGINS.has(origin) || LOCAL_ORIGIN_PATTERN.test(origin);
}

function responseHeaders(origin: string | null): HeadersInit {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Cache-Control': 'private, no-store',
    'Content-Type': 'application/json',
    'Vary': 'Origin',
  };
  if (origin && isAllowedOrigin(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function jsonResponse(
  body: Record<string, unknown>,
  status: number,
  origin: string | null,
  retryAfter?: number,
): Response {
  const headers = new Headers(responseHeaders(origin));
  if (retryAfter) headers.set('Retry-After', String(retryAfter));
  return new Response(JSON.stringify(body), { status, headers });
}

async function getAuthenticatedUser(req: Request) {
  if (!supabaseAdmin) throw new RequestError(500, 'Places authentication is not configured.');
  const token = String(req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) throw new RequestError(401, 'Sign in to search live nearby places.');
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user?.id) throw new RequestError(401, 'Your session could not be verified. Please sign in again.');
  return data.user;
}

async function consumeRateLimit(userId: string): Promise<void> {
  if (!supabaseAdmin) throw new RequestError(500, 'Places authentication is not configured.');
  const { data, error } = await supabaseAdmin.rpc('consume_google_places_quota', {
    p_user_id: userId,
    p_minute_limit: MAX_REQUESTS_PER_MINUTE,
    p_day_limit: MAX_REQUESTS_PER_DAY,
    p_global_day_limit: MAX_GLOBAL_REQUESTS_PER_DAY,
  });
  if (error) {
    console.error('Google Places quota check failed with code', error.code || 'unknown');
    throw new RequestError(503, 'Nearby search is temporarily unavailable.');
  }

  const result = Array.isArray(data) ? data[0] : data;
  if (result?.allowed === true) return;

  const retryAfter = Math.max(1, Number(result?.retry_after_seconds) || 60);
  if (result?.limit_reason === 'user_minute') {
    throw new RequestError(429, 'Too many nearby searches. Please wait a moment.', retryAfter);
  }
  if (result?.limit_reason === 'user_day') {
    throw new RequestError(429, 'Your daily nearby-search limit has been reached.', retryAfter);
  }
  if (result?.limit_reason === 'global_day') {
    throw new RequestError(429, 'Nearby search has reached today\'s safety limit.', retryAfter);
  }
  throw new RequestError(503, 'Nearby search is temporarily unavailable.');
}

function normalizeQuery(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 100);
}

function toCoordinate(value: unknown, min: number, max: number, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new RequestError(400, `${label} is invalid.`);
  }
  return parsed;
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');

  if (!isAllowedOrigin(origin)) {
    return jsonResponse({ error: 'Origin is not allowed.' }, 403, null);
  }
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: responseHeaders(origin) });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, 405, origin);
  }
  if (!GOOGLE_MAPS_SERVER_API_KEY) {
    return jsonResponse({ error: 'Nearby search is not configured.' }, 500, origin);
  }

  try {
    const user = await getAuthenticatedUser(req);

    let payload: Record<string, unknown> = {};
    try {
      payload = await req.json();
    } catch {
      throw new RequestError(400, 'Invalid JSON payload.');
    }

    const query = normalizeQuery(payload.query);
    if (query.length < 2) throw new RequestError(400, 'Search query is too short.');
    const latitude = toCoordinate(payload.latitude, -90, 90, 'Latitude');
    const longitude = toCoordinate(payload.longitude, -180, 180, 'Longitude');

    const requestBody: Record<string, unknown> = {
      textQuery: query,
      maxResultCount: 8,
      locationBias: {
        circle: {
          center: { latitude, longitude },
          radius: 20_000,
        },
      },
    };
    if (payload.restaurantIntent === true) requestBody.includedType = 'restaurant';

    await consumeRateLimit(user.id);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    let googleResponse: Response;
    try {
      googleResponse = await fetch(GOOGLE_PLACES_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': GOOGLE_MAPS_SERVER_API_KEY,
          'X-Goog-FieldMask': GOOGLE_FIELD_MASK,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!googleResponse.ok) {
      console.error('Google Places request failed with status', googleResponse.status);
      throw new RequestError(502, 'Nearby search is temporarily unavailable.');
    }

    const googlePayload = await googleResponse.json();
    const places = (Array.isArray(googlePayload?.places) ? googlePayload.places : [])
      .slice(0, 8)
      .map((place: Record<string, unknown>) => {
        const displayName = place?.displayName as Record<string, unknown> | undefined;
        const location = place?.location as Record<string, unknown> | undefined;
        return {
          id: String(place?.id || ''),
          displayName: { text: String(displayName?.text || '') },
          formattedAddress: String(place?.formattedAddress || ''),
          location: {
            latitude: Number(location?.latitude),
            longitude: Number(location?.longitude),
          },
          businessStatus: String(place?.businessStatus || ''),
        };
      });

    return jsonResponse({ places }, 200, origin);
  } catch (error) {
    const status = error instanceof RequestError ? error.status : 500;
    const message = error instanceof RequestError ? error.message : 'Nearby search failed.';
    const retryAfter = error instanceof RequestError ? error.retryAfter : undefined;
    return jsonResponse({ error: message }, status, origin, retryAfter);
  }
});
