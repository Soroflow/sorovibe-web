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
    const nowIso = new Date().toISOString();

    // Link purchase-row til user_id så refund-handler ikke skal email-lookup.
    // Idempotent: opdaterer kun rows der matcher session_id og endnu ikke er linked.
    const linkResp = await supabaseRequest(
      `/rest/v1/lifetime_purchases?stripe_session_id=eq.${encodeURIComponent(session.id)}&applied_to_user_id=is.null`,
      {
        method: 'PATCH',
        headers: { 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          applied_to_user_id: user.id,
          applied_at: nowIso,
        }),
      }
    );
    if (!linkResp.ok) {
      const errText = await linkResp.text();
      console.error('lifetime_purchases applied_to_user_id link failed', linkResp.status, errText);
    }

    const updateResp = await supabaseRequest(`/auth/v1/admin/users/${user.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        user_metadata: {
          ...(user.user_metadata || {}),
          lifetime_supporter: true,
          lifetime_purchased_at: nowIso,
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

// ── Resend transactional email (refund-bekræftelse) ────────────────────
// Genbruger samme FROM/REPLY-mønster som api/subscribe.js (noreply@sorovibe.com).
// Bilingual: vælger sprog via user_metadata.locale ('en' → engelsk, alt andet → dansk).
//
// Stripe sender allerede sin egen refund-receipt via deres mail-engine, men siger ingenting
// om at app-adgangen er trukket tilbage. Denne mail lukker det informations-gap.

const REFUND_FROM = 'Trace <noreply@sorovibe.com>';
const REFUND_REPLY_TO = 'hello@sorovibe.com';

function refundEmailTemplate(lang, isDispute) {
  const da = {
    subject: isDispute
      ? 'Din betalingstvist er registreret — Trace-adgang sat på pause'
      : 'Din refund er gennemført — Trace-adgang trukket tilbage',
    heading: isDispute ? 'Tvisten er registreret' : 'Refund gennemført',
    body: isDispute
      ? 'Vi har modtaget en betalingstvist på dit Lifetime-køb. Din premium-adgang (inkl. AI-måltidsscan) er sat på pause indtil tvisten er afsluttet. Hvis tvisten afgøres til din fordel, gen-aktiverer vi automatisk din adgang.'
      : 'Din refund af Lifetime-købet er gennemført. Vi har trukket din premium-adgang (inkl. AI-måltidsscan) tilbage. Du kan stadig bruge appen gratis med begrænsede funktioner.',
    repurchase: 'Hvis du ombestemmer dig, kan du købe Lifetime igen når som helst.',
    questions: 'Spørgsmål? Svar bare på denne mail.',
    repurchaseUrl: 'https://sorovibe.com/#early-supporter',
    repurchaseCta: 'Køb Lifetime igen',
  };
  const en = {
    subject: isDispute
      ? 'Your payment dispute is registered — Trace access paused'
      : 'Your refund is complete — Trace access revoked',
    heading: isDispute ? 'Dispute registered' : 'Refund complete',
    body: isDispute
      ? 'We have received a payment dispute for your Lifetime purchase. Your premium access (including AI meal scanning) is paused while the dispute is resolved. If the dispute is decided in your favor, we will automatically re-enable your access.'
      : 'Your Lifetime refund has been processed. We have revoked your premium access (including AI meal scanning). You can still use the app for free with limited features.',
    repurchase: 'If you change your mind, you can purchase Lifetime again any time.',
    questions: 'Questions? Just reply to this email.',
    repurchaseUrl: 'https://sorovibe.com/#early-supporter',
    repurchaseCta: 'Buy Lifetime again',
  };
  const t = lang === 'en' ? en : da;
  const text =
    `${t.heading}\n\n${t.body}\n\n${t.repurchase}\n${t.repurchaseUrl}\n\n${t.questions}\n\n— Trace`;
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${t.heading}</title></head>
<body style="margin:0;padding:0;background:#f5f3ef;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f5f3ef;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;background:#fff;border-radius:12px;padding:32px;">
<tr><td>
<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#1f1d18;font-weight:600;">${t.heading}</h1>
<p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#3a372f;">${t.body}</p>
<p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#3a372f;">${t.repurchase}</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td>
<a href="${t.repurchaseUrl}" style="display:inline-block;padding:12px 24px;background:#1f1d18;color:#fff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:500;">${t.repurchaseCta}</a>
</td></tr></table>
<p style="margin:28px 0 0;font-size:13px;line-height:1.6;color:#6b675e;">${t.questions}</p>
</td></tr>
</table>
<p style="font-size:12px;line-height:1.6;color:#888580;margin:20px 0 0;text-align:center;">— Trace · Sorovibe</p>
</td></tr>
</table>
</body></html>`;
  return { subject: t.subject, html, text };
}

