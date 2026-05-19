// Vercel Edge Function — modtager Stripe webhook events for to produkter:
//
//   1) LIFETIME (one-time): Early Supporter 199 kr lifetime adgang
//      Event: checkout.session.completed (mode=payment)
//      Effekt: Insert i lifetime_purchases + sæt user_metadata.lifetime_supporter = true
//
//   2) MEDLEMSKAB (subscription): 349 kr/år recurring
//      Events: checkout.session.completed (mode=subscription),
//              customer.subscription.created/updated/deleted,
//              invoice.paid, invoice.payment_failed
//      Effekt: Upsert i subscriptions-tabel med status + current_period_end.
//              get_my_access_status RPC læser denne tabel for AI-adgang.
//
// Påkrævede environment variables på Vercel:
//   STRIPE_WEBHOOK_SECRET        — Stripe → Webhooks → endpoint signing secret (whsec_...)
//   SUPABASE_URL                 — fx https://dktmdmleeaenntwknhxe.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY    — Supabase Settings → API → service_role key (HEMMELIG)
//
// Frivillig:
//   STRIPE_PRICE_ID              — lifetime price-id (one-time 19900 DKK)
//   STRIPE_MEMBERSHIP_PRICE_ID   — medlemskab price-id (recurring 34900 DKK/år)

export const config = { runtime: 'edge' };

// ── Stripe signature verification (HMAC-SHA256) ─────────────────────────
async function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = sigHeader.split(',').reduce((acc, p) => {
    const [k, v] = p.split('=');
    acc[k] = v;
    return acc;
  }, {});
  if (!parts.t || !parts.v1) return false;

  // Replay-protection: 5-min vindue
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

// ── Supabase REST helper ─────────────────────────────────────────────────
async function supabaseRequest(path, opts = {}) {
  const url = process.env.SUPABASE_URL + path;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return fetch(url, {
    ...opts,
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
}

// Slå auth.users op via email via SECURITY DEFINER RPC.
// Supabase Auth Admin API har INGEN filter-by-email — derfor RPC.
// Returnerer {id, user_metadata} eller null.
async function findUserByEmail(email) {
  if (!email) return null;
  const resp = await supabaseRequest('/rest/v1/rpc/find_user_by_email', {
    method: 'POST',
    body: JSON.stringify({ p_email: email }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    console.error('findUserByEmail RPC failed', resp.status, errText.slice(0, 200));
    return null;
  }
  const user = await resp.json().catch(() => null);
  // RPC returnerer null hvis ingen match, eller {id, user_metadata}
  if (!user || !user.id) return null;
  return user;
}

// ── LIFETIME flow (eksisterende — uændret adfærd) ───────────────────────
async function recordLifetimePurchase(session) {
  const email = (session.customer_details?.email || session.customer_email || '').toLowerCase();
  if (!email) {
    console.error('No email in lifetime session', session.id);
    return { ok: false, reason: 'no_email' };
  }

  // Insert i lifetime_purchases (idempotent via UNIQUE stripe_session_id)
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
  }

  // Marker bruger som lifetime_supporter hvis konto findes
  const user = await findUserByEmail(email);
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
      console.error('lifetime user_metadata update failed', updateResp.status, errText);
    }
  }

  return { ok: true };
}

// ── MEDLEMSKAB flow (NY) ────────────────────────────────────────────────
// Upsert subscription-state i public.subscriptions. Idempotent via UNIQUE user_id.

async function upsertSubscription({ userId, customerId, subscriptionId, status, currentPeriodEnd, cancelledAt }) {
  if (!userId || !customerId || !subscriptionId) {
    console.error('upsertSubscription missing required fields', { userId: !!userId, customerId: !!customerId, subscriptionId: !!subscriptionId });
    return { ok: false, reason: 'missing_fields' };
  }
  const resp = await supabaseRequest('/rest/v1/subscriptions?on_conflict=user_id', {
    method: 'POST',
    headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      user_id: userId,
      stripe_customer_id: customerId,
      stripe_subscription_id: subscriptionId,
      status,
      current_period_end: currentPeriodEnd,
      cancelled_at: cancelledAt,
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    console.error('subscriptions upsert failed', resp.status, errText);
    return { ok: false, reason: 'upsert_failed' };
  }
  return { ok: true };
}

// Slå user_id op via stripe_customer_id i subscriptions-tabel.
// Bruges når subscription.* events kommer uden email (kun customer_id).
async function findUserIdByCustomerId(customerId) {
  if (!customerId) return null;
  const resp = await supabaseRequest(
    `/rest/v1/subscriptions?stripe_customer_id=eq.${encodeURIComponent(customerId)}&select=user_id&limit=1`,
    { method: 'GET' }
  );
  if (!resp.ok) {
    console.error('findUserIdByCustomerId failed', resp.status);
    return null;
  }
  const rows = await resp.json().catch(() => []);
  return Array.isArray(rows) && rows[0] ? rows[0].user_id : null;
}

// Handler: checkout.session.completed med mode=subscription
// Dette er FØRSTE event når bruger gennemfører subscription-checkout.
// Vi linker stripe_customer_id → user_id via email her, så subsequent
// customer.subscription.* events kan finde brugeren via customer_id alene.
async function handleSubscriptionCheckout(session) {
  const email = (session.customer_details?.email || session.customer_email || '').toLowerCase();
  const customerId = session.customer;
  const subscriptionId = session.subscription;
  if (!email || !customerId || !subscriptionId) {
    console.error('subscription checkout missing fields', { hasEmail: !!email, customerId, subscriptionId });
    return { ok: false, reason: 'missing_fields' };
  }

  const user = await findUserByEmail(email);
  if (!user?.id) {
    // Edge case: bruger har ikke konto endnu. Skal vi creater? Nej — kræver email-verification.
    // I stedet logger vi og venter på at customer.subscription.* events kommer ind.
    // De vil fejle indtil brugeren signer op med samme email. Et separat sync-job kan retroaktivt
    // matche disse — eller bruger kontakter support.
    console.warn('Subscription checkout for unregistered email', email, 'subscription:', subscriptionId);
    return { ok: false, reason: 'no_user' };
  }

  // Hent fuld subscription fra Stripe API for at få status + current_period_end
  const sub = await fetchStripeSubscription(subscriptionId);
  if (!sub) {
    console.error('Could not fetch subscription from Stripe', subscriptionId);
    return { ok: false, reason: 'stripe_fetch_failed' };
  }

  return upsertSubscription({
    userId: user.id,
    customerId,
    subscriptionId,
    status: sub.status,
    currentPeriodEnd: new Date(sub.current_period_end * 1000).toISOString(),
    cancelledAt: sub.cancel_at ? new Date(sub.cancel_at * 1000).toISOString() : null,
  });
}

// Hent subscription-objekt fra Stripe API. Bruges når event kun har customer_id.
async function fetchStripeSubscription(subscriptionId) {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    console.error('STRIPE_SECRET_KEY not set — cannot fetch subscription details');
    return null;
  }
  const resp = await fetch(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
    headers: { 'Authorization': `Bearer ${stripeKey}` },
  });
  if (!resp.ok) {
    console.error('Stripe subscription fetch failed', resp.status);
    return null;
  }
  return resp.json().catch(() => null);
}

