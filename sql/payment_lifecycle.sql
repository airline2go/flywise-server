-- ============================================================
-- Airpiv — Payment lifecycle: AUTHORIZE → BOOK → CAPTURE (run once
-- in Supabase SQL Editor). Safe to re-run: every statement is
-- idempotent (add column if not exists / create ... if not exists /
-- guarded do-blocks).
--
-- [PAYMENT-LIFECYCLE] The booking flow moved from an immediate
-- Stripe charge (captured at checkout, refunded if Duffel failed) to
-- a manual-capture authorization that is only CAPTURED after the
-- Duffel supplier booking succeeds — and CANCELLED (not refunded) if
-- the supplier booking fails before capture. That lifecycle needs
-- richer, SEPARATE state than the single legacy `status` column can
-- carry (brief §5/§6/§20):
--   * booking_status  — the operational state of the trip booking
--   * payment_status  — the Stripe money state (authorized/captured/…)
--   * supplier_status — the Duffel supplier state
-- The legacy `bookings.status` (confirmed|cancelled|refunded, guarded
-- by bookings_status_check) is UNCHANGED and still written exactly as
-- before, so existing admin/stats code keeps working untouched; the
-- new columns are additive and nullable.
-- ============================================================

create extension if not exists pgcrypto;

-- ─── bookings: payment lifecycle columns ────────────────────────
alter table bookings add column if not exists payment_status text default 'pending';
alter table bookings add column if not exists booking_status text;
alter table bookings add column if not exists supplier_status text;
alter table bookings add column if not exists payment_intent_id text;
alter table bookings add column if not exists authorized_amount numeric(10,2);
alter table bookings add column if not exists authorized_at timestamptz;
alter table bookings add column if not exists authorization_expires_at timestamptz;
alter table bookings add column if not exists captured_amount numeric(10,2);
alter table bookings add column if not exists captured_at timestamptz;
alter table bookings add column if not exists capture_id text;
alter table bookings add column if not exists capture_attempts int default 0;
alter table bookings add column if not exists authorization_cancelled_at timestamptz;
alter table bookings add column if not exists last_payment_error text;
alter table bookings add column if not exists payment_operation_id text;

-- CHECK constraints for the new status vocabularies (brief §6). Added
-- via guarded do-blocks (Postgres has no ADD CONSTRAINT IF NOT EXISTS).
-- Kept in sync with src/services/payments.js constants — if one of
-- these ever fails to apply, a row already holds a value outside the
-- set, which is itself the finding.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'bookings_payment_status_check') then
    alter table bookings add constraint bookings_payment_status_check
      check (payment_status is null or payment_status in (
        'pending','authorized','capture_pending','captured','authorization_cancelled',
        'capture_failed','authorization_expired','refund_pending','refunded','manual_review_required'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'bookings_booking_status_check') then
    alter table bookings add constraint bookings_booking_status_check
      check (booking_status is null or booking_status in (
        'pending','booking_pending_supplier','booking_confirmed','booking_failed',
        'ticketed','cancel_requested','cancelled','manual_review_required'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'bookings_supplier_status_check') then
    alter table bookings add constraint bookings_supplier_status_check
      check (supplier_status is null or supplier_status in (
        'pending','revalidated','booking_requested','booked','failed','cancelled'));
  end if;
end $$;

-- One authorization/PaymentIntent per booking (defence in depth beside the
-- existing stripe_payment_id partial-unique index in booking_idempotency.sql).
create unique index if not exists bookings_payment_intent_id_key
  on bookings (payment_intent_id)
  where payment_intent_id is not null;
create index if not exists bookings_payment_status_idx on bookings (payment_status);
create index if not exists bookings_booking_status_idx on bookings (booking_status);
-- Admin/reconciliation: quickly find everything needing a human.
create index if not exists bookings_manual_review_idx on bookings (booking_status)
  where booking_status = 'manual_review_required';

-- ─── payments: lifecycle columns (ledger stays authoritative on amount) ──
-- payments.status keeps its own CHECK ('paid'|'refunded'|'failed') and is
-- written exactly as before; payment_status is the richer, additive lifecycle
-- mirror so the ledger row can distinguish authorized vs captured vs cancelled.
alter table payments add column if not exists payment_status text;
alter table payments add column if not exists payment_intent_id text;
alter table payments add column if not exists authorized_at timestamptz;
alter table payments add column if not exists captured_at timestamptz;
alter table payments add column if not exists captured_amount numeric(10,2);
alter table payments add column if not exists capture_id text;
alter table payments add column if not exists authorization_cancelled_at timestamptz;
create index if not exists payments_payment_intent_id_idx on payments (payment_intent_id);

-- ─── payment_operations: durable idempotency record (brief §21) ─────────
-- A durable answer to "has this authorization / capture / cancel already
-- been attempted, and did it succeed?" — so correctness never depends only
-- on the in-memory `inFlight` Set (brief §21: in-memory protection is useful
-- but NOT sufficient). One row per (session_id, operation): the UNIQUE
-- constraint makes a concurrent second capture/cancel from browser + webhook
-- collapse to a single durable record instead of two.
create table if not exists payment_operations (
  id uuid primary key default gen_random_uuid(),
  session_id        text not null,
  payment_intent_id text,
  operation         text not null,                     -- authorize | capture | cancel
  status            text not null default 'pending',   -- pending | success | failed
  attempts          int  not null default 0,
  amount_minor      bigint,
  currency          text,
  stripe_error_code text,
  last_error        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (session_id, operation)
);
create index if not exists payment_operations_pi_idx on payment_operations (payment_intent_id);
create index if not exists payment_operations_status_idx on payment_operations (status);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'payment_operations_operation_check') then
    alter table payment_operations add constraint payment_operations_operation_check
      check (operation in ('authorize','capture','cancel'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'payment_operations_status_check') then
    alter table payment_operations add constraint payment_operations_status_check
      check (status in ('pending','success','failed'));
  end if;
end $$;

-- ─── pending_bookings: widen the transient status vocabulary ────────────
-- /booking-status polling reads pending_bookings.status. The lifecycle adds
-- transient states the frontend recovery poll must be able to observe
-- (authorized before booking, authorization_cancelled / capture_failed /
-- manual_review outcomes). Re-created to include them; the old set stays valid.
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'pending_bookings_status_check') then
    alter table pending_bookings drop constraint pending_bookings_status_check;
  end if;
  alter table pending_bookings add constraint pending_bookings_status_check
    check (status in (
      'pending','paid','authorized','booked','failed',
      'authorization_cancelled','capture_failed','manual_review','failed_price_drift'));
end $$;

alter table pending_bookings add column if not exists payment_intent_id text;
alter table pending_bookings add column if not exists payment_status text;
