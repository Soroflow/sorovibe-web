// Vercel Edge Function — modtager email-signups fra sorovibe.com og
// tilføjer dem til en Resend audience.
//
// Påkrævede environment variables på Vercel:
//   RESEND_API_KEY      — fra https://resend.com/api-keys
//   RESEND_AUDIENCE_ID  — fra https://resend.com/audiences (klik audience → kopier ID)
//
// Frivillig:
//   ALLOWED_ORIGIN      — fx "https://sorovibe.com" (default: tillader alt)

export const config = { runtime: 'edge' };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

function corsHeaders(req) {
  const allowed = process.env.ALLOWED_ORIGIN || '*';
  const origin = req.headers.get('origin') || '';
  // Hvis ALLOWED_ORIGIN er sat og origin matcher, ekkoer vi den. Ellers wildcard.
  const allow = allowed === '*' ? '*' : (origin === allowed ? origin : allowed);
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

export default async function handler(req) {
  const cors = corsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, 405, cors);
  }

  let payload;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400, cors);
  }

  const email = (payload?.email || '').toString().trim().toLowerCase();
  const lang = payload?.lang === 'en' ? 'en' : 'da';

  if (!email || !EMAIL_RE.test(email) || email.length > 254) {
    return jsonResponse({ error: 'invalid_email' }, 400, cors);
  }

  const apiKey = process.env.RESEND_API_KEY;
  const audienceId = process.env.RESEND_AUDIENCE_ID;

  if (!apiKey || !audienceId) {
    return jsonResponse({ error: 'server_misconfigured' }, 500, cors);
  }

  try {
    const resp = await fetch(
      `https://api.resend.com/audiences/${audienceId}/contacts`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email,
          unsubscribed: false,
          // Resend understøtter ikke tags på contacts endnu, men first_name kan
          // bruges som lille marker på sproget hvis ønsket. Tomt for nu.
        }),
      }
    );

    if (resp.ok) {
      return jsonResponse({ ok: true, lang }, 200, cors);
    }

    // Resend returnerer 422 / "validation_error" når contact allerede findes —
    // det skal brugeren ikke straffes for, returnér success.
    const data = await resp.json().catch(() => ({}));
    const msg = (data?.message || '').toLowerCase();
    if (resp.status === 422 || msg.includes('already exists') || msg.includes('contact already')) {
      return jsonResponse({ ok: true, lang, alreadySubscribed: true }, 200, cors);
    }

    console.error('Resend error', resp.status, data);
    return jsonResponse({ error: 'subscribe_failed' }, 502, cors);
  } catch (err) {
    console.error('subscribe exception', err);
    return jsonResponse({ error: 'network_error' }, 500, cors);
  }
}
