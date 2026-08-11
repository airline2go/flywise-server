-- ============================================================
-- Airpiv — Booking/payment idempotency constraints (run once in
-- Supabase SQL Editor). Safe to re-run.
--
-- [F4 · CROSS-INSTANCE IDEMPOTENCY] The Stripe webhook and the browser's
-- /confirm-payment can both drive bookFromSession() for the same checkout
-- session. Duffel's own Idempotency-Key (order_<session_id>) prevents a
-- double *Duffel* order, and an in-process Set de-dupes within one Node
-- process — but across two Render instances neither guard applies to the
-- Supabase writes, so a race could insert two `bookings` rows (and two
-- `payments` rows) for a single paid session. A UNIQUE constraint is the
-- hard, cross-instance backstop: the second writer's insert is rejected /
-- ignored instead of duplicating the financial record.
--
-- NOTE: if these fail because duplicate rows already exist, de-duplicate
-- first (keep the earliest row per key) — a pre-existing duplicate is
-- itself a bug this constraint is meant to prevent going forward.
-- ============================================================

-- One booking per Stripe checkout session.
create unique index if not exists bookings_stripe_session_id_key
  on bookings (stripe_session_id)
  where stripe_session_id is not null;

-- One booking per Stripe PaymentIntent (defence in depth alongside the
-- session key above).
create unique index if not exists bookings_stripe_payment_id_key
  on bookings (stripe_payment_id)
  where stripe_payment_id is not null;

-- One payment ledger row per Stripe PaymentIntent.
create unique index if not exists payments_stripe_payment_id_key
  on payments (stripe_payment_id)
  where stripe_payment_id is not null;
