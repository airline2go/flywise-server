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
| F3 | Stripe webhook not durable; no event store / dedup by `stripe_event_id` | **HIGH** | ✅ Fixed (Phase 2) |
| F4 | Idempotency is process-local (`inFlight` Set); no DB unique guard on `bookings.stripe_session_id` | **HIGH** | ✅ Fixed (Phase 2) |
| F5 | Duffel webhook: no timestamp-freshness / replay protection / event dedup | **MED-HIGH** | ✅ Fixed (Phase 2) |
| F6 | Payment ledger records **supplier (Duffel) net** as the customer payment amount | **MED-HIGH** | ✅ Fixed (Phase 3) |
| F7 | Money handled as floating-point (`parseFloat`, `*`, round-to-cents) | **MEDIUM** | ◑ Partial (Phase 3): helper + charge boundary; deep engine conversion deferred |
| F8 | Promo `used_count` increment is read-then-write (race → over-redemption) | **MEDIUM** | ✅ Fixed (Phase 3) |
| F9 | Guest booking access by `order_id`/`session_id` alone (no secret token) | **MEDIUM** | ⏳ Phase 4 (design) |
| F10 | `npm audit`: 2 high (transitive dev), 1 low (`body-parser`, runtime) | **LOW-MED** | ✅ Fixed (Phase 2) |
| F11 | No dedicated `/readiness`; `/health` returns 503 if any dependency down | **LOW** | ✅ Fixed (Phase 2) |

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

## Phase 2 — durability & idempotency (implemented)

> **Migrations required before/with deploy:** `sql/webhook_events.sql`
> (`stripe_webhook_events`, `duffel_webhook_events`) and
> `sql/booking_idempotency.sql` (unique indexes on
> `bookings.stripe_session_id`, `bookings.stripe_payment_id`,
> `payments.stripe_payment_id`). All idempotent / safe to re-run. Every code
> path degrades gracefully when the tables/constraints are absent (best-effort,
> same behavior as before), so code and SQL can deploy in either order — but the
> guarantees only take effect once the SQL is applied.

**Result:** Jest **576/576 pass** (45 suites, +14). ESLint at baseline. `npm audit`
**0 vulnerabilities**. No API-contract or money-math change.

### F3 — Durable Stripe webhook events + dedup — **HIGH** ✅

**Files:** `src/services/webhookEvents.js` (new), `src/routes/webhooks.routes.js`,
`sql/webhook_events.sql` (new).

Every Stripe event is recorded in `stripe_webhook_events` (PK `stripe_event_id`)
**before** processing. A re-delivery already marked `processed` is skipped
(dedup); a processing failure marks the row `processing_failed` + `last_error` +
`retry_count` instead of being Sentry-only — leaving it recoverable by a
reconciliation/worker job (brief §4.1–§4.7). `beginStripeEvent` degrades to
best-effort (behaves exactly as before) when Supabase is unconfigured or the
event carries no id.

**Tests:** `test/webhookEvents.test.js` (begin/complete/fail state machine:
processed→skip, failed→retry, first-seen→process, 23505 race, non-conflict
error→best-effort) + `test/webhooks.routes.test.js` (dedup-skip on a
`processed` event, first-seen still books).

### F4 — Cross-instance booking idempotency — **HIGH** ✅

**Files:** `src/services/booking.js`, `sql/booking_idempotency.sql` (new).

The `bookings` write is now an **upsert on `stripe_session_id` with
`ignoreDuplicates`** (INSERT … ON CONFLICT DO NOTHING), backed by UNIQUE indexes
on `bookings.stripe_session_id`, `bookings.stripe_payment_id`, and
`payments.stripe_payment_id`. If the Stripe webhook and `/confirm-payment` both
reach `bookFromSession` on separate instances for the same paid session, only one
financial row is ever written — the DB constraint is the hard cross-instance
backstop the in-process `inFlight` Set cannot provide (brief §7.5, §21.7). Duffel's
existing `Idempotency-Key` continues to prevent a double Duffel order.

### F5 — Duffel webhook replay/freshness + dedup — **MED-HIGH** ✅

**Files:** `src/routes/webhooks.routes.js`, `src/services/webhookEvents.js`,
`sql/webhook_events.sql` (`duffel_webhook_events`).

Added a **timestamp-freshness check** — a correctly-signed payload whose signed
`t` is more than `MAX_WEBHOOK_AGE_SEC` (300s) from now (past or future) is
rejected `400` before any work — plus **per-event dedup** on `duffel_event_id`,
so a captured/replayed or re-delivered event is not re-applied (brief §10.3–§10.6).

