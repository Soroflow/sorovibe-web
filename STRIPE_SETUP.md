# Stripe Lifetime-køb — opsætnings-runbook

Koden er bygget og deploy-klar, men der er 5 manuelle trin du skal gøre i Stripe/Supabase/Vercel før knappen virker. Følg dem i rækkefølge.

## Forudsætninger

- **CVR-nummer** (gratis enkeltmandsvirksomhed på [virk.dk](https://virk.dk) — MitID-verifikation, ~5 min). Du må ikke sælge B2C i Danmark uden CVR.
- **Stripe-konto** (gratis, dansk konto, MitID-verificeret) — [stripe.com](https://stripe.com).
- **Bogføring** — hobbyvirksomhed under 50.000 kr/år omsætning kræver ikke momsregistrering. Over → momsregistrering + Dinero/Billy fra ~100 kr/md.

---

## Trin 1 — Opret produkt + Payment Link i Stripe

1. Log ind i Stripe Dashboard → **Products** → "Add product".
2. Udfyld:
   - **Name:** `Træningslog Lifetime`
   - **Description:** `Lifetime adgang til Træningslog (workout, kost, søvn, cardio) plus bug-fixes og forbedringer af disse features. Fremtidige Pro-features (AI-coach, custom programmering, Apple Health) ikke inkluderet.`
   - **Pricing:**
     - Model: `One-off`
     - Price: `199.00 DKK`
     - Tax behavior: `Inclusive` (eller `Exclusive` hvis du er momsregistreret — Stripe Tax kan håndtere EU-moms automatisk).
3. Klik **Save product**.
4. Kopiér **Price ID** (`price_xxx...`) — gem til Trin 4.

### Opret Payment Link

5. **Payment links** → "New link".
6. Vælg produktet du lige har oprettet.
7. **After payment:**
   - "Don't show confirmation page" → **OFF** (vis kvittering).
   - "Show confirmation page with custom message" eller redirect til `https://fit.sorovibe.com?lifetime=success`.
8. **Customer information:**
   - Email: `Always collect` (kritisk — det er sådan vi matcher købet til kontoen).
   - Address: `Don't collect` (medmindre du har momsregistreret virksomhed → så `Always`).
9. **Advanced options:**
   - **Apply promotion code:** OFF (medmindre du vil have rabatkoder).
   - **Allow customers to adjust quantity:** OFF.
10. Klik **Create link**.
11. Kopiér URL'en — det ligner `https://buy.stripe.com/...`. Gem til Trin 5.

### Test-mode først

⚠️ Lav HELE setup'en i **Test mode** først. Skift først til Live mode når du har testet et komplet køb med test-kort `4242 4242 4242 4242`.

---

## Trin 2 — Opret Supabase-tabel til lifetime-køb

Webhook'en skriver hver lifetime-betaling til en ny tabel `lifetime_purchases`. Den bruges:
- Som audit-log af betalinger.
- Til at låse lifetime op for brugere der køber FØR de opretter konto (sync ved næste login).

Kør denne SQL i Supabase → **SQL Editor** → "New query":

```sql
-- Tabel: lifetime_purchases
create table if not exists public.lifetime_purchases (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  stripe_session_id text not null unique,
  stripe_payment_intent text,
  amount_total integer,
  currency text,
  paid_at timestamptz not null default now(),
  applied_to_user_id uuid references auth.users(id) on delete set null,
  applied_at timestamptz
);

create index lifetime_purchases_email_idx on public.lifetime_purchases (lower(email));

-- RLS: kun service_role læser/skriver (webhook + admin)
alter table public.lifetime_purchases enable row level security;

-- Ingen policies for public → almindelige brugere får 0 rows.
-- Service role bypasser RLS automatisk.
```

Verificer tabellen er oprettet: **Table Editor** → skal vise `lifetime_purchases` med 0 rows.

---

## Trin 3 — Sæt webhook op i Stripe

Webhook'en sender event hver gang nogen betaler. Vores `/api/stripe-webhook` lytter på `checkout.session.completed`.

1. Stripe Dashboard → **Developers** → **Webhooks** → "Add endpoint".
2. **Endpoint URL:** `https://sorovibe.com/api/stripe-webhook`
3. **Events to send:** Vælg kun `checkout.session.completed`.
4. Klik **Add endpoint**.
5. På den nye endpoint-side: klik **Signing secret** → **Reveal** → kopiér værdien (`whsec_...`). Gem til Trin 4.

---

## Trin 4 — Tilføj env-variable i Vercel

Gå til Vercel Dashboard → projektet `sorovibe-web` → **Settings** → **Environment Variables**. Tilføj følgende til **Production** (og Preview hvis du vil teste i preview-deploys):

| Name | Value | Hvor det kommer fra |
|---|---|---|
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` | Trin 3, signing secret |
| `STRIPE_PRICE_ID` | `price_...` | Trin 1, Price ID (valgfrit men anbefalet) |
| `SUPABASE_URL` | `https://dktmdmleeaenntwknhxe.supabase.co` | Allerede i memory |
| `SUPABASE_SERVICE_ROLE_KEY` | `eyJ...` HEMMELIGHED | Supabase → Settings → API → `service_role` key |
| `ALLOWED_ORIGIN` | `https://sorovibe.com,https://www.sorovibe.com` | Hardcoded fallback i koden — sæt for klarhed |

⚠️ `SUPABASE_SERVICE_ROLE_KEY` skal behandles som et password — den giver admin-adgang til hele din database. Aldrig commit til git, aldrig log eller send til klienten.

Klik **Save** efter hver. Trigger en redeploy: **Deployments** → seneste → "Redeploy".

---

## Trin 5 — Opdater placeholder-URL i index.html

Lige nu står der `STRIPE_PAYMENT_LINK_PLACEHOLDER` som href på "Køb lifetime"-knappen. Erstat den:

```bash
# I Claude Sorovibe Web/index.html, find:
<a href="STRIPE_PAYMENT_LINK_PLACEHOLDER" class="pricing-btn" id="lifetimeBtn"

# Erstat STRIPE_PAYMENT_LINK_PLACEHOLDER med Payment Link URL fra Trin 1:
<a href="https://buy.stripe.com/DIT_PAYMENT_LINK_ID" class="pricing-btn" id="lifetimeBtn"
```

Eller bed mig (Claude) om at gøre det — bare giv mig URL'en.

---

## Trin 6 — Test

1. **Test mode** (brug test-kort `4242 4242 4242 4242`, hvilken som helst CVC, hvilken som helst fremtidig dato):
   - Klik "Køb lifetime →" på sorovibe.com
   - Gennemfør køb med test-kort
   - Verificer at:
     - Stripe Dashboard → Payments viser betalingen (test mode)
     - Stripe → Webhooks → din endpoint viser "200 OK" responsen
     - Supabase → `lifetime_purchases` har en ny række med din email
     - Hvis du har en bruger med samme email på fit.sorovibe.com: kør SQL `select raw_user_meta_data from auth.users where email = 'din@email.dk'` → skal indeholde `"lifetime_supporter": true`.

2. **Live mode** — gentag opsætningen i Live mode (nyt Payment Link, ny webhook, ny Price ID, opdater env-vars). Test ét rigtigt køb med dit eget kort på 199 kr — Stripe sender pengene til din bankkonto efter 7 dage (kan ned-justeres til instant ved KYC-verifikation).

---

## Trin 7 — Træningsappen (fit.sorovibe.com) skal læse flaget

Selve app'en på fit.sorovibe.com checker IKKE `lifetime_supporter` endnu — det er en separat opdatering der skal gøres næste gang vi rør app-kodebasen. Spørg mig om "gate-check" når du er klar.

Plan:
- Ved login: læs `user.user_metadata?.lifetime_supporter` → hvis true, sæt en global `isLifetime`-flag.
- Hvis user ikke er lifetime: forny `lifetime_purchases`-sync — slå email op, hvis match: opdater metadata + sæt flaget.
- Lås gated features: skjul "Køb lifetime" CTA, vis "Lifetime medlem"-badge.

---

## Hvis noget bryder

- **Webhook retry-loop** → tjek Vercel logs (`Deployments → seneste → Functions → /api/stripe-webhook`). Almindeligste fejl: forkert `STRIPE_WEBHOOK_SECRET` eller `SUPABASE_SERVICE_ROLE_KEY`.
- **Signature mismatch** → du har sandsynligvis kopieret webhook secret fra Test mode men kører Live mode (eller omvendt). Test og Live har separate secrets.
- **Supabase 401** → service_role key er forkert eller revoked. Re-generer i Supabase Settings → API → "Reset service_role JWT secret".
- **Køb registreres ikke** → tjek at Stripe Customer email-feltet faktisk er udfyldt på betalings-siden. Hvis du har "Email: Don't collect" går det galt.

## Bilag — hvad koden faktisk laver

```
[Bruger på sorovibe.com] → klik "Køb lifetime →"
        ↓
[Stripe Checkout (buy.stripe.com)] → bruger betaler
        ↓
[Stripe webhook] → POST https://sorovibe.com/api/stripe-webhook
        ↓
[stripe-webhook.js] → verificer signatur (HMAC-SHA256)
        ↓
[stripe-webhook.js] → indsæt række i Supabase `lifetime_purchases`
        ↓
[stripe-webhook.js] → slå op i auth.users efter email
        ↓
[hvis bruger findes] → opdater raw_user_meta_data.lifetime_supporter = true
[hvis bruger ikke findes] → bare gem i lifetime_purchases (sync ved næste login)
```
