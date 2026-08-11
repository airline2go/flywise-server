# Airpiv / FlyWise — Backend Security & Financial Audit

**Repository:** `airline2go/flywise-server` (Express + Duffel + Stripe + Supabase + Redis + Sentry)
**Scope:** Backend only (no frontend / Next.js / UI changes), per the audit brief.
**Date:** 2026-08-11
**Baseline:** `npm ci` OK · Jest **540/540 pass** (41 suites) · ESLint 5 pre-existing errors / 9 warnings · `npm audit` 2 high + 1 low.

> **Note on repository scoping.** The audit brief describes the Express backend
> (Duffel, Stripe, webhooks, booking state machine, `bookingStatus` Map, etc.).
> That backend is **this repo (`flywise-server`)**, not `flywise-app` (which is
> the static/Next.js frontend that calls this server at `https://api.airpiv.com`).
> All findings and fixes below apply to `flywise-server`.

This document is the deliverable for brief §60. It lists every finding with a
severity, the affected file, the recommended fix, and — where already
implemented — the commit/tests. Work is **phased by priority**; only Phase 1 is
implemented in this PR. Each subsequent phase is intended as its own reviewable
PR because this is live financial/booking code.

---

## Executive summary

The backend is, overall, **more mature than a typical first audit target**:
server-authoritative pricing, Duffel `Idempotency-Key` on order creation,
full-refund-on-booking-failure, Stripe/Duffel webhook signature verification,
scrypt-hashed admin passwords with hashed session tokens, CORS whitelist,
helmet-lite security headers, Redis-backed rate limiting, RLS SQL, and a
540-test suite already exist.

The gaps that remain are concentrated in **durability, idempotency across
instances, financial-ledger correctness, and one clear open-redirect** — exactly
the areas the brief prioritizes.

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| F1 | Client-controlled Stripe `success_url`/`cancel_url` (open redirect) | **HIGH** | ✅ Fixed (Phase 1) |
| F2 | In-memory booking status → `unknown` after restart / across instances | **HIGH** | ✅ Fixed (Phase 1) |
| F3 | Stripe webhook not durable; no event store / dedup by `stripe_event_id` | **HIGH** | ⏳ Phase 2 |
| F4 | Idempotency is process-local (`inFlight` Set); no DB unique guard on `bookings.stripe_session_id` | **HIGH** | ⏳ Phase 2 |
| F5 | Duffel webhook: no timestamp-freshness / replay protection / event dedup | **MED-HIGH** | ⏳ Phase 2 |
| F6 | Payment ledger records **supplier (Duffel) net** as the customer payment amount | **MED-HIGH** | ⏳ Phase 3 |
| F7 | Money handled as floating-point (`parseFloat`, `*`, round-to-cents) | **MEDIUM** | ⏳ Phase 3 |
| F8 | Promo `used_count` increment is read-then-write (race → over-redemption) | **MEDIUM** | ⏳ Phase 3 |
| F9 | Guest booking access by `order_id`/`session_id` alone (no secret token) | **MEDIUM** | ⏳ Phase 4 (design) |
| F10 | `npm audit`: 2 high (transitive dev), 1 low (`body-parser`, runtime) | **LOW-MED** | ⏳ Phase 2 |
| F11 | No dedicated `/readiness`; `/health` returns 503 if any dependency down | **LOW** | ⏳ Phase 2 |

