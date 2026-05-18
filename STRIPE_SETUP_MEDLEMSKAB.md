# Stripe Medlemskab + AI-scanning — opsætnings-runbook

Følger op på den allerede deployede Lifetime-opsætning (`STRIPE_SETUP.md`). Denne guide tilføjer:

1. **Medlemskab 349 kr/år** recurring abonnement i Stripe
2. **Server-side webhook**-handlers for subscription events (allerede deployet i `api/stripe-webhook.js`)
3. **OpenAI API-key** for AI-måltidsscanning (Premium-feature)
4. **Vercel env vars** for både sorovibe.com OG training-log-molu projekter
5. **Opdater placeholder** i `index.html` med Medlemskab Payment Link URL

Strukturen er identisk med Lifetime-flow — webhook'en håndterer nu BÅDE engangsbetaling og subscription i samme endpoint. Database-tabellerne (`subscriptions`, `ai_scan_log`, `access_codes`, `code_redemptions`) er allerede oprettet i Supabase via MCP.

---

## Forudsætninger

- ✅ Stripe-konto aktiveret (fra lifetime-setup)
- ✅ Supabase-tabeller `subscriptions`, `ai_scan_log`, `access_codes`, `code_redemptions` oprettet (via MCP)
- ✅ RPCs `get_my_access_status()` og `redeem_access_code()` deployet
- ⚠️ **OpenAI-konto påkrævet** — opret på [platform.openai.com](https://platform.openai.com), tilføj betalingskort under Billing. Sæt et **monthly usage limit** (fx $20/md) for at undgå overraskelser.

---

## Trin 1 — Opret Medlemskab-produkt i Stripe

1. Log ind i Stripe Dashboard → **Products** → "Add product".
2. Udfyld:
   - **Name:** `Sorovibe Medlemskab`
   - **Description:** `Årligt medlemskab af Sorovibe Træningslog inkl. AI-måltidsscanning (5 scans/dag). Indeholder alle features: workout, manuel makro-log, kropsmålinger, cardio, søvn, analytics, eksport. 4-ugers gratis trial.`
   - **Pricing:**
     - Model: **Recurring**
     - Price: `349.00 DKK`
     - Billing period: `Yearly`
     - Tax behavior: matcher din lifetime-setup (`Inclusive` hvis under momsgrænse, `Exclusive` hvis registreret).
3. Klik **Save product**.
4. Kopiér **Price ID** (`price_xxx...`) — gem til Trin 5.

### Opret Payment Link med 4-ugers trial

5. **Payment links** → "New link".
6. Vælg `Sorovibe Medlemskab` produktet.
7. **After payment:**
   - Redirect til `https://fit.sorovibe.com?membership=success`.
8. **Customer information:**
   - Email: `Always collect`.
   - Address: `Don't collect` (medmindre momsregistreret).
9. **Advanced options:**
   - **Free trial:** ✅ Aktiver. Sæt til **28 days** (matcher app-side trial).
   - **Apply promotion code:** OFF (medmindre du vil have rabatkoder).
   - **Allow customers to adjust quantity:** OFF.
10. Klik **Create link**.
11. Kopiér URL'en (`https://buy.stripe.com/...`). Gem til Trin 6.

### Test-mode først

⚠️ Lav HELE setup'en i **Test mode** først. Skift først til Live mode når et komplet flow er testet:
- Test-kort `4242 4242 4242 4242` for succesfuld 4-uger-trial → første betaling
- Test-kort `4000 0000 0000 0341` for "decline after authentication" (test failed renewal)

---

## Trin 2 — Subscriptions-tabel er allerede oprettet

Databasen blev opdateret via Supabase MCP i samme session som webhook-koden. Du kan verificere:

```sql
select count(*) from public.subscriptions;        -- skal returnere 0 (tom tabel)
select count(*) from public.ai_scan_log;          -- skal returnere 0
select count(*) from public.access_codes;         -- skal returnere 0
select * from pg_proc where proname = 'get_my_access_status';  -- skal returnere 1 row
select * from pg_proc where proname = 'redeem_access_code';    -- skal returnere 1 row
```

Alle 4 nye tabeller har RLS enabled uden policies — kun service_role kan tilgå direkte. App læser via SECURITY DEFINER RPC'er.

---

## Trin 3 — Tilføj subscription events til eksisterende Stripe-webhook

Det eksisterende endpoint `https://sorovibe.com/api/stripe-webhook` håndterer nu BÅDE one-time payments og subscriptions. Du skal kun tilføje events i Stripe Dashboard.

1. Stripe Dashboard → **Developers** → **Webhooks** → klik på det eksisterende endpoint (`Sorovibe Lifetime`).
2. Klik **Update details** → tilføj følgende events ud over `checkout.session.completed`:
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.paid`
   - `invoice.payment_failed`
3. **Save changes**.

Webhook-secret'en (`whsec_...`) er den samme som før — ingen ny env var nødvendig her.

Eventuelt omdøb endpoint til `Sorovibe (Lifetime + Membership)` for klarhed.

---

## Trin 4 — Hent Stripe Secret Key

Webhook'en henter subscription-detaljer fra Stripe API ved nogle events (`invoice.paid` har kun subscription_id, ikke fuld objekt). Dette kræver din Secret Key.

1. Stripe Dashboard → **Developers** → **API keys** → **Reveal live secret key** (eller "Reveal test key" i test-mode).
2. Kopiér `sk_live_...` (eller `sk_test_...`). Gem til Trin 5.

⚠️ Behandle denne nøgle som et password. Aldrig commit til Git.

---

## Trin 5 — Tilføj env-variable i Vercel (sorovibe-web)

Gå til Vercel Dashboard → projektet `sorovibe-web` → **Settings** → **Environment Variables**. Tilføj følgende til **Production**:

| Name | Value | Bemærkning |
|---|---|---|
| `STRIPE_MEMBERSHIP_PRICE_ID` | `price_xxx...` (fra Trin 1) | Medlemskab price-ID |
| `STRIPE_SECRET_KEY` | `sk_live_...` (fra Trin 4) | Bruges af webhook til at hente subscription-detaljer |

`STRIPE_PRICE_ID` (lifetime), `STRIPE_WEBHOOK_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` er allerede sat.

### Trigger redeploy

Vercel deployer ikke automatisk ved env-var ændringer. Gå til **Deployments** → seneste deploy → "..." menu → **Redeploy** (uden "Use existing build cache").

---

## Trin 6 — Opdater sorovibe.com placeholder

I `index.html` har Medlemskab-knappen midlertidigt `href="https://fit.sorovibe.com"` (peger på appen for trial-start uden card). Du kan vælge:

**A) Behold trial-start uden Stripe** (anbefalet for launch — lavere friktion):
- Lad knappen pege på `https://fit.sorovibe.com` så bruger opretter konto, får 4 ugers trial automatisk via app-logic.
- Brugeren betaler først efter trial slutter — opfordres til subscription via in-app banner dag 22+.
- Fordel: ingen kort-info ved signup → højere conversion til trial-start.

**B) Direkte Payment Link med trial** (alternativ — fanger card upfront):
- Erstat `href="https://fit.sorovibe.com"` med `href="https://buy.stripe.com/..."` (URL fra Trin 1).
- Bruger udfylder kort ved trial-start. Auto-renewal aktiverer efter 28 dage.
- Fordel: stærkere commitment, automatisk konvertering fra trial.

