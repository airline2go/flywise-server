-- ============================================================
-- AirPiv Finance — Phase 2 · 07 · INTEGRATION & SETTLEMENT TABLES
-- Stripe / Duffel financial mirrors, refunds, chargebacks, credit notes,
-- bank lines. Run once AFTER 00–06. Idempotent. Additive.
--
-- These are the raw, provider-faithful settlement records the reconciliation
-- and tax engines read. Money in integer MINOR UNITS. Every provider id is
-- UNIQUE → a re-delivered Stripe/Duffel event can never create a duplicate
-- financial record (spec Phase 35). A Stripe/Duffel FEE is stored as a fee,
-- NEVER as VAT — tax treatment is decided only by the Tax Engine (spec
-- Phase 10/11, non-negotiable rule 11).
-- ============================================================

create extension if not exists pgcrypto;

-- ── Stripe: balance transactions (the money-movement source of truth) ──
create table if not exists stripe_transactions (
  id                  uuid primary key default gen_random_uuid(),
  stripe_id           text unique not null,        -- balance transaction id (txn_...)
  type                text,                          -- charge|refund|payout|adjustment|stripe_fee|...
  source_id           text,                          -- pi_/ch_/re_/po_/dp_ that produced it
  gross_minor         bigint,
  fee_minor           bigint,
  net_minor           bigint,
  currency            text,
  -- FX as Stripe reported it (settlement source, Decision 1).
  exchange_rate       numeric(18,8),
  exchange_rate_source text default 'STRIPE',
  original_amount_minor bigint,
  original_currency   text,
  payout_id           text,
  booking_id          uuid,
  payment_id          uuid,
  customer_id         uuid,
  financial_event_id  uuid references financial_events(id) on delete set null,
  available_on        timestamptz,
  stripe_created_at   timestamptz,
  payload             jsonb,
  created_at          timestamptz not null default now()
);
create index if not exists stripe_transactions_type_idx    on stripe_transactions (type);
create index if not exists stripe_transactions_payout_idx  on stripe_transactions (payout_id);
create index if not exists stripe_transactions_source_idx  on stripe_transactions (source_id);
create index if not exists stripe_transactions_booking_idx on stripe_transactions (booking_id);

-- ── Stripe: fee detail per balance transaction ──────────────
create table if not exists stripe_fees (
  id                    uuid primary key default gen_random_uuid(),
  stripe_transaction_id uuid references stripe_transactions(id) on delete cascade,
  stripe_balance_txn_id text,
  fee_type              text,           -- 'stripe_fee' | 'application_fee' | 'tax' (as Stripe labels it — not our VAT)
  description           text,
  amount_minor          bigint,
  currency              text,
  -- One fee line per (balance txn, type, description) — idempotent import.
  idempotency_key       text unique not null,
  created_at            timestamptz not null default now()
);
create index if not exists stripe_fees_txn_idx on stripe_fees (stripe_transaction_id);

-- ── Stripe: payouts ─────────────────────────────────────────
create table if not exists stripe_payouts (
  id            uuid primary key default gen_random_uuid(),
  stripe_id     text unique not null,     -- po_...
  amount_minor  bigint,
  currency      text,
  status        text,                     -- pending|in_transit|paid|failed|canceled
  arrival_date  timestamptz,
  stripe_created_at timestamptz,
  bank_reference text,
  payload       jsonb,
  created_at    timestamptz not null default now()
);

-- ── Stripe: refunds mirror ──────────────────────────────────
create table if not exists stripe_refunds (
  id                 uuid primary key default gen_random_uuid(),
  stripe_id          text unique not null,     -- re_...
  payment_intent_id  text,
  charge_id          text,
  amount_minor       bigint,
  currency           text,
  status             text,
  reason             text,
  booking_id         uuid,
  refund_id          uuid,                      -- link to unified refunds row (set by app)
  financial_event_id uuid references financial_events(id) on delete set null,
  stripe_created_at  timestamptz,
  payload            jsonb,
  created_at         timestamptz not null default now()
);
create index if not exists stripe_refunds_pi_idx on stripe_refunds (payment_intent_id);

-- ── Stripe: disputes / chargebacks mirror ───────────────────
create table if not exists stripe_disputes (
  id                 uuid primary key default gen_random_uuid(),
  stripe_id          text unique not null,     -- dp_...
  charge_id          text,
  payment_intent_id  text,
  amount_minor       bigint,
  currency           text,
  status             text,                      -- warning_needs_response|needs_response|under_review|won|lost
  reason             text,
  booking_id         uuid,
  chargeback_id      uuid,                      -- link to unified chargebacks row
  financial_event_id uuid references financial_events(id) on delete set null,
  stripe_created_at  timestamptz,
  payload            jsonb,
  created_at         timestamptz not null default now()
);

-- ── Duffel: official supplier invoices (authoritative over API net) ──
create table if not exists duffel_invoices (
  id               uuid primary key default gen_random_uuid(),
  duffel_id        text unique,               -- Duffel invoice id (when provided)
  invoice_number   text,
  invoice_date     date,
  supplier         text,
  supplier_country text,
  supplier_tax_id  text,
  currency         text,
  subtotal_minor   bigint,
  tax_minor        bigint,
  total_minor      bigint,
  document_reference text,
  idempotency_key  text unique not null,
  payload          jsonb,
  created_at       timestamptz not null default now()
);

