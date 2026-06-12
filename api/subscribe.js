// Vercel Edge Function — modtager email-signups fra sorovibe.com og:
//   1. Tilføjer kontakten til en Resend Segment
//   2. Sender en welcome-email på det sprog brugeren brugte
//
// Påkrævede environment variables på Vercel:
//   RESEND_API_KEY      — fra https://resend.com/api-keys (Full Access scope)
//   RESEND_SEGMENT_ID   — UUID for den segment der skal modtage signups
//
// Frivillig:
//   ALLOWED_ORIGIN      — fx "https://sorovibe.com" (default: kun apex + www).
//                         Sat strikt for at forhindre cross-site abuse.

export const config = { runtime: 'edge' };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FROM_ADDRESS = 'Sorovibe <noreply@sorovibe.com>';
const REPLY_TO = 'hello@sorovibe.com';

// Hardcoded allowlist hvis ALLOWED_ORIGIN ikke er sat
const DEFAULT_ALLOWED_ORIGINS = [
  'https://sorovibe.com',
  'https://www.sorovibe.com',
];

// ── RATE LIMIT (simpel in-memory pr. Edge-instans) ─────────────────────
// Bemærk: Vercel Edge functions kan have flere instances og memory wipes
// ved cold start. Det er ikke bullet-proof, men stopper trivielle floods.
// For ægte rate-limit brug Upstash Redis.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 5; // max 5 signups pr. IP pr. minut
const ipRequests = new Map(); // ip -> array of timestamps

function checkRateLimit(ip) {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const arr = (ipRequests.get(ip) || []).filter(ts => ts > cutoff);
  if (arr.length >= RATE_LIMIT_MAX) {
    return { ok: false, retryAfter: Math.ceil((arr[0] + RATE_LIMIT_WINDOW_MS - now) / 1000) };
  }
  arr.push(now);
  ipRequests.set(ip, arr);
  // Skraldspand: hold map'en under kontrol
  if (ipRequests.size > 10_000) {
    for (const [k, v] of ipRequests) {
      if (!v.some(ts => ts > cutoff)) ipRequests.delete(k);
    }
  }
  return { ok: true };
}

