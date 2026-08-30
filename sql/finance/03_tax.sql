-- ============================================================
-- AirPiv Finance — Phase 1 · 03 · TAX ENGINE TABLES
-- tax_rules, tax_rule_versions, tax_transactions, tax_exceptions.
-- Run once. Idempotent. Additive.
--
-- CRITICAL (spec Phase 6, 49–50, Tax Rule Safety): this file creates the
-- STRUCTURE of a versioned, configurable tax engine and seeds NO production
-- tax rule. The only seeded rule is a placeholder in REVIEW_REQUIRED state.
-- No vat_rate / exemption / reverse_charge / revenue_recognition value is
-- treated as authoritative until a Steuerberater approves it. tax_rule_versions
-- are immutable in content (enforced in 06_integrity_triggers.sql).
-- ============================================================

create extension if not exists pgcrypto;

-- ── Tax rules (logical rule; lifecycle only, no numbers here) ──
create table if not exists tax_rules (
  id             uuid primary key default gen_random_uuid(),
  rule_code      text unique not null,
  rule_name      text not null,
  status         text not null default 'DRAFT'
                   check (status in ('DRAFT','REVIEW_REQUIRED','APPROVED','ACTIVE','RETIRED')),
  requires_review boolean not null default true,
  created_at     timestamptz not null default now(),
  created_by     text
);

-- ── Tax rule versions (the actual, immutable, dated rule content) ──
-- Content columns are frozen once written; only lifecycle columns
-- (status/review/approval/valid_until) may change (see triggers).
create table if not exists tax_rule_versions (
  id                 uuid primary key default gen_random_uuid(),
  tax_rule_id        uuid not null references tax_rules(id) on delete cascade,
  version            int  not null,
  -- Matching dimensions (spec Phase 6). All nullable — a rule matches on the
  -- dimensions it constrains.
  tax_type           text,
  transaction_type   text,
  service_type       text,
  supplier_type      text,
  customer_type      text,
  customer_country   text,
  supplier_country   text,
  origin_country     text,
  destination_country text,
  route_type         text,
  -- Outcome (NEVER invented — stays null / review until approved).
  vat_rate           numeric(6,3),
  taxable_percentage numeric(6,3),
  output_vat_required boolean,
  input_vat_allowed  boolean,
  reverse_charge     boolean,
  exemption_code     text,
  revenue_recognition text
                       check (revenue_recognition in
                         ('PRINCIPAL','AGENT','INTERMEDIARY','PASS_THROUGH','REVIEW_REQUIRED') or revenue_recognition is null),
  legal_basis        text,
  source_reference   text,
  valid_from         date,
  valid_until        date,
  status             text not null default 'REVIEW_REQUIRED'
                       check (status in ('DRAFT','REVIEW_REQUIRED','APPROVED','ACTIVE','RETIRED')),
  review_status      text not null default 'REVIEW_REQUIRED'
                       check (review_status in ('DRAFT','REVIEW_REQUIRED','APPROVED','REJECTED')),
  approved_by        text,
  approved_at        timestamptz,
  created_at         timestamptz not null default now(),
  created_by         text,
  unique (tax_rule_id, version)
);
create index if not exists tax_rule_versions_rule_idx   on tax_rule_versions (tax_rule_id, version desc);
create index if not exists tax_rule_versions_status_idx on tax_rule_versions (status);

-- Seed ONLY a placeholder rule so the engine can reference a concrete
-- REVIEW_REQUIRED target instead of guessing. No tax numbers set.
do $$
declare v_rule uuid;
begin
  if not exists (select 1 from tax_rules where rule_code = 'RULE_REVIEW_REQUIRED_001') then
    insert into tax_rules (rule_code, rule_name, status, requires_review, created_by)
    values ('RULE_REVIEW_REQUIRED_001', 'Unclassified — pending Steuerberater review',
            'REVIEW_REQUIRED', true, 'system:phase1-seed')
    returning id into v_rule;
    insert into tax_rule_versions (tax_rule_id, version, status, review_status, legal_basis, created_by)
    values (v_rule, 1, 'REVIEW_REQUIRED', 'REVIEW_REQUIRED',
            'Placeholder — no legal interpretation applied.', 'system:phase1-seed');
  end if;
end $$;

-- ── Tax transactions (the per-event tax outcome, always rule+version tagged) ──
create table if not exists tax_transactions (
  id                  uuid primary key default gen_random_uuid(),
  financial_event_id  uuid references financial_events(id) on delete cascade,
  booking_id          uuid,
  tax_rule_id         uuid references tax_rules(id) on delete restrict,
  tax_rule_version_id uuid references tax_rule_versions(id) on delete restrict,
  direction           text not null default 'REVIEW_REQUIRED'
                        check (direction in ('OUTPUT','INPUT','REVERSE_CHARGE','EXEMPT','OUT_OF_SCOPE','REVIEW_REQUIRED')),
  tax_type            text,
  -- Amounts in EUR minor units; base + calculated + rounded + diff kept
  -- separately so rounding is always visible (spec Phase 43).
  taxable_base_minor  bigint,
  calculated_tax_minor bigint,
  rounded_tax_minor   bigint,
  rounding_diff_minor bigint,
  vat_rate            numeric(6,3),
  currency            text not null default 'EUR',
  original_currency   text,
  legal_basis         text,
  review_status       text not null default 'REVIEW_REQUIRED'
                        check (review_status in ('OK','REVIEW_REQUIRED','APPROVED','REJECTED')),
  created_at          timestamptz not null default now(),
  created_by          text
);
create index if not exists tax_transactions_event_idx   on tax_transactions (financial_event_id);
create index if not exists tax_transactions_booking_idx on tax_transactions (booking_id);
create index if not exists tax_transactions_rule_idx    on tax_transactions (tax_rule_id, tax_rule_version_id);
create index if not exists tax_transactions_dir_idx     on tax_transactions (direction);

-- Wire the deferred FK from journal_lines → tax_transactions.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'journal_lines_tax_transaction_fk') then
    alter table journal_lines
      add constraint journal_lines_tax_transaction_fk
      foreign key (tax_transaction_id) references tax_transactions(id) on delete set null;
  end if;
end $$;

-- ── Tax exceptions queue (spec Phase 23) ────────────────────
create table if not exists tax_exceptions (
  id           uuid primary key default gen_random_uuid(),
  exception_type text not null,          -- e.g. MISSING_SUPPLIER_VAT_ID, TAX_RULE_NOT_FOUND, ...
  entity_type  text,
  entity_id    text,
  financial_event_id uuid references financial_events(id) on delete set null,
  booking_id   uuid,
  severity     text not null default 'REVIEW'
                 check (severity in ('INFO','REVIEW','BLOCKED')),
  status       text not null default 'OPEN'
                 check (status in ('OPEN','IN_REVIEW','APPROVED','REJECTED','RESOLVED')),
  details      jsonb,
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz,
  resolved_by  text,
  resolution_note text
);
create index if not exists tax_exceptions_status_idx on tax_exceptions (status);
create index if not exists tax_exceptions_type_idx   on tax_exceptions (exception_type);
create index if not exists tax_exceptions_booking_idx on tax_exceptions (booking_id);
