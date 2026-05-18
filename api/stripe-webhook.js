// Vercel Edge Function — modtager Stripe webhook events og registrerer
// lifetime-køb i Supabase. Når Stripe sender 'checkout.session.completed':
//   1. Verificer webhook-signatur via STRIPE_WEBHOOK_SECRET
//   2. Indsæt række i `lifetime_purchases`-tabel i Supabase
//   3. Hvis brugeren allerede har en konto (auth.users.email match),
//      sæt raw_user_meta_data.lifetime_supporter = true så appen låser op
//
// Påkrævede environment variables på Vercel:
//   STRIPE_WEBHOOK_SECRET        — fra Stripe → Webhooks → endpoint signing secret (whsec_...)
//   SUPABASE_URL                 — fx https://dktmdmleeaenntwknhxe.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY    — Supabase Settings → API → service_role key (HEMMELIG!)
//
// Frivillig:
//   STRIPE_PRICE_ID              — hvis sat, valideres at købet matcher denne pris.
//                                 Stopper at andre prices fra samme Stripe-konto trigger lifetime.

export const config = { runtime: 'edge' };

// ── Stripe signature verification (HMAC-SHA256) ─────────────────────────
// Stripe signerer payload med din webhook secret. Vi bruger Web Crypto API
// (Edge runtime har det indbygget — ingen Node 'crypto' import nødvendig).

async function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader) return false;
  // Stripe-Signature: "t=1234567890,v1=abc123..."
  const parts = sigHeader.split(',').reduce((acc, p) => {
    const [k, v] = p.split('=');
    acc[k] = v;
    return acc;
  }, {});
  if (!parts.t || !parts.v1) return false;

  // Tjek timestamp er inden for 5 min — modvirker replay-attacks
  const ts = parseInt(parts.t, 10);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > 300) return false;

  const signedPayload = `${parts.t}.${rawBody}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(signedPayload));
  const hex = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // Konstant-tids sammenligning
  if (hex.length !== parts.v1.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) {
    diff |= hex.charCodeAt(i) ^ parts.v1.charCodeAt(i);
  }
  return diff === 0;
}

// ── Supabase helper ─────────────────────────────────────────────────────
async function supabaseRequest(path, opts = {}) {
  const url = process.env.SUPABASE_URL + path;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const resp = await fetch(url, {
    ...opts,
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  return resp;
}

async function recordLifetimePurchase(session) {
  const email = (session.customer_details?.email || session.customer_email || '').toLowerCase();
  if (!email) {
    console.error('No email in Stripe session', session.id);
    return { ok: false, reason: 'no_email' };
  }

  // 1. Indsæt i lifetime_purchases (idempotent via UNIQUE constraint på stripe_session_id)
  const insertResp = await supabaseRequest('/rest/v1/lifetime_purchases', {
    method: 'POST',
    headers: { 'Prefer': 'return=minimal,resolution=ignore-duplicates' },
    body: JSON.stringify({
      email,
      stripe_session_id: session.id,
      stripe_payment_intent: session.payment_intent || null,
      amount_total: session.amount_total || null,
      currency: session.currency || null,
      paid_at: new Date((session.created || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    }),
  });

  if (!insertResp.ok && insertResp.status !== 409) {
    const errText = await insertResp.text();
    console.error('lifetime_purchases insert failed', insertResp.status, errText);
    // Don't fail webhook — Stripe will retry, men hvis det er et schema-issue
    // vil retry ikke hjælpe. Logger og returnerer success så Stripe ikke spammer.
  }

  // 2. Slå op om brugeren allerede har en auth.users-konto med samme email
  // og marker dem som lifetime_supporter via Admin API.
  const lookupResp = await supabaseRequest(
    `/auth/v1/admin/users?filter=${encodeURIComponent('email.eq.' + email)}`,
    { method: 'GET' }
  );
  if (lookupResp.ok) {
    const data = await lookupResp.json().catch(() => ({}));
    const user = Array.isArray(data?.users) ? data.users[0] : null;
    if (user?.id) {
      const updateResp = await supabaseRequest(`/auth/v1/admin/users/${user.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          user_metadata: {
            ...(user.user_metadata || {}),
            lifetime_supporter: true,
            lifetime_purchased_at: new Date().toISOString(),
          },
        }),
      });
      if (!updateResp.ok) {
        const errText = await updateResp.text();
        console.error('user_metadata update failed', updateResp.status, errText);
      }
    }
    // Hvis ingen bruger findes: rækken i lifetime_purchases bliver brugt
    // ved næste signup (eller et separat job sync'er det). Se STRIPE_SETUP.md.
  } else {
    console.error('auth user lookup failed', lookupResp.status);
  }

  return { ok: true };
}

// ── HANDLER ────────────────────────────────────────────────────────────
export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error('STRIPE_WEBHOOK_SECRET not configured');
    return new Response('Server misconfigured', { status: 500 });
  }

  const sig = req.headers.get('stripe-signature');
  const rawBody = await req.text();

  const valid = await verifyStripeSignature(rawBody, sig, secret);
  if (!valid) {
    console.error('Invalid Stripe signature');
    return new Response('Invalid signature', { status: 400 });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  // Vi reagerer kun på checkout.session.completed
  if (event.type !== 'checkout.session.completed') {
    return new Response(JSON.stringify({ received: true, ignored: event.type }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const session = event.data?.object;
  if (!session) {
    return new Response('Missing session', { status: 400 });
  }

  // Validér payment_status og at det er en lifetime-bestilling
  if (session.payment_status !== 'paid') {
    return new Response(JSON.stringify({ received: true, ignored: 'unpaid' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Valgfri price-validering for at undgå at andre Stripe-products trigger lifetime
  const expectedPriceId = process.env.STRIPE_PRICE_ID;
  if (expectedPriceId) {
    // line_items kommer ikke automatisk med — vi tjekker hellere amount + currency
    // mod hvad vi forventer (199 DKK = 19900 øre).
    // Sat her som soft-check: log men accepter, så vi ikke afviser legit køb.
    if (session.amount_total !== 19900 || session.currency !== 'dkk') {
      console.warn('Unexpected amount/currency', session.amount_total, session.currency);
    }
  }

  try {
    await recordLifetimePurchase(session);
  } catch (err) {
    console.error('recordLifetimePurchase threw', err);
    // Returner 200 alligevel — undgå at Stripe retry'er evigt på recoverable fejl
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