create table if not exists duffel_invoice_lines (
  id                 uuid primary key default gen_random_uuid(),
  duffel_invoice_id  uuid references duffel_invoices(id) on delete cascade,
  line_reference     text,
  description        text,
  order_id           text,
  booking_id         uuid,
  financial_event_id uuid references financial_events(id) on delete set null,
  quantity           numeric(12,3),
  net_minor          bigint,
  tax_minor          bigint,
  gross_minor        bigint,
  currency           text,
  -- Unmatched lines surface in reconciliation_exceptions (DUFFEL_UNMATCHED).
  match_status       text not null default 'UNMATCHED'
                       check (match_status in ('MATCHED','PARTIALLY_MATCHED','UNMATCHED','MANUAL_REVIEW')),
  idempotency_key    text unique not null,
  created_at         timestamptz not null default now()
);
create index if not exists duffel_invoice_lines_inv_idx     on duffel_invoice_lines (duffel_invoice_id);
create index if not exists duffel_invoice_lines_booking_idx on duffel_invoice_lines (booking_id);

-- ── Unified refunds (independent financial event, spec Phase 12) ──
-- A refund is NOT an edit of the original booking — it is its own record and
-- its own financial_event. Tax adjustment stays REVIEW_REQUIRED until a rule
-- is approved.
create table if not exists refunds (
  id                  uuid primary key default gen_random_uuid(),
  booking_id          uuid,
  original_payment_id uuid,
  stripe_refund_id    text,
  refund_reason       text,
  refund_type         text not null default 'FULL'
                        check (refund_type in ('FULL','PARTIAL','PRICE_ADJUSTMENT','CANCELLATION')),
  original_amount_minor bigint,
  original_currency   text,
  customer_refund_minor bigint,
  supplier_refund_minor bigint,
  fee_minor           bigint,
  accounting_amount_eur_minor bigint,
  exchange_rate       numeric(18,8),
  exchange_rate_source text,
  tax_adjustment_status text not null default 'REVIEW_REQUIRED'
                          check (tax_adjustment_status in ('REVIEW_REQUIRED','APPROVED','NOT_APPLICABLE')),
  tax_transaction_id  uuid references tax_transactions(id) on delete set null,
  financial_event_id  uuid references financial_events(id) on delete set null,
  refund_date         timestamptz,
  idempotency_key     text unique not null,
  status              text not null default 'RECORDED'
                        check (status in ('RECORDED','POSTED','REVERSED')),
  created_at          timestamptz not null default now(),
  created_by          text
);
create index if not exists refunds_booking_idx on refunds (booking_id);

-- ── Chargebacks (independent, spec Phase 13) ────────────────
create table if not exists chargebacks (
  id                 uuid primary key default gen_random_uuid(),
  booking_id         uuid,
  stripe_dispute_id  text,
  amount_minor       bigint,
  currency           text,
  fee_minor          bigint,
  status             text,
  recovered_amount_minor bigint,
  final_result       text,           -- won|lost|null
  tax_treatment_status text not null default 'REVIEW_REQUIRED'
                         check (tax_treatment_status in ('REVIEW_REQUIRED','APPROVED','NOT_APPLICABLE')),
  tax_transaction_id uuid references tax_transactions(id) on delete set null,
  financial_event_id uuid references financial_events(id) on delete set null,
  idempotency_key    text unique not null,
  created_at         timestamptz not null default now()
);
create index if not exists chargebacks_booking_idx on chargebacks (booking_id);

-- ── Credit notes (spec Phase 17) ────────────────────────────
create table if not exists credit_notes (
  id                  uuid primary key default gen_random_uuid(),
  credit_note_number  text unique,
  original_invoice_id uuid references invoices(id) on delete set null,
  booking_id          uuid,
  credit_type         text check (credit_type in ('FULL_REFUND','PARTIAL_REFUND','PRICE_ADJUSTMENT','COMMISSION_ADJUSTMENT','TAX_ADJUSTMENT')),
  net_minor           bigint,
  vat_minor           bigint,
  gross_minor         bigint,
  currency            text,
  vat_status          text not null default 'REVIEW_REQUIRED'
                        check (vat_status in ('REVIEW_REQUIRED','APPROVED','EXEMPT','NOT_APPLICABLE')),
  tax_transaction_id  uuid references tax_transactions(id) on delete set null,
  reason              text,
  created_at          timestamptz not null default now(),
  created_by          text
);
create index if not exists credit_notes_invoice_idx on credit_notes (original_invoice_id);

-- ── Bank transactions (for the fourth reconciliation leg) ───
create table if not exists bank_transactions (
  id             uuid primary key default gen_random_uuid(),
  external_id    text unique,
  booked_at      date,
  amount_minor   bigint,
  currency       text,
  counterparty   text,
  reference      text,
  payout_id      text,
  match_status   text not null default 'UNMATCHED'
                   check (match_status in ('MATCHED','PARTIALLY_MATCHED','UNMATCHED','MANUAL_REVIEW')),
  idempotency_key text unique not null,
  payload        jsonb,
  created_at     timestamptz not null default now()
);