function getClientIp(req) {
  const fwd = req.headers.get('x-forwarded-for') || '';
  return fwd.split(',')[0].trim() || req.headers.get('x-real-ip') || 'unknown';
}

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
  const origin = req.headers.get('origin') || '';
  const envAllowed = process.env.ALLOWED_ORIGIN;
  const allowList = envAllowed
    ? envAllowed.split(',').map(s => s.trim())
    : DEFAULT_ALLOWED_ORIGINS;
  const allow = allowList.includes(origin) ? origin : allowList[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

// ── WELCOME EMAIL ──────────────────────────────────────────────────────
// Unsubscribe-token: HMAC-SHA256('unsub:'+email) signeret med RESEND_API_KEY.
// Skal matche expectedToken() i api/unsubscribe.js. Ingen ekstra env-var.
async function unsubscribeToken(apiKey, email) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(apiKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode('unsub:' + email.toLowerCase()));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function unsubscribeUrl(apiKey, email, lang) {
  const t = await unsubscribeToken(apiKey, email);
  return `https://sorovibe.com/api/unsubscribe?e=${encodeURIComponent(email)}&t=${t}&lang=${lang}`;
}

function buildWelcomeTemplate(lang, unsubUrl) {
  const L = lang === 'en' ? {
    subject: 'Welcome to Sorovibe',
    heading: 'Welcome to Sorovibe',
    greeting: 'Hi,',
    thanks: 'Thanks for signing up.',
    body: "You'll hear from me next time something meaningful lands — new products, updates, or anything I think you should know. No spam ever, and you can unsubscribe at any time.",
    cta: 'In the meantime, give the training app a try at',
    ctaLink: 'trace.sorovibe.com',
    sign: '— Soroush',
    brand: 'Sorovibe',
    footer: "You're receiving this email because you signed up at sorovibe.com.",
    unsubLink: 'Unsubscribe with one click',
    unsubOr: 'or write to',
  } : {
    subject: 'Velkommen til Sorovibe',
    heading: 'Velkommen til Sorovibe',
    greeting: 'Hej,',
    thanks: 'Tak fordi du tilmeldte dig.',
    body: 'Du hører fra mig næste gang der lander noget meningsfuldt — nye produkter, opdateringer, eller noget jeg synes du skal vide. Aldrig spam, og du kan altid afmelde dig igen.',
    cta: 'I mellemtiden kan du prøve træningsappen på',
    ctaLink: 'trace.sorovibe.com',
    sign: '— Soroush',
    brand: 'Sorovibe',
    footer: 'Du modtager denne email fordi du tilmeldte dig på sorovibe.com.',
    unsubLink: 'Afmeld med ét klik',
    unsubOr: 'eller skriv til',
  };

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${L.heading}</title></head>
<body style="margin:0;padding:0;background:#f7f6f3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1917;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f7f6f3;">
<tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#ffffff;border:1px solid #e8e6e1;border-radius:16px;">
<tr><td style="padding:36px 32px 32px;">
<h1 style="font-size:24px;font-weight:700;margin:0 0 18px;letter-spacing:-0.02em;line-height:1.2;color:#1a1917;">${L.heading}</h1>
<p style="font-size:16px;line-height:1.65;margin:0 0 14px;color:#1a1917;">${L.greeting}</p>
<p style="font-size:16px;line-height:1.65;margin:0 0 14px;color:#1a1917;">${L.thanks}</p>
<p style="font-size:16px;line-height:1.65;margin:0 0 14px;color:#1a1917;">${L.body}</p>
<p style="font-size:16px;line-height:1.65;margin:0 0 26px;color:#1a1917;">${L.cta} <a href="https://${L.ctaLink}" style="color:#085041;text-decoration:underline;">${L.ctaLink}</a>.</p>
<p style="font-size:16px;line-height:1.65;margin:0;color:#1a1917;">${L.sign}<br><span style="color:#888580;">${L.brand}</span></p>
</td></tr>
</table>
<p style="font-size:12px;line-height:1.6;color:#888580;margin:20px 0 0;text-align:center;max-width:520px;">
${L.footer}<br>
<a href="${unsubUrl}" style="color:#888580;text-decoration:underline;">${L.unsubLink}</a> ${L.unsubOr} <a href="mailto:hello@sorovibe.com" style="color:#888580;text-decoration:underline;">hello@sorovibe.com</a>.
</p>
</td></tr>
</table>
</body></html>`;

  const text = [
    L.heading, '', L.greeting, '', L.thanks, '', L.body, '',
    `${L.cta} ${L.ctaLink}.`, '', L.sign, L.brand, '', '---', L.footer,
    `${L.unsubLink}: ${unsubUrl}`,
  ].join('\n');

  return { subject: L.subject, html, text };
}

async function sendWelcomeEmail(apiKey, email, lang) {
  const unsubUrl = await unsubscribeUrl(apiKey, email, lang);
  const tmpl = buildWelcomeTemplate(lang, unsubUrl);
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      to: email,
      reply_to: REPLY_TO,
      subject: tmpl.subject,
      html: tmpl.html,
      text: tmpl.text,
      headers: {
        // RFC 8058 One-Click: Gmail/Yahoo viser deres egen "Afmeld"-knap og
        // POST'er direkte til URL'en. Mailto beholdt som fallback.
        'List-Unsubscribe': `<${unsubUrl}>, <mailto:hello@sorovibe.com?subject=Unsubscribe>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    }),
  });
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    throw new Error(`Resend email send failed: ${resp.status} ${JSON.stringify(data)}`);
  }
  return resp.json();
}

// ── HANDLER ────────────────────────────────────────────────────────────
export default async function handler(req) {
  const cors = corsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, 405, cors);
  }

  // Rate-limit pr. IP
  const ip = getClientIp(req);
  const rl = checkRateLimit(ip);
  if (!rl.ok) {
    return jsonResponse(
      { error: 'rate_limited' },
      429,
      { ...cors, 'Retry-After': String(rl.retryAfter) }
    );
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
  const segmentId = process.env.RESEND_SEGMENT_ID;

  if (!apiKey || !segmentId) {
    console.error('subscribe: server_misconfigured (missing RESEND_API_KEY or RESEND_SEGMENT_ID)');
    return jsonResponse({ error: 'server_misconfigured' }, 500, cors);
  }

  // Standard success-svar — identisk uanset om kontakten er ny eller eksisterende.
  // (Forhindrer email-enumeration via response-difference.)
  const successResponse = jsonResponse({ ok: true, lang }, 200, cors);
  let isNewContact = false;

  try {
    const resp = await fetch('https://api.resend.com/contacts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        unsubscribed: false,
        segments: [{ id: segmentId }],
      }),
    });

    if (resp.ok) {
      isNewContact = true;
    } else {
      const data = await resp.json().catch(() => ({}));
      const msg = (data?.message || '').toLowerCase();
      const alreadyExists =
        resp.status === 422 ||
        msg.includes('already exists') ||
        msg.includes('contact already');

      if (!alreadyExists) {
        console.error('Resend contacts error', resp.status, data);
        return successResponse;
      }
    }
  } catch (err) {
    console.error('Subscribe exception', err);
    return successResponse;
  }

  if (isNewContact) {
    try {
      await sendWelcomeEmail(apiKey, email, lang);
    } catch (err) {
      console.error('Welcome email failed (signup still succeeded)', err);
    }
  }

  return successResponse;
}
