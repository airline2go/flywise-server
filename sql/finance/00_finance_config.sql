-- ============================================================
-- AirPiv Finance — Phase 1 · 00 · CONFIGURATION (regime / role / FX)
-- Run once in Supabase SQL Editor. Idempotent. Safe to re-run.
--
-- This file stores the *governing decisions* the whole finance engine
-- reads, and NOTHING that interprets tax law. Every legally-unsettled
-- value ships as REVIEW_REQUIRED and must be approved by a Steuerberater
-- before any production VAT/revenue treatment is derived from it (spec
-- Phase 1 Decisions 1–3, Phase 49–50).
--
-- Design: `finance_config` holds the CURRENT value of each key.
-- `finance_config_versions` is an APPEND-ONLY history (immutable — see
-- 06_integrity_triggers.sql) so any past posting can be reproduced against
-- the config that was in force when it happened (GoBD reproducibility).
-- ============================================================

create extension if not exists pgcrypto;   -- gen_random_uuid()

-- Current, single-row-per-key configuration.
create table if not exists finance_config (
  key            text primary key,
  value          text not null,
  review_status  text not null default 'APPROVED'
                   check (review_status in ('DRAFT','REVIEW_REQUIRED','APPROVED')),
  effective_from timestamptz not null default now(),
  effective_until timestamptz,
  updated_at     timestamptz not null default now(),
  updated_by     text,
  note           text
);

-- Append-only audit of every config change (never UPDATEd/DELETEd).
create table if not exists finance_config_versions (
  id            uuid primary key default gen_random_uuid(),
  key           text not null,
  old_value     text,
  new_value     text not null,
  review_status text not null,
  changed_at    timestamptz not null default now(),
  changed_by    text,
  reason        text
);
create index if not exists finance_config_versions_key_idx
  on finance_config_versions (key, changed_at desc);

-- ── Seed the governing decisions (only if absent — never overwrite a
--    value an operator/Steuerberater has since changed). ──────────────
insert into finance_config (key, value, review_status, note) values
  -- DECISION 1 — accounting currency is EUR; original currency always kept.
  ('accounting_currency', 'EUR', 'APPROVED',
   'Ledger base currency. Original transaction currency is preserved on every event.'),
  -- FX source per purpose. Settlement/accounting may use provider/ECB;
  -- the VAT conversion method is a legal question → REVIEW_REQUIRED.
  ('settlement_fx_source', 'PROVIDER', 'APPROVED',
   'Settlement amounts keep the source provider (Stripe/Duffel) settlement FX as-reported.'),
  ('accounting_fx_source', 'ECB', 'APPROVED',
   'Default booking-to-EUR conversion for the ledger. Overridable per event type later.'),
  ('vat_fx_source', 'REVIEW_REQUIRED', 'REVIEW_REQUIRED',
   'FX method for VAT base conversion — must be approved by Steuerberater before use.'),
  -- DECISION 2 — AirPiv contractual role is NOT decided in code.
  ('airpiv_business_role', 'REVIEW_REQUIRED', 'REVIEW_REQUIRED',
   'principal/intermediary/agent is a legal determination — pending Steuerberater review.'),
  -- DECISION 3 — VAT regime is settled: Regelbesteuerung (not Kleinunternehmer).
  ('vat_regime', 'REGELBESTEUERUNG', 'APPROVED',
   'Standard VAT regime. Does NOT imply a default 19% on any booking — Tax Engine decides per transaction.')
on conflict (key) do nothing;

-- Record the seed as the first version entry (best-effort; only for keys
-- that have no history yet, so re-running never stacks duplicates).
insert into finance_config_versions (key, old_value, new_value, review_status, changed_by, reason)
select c.key, null, c.value, c.review_status, 'system:phase1-seed', 'Phase 1 initial seed'
from finance_config c
where not exists (select 1 from finance_config_versions v where v.key = c.key);