**Tests:** stale-timestamp rejected, duplicate `processed` event skipped, plus the
full existing Duffel webhook suite (valid/invalid signature, DB-error, unknown
type).

### F10 — Dependency vulnerabilities — **LOW-MED** ✅

`npm audit fix` (non-major, lockfile-only) → **0 vulnerabilities** (was 2 high /
1 low). No `package.json` range changes; full suite re-run green (brief §39).

### F11 — Readiness vs liveness — **LOW** ✅

**Files:** `src/routes/health.routes.js`, `src/middleware/globalMiddleware.js`.

New `GET /readiness` gates **only** on the database (the critical serving
dependency) and is excluded from the maintenance kill-switch — a Duffel/Stripe/
Redis outage no longer makes an otherwise-serving process look un-ready (brief
§32). Deep `/health` (all dependencies) is unchanged; liveness stays `/`.

**Tests:** `test/health.readiness.test.js` (200 when DB reachable, 503 on DB error).

---

## Phase 3 — financial correctness (implemented)

> **Migrations required:** `sql/payment_ledger.sql` (`payments.supplier_amount`,
> `payments.margin_amount`) and `sql/promo_atomic_increment.sql`
> (`increment_promo_usage` RPC). Idempotent / safe to re-run. Code degrades
> gracefully if not yet applied.

**Result:** Jest **598/598 pass** (48 suites, +22). ESLint at baseline. `npm audit`
0 vulnerabilities.

### F6 — Payment ledger records the customer payment — **MED-HIGH** ✅

**Files:** `src/services/booking.js`, `sql/payment_ledger.sql` (new).

The `payments` insert in `bookFromSession` previously stored the **Duffel net
(supplier) amount** in `amount` — a €115 customer charge appeared as €100 in the
ledger (brief §8.1/§8.2). Now `amount = customer_paid` (what Stripe actually
charged), with the supplier cost and margin in their own additive columns
(`supplier_amount`, `margin_amount`), so the ledger reconciles independently
against Stripe (customer) and Duffel (supplier). The figures are computed once
and shared with the `bookings` row so they can't disagree.

**Test:** `test/booking.ledger.test.js` — end-to-end `bookFromSession` asserts
`amount=113, supplier_amount=100, margin_amount=13` for a €100-net / €13-margin
booking.

### F7 — Integer-minor-unit money — **MEDIUM** ◑ (partial)

**Files:** `src/utils/money.js` (new), `src/routes/booking.routes.js`,
`src/routes/flight-change.routes.js`, `src/services/booking.js`.

Added `money.js` — the single documented money utility the brief (§26) requires:
`toMinor`/`fromMinor`/`roundMoney`/`sumMoney` in integer minor units, with
explicit per-currency decimals (0/2/3, incl. zero-decimal JPY) and a half-up
rounding policy that avoids the classic `1.005*100` float artifact. The **actual
Stripe charge amounts** (`/create-checkout-session`, `/add-services`,
`/change-pay`) and the ledger margin now go through it instead of ad-hoc
`Math.round(x*100)`.

**Honest scope:** this establishes the mandated helper and routes the money that
actually leaves/enters the customer's account through it, but the **internal
pricing engine** (`computeAuthoritativePricing`, `normalizeOffer`, tier math)
still computes in floats before that boundary. Converting the whole engine to
minor units is a broad, higher-risk change deferred to its own PR — tracked as
**F7-deep**. Values are unaffected for the 2-decimal currencies in use (the
helper produces identical results at the charge boundary).

**Test:** `test/money.test.js` — the full §26 matrix (0, 0.01, 10.99, large,
discount, refund, rounding artifact, currency decimals, case-insensitivity).

### F8 — Atomic promo increment — **MEDIUM** ✅

**Files:** `src/services/booking.js` (`incrementPromoUsage`),
`sql/promo_atomic_increment.sql` (new).

Replaced the read-then-write increment with the `increment_promo_usage` RPC — a
single guarded `UPDATE … WHERE id=$1 AND (max_uses IS NULL OR used_count <
max_uses)` returning whether it incremented. Two concurrent checkouts can no
longer push `used_count` past `max_uses` (brief §27.3/§27.4); a cap-reached
result is logged.

**Test:** `test/promoIncrement.test.js` — RPC called with the promo id, `true` on
success, `false`+log on cap-reached, `false`+log on error, no-op without an id.

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