Items the brief lists that were **reviewed and found already adequate** are in
[§ "Already adequate"](#already-adequate-no-change-needed) so they are not
re-touched and risk is not introduced.

---

## Phase 1 — implemented in this PR

### F1 — Open redirect via client-supplied Stripe URLs — **HIGH** ✅

**Files:** `src/routes/booking.routes.js` (`/create-checkout-session`,
`/add-services`), `src/routes/flight-change.routes.js` (`/change-pay`).

**Before.** The browser sent `success_url` / `cancel_url` in the request body and
the server used them verbatim:

```js
success_url: (success_url || 'https://example.com/success') + '?session_id={CHECKOUT_SESSION_ID}',
cancel_url:  cancel_url  || 'https://example.com/cancel',
```

Any value was accepted — an external domain (open redirect off a payment flow),
a `javascript:`/`data:` URL, or a protocol-relative `//evil.com`. The
`example.com` fallback also meant a missing URL silently redirected off-site.

**Failure scenario.** An attacker crafts a booking link with
`success_url=https://evil.com/steal?` → after paying, the customer is redirected
to the attacker's page carrying the Stripe `session_id`, enabling phishing and
session-context leakage.

**Fix.** New `src/utils/redirectUrls.js`:
- Parses the client URL; accepts it **only** if its `origin` is in
  `env.ALLOWED_ORIGINS` (the same whitelist CORS uses:
  `airpiv.com`, `www.airpiv.com`, `flywise-app-amber.vercel.app`).
- Rejects `javascript:`/`data:`/`file:` (non-http(s) protocols), malformed URLs,
  protocol-relative URLs, and userinfo-spoofing (`https://airpiv.com@evil.com`).
- Falls back to the **canonical base** (`ALLOWED_ORIGINS[0]`) + a safe path —
  never `example.com`.
- Appends the Stripe `{CHECKOUT_SESSION_ID}` placeholder with correct `?`/`&`.

Backward compatible: the frontend already sends `airpiv.com` URLs, which pass the
whitelist unchanged (verified by the pre-existing flight-change test that asserts
`https://airpiv.com/success?change_session_id={CHECKOUT_SESSION_ID}`).

**Tests:** `test/redirectUrls.test.js` (23 assertions — the full §3.6 matrix:
valid Airpiv URL accepted, external rejected, look-alike subdomain rejected,
`javascript:`/`data:` rejected, protocol-relative rejected, malformed rejected,
empty → default, userinfo-spoof rejected) + existing endpoint tests remain green.

### F2 — In-memory booking status lost on restart / across instances — **HIGH** ✅

**Files:** `src/services/pendingBookings.js`, `src/routes/booking.routes.js`
(`GET /booking-status/:sessionId`).

**Before.** `bookingStatus` was a process-local `Map`. `GET /booking-status/:id`
read it synchronously; after a Render restart/redeploy (or when the poll hits a
second instance) it returned `status: 'unknown'` for a booking that had actually
succeeded — the customer paid, Duffel confirmed, the row is in the DB, but the
poll can't see it.

**Fix.** New durable resolver `resolveBookingStatus(sessionId)`:
- Reads the in-memory `Map` first (richest detail: `error`, `refunded`).
- Falls back to the durable `pending_bookings` row (already persisted at
  checkout-session creation and updated to `booked` + Duffel order id on
  confirmation) so status survives restarts and works across instances.
- The route is now `async` and awaits the resolver. The synchronous
  `getBookingStatus()` is unchanged for existing callers/tests.

No new table or migration — reuses the existing `pending_bookings` table.

**Tests:** `test/pendingBookings.status.test.js` (memory-first, DB-fallback,
null-session, not-found) + `test/booking.routes.test.js` durable-status block
(unknown, recovered-booked, async-await regression).

**Phase 1 result:** Jest **562/562 pass** (43 suites, +22 new). ESLint unchanged
from baseline (no new errors/warnings). No API-contract or money-math change.

---

## Phase 2 — durability & idempotency (recommended next PR)

### F3 — Stripe webhook is not durable — **HIGH** ⏳

**File:** `src/routes/webhooks.routes.js` (`POST /webhooks/stripe`).

Signature is verified (good) and the handler ACKs 200 immediately (good, avoids
Stripe retry storms). But there is **no event store**: if `bookFromSession()`
fails after the 200 ACK, the event is only sent to Sentry — it is not persisted,
not marked `processing_failed`, and not retryable. A crash/restart between ACK
and completion loses it (brief §4).

**Recommended fix (brief §4.1–§4.7):**
1. New table `stripe_events (stripe_event_id text unique, type, session_id,
   payment_intent, received_at, processed_at, status, error, retry_count)`.
2. On receipt: verify signature → `insert ... on conflict (stripe_event_id) do
   nothing`. If the row already exists and is `processed`, ACK and stop
   (idempotent, brief §4.4/§7.4). Then ACK 200.
3. Process asynchronously; on success set `processed_at`/`status='processed'`, on
   failure set `status='processing_failed'` + `error` + `retry_count`.
4. A reconciliation/worker job (brief §34/§49) retries `processing_failed` rows
   idempotently.

### F4 — Idempotency is process-local — **HIGH** ⏳

**Files:** `src/services/booking.js` (`inFlight = new Set()`),
`src/routes/booking.routes.js`, `src/routes/webhooks.routes.js`.

`inFlight` de-dupes only **within one process**. Two instances (webhook +
`/confirm-payment`) can both pass `inFlight.has(session.id)` and both call
`bookFromSession`. Duffel's `Idempotency-Key: order_<session_id>` prevents a
double Duffel order (good), but the **`bookings` and `payments` inserts are not
guarded by a DB unique constraint** → duplicate financial rows are possible
(brief §7.5, §21.7).

**Recommended fix:**
- `alter table bookings add constraint bookings_stripe_session_id_key unique
  (stripe_session_id)`; switch the insert to upsert / `on conflict do nothing`.
- Unique on `payments.stripe_payment_id` and `bookings.stripe_payment_id`.
- Optionally a Redis `SET NX` lock keyed by `session_id` as a cross-instance
  guard in front of `bookFromSession` (brief §7.3), with the DB constraint as
  the hard backstop.

### F5 — Duffel webhook replay / freshness — **MED-HIGH** ⏳

**File:** `src/routes/webhooks.routes.js` (`POST /webhooks/duffel`).

Signature verification uses `timingSafeEqual` (good), but there is **no
timestamp-freshness check** and **no processed-event dedup** — a captured valid
request can be replayed indefinitely (brief §10.3–§10.6).

**Recommended fix:** reject when `|now - t| > 5 min` (with small clock-drift
allowance); persist `duffel_event_id` (unique) and skip already-processed events.

### F10 — Dependency vulnerabilities — **LOW-MED** ⏳

`npm audit`: `brace-expansion` (high, transitive via eslint — dev only),
`js-yaml` (high, transitive via eslint — dev only), `body-parser <1.20.6` (low,
runtime via express). All fixable with a **non-major** `npm audit fix`. Recommend
applying in Phase 2 and re-running the suite (brief §39).

### F11 — Readiness vs liveness — **LOW** ⏳

`/health` returns 503 if **any** dependency (incl. Duffel) is down, which can make
an otherwise-serving process look dead (brief §32 warns against exactly this). Add
a separate `/readiness` (process + DB) distinct from a deep `/health`.

---

## Phase 3 — financial correctness (recommended, isolated PR)

### F6 — Payment ledger mislabels supplier cost as customer payment — **MED-HIGH** ⏳

**File:** `src/services/booking.js` (`payments` insert in `bookFromSession`).

```js
supa.from('payments').insert({ ...,
  amount: booking.duffel_amount ? Number(booking.duffel_amount) : null, // ← Duffel NET, not customer_paid
  ... });
```

The `payments` row records the **Duffel net (supplier) amount** as the payment,
which is exactly what brief §8.1/§8.2 warns against (customer paid €115, supplier
cost €100 — the ledger must not store €100 as the Stripe customer payment). The
authoritative `customer_paid` is correctly stored on `bookings`, but the
`payments` ledger is wrong for reconciliation.

**Recommended fix:** record `amount = customer_paid`, and store supplier cost and
margin as separate fields (or a separate ledger entry), each with `currency` and
`stripe_payment_id`. Enables true Stripe↔DB↔Duffel reconciliation (brief §8.9,
§49).

### F7 — Floating-point money — **MEDIUM** ⏳

`parseFloat` + `*` + `Math.round(x*100)/100` throughout pricing. Brief §8.6/§26
mandate integer minor units. This is a broad, high-risk refactor touching every
pricing path — do it as its own PR with the §26 test matrix (0, 0.01, 10.99,
large, discount, refund, currency mismatch, rounding) and a shared `money.js`
helper (add/mul/round in minor units, explicit rounding mode).

### F8 — Promo over-redemption race — **MEDIUM** ⏳

**File:** `src/services/booking.js` (`incrementPromoUsage`) — read-then-write,
acknowledged in a code comment. Concurrent checkouts can exceed `max_uses` (brief
§27.3/§27.4). **Fix:** a Postgres RPC doing an atomic
`update promo_codes set used_count = used_count + 1 where id = $1 and
(max_uses is null or used_count < max_uses)` and treating 0 rows as "limit
reached".

---

## Phase 4 — guest access model (design decision required)

### F9 — Guest booking access via `order_id`/`session_id` alone — **MEDIUM** ⏳

**Files:** `src/services/booking.js` (`checkOrderOwnership`),
`src/routes/booking.routes.js` (`/booking-confirmation`, `/order/:id`,
`/add-services`), `cancel.routes.js`, `flight-change.routes.js`.

For a **logged-in** user, authorization is correct (server-verified Supabase JWT
→ `req.userId`, compared to `bookings.user_id`; client-supplied ids are never
trusted — good). For a **guest** booking (`user_id = null`), knowledge of the
Duffel `order_id`/`session_id` alone is currently sufficient to view/act on the
booking. The brief (§2) states an order id must not be treated as a secret.

This is the "manage my booking by reference" model most OTAs use, so it is a
**deliberate design point, not an accidental IDOR** — but §2 asks for a stronger
mechanism. **Recommended design:** issue a cryptographically-random guest access
token at booking time, store **only its SHA-256 hash** (the codebase already does
exactly this for admin sessions in `adminAuth.hashToken`), return the token once,
and require it (plus optionally verified email) for guest booking access, with an
expiry. This changes the guest API contract and the frontend, so it needs product
sign-off and coordinated frontend work — hence a separate phase.

---

## Already adequate (no change needed)

Reviewed against the brief and found sufficient; **not** modified to avoid
introducing risk into live financial code:

- **Server-authoritative pricing** (§9): `computeAuthoritativePricing` re-derives
  net cost, margins, promo, loyalty from Duffel's live offer + server tables;
  client amounts are used only for drift detection. Price re-validated before
  booking; increase > €5 blocks the order and refunds in full.
- **Refund-on-failure durability** (§12): any Duffel order-create failure after
  payment triggers a Stripe refund; `refunded` flag surfaced; Sentry-alerted.
  Duffel `Idempotency-Key` prevents double orders.
- **Webhook signatures** (§4/§10): Stripe `constructEvent` + Duffel HMAC-SHA256
  with `timingSafeEqual`, both mounted on `express.raw` before `express.json`.
- **Auth** (§16): `attachUserIfPresent` verifies the Supabase JWT server-side;
  `user_id` is never trusted from the body. Admin routes uniformly `requireAdmin`;
  `requireFullAdmin` gates sensitive ops; staff/admin roles enforced server-side.
- **Admin identity** (§17): scrypt password hashing, session tokens stored as
  SHA-256 hashes, 12h expiry, per-request active-user re-check, activity log.
- **CORS** (§19): env-driven allowlist, no `*`, correct `OPTIONS` handling.
- **Security headers** (§51): nosniff, frame-deny, HSTS preload, strict CSP,
  Referrer-Policy, Permissions-Policy, `no-store` on payment routes.
- **Rate limiting** (§20): Redis distributed counters with conservative in-memory
  fallback; financial/booking buckets present.
- **Pending-booking durability** (§6 partial): `pending_bookings` table persists
  the checkout payload across restarts (in-memory only a cache).

---

## Test matrix coverage (brief §57) — current state

| Area | Existing | Added (Phase 1) | Remaining (later phases) |
|------|----------|-----------------|--------------------------|
| Payment | success/fail, refund-on-failure, price-drift refund | — | duplicate webhook, delayed webhook, replay, partial refund (F3) |
| Booking | normal, expired offer, Duffel 4xx/5xx, duplicate (process-local), idempotency | — | server-restart recovery (F4) |
| Auth | unauth, wrong user, guest, admin, staff | — | guest token valid/invalid/expired (F9) |
| Change | valid/expired/reused quote, price change, dup confirm | — | — |
| Cancellation | eligible/not, duplicate, webhook confirm | — | refund-failure manual-review (F3) |
| Security | IDOR, forged webhook, oversized payload, rate limit, invalid JWT | **open redirect / malformed / js: / data: URL** | webhook replay (F5) |
| Money | promo/discount/refund basics | redirect param edge cases | integer-minor-unit matrix (F7) |

---

## Production deployment checklist (delta from this PR)

- [x] No new env vars, no new DB migration required for Phase 1.
- [x] `ALLOWED_ORIGINS` must list every legitimate frontend origin (it drives both
      CORS **and** the new redirect whitelist) — currently
      `airpiv.com, www.airpiv.com, flywise-app-amber.vercel.app`.
- [x] Jest green (562/562); ESLint at baseline; no API-contract change.
- [ ] Phases 2–4 each ship their own migration(s) + tests + this checklist delta.
