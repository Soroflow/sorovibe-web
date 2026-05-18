// Vercel Edge Function — returnerer antal lifetime-køb fra Supabase.
// Bruges af sorovibe.com til at vise live "X af 100 pladser solgt"-counter.
//
// Påkrævede environment variables (allerede sat for stripe-webhook):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//
// Cache: 60 sek edge + 60 sek browser. Counteren behøver ikke real-time —
// hvis nogen lige har købt og counteren viser N-1 i et minut er det fint.

export const config = { runtime: 'edge' };

const MAX_SLOTS = 100;

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': 'https://sorovibe.com',
      'Vary': 'Origin',
      ...extraHeaders,
    },
  });
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': 'https://sorovibe.com',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Vary': 'Origin',
      },
    });
  }

  if (req.method !== 'GET') {
    return jsonResponse({ error: 'method_not_allowed' }, 405);
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error('lifetime-count: missing Supabase env vars');
    // Fallback: returnér 0 så siden ikke breaker
    return jsonResponse({ count: 0, max: MAX_SLOTS, fallback: true }, 200, {
      'Cache-Control': 'no-store',
    });
  }

  try {
    const resp = await fetch(`${supabaseUrl}/rest/v1/rpc/get_lifetime_count`, {
      method: 'POST',
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      console.error('lifetime-count: Supabase RPC failed', resp.status, text);
      return jsonResponse({ count: 0, max: MAX_SLOTS, fallback: true }, 200, {
        'Cache-Control': 'no-store',
      });
    }

    const result = await resp.json();
    // RPC returnerer enten en number direkte eller {result: n}
    const count =
      typeof result === 'number'
        ? result
        : typeof result?.result === 'number'
          ? result.result
          : 0;

    // Cache 60 sek edge + 60 sek browser. stale-while-revalidate for snappy UX.
    return jsonResponse(
      { count, max: MAX_SLOTS },
      200,
      {
        'Cache-Control': 'public, max-age=60, s-maxage=60, stale-while-revalidate=300',
      }
    );
  } catch (err) {
    console.error('lifetime-count: exception', err);
    return jsonResponse({ count: 0, max: MAX_SLOTS, fallback: true }, 200, {
      'Cache-Control': 'no-store',
    });
  }
}
