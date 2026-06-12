// Vercel Edge Function — ét-kliks afmelding fra Sorovibe-nyhedsbrevet.
//
//   GET  /api/unsubscribe?e=<email>&t=<token>&lang=da|en
//        → bekræftelses-side med "Afmeld"-knap (ingen handling endnu —
//          beskytter mod mail-scannere/safe-link-prefetch der GET'er alle links)
//   POST samme URL
//        → udfører afmeldingen. Bruges af både formular-knappen og
//          RFC 8058 One-Click (List-Unsubscribe-Post) fra Gmail/Yahoo.
//
// Token = HMAC-SHA256('unsub:' + email) signeret med RESEND_API_KEY (base64url).
// Skal matche unsubscribeToken() i subscribe.js — ingen ekstra env-var nødvendig.

export const config = { runtime: 'edge' };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Let rate-limit (samme pattern som subscribe.js)
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;
const ipRequests = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const arr = (ipRequests.get(ip) || []).filter(ts => ts > cutoff);
  if (arr.length >= RATE_LIMIT_MAX) return false;
  arr.push(now);
  ipRequests.set(ip, arr);
  if (ipRequests.size > 10_000) {
    for (const [k, v] of ipRequests) {
      if (!v.some(ts => ts > cutoff)) ipRequests.delete(k);
    }
  }
  return true;
}

function getClientIp(req) {
  const fwd = req.headers.get('x-forwarded-for') || '';
  return fwd.split(',')[0].trim() || req.headers.get('x-real-ip') || 'unknown';
}

async function expectedToken(apiKey, email) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(apiKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode('unsub:' + email.toLowerCase()));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const COPY = {
  da: {
    confirmTitle: 'Afmeld nyhedsbrevet',
    confirmBody: 'Klik på knappen for at afmelde {email} fra Sorovibe-nyhedsbrevet.',
    confirmBtn: 'Afmeld mig',
    doneTitle: 'Du er afmeldt',
    doneBody: 'Du modtager ikke flere nyhedsbreve fra Sorovibe. Du er altid velkommen tilbage.',
    invalidTitle: 'Linket er ugyldigt',
    invalidBody: 'Afmeldings-linket er ugyldigt eller ufuldstændigt. Skriv til hello@sorovibe.com, så klarer vi det manuelt.',
    back: 'Tilbage til sorovibe.com',
  },
  en: {
    confirmTitle: 'Unsubscribe from the newsletter',
    confirmBody: 'Click the button to unsubscribe {email} from the Sorovibe newsletter.',
    confirmBtn: 'Unsubscribe me',
    doneTitle: "You're unsubscribed",
    doneBody: "You won't receive any more newsletters from Sorovibe. You're always welcome back.",
    invalidTitle: 'Invalid link',
    invalidBody: 'This unsubscribe link is invalid or incomplete. Write to hello@sorovibe.com and we will handle it manually.',
    back: 'Back to sorovibe.com',
  },
};

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function page(lang, kind, email) {
  const t = COPY[lang] || COPY.da;
  let title, body, action = '';
  if (kind === 'confirm') {
    title = t.confirmTitle;
    body = t.confirmBody.replace('{email}', '<strong>' + escapeHtml(email) + '</strong>');
    action = '<form method="post" style="margin:22px 0 0;"><button type="submit" style="background:#1a1917;color:#f7f6f3;border:none;border-radius:12px;padding:13px 26px;font-size:15px;font-weight:600;font-family:inherit;cursor:pointer;">' + t.confirmBtn + '</button></form>';
  } else if (kind === 'done') {
    title = t.doneTitle;
    body = t.doneBody;
  } else {
    title = t.invalidTitle;
    body = t.invalidBody;
  }
  return '<!DOCTYPE html><html lang="' + lang + '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>' + title + ' · Sorovibe</title></head>' +
    '<body style="margin:0;background:#f7f6f3;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;color:#1a1917;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;box-sizing:border-box;">' +
    '<div style="background:#fff;border:1px solid #e8e6e1;border-radius:16px;padding:36px 32px;max-width:440px;text-align:center;">' +
    '<h1 style="font-size:22px;margin:0 0 12px;letter-spacing:-0.02em;">' + title + '</h1>' +
    '<p style="font-size:15px;line-height:1.65;margin:0;color:#444;">' + body + '</p>' +
    action +
    '<p style="margin:26px 0 0;"><a href="https://sorovibe.com" style="font-size:13px;color:#888580;">' + t.back + '</a></p>' +
    '</div></body></html>';
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export default async function handler(req) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return new Response('method_not_allowed', { status: 405 });
  }

  const url = new URL(req.url);
  const email = (url.searchParams.get('e') || '').trim().toLowerCase();
  const token = (url.searchParams.get('t') || '').trim();
  const lang = url.searchParams.get('lang') === 'en' ? 'en' : 'da';

  if (!checkRateLimit(getClientIp(req))) {
    return new Response('rate_limited', { status: 429, headers: { 'Retry-After': '60' } });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('unsubscribe: RESEND_API_KEY mangler');
    return htmlResponse(page(lang, 'invalid'), 500);
  }

  // Validér link
  let valid = false;
  if (email && EMAIL_RE.test(email) && email.length <= 254 && token) {
    const exp = await expectedToken(apiKey, email);
    valid = timingSafeEqual(exp, token);
  }
  if (!valid) {
    return htmlResponse(page(lang, 'invalid'), req.method === 'POST' ? 400 : 200);
  }

  // GET = vis bekræftelses-side (ingen handling — scanner-sikkert)
  if (req.method === 'GET') {
    return htmlResponse(page(lang, 'confirm', email));
  }

  // POST = udfør afmeldingen (formular-knap ELLER RFC 8058 One-Click)
  let ok = false;
  try {
    const r = await fetch('https://api.resend.com/contacts/' + encodeURIComponent(email), {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ unsubscribed: true }),
    });
    // 404 = kontakten findes ikke (allerede slettet) → idempotent succes
    ok = r.ok || r.status === 404;
    if (!ok) console.error('Resend unsubscribe PATCH fejlede', r.status, await r.text().catch(() => ''));
  } catch (err) {
    console.error('Unsubscribe exception', err);
  }
  return htmlResponse(page(lang, ok ? 'done' : 'invalid'), ok ? 200 : 500);
}
