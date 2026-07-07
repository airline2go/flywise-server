-- ═══════════════════════════════════════════════════════════════
-- [MISSING-INDEXES-FIX] Real gaps found by auditing server.js's
-- actual query patterns against the existing schema — every index
-- below backs a column that's queried repeatedly in hot paths
-- (cancellation, refund, order lookup, admin search), confirmed by
-- grep count in server.js, not guessed from column names alone.
--
-- Without these, Postgres has to sequentially scan the entire
-- `bookings` / `payments` table on every single cancellation,
-- refund, or "view booking" request — negligible today with a
-- small table, but this is exactly the kind of gap that turns into
-- a real slowdown once the table has tens of thousands of rows and
-- nobody remembers to fix it retroactively.
--
-- Safe to run any number of times (IF NOT EXISTS) and safe to run
-- on a live database — CREATE INDEX (without CONCURRENTLY) briefly
-- locks writes to the table while it builds; for these table sizes
-- today that's sub-second. If run later against a much larger,
-- actively-written table, switch to CREATE INDEX CONCURRENTLY
-- instead (cannot run inside a transaction block).
-- ═══════════════════════════════════════════════════════════════

-- bookings.duffel_order_id — looked up on every /cancel-quote,
-- /cancel-confirm, /order/:id, and /booking-confirmation call
-- (confirmed: 24 references in server.js). This is the single
-- hottest missing index in the schema.
create index if not exists bookings_duffel_order_id_idx
  on bookings (duffel_order_id);

-- bookings.booking_reference — the customer-facing reference code,
-- looked up whenever a booking is found by reference rather than
-- internal ID (confirmed: 21 references in server.js).
create index if not exists bookings_booking_reference_idx
  on bookings (booking_reference);

-- payments.stripe_payment_id — the Stripe PaymentIntent ID, used
-- to reconcile a booking's refund path back to its original charge
-- (confirmed: 10 references in server.js). payments_session_id_idx
-- already existed for stripe_session_id; this covers the other
-- lookup key on the same table.
create index if not exists payments_stripe_payment_id_idx
  on payments (stripe_payment_id);

-- loyalty_accounts.tier — the admin dashboard and any future
-- tier-based reporting/segmentation filters by this column; small
-- table today, but a text-column filter is one of the cheapest
-- indexes to add proactively.
create index if not exists loyalty_accounts_tier_idx
  on loyalty_accounts (tier);
