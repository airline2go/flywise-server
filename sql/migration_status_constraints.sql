-- ═══════════════════════════════════════════════════════════════
-- [MISSING-CONSTRAINTS-FIX] Three "status" columns across the
-- schema (bookings, payments, pending_bookings) are documented in
-- their own inline comments as having a fixed set of valid values
-- (e.g. "confirmed | cancelled | refunded") — but nothing in the
-- database actually ENFORCES that. A bug, a bad manual edit in the
-- Supabase table editor, or a future code change could silently
-- write an invalid status (a typo like 'cancelld', or an unrelated
-- value) and nothing would catch it — the column would just accept
-- it, and every piece of code that branches on status would then
-- be working against a value it never expected.
--
-- Each constraint below uses the exact value set already documented
-- in the schema's own comments, cross-checked against every literal
-- status value server.js actually writes today (confirmed via grep,
-- not guessed). This should be a pure no-op against current data —
-- but if it ever fails to apply, that failure IS the finding: it
-- means a row already holds a status value outside the documented
-- set, worth investigating before forcing the constraint through.
--
-- RECOMMENDED FIRST STEP before running this file: run each of the
-- three SELECT DISTINCT queries below yourself and confirm every
-- value shown is one of the ones the CHECK constraint allows.
--
--   select distinct status from bookings;
--   select distinct status from payments;
--   select distinct status from pending_bookings;
--
-- Uses a DO block per table because Postgres has no native
-- "ADD CONSTRAINT IF NOT EXISTS" — this checks pg_constraint
-- first, so the file is safe to run more than once.
-- ═══════════════════════════════════════════════════════════════

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'bookings_status_check') then
    alter table bookings
      add constraint bookings_status_check
      check (status in ('confirmed', 'cancelled', 'refunded'));
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'payments_status_check') then
    alter table payments
      add constraint payments_status_check
      check (status in ('paid', 'refunded', 'failed'));
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pending_bookings_status_check') then
    alter table pending_bookings
      add constraint pending_bookings_status_check
      check (status in ('pending', 'paid', 'booked', 'failed'));
  end if;
end $$;

-- [PROMO-CODE-SANITY-CHECK] Nothing currently stops an admin from
-- typing "500" into the value field for a "percent" promo code
-- (e.g. via a fat-fingered admin panel entry) — the checkout code
-- happens to cap the applied discount at the offer's own price, so
-- this wouldn't produce a negative charge, but it's still clearly
-- invalid business data that should never have been saved in the
-- first place. Fixed-amount codes have no upper cap here since
-- that's a currency amount, not a percentage.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'promo_codes_value_check') then
    alter table promo_codes
      add constraint promo_codes_value_check
      check (value > 0 and (type <> 'percent' or value <= 100));
  end if;
end $$;