Begge er gyldige. **A er bedre for launch** — du kan altid skifte til B senere når app-flow er valideret.

---

## Trin 7 — OpenAI API-key til AI-måltidsscanning (training-log-molu)

AI-scan endpoint ligger i fit.sorovibe.com appen (Vercel projekt `training-log-molu`). Sæt OpenAI-nøglen op der.

1. [platform.openai.com](https://platform.openai.com) → log ind → **API keys** → "Create new secret key".
2. Navngiv den `Sorovibe Træningslog AI-scan`. Kopiér nøglen (vises kun én gang).
3. Vercel → projektet **`training-log-molu`** → **Settings** → **Environment Variables**. Tilføj til **Production**:

| Name | Value | Hvor det kommer fra |
|---|---|---|
| `OPENAI_API_KEY` | `sk-proj-...` | OpenAI API key fra trin 2 |
| `SUPABASE_URL` | `https://dktmdmleeaenntwknhxe.supabase.co` | Samme som sorovibe-web |
| `SUPABASE_ANON_KEY` | publishable anon key fra Supabase → Settings → API | Bruges til RPC-kald fra Edge function |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key fra Supabase → Settings → API | Bruges til at indsætte i ai_scan_log |

4. **Indstil monthly budget** på OpenAI Platform → **Settings** → **Billing** → **Usage limits**:
   - Hard limit: $30/md (forhindrer overraskelses-regning hvis kode-bug eller misbrug)
   - Soft limit: $20/md (sender warning-email)

Med 5 scans/dag worst case × 30 dage × $0.004/scan = ~$0.60/bruger/md. $30 dækker ca. 50 aktive Premium-brugere worst case (i praksis bruger de fleste ikke alle 5 scans dagligt — realistisk dækker $30 ca. 80-100 aktive brugere). Justér limit efter behov.

5. Trigger redeploy af training-log-molu (Settings → Deployments → seneste → Redeploy).

---

## Trin 8 — Test end-to-end

**Test 1: Trial-start (uden Stripe)**
1. Opret ny bruger på `fit.sorovibe.com` med ny email.
2. Tjek Settings → skal vise blå "Gratis trial — 28 dage tilbage" badge.
3. Naviger til Kost → skal se AI-måltidsscanning kort med "0 / 5 scans i dag".
4. Tag billede af mad → AI returnerer makroer → værdier fyldes i felter → tryk Gem.
5. Tjek Supabase: `select * from ai_scan_log;` skal vise 1 row.

**Test 2: Subscription (med Stripe test mode)**
1. Klik "Køb Medlemskab" → udfyld test-kort `4242 4242 4242 4242` → bekræft.
2. Tjek Stripe Dashboard → Webhooks → seneste deliveries skal vise `customer.subscription.created` returneret 200.
3. Tjek Supabase: `select * from subscriptions;` skal vise 1 row med status='trialing'.
4. Tjek app: Settings → skal vise grøn "Medlemskab aktiv" badge.

**Test 3: Access code**
1. Opret en kode i Supabase SQL Editor:
```sql
insert into access_codes (code, type, max_uses, notes)
values ('TEST-TRIAL-EXTEND', 'trial_extension_days', 14, 1, 'Manual test');
```
2. I app: Settings → "Adgangskode" → indtast `TEST-TRIAL-EXTEND` → "Indløs".
3. Skal vise grøn "✓ Trial forlænget med 14 dage" + badge opdaterer trial_days_left.

---

## Generering af gift-koder (manuel SQL)

For at give nogen lifetime-adgang manuelt (uden Stripe-betaling):

```sql
insert into access_codes (code, type, max_uses, notes)
values ('GIFT-ANNA-2026', 'lifetime_grant', 1, 'Givet til Anna ift. influencer-deal');
```

Single-use kode: `max_uses = 1`. Multi-use (fx pressepakke): `max_uses = 50` + samme kode til alle reviewers.

For trial-forlængelse (support-recovery):
```sql
insert into access_codes (code, type, effect_value, max_uses, notes)
values ('SUPPORT-BUG-RECOVERY', 'trial_extension_days', 14, 1, 'Bruger ramt af crash, kulance');
```

Vigtigt: `lifetime_grant` koder **tæller IKKE i de 100 betalte lifetime-pladser** (lifetime_purchases-tabellen). Du beholder fuld kontrol over scarcity-marketing.

---

## Driftsovervågning

**Daglig sundhedstjek:**

```sql
-- Aktive subscriptions
select count(*) filter (where status = 'active') as active,
       count(*) filter (where status = 'trialing') as trialing,
       count(*) filter (where status = 'past_due') as past_due,
       count(*) filter (where status = 'cancelled') as cancelled
from public.subscriptions;

-- Lifetime-pladser solgt (frem til 1. aug 2026)
select count(*) from public.lifetime_purchases;

-- Dagens AI-scans (omkostnings-tracking)
select count(*), date_trunc('day', scanned_at) as day
from public.ai_scan_log
where scanned_at > now() - interval '7 days'
group by day order by day desc;

-- Brugere med trial der udløber inden for 7 dage (advarsels-kandidater til email)
select email, created_at, created_at + interval '28 days' as trial_ends
from auth.users
where created_at + interval '28 days' between now() and now() + interval '7 days'
  and id not in (select user_id from subscriptions where status in ('active','trialing','past_due'))
  and coalesce((raw_user_meta_data->>'lifetime_supporter')::boolean, false) = false
order by trial_ends;
```

OpenAI-omkostnings-tracking: Dashboard → Usage. Med 5 scans/dag worst case × $0.004/scan, en aktiv Premium-bruger koster ~$7-8/år i AI (i praksis ~$3-5 for typiske brugere). På 349 kr/år (~$50) er det 14-16% af omsætningen worst case, 85% margin. Hold øje hvis usage stiger uventet.

---

## Hvis noget går galt

**Webhook fejler:**
- Stripe Dashboard → Webhooks → endpoint → seneste deliveries. Tjek response code + body.
- Vercel Dashboard → projektet `sorovibe-web` → Logs → filter `[scan-meal]` eller `webhook`. Stripe retry'er ved 5xx, men ikke 4xx.

**Bruger får ikke adgang efter betaling:**
- Tjek `subscriptions`-tabel: er rowen indsat?
- Hvis ikke: tjek webhook-leverancer i Stripe. Hvis 200 men ingen row: `findUserByEmail` returnerede ikke noget — verificer email matcher mellem Stripe-betaling og auth.users.
- Manuel fix: kør `select claim_lifetime_for_self()` mens logget ind som brugeren, eller insert subscription-row manuelt med korrekt user_id.

**AI-scan fejler:**
- Tjek Vercel Logs på `training-log-molu` for `[scan-meal]` errors.
- Verificer `OPENAI_API_KEY` env-var er sat og gyldig.
- Tjek OpenAI billing — har du brugt din monthly limit op?
- Tjek `ai_scan_log`-tabel for at se hvor mange scans bruger har lavet i dag.
