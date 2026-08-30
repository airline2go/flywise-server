# CURRENT_FINANCE_ARCHITECTURE.md

> **AirPiv — Phase 0 Audit (1/3)**
> Snapshot of how money, payments, suppliers, invoices and audit currently work in
> `flywise-server` **before** any Finance/Accounting/VAT engine is built.
> Status: descriptive only. No tax rule, account, or ledger is invented here.
> Date: 2026-08-30. Branch: `claude/ready-for-edits-4h7xyf`.

---

## 1. High-level money flow (as it exists today)

```
Search (Duffel offer)
   → normalizeOffer()  [adds margin tiers to displayed price]
   → /create-checkout-session  [computeAuthoritativePricing → Stripe Checkout Session]
   → Stripe hosted payment page (customer pays customerAmount, fixed)
   → checkout.session.completed  (Stripe webhook)  AND/OR  /confirm-payment (browser)
       → bookFromSession()               [src/services/booking.js — THE core]
           → computeAuthoritativePricing()  [re-derive net + margin + promo + loyalty]
           → price-drift guard (>€5 rise → full Stripe refund, block)
           → Duffel POST /air/orders  (pay supplier NET only, Idempotency-Key order_<session>)
           → INSERT payments row        (customer amount + supplier_amount + margin_amount)
           → UPSERT bookings row         (onConflict stripe_session_id, ignoreDuplicates)
           → applyLoyaltyForBooking(), promo increment, referral attach
           → confirmation email (best-effort)
```

Cancellation / refund path:

```
/cancel-quote   → Duffel pending cancellation → REAL refund_amount + fee breakdown (preview)
/cancel-confirm → Duffel confirm + proportional Stripe refund + loyalty reversal + email
/cancel         → legacy simple path (full Duffel cancel + refund)
duffel webhook order_cancellation.confirmed → bookings.status = 'cancelled'
```

There is **no separate refund/chargeback ledger row today** — a refund flips
`bookings.status` and is recorded only as an admin *event* (`recordCancellationEvent`),
not as its own financial record.

---

## 2. Where each finance concept lives right now

| Concept | Location | Notes |
|---|---|---|
| Displayed "from" price + margin | `src/services/normalizeOffer.js`, `src/config/price.js` | Price snapshot, central TTL |
| Authoritative pricing | `src/services/booking.js → computeAuthoritativePricing()` | Single source of truth for net vs charged |
| Margin tiers config | `src/services/adminConfig.js` (`ticket_profit_tiers`, `ancillary_profit_tiers`) | Stored in `admin_config` |
| Money math | `src/utils/money.js` | Integer minor units + documented half-up rounding |
| Stripe client | `src/clients/stripe.js` | Null when key absent |
| Duffel client | `src/services/duffel.js` | Timeout + retry + circuit breaker |
| Stripe webhook | `src/routes/webhooks.routes.js` `/webhooks/stripe` | Signature verify, replay window, dedup |
| Duffel webhook | `src/routes/webhooks.routes.js` `/webhooks/duffel` | HMAC verify, cancellation sync |
| Webhook idempotency | `src/services/webhookEvents.js`, `sql/webhook_events.sql` | `stripe_webhook_events`, `duffel_webhook_events` |
| Booking idempotency | `sql/booking_idempotency.sql` | Unique indexes on session/payment ids |
| Invoices | `sql/schema_admin.sql` (`invoices`, `invoice_seq`), `admin.routes.js /admin/invoices/issue` | Gap-free §14 UStG sequence; **no VAT breakdown** |
| Invoice/tax config | `admin_config.invoice_config` (`taxMode: kleinunternehmer\|regular`) | Company header + tax mode only |
| Admin identity/roles | `sql/admin_staff.sql`, `src/services/adminAuth.js` | Only `admin` / `staff` |
| Admin audit | `admin_activity_log`, `loyalty_transactions`, `admin_credit_log` | App-level, not an immutable accounting log |
| Stats / profit | `admin.routes.js /admin/stats` | revenue = Σ customer_paid, profit = Σ profit_margin |