async function sendRefundEmail(email, lang, isDispute) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('RESEND_API_KEY not set — refund-confirmation email skipped');
    return { ok: false, reason: 'no_api_key' };
  }
  if (!email) {
    return { ok: false, reason: 'no_email' };
  }
  const tmpl = refundEmailTemplate(lang, isDispute);
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: REFUND_FROM,
        to: email,
        reply_to: REFUND_REPLY_TO,
        subject: tmpl.subject,
        html: tmpl.html,
        text: tmpl.text,
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.error('Resend refund-email failed', resp.status, errText.slice(0, 200));
      return { ok: false, reason: 'send_failed' };
    }
    return { ok: true };
  } catch (err) {
    console.error('Resend refund-email threw', err?.message || err);
    return { ok: false, reason: 'threw' };
  }
}

// ── LIFETIME REFUND flow (audit-fix 2026-05-21) ─────────────────────────
// Trigger: charge.refunded eller charge.dispute.created (chargeback).
// Effekt: Marker lifetime_purchases-row som refunded + clear bruger's lifetime_supporter
// flag i user_metadata, så han mister fri AI-adgang.
//
// Find purchase-row enten via stripe_payment_intent (charge.refunded) eller
// charge.payment_intent (dispute). Kun lifetime-køb håndteres her — subscription-refund
// flyder gennem customer.subscription.updated → status='canceled'.

async function handleLifetimeRefund(charge, eventType) {
  const paymentIntent = charge.payment_intent;
  if (!paymentIntent) {
    console.warn('Refund event mangler payment_intent', eventType, charge.id);
    return { ok: false, reason: 'no_payment_intent' };
  }

  // Find lifetime_purchases row via stripe_payment_intent
  const lookupResp = await supabaseRequest(
    `/rest/v1/lifetime_purchases?stripe_payment_intent=eq.${encodeURIComponent(paymentIntent)}&select=id,email,applied_to_user_id,refunded_at&limit=1`,
    { method: 'GET' }
  );
  if (!lookupResp.ok) {
    console.error('lifetime_purchases lookup failed', lookupResp.status);
    return { ok: false, reason: 'lookup_failed' };
  }
  const rows = await lookupResp.json().catch(() => []);
  const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
  if (!row) {
    // Ikke et lifetime-køb (kan være subscription invoice eller andet). Ignorér stille.
    console.log('No lifetime purchase found for refunded payment_intent', paymentIntent);
    return { ok: true, ignored: 'not_lifetime' };
  }

  // Idempotent: hvis refunded_at allerede sat, returner OK uden at gøre mere
  if (row.refunded_at) {
    console.log('Lifetime purchase already marked refunded', row.id);
    return { ok: true, idempotent: true };
  }

  // Marker row som refunded
  const updateResp = await supabaseRequest(
    `/rest/v1/lifetime_purchases?id=eq.${row.id}`,
    {
      method: 'PATCH',
      headers: { 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        refunded_at: new Date().toISOString(),
        refund_reason: eventType,
      }),
    }
  );
  if (!updateResp.ok) {
    const errText = await updateResp.text();
    console.error('lifetime_purchases refund-update failed', updateResp.status, errText);
    return { ok: false, reason: 'update_failed' };
  }

  // Clear lifetime_supporter user_metadata. Brug applied_to_user_id hvis sat,
  // ellers slå op via email (fallback for legacy-rows uden applied_to_user_id).
  let userId = row.applied_to_user_id;
  let userLocale = 'da';
  let userEmail = row.email;
  if (!userId && row.email) {
    const user = await findUserByEmail(row.email);
    userId = user?.id || null;
    if (user?.user_metadata?.locale === 'en') userLocale = 'en';
  }

  if (userId) {
    // Fetch current user_metadata først så vi ikke wipes andre felter
    const getUserResp = await supabaseRequest(`/auth/v1/admin/users/${userId}`, { method: 'GET' });
    if (getUserResp.ok) {
      const currentUser = await getUserResp.json().catch(() => null);
      const meta = { ...(currentUser?.user_metadata || {}) };
      if (meta.locale === 'en') userLocale = 'en';
      if (!userEmail && currentUser?.email) userEmail = currentUser.email;
      delete meta.lifetime_supporter;
      delete meta.lifetime_purchased_at;
      meta.lifetime_refunded_at = new Date().toISOString();
      meta.lifetime_refund_reason = eventType;

      const updateUserResp = await supabaseRequest(`/auth/v1/admin/users/${userId}`, {
        method: 'PUT',
        body: JSON.stringify({ user_metadata: meta }),
      });
      if (!updateUserResp.ok) {
        const errText = await updateUserResp.text();
        console.error('lifetime user_metadata refund-clear failed', updateUserResp.status, errText);
      }
    } else {
      console.warn('Could not fetch user to clear lifetime_supporter', userId, getUserResp.status);
    }
  } else {
    console.warn('Refund processed but no user_id found to clear', row.email);
  }

  // Send refund-confirmation-mail. Fire-and-forget i den forstand at email-fejl ikke
  // ruller refund-handling tilbage — refund er sket på Stripe-siden uanset hvad.
  // isDispute=true når event er charge.dispute.* så ordlyden matcher (pause vs revoke).
  if (userEmail) {
    const isDispute = eventType.startsWith('charge.dispute.');
    await sendRefundEmail(userEmail, userLocale, isDispute);
  }

  return { ok: true };
}