// Handler: customer.subscription.created/updated/deleted
// Stripe sender subscription-objektet direkte i event.data.object.
async function handleSubscriptionEvent(subscription, eventType) {
  const customerId = subscription.customer;
  const subscriptionId = subscription.id;
  if (!customerId || !subscriptionId) {
    return { ok: false, reason: 'missing_fields' };
  }

  // Map subscription state: deleted-events markeres som cancelled.
  let status = subscription.status;
  let cancelledAt = subscription.cancel_at ? new Date(subscription.cancel_at * 1000).toISOString() : null;
  if (eventType === 'customer.subscription.deleted') {
    status = 'cancelled';
    cancelledAt = new Date().toISOString();
  }

  // Find user via customer_id (tidligere mappet i handleSubscriptionCheckout).
  const userId = await findUserIdByCustomerId(customerId);
  if (!userId) {
    // Bruger ikke fundet — kunne være race med checkout.session.completed.
    // Stripe retry'er events ved fejl, så vi returnerer 200 og lader Stripe forsøge igen senere.
    console.warn('No user mapping for customer', customerId, '— event ignored');
    return { ok: false, reason: 'no_user_mapping' };
  }

  return upsertSubscription({
    userId,
    customerId,
    subscriptionId,
    status,
    currentPeriodEnd: subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000).toISOString()
      : new Date().toISOString(),
    cancelledAt,
  });
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

  const eventType = event.type;
  const obj = event.data?.object;
  if (!obj) {
    return new Response('Missing object', { status: 400 });
  }

  try {
    if (eventType === 'checkout.session.completed') {
      const mode = obj.mode;
      if (mode === 'payment') {
        // Lifetime one-time payment
        if (obj.payment_status !== 'paid') {
          return new Response(JSON.stringify({ received: true, ignored: 'unpaid' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        await recordLifetimePurchase(obj);
      } else if (mode === 'subscription') {
        // Medlemskab — link customer_id → user_id og opret subscription-row
        await handleSubscriptionCheckout(obj);
      } else {
        console.warn('Unknown checkout mode', mode);
      }
    } else if (
      eventType === 'customer.subscription.created' ||
      eventType === 'customer.subscription.updated' ||
      eventType === 'customer.subscription.deleted'
    ) {
      await handleSubscriptionEvent(obj, eventType);
    } else if (eventType === 'invoice.paid') {
      // Renewal succeeded — refresh subscription state ved at hente fra Stripe.
      // (Stripe sender også customer.subscription.updated samtidig, så dette er
      // primært defensiv backup hvis subscription-updated går tabt.)
      if (obj.subscription) {
        const sub = await fetchStripeSubscription(obj.subscription);
        if (sub) await handleSubscriptionEvent(sub, 'customer.subscription.updated');
      }
    } else if (eventType === 'invoice.payment_failed') {
      // Payment fejlede — Stripe markerer typisk subscription som past_due via
      // separat customer.subscription.updated event. Vi gør intet ekstra her,
      // men logger til debugging.
      console.log('invoice.payment_failed for subscription', obj.subscription);
    }
    // Andre events ignoreres
  } catch (err) {
    console.error('Webhook handler threw', err?.message || err);
    // Returner 200 alligevel — undgå at Stripe retry'er evigt på recoverable fejl
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