---

## 3. Money model as-implemented

- **Application layer** already has a correct integer-minor-unit utility
  (`money.js`, ISO-4217 aware: JPY=0, BHD=3, default=2, half-up rounding).
- **Database layer** stores every amount as `numeric(10,2)` in the booking's own
  currency. There is **no** `amount_minor`, no `accounting_amount_minor`, no
  `exchange_rate`, no `accounting_currency`. Amounts are single-currency per row.
- `bookings.profit_margin` is a **generated** column
  (`ticket_margin + ancillary_margin`).

### Amounts captured per booking (`bookings`)
`customer_paid` (Stripe charge), `duffel_amount` (supplier NET), `ticket_margin`,
`ancillary_margin`, `discount_amount`, `loyalty_discount`, `promo_code`,
`loyalty_points_earned`, `profit_margin` (generated), `currency`.

### Amounts captured per payment (`payments`)
`amount` (customer), `supplier_amount` (Duffel NET), `margin_amount`, `currency`,
`status` (`paid|refunded|failed`), `stripe_session_id`, `stripe_payment_id`.

---

## 4. Integrations

### Stripe
- Used **only** for Checkout Sessions + PaymentIntents + ad-hoc refunds
  (`stripe.refunds.create`).
- Webhook handles `checkout.session.completed` and `payment_intent.payment_failed`.
- **Not imported / not stored:** Balance Transactions, **Stripe fees**, Payouts,
  Disputes/Chargebacks, currency conversions, adjustments. Stripe fee is currently
  invisible to accounting.

### Duffel
- Used for search, offers, seat maps, order creation, cancellations.
- Supplier cost = `payAmount` (offer `total_amount`, net).
- **Not imported / not stored:** Duffel **invoices**, invoice line items, Duffel
  **fees** (the "$3 + 1%"), credits, adjustments. Supplier cost is only the order
  net; no official Duffel invoice is reconciled against it.

---

## 5. Idempotency & durability (already strong)

- Stripe: signature verify + `MAX_WEBHOOK_AGE_SEC=300` replay window +
  `stripe_webhook_events` dedup (`received|processed|processing_failed`).
- Duffel: HMAC verify + freshness window + `duffel_webhook_events` dedup.
- Duffel order create carries `Idempotency-Key: order_<session_id>`.
- DB unique indexes: one booking per session / per payment intent, one payment per
  payment intent (`sql/booking_idempotency.sql`).
- In-process `inFlight` Set de-dupes within a single Node process.

This is a **good foundation** to extend with `financial_events.idempotency_key`.

---

## 6. Scheduled jobs

- In-process `setInterval` refreshers only: `routeIntelligenceRefresh`,
  `routePriceHistoryRefresh` (loaded from `server.js`).
- **No** finance cron: no Stripe sync, no Duffel invoice sync, no reconciliation,
  no VAT preparation, no ledger integrity check.

---

## 7. Security / RLS

- `sql/rls_security_fixes.sql` enables RLS and locks service-role-only tables
  (incl. `payments`, `invoices`, `loyalty_accounts`).
- Admin auth: `ADMIN_TOKEN` legacy shared secret **plus** per-admin accounts
  (`admin_users`, `admin_sessions`, scrypt passwords). Roles limited to
  `admin` (full) and `staff` (no margins/credit/staff-mgmt).

---

## 8. Observability

- Sentry wired (`src/clients/sentry.js`) with a `critical: booking_failed_after_payment`
  tag on post-payment booking failures.
- `api_logs` records Duffel API cost/latency.
- Structured `log()` helper throughout.

---

## 9. One-line summary

AirPiv today has a **correct, idempotent booking-and-payment pipeline** with
clean margin math and a gap-free invoice sequence — but it has **no accounting
core**: no double-entry ledger, no tax engine, no Stripe/Duffel fee capture, no
reconciliation, no immutable audit ledger, no multi-currency/FX record, and only
a two-role admin model. Everything downstream of "a booking was paid" is derived
ad-hoc from `bookings`/`payments`, not posted as immutable financial events.