// ── DISPUTE CLOSED flow (re-grant ved vundet dispute) ───────────────────
// Når Stripe lukker en dispute, kommer charge.dispute.closed med status:
//   - 'won' / 'warning_closed': vi vandt → re-grant lifetime_supporter
//   - 'lost': bruger vandt → adgang forbliver revoked (allerede cleared via dispute.created)
//   - 'warning_needs_response' osv.: ignorér (ikke en final state)
async function handleDisputeClosed(dispute) {
  const status = dispute?.status;
  const paymentIntent = dispute?.payment_intent;
  if (!paymentIntent) {
    console.warn('dispute.closed mangler payment_intent', dispute?.id);
    return { ok: false, reason: 'no_payment_intent' };
  }
  // Kun "won" + "warning_closed" giver re-grant. Alt andet ignoreres.
  if (status !== 'won' && status !== 'warning_closed') {
    console.log('dispute.closed status', status, '— ingen re-grant');
    return { ok: true, ignored: 'not_won' };
  }

  // Find purchase-row
  const lookupResp = await supabaseRequest(
    `/rest/v1/lifetime_purchases?stripe_payment_intent=eq.${encodeURIComponent(paymentIntent)}&select=id,email,applied_to_user_id&limit=1`,
    { method: 'GET' }
  );
  if (!lookupResp.ok) {
    console.error('lifetime_purchases dispute-close lookup failed', lookupResp.status);
    return { ok: false, reason: 'lookup_failed' };
  }
  const rows = await lookupResp.json().catch(() => []);
  const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
  if (!row) {
    console.log('No lifetime purchase found for won dispute', paymentIntent);
    return { ok: true, ignored: 'not_lifetime' };
  }

  // Clear refunded_at/refund_reason (re-aktiver row)
  const restoreResp = await supabaseRequest(
    `/rest/v1/lifetime_purchases?id=eq.${row.id}`,
    {
      method: 'PATCH',
      headers: { 'Prefer': 'return=minimal' },
      body: JSON.stringify({ refunded_at: null, refund_reason: null }),
    }
  );
  if (!restoreResp.ok) {
    const errText = await restoreResp.text();
    console.error('lifetime_purchases dispute-close restore failed', restoreResp.status, errText);
  }

  // Re-grant lifetime_supporter
  let userId = row.applied_to_user_id;
  if (!userId && row.email) {
    const user = await findUserByEmail(row.email);
    userId = user?.id || null;
  }
  if (!userId) {
    console.warn('dispute won but no user to re-grant', row.email);
    return { ok: true, partial: 'no_user' };
  }

  const getUserResp = await supabaseRequest(`/auth/v1/admin/users/${userId}`, { method: 'GET' });
  if (!getUserResp.ok) {
    console.warn('dispute re-grant: could not fetch user', userId);
    return { ok: false, reason: 'user_fetch_failed' };
  }
  const currentUser = await getUserResp.json().catch(() => null);
  const meta = { ...(currentUser?.user_metadata || {}) };
  meta.lifetime_supporter = true;
  meta.lifetime_purchased_at = meta.lifetime_purchased_at || new Date().toISOString();
  meta.lifetime_regranted_at = new Date().toISOString();
  meta.lifetime_regrant_reason = 'dispute_won';
  delete meta.lifetime_refunded_at;
  delete meta.lifetime_refund_reason;

  const updateUserResp = await supabaseRequest(`/auth/v1/admin/users/${userId}`, {
    method: 'PUT',
    body: JSON.stringify({ user_metadata: meta }),
  });
  if (!updateUserResp.ok) {
    const errText = await updateUserResp.text();
    console.error('dispute re-grant user_metadata update failed', updateUserResp.status, errText);
    return { ok: false, reason: 'user_update_failed' };
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
    currentPeriodEnd: extractPeriodEnd(sub),
    cancelledAt: extractCancelledAt(sub),
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

// Extract current_period_end fra subscription. Stripe API 2025-03+ har flyttet feltet
// fra subscription-niveau til subscription.items.data[0]. Vi prøver begge for kompatibilitet.
// Returnerer ISO-string. Falder tilbage til "now + 1 year" hvis intet kan parses.
function extractPeriodEnd(sub) {
  const itemEnd = sub?.items?.data?.[0]?.current_period_end;
  const subEnd = sub?.current_period_end;
  const ts = (typeof itemEnd === 'number' ? itemEnd : null) ||
             (typeof subEnd === 'number' ? subEnd : null);
  if (ts && ts > 0) {
    const d = new Date(ts * 1000);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  // Fallback: defensiv — 1 år frem. Webhook bør stadig lykkes så vi har EN row.
  console.warn('extractPeriodEnd: no valid timestamp found, using fallback', {
    itemEnd, subEnd, sub_id: sub?.id
  });
  const fallback = new Date();
  fallback.setFullYear(fallback.getFullYear() + 1);
  return fallback.toISOString();
}

// Extract cancelled_at fra subscription. Stripe kalder feltet både cancel_at og canceled_at
// afhængigt af API-version og context.
function extractCancelledAt(sub) {
  const ts = sub?.canceled_at || sub?.cancel_at;
  if (typeof ts === 'number' && ts > 0) {
    const d = new Date(ts * 1000);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return null;
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
  let cancelledAt = extractCancelledAt(subscription);
  if (eventType === 'customer.subscription.deleted') {
    status = 'cancelled';
    if (!cancelledAt) cancelledAt = new Date().toISOString();
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
    currentPeriodEnd: extractPeriodEnd(subscription),
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
    } else if (
      eventType === 'charge.refunded' ||
      eventType === 'charge.dispute.created' ||
      eventType === 'charge.dispute.funds_withdrawn'
    ) {
      // Refund eller chargeback på lifetime-køb. Clear lifetime_supporter flag.
      // Subscription-refunds håndteres via customer.subscription.updated → status=canceled.
      // For charge.refunded er obj = charge-objektet direkte.
      // For dispute-events er obj = dispute-objektet, charge er i obj.charge (kun ID-string),
      // payment_intent ligger i obj.payment_intent.
      let chargeData = obj;
      if (eventType.startsWith('charge.dispute.')) {
        // Map dispute → charge-lignende object for handleLifetimeRefund (kun payment_intent kræves)
        chargeData = { payment_intent: obj.payment_intent, id: obj.charge };
      }
      await handleLifetimeRefund(chargeData, eventType);
    } else if (eventType === 'charge.dispute.closed') {
      // Dispute er afgjort. Hvis vi vandt (status='won' eller 'warning_closed'),
      // gen-aktivér brugerens lifetime_supporter. Hvis vi tabte, gør intet —
      // funds_withdrawn-eventet har allerede cleared adgangen.
      await handleDisputeClosed(obj);
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
