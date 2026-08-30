-- ============================================================
-- AirPiv Finance — Phase 1 · 01 · ACCOUNTING CORE
-- Chart of accounts, accounting periods, double-entry journal.
-- Run once. Idempotent. Additive — touches no existing table.
--
-- Money is stored in INTEGER MINOR UNITS (bigint), never floating point
-- (spec Phase 2). Every ledger line also carries its EUR accounting amount
-- in minor units so debit=credit is enforced in ONE currency (EUR) at post
-- time (spec Phase 4). Original transaction currency + FX provenance live on
-- financial_events (see 02_financial_events.sql) and on the journal entry.
-- ============================================================

create extension if not exists pgcrypto;

-- ── Chart of accounts ───────────────────────────────────────
-- Configurable. NO DATEV account numbers are invented here (spec Phase 27):
-- `datev_account` is nullable and mapped later by the Steuerberater. The only
-- seeded row is a technical SUSPENSE account so unclassified/REVIEW_REQUIRED
-- entries have somewhere to post without guessing a tax account.
create table if not exists accounting_accounts (
  id             uuid primary key default gen_random_uuid(),
  code           text unique not null,          -- internal stable code
  name           text not null,
  account_type   text not null
                   check (account_type in ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE','CONTRA','SUSPENSE')),
  datev_account  text,                            -- filled in by accountant mapping, later
  parent_id      uuid references accounting_accounts(id) on delete set null,
  active         boolean not null default true,
  requires_review boolean not null default false,
  created_at     timestamptz not null default now(),
  note           text
);
create index if not exists accounting_accounts_type_idx on accounting_accounts (account_type);

insert into accounting_accounts (code, name, account_type, requires_review, note) values
  ('SUSPENSE_REVIEW', 'Suspense — REVIEW_REQUIRED', 'SUSPENSE', true,
   'Technical clearing account for unclassified entries pending review. Not a tax account.')
on conflict (code) do nothing;

-- ── Accounting periods ──────────────────────────────────────
-- One row per (year, month). Closing state gates posting (see triggers).
create table if not exists accounting_periods (
  id           uuid primary key default gen_random_uuid(),
  year         int  not null,
  month        int  not null check (month between 1 and 12),
  status       text not null default 'OPEN'
                 check (status in ('OPEN','SOFT_CLOSED','CLOSED','REOPENED')),
  closed_at    timestamptz,
  closed_by    text,
  reopened_at  timestamptz,
  reopened_by  text,
  reopen_reason text,
  checkpoint   jsonb,          -- snapshot of VAT/ledger totals taken at close
  created_at   timestamptz not null default now(),
  unique (year, month)
);

-- ── Journal entries (headers) ───────────────────────────────
-- entry_number is gap-free via a sequence (atomic like invoice_seq).
create sequence if not exists finance_journal_entry_seq start 1;

create table if not exists journal_entries (
  id                  uuid primary key default gen_random_uuid(),
  entry_number        bigint unique not null default nextval('finance_journal_entry_seq'),
  entry_date          date not null default current_date,
  posting_date        date,
  accounting_period_id uuid references accounting_periods(id) on delete restrict,
  source_type         text,                 -- 'booking'|'stripe'|'duffel'|'refund'|'adjustment'|...
  source_id           text,
  financial_event_id  uuid,                 -- FK added in 02 after that table exists
  booking_id          uuid,                 -- loose link (bookings.id) — no hard FK, keeps decoupled
  customer_id         uuid,
  supplier_id         text,
  currency            text not null default 'EUR',
  exchange_rate       numeric(18,8),
  description         text,
  status              text not null default 'DRAFT'
                        check (status in ('DRAFT','POSTED','REVERSED','VOIDED')),
  reversal_of         uuid references journal_entries(id) on delete restrict,
  reversed_by         uuid references journal_entries(id) on delete restrict,
  created_at          timestamptz not null default now(),
  created_by          text
);
create index if not exists journal_entries_status_idx on journal_entries (status);
create index if not exists journal_entries_period_idx on journal_entries (accounting_period_id);
create index if not exists journal_entries_source_idx on journal_entries (source_type, source_id);
create index if not exists journal_entries_booking_idx on journal_entries (booking_id);

-- ── Journal lines ───────────────────────────────────────────
-- Each line is EITHER a debit OR a credit (never both). Amounts in minor
-- units. accounting_amount_eur_minor is the signed-into-EUR value used for
-- the debit=credit balance check.
create table if not exists journal_lines (
  id                  uuid primary key default gen_random_uuid(),
  journal_entry_id    uuid not null references journal_entries(id) on delete cascade,
  account_id          uuid not null references accounting_accounts(id) on delete restrict,
  debit_minor         bigint not null default 0 check (debit_minor  >= 0),
  credit_minor        bigint not null default 0 check (credit_minor >= 0),
  currency            text not null default 'EUR',
  -- EUR value of this line in minor units (debit positive, credit positive;
  -- balance = Σdebit_eur − Σcredit_eur must be 0 at post time).
  debit_eur_minor     bigint not null default 0 check (debit_eur_minor  >= 0),
  credit_eur_minor    bigint not null default 0 check (credit_eur_minor >= 0),
  tax_transaction_id  uuid,                 -- FK added in 03 after that table exists
  cost_center         text,
  project_code        text,
  line_no             int,
  memo                text,
  -- A line is one-sided in both its own currency and in EUR.
  constraint journal_lines_one_sided     check (debit_minor = 0 or credit_minor = 0),
  constraint journal_lines_one_sided_eur check (debit_eur_minor = 0 or credit_eur_minor = 0)
);
create index if not exists journal_lines_entry_idx   on journal_lines (journal_entry_id);
create index if not exists journal_lines_account_idx on journal_lines (account_id);
