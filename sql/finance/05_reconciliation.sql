-- ============================================================
-- AirPiv Finance — Phase 1 · 05 · RECONCILIATION
-- reconciliation_matches, reconciliation_exceptions.
-- Run once. Idempotent. Additive.
--
-- Structure only (spec Phase 11). The matching ENGINE (Booking ↔ Stripe ↔
-- Duffel ↔ Bank ↔ Ledger) is Phase 2+ backend logic; these tables hold its
-- results and the exceptions it raises. Matching must never rely on amount
-- alone — the match_keys jsonb records exactly which keys were used.
-- ============================================================

create extension if not exists pgcrypto;

create table if not exists reconciliation_matches (
  id            uuid primary key default gen_random_uuid(),
  status        text not null default 'MANUAL_REVIEW'
                  check (status in ('MATCHED','PARTIALLY_MATCHED','UNMATCHED','MANUAL_REVIEW')),
  -- The two (or more) sides being reconciled, kept generic.
  left_source   text,          -- 'booking'|'stripe'|'duffel'|'bank'|'ledger'
  left_id       text,
  right_source  text,
  right_id       text,
  match_keys    jsonb,         -- which keys matched: {amount,currency,date,booking_id,...}
  amount_minor  bigint,
  currency      text,
  difference_minor bigint not null default 0,
  matched_by    text,          -- 'system' | admin id
  matched_at    timestamptz,
  created_at    timestamptz not null default now(),
  note          text
);
create index if not exists reconciliation_matches_status_idx on reconciliation_matches (status);
create index if not exists reconciliation_matches_left_idx   on reconciliation_matches (left_source, left_id);
create index if not exists reconciliation_matches_right_idx  on reconciliation_matches (right_source, right_id);

create table if not exists reconciliation_exceptions (
  id            uuid primary key default gen_random_uuid(),
  exception_type text not null,   -- STRIPE_PAYOUT_UNMATCHED, DUFFEL_UNMATCHED, BOOKING_AMOUNT_MISMATCH, ...
  source        text,
  source_id     text,
  booking_id    uuid,
  amount_minor  bigint,
  currency      text,
  difference_minor bigint,
  severity      text not null default 'REVIEW'
                  check (severity in ('INFO','REVIEW','CRITICAL')),
  status        text not null default 'OPEN'
                  check (status in ('OPEN','IN_REVIEW','RESOLVED','REJECTED')),
  details       jsonb,
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz,
  resolved_by   text
);
create index if not exists reconciliation_exceptions_status_idx on reconciliation_exceptions (status);
create index if not exists reconciliation_exceptions_type_idx   on reconciliation_exceptions (exception_type);
