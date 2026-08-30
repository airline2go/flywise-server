-- ============================================================
-- AirPiv Finance — Phase 1 · 02 · FINANCIAL EVENTS
-- The immutable source layer: every money-affecting fact (a booking paid,
-- a Stripe fee, a Duffel invoice line, a refund, a chargeback) becomes ONE
-- financial_event before any accounting entry is derived from it (spec
-- Phase 1 architecture, Phase 7). Idempotent. Additive.
--
-- Original currency is ALWAYS preserved (Decision 1). EUR accounting amount +
-- full FX provenance are stored alongside so the conversion is reproducible.
-- idempotency_key is UNIQUE — the hard, cross-instance guard against a
-- duplicated Stripe/Duffel webhook creating a second accounting record
-- (spec Phase 35).
-- ============================================================

create extension if not exists pgcrypto;

create table if not exists financial_events (
  id                  uuid primary key default gen_random_uuid(),
  event_type          text not null,          -- e.g. booking_paid|stripe_fee|duffel_invoice_line|refund|chargeback
  source_type         text not null,          -- 'stripe'|'duffel'|'booking'|'bank'|'manual'
  source_id           text,                   -- provider id (payment_intent, invoice line, order, ...)
  -- Cross-instance idempotency: one event per real-world fact.
  idempotency_key     text unique not null,

  -- Loose links to existing entities (no hard FK — keeps this decoupled and
  -- backward compatible even if a link target is archived).
  booking_id          uuid,
  payment_id          uuid,
  customer_id         uuid,
  supplier_id         text,

  occurred_at         timestamptz not null default now(),

  -- Money — original is authoritative and never replaced (Decision 1).
  original_amount_minor  bigint not null,
  original_currency      text   not null,
  accounting_amount_eur_minor bigint,          -- null until FX applied (may be REVIEW_REQUIRED)
  exchange_rate          numeric(18,8),
  exchange_rate_source   text check (exchange_rate_source in
                            ('ECB','STRIPE','DUFFEL','MANUAL','SYSTEM','PROVIDER') or exchange_rate_source is null),
  exchange_rate_timestamp timestamptz,
  conversion_method      text,

  -- Classification carried but never guessed. Defaults keep the event fully
  -- recorded while its tax/revenue treatment stays pending (Decision 2/3).
  business_role              text not null default 'REVIEW_REQUIRED'
                               check (business_role in ('UNKNOWN','PRINCIPAL','INTERMEDIARY','AGENT','REVIEW_REQUIRED')),
  business_role_source       text,
  business_role_rule_version uuid,
  review_status              text not null default 'REVIEW_REQUIRED'
                               check (review_status in ('OK','REVIEW_REQUIRED','APPROVED','REJECTED')),

  status              text not null default 'RECORDED'
                        check (status in ('RECORDED','CLASSIFIED','POSTED','REVERSED','VOIDED')),
  journal_entry_id    uuid references journal_entries(id) on delete set null,

  payload             jsonb,                  -- raw provider payload snapshot
  created_at          timestamptz not null default now(),
  created_by          text
);
create index if not exists financial_events_type_idx    on financial_events (event_type);
create index if not exists financial_events_source_idx   on financial_events (source_type, source_id);
create index if not exists financial_events_booking_idx  on financial_events (booking_id);
create index if not exists financial_events_status_idx   on financial_events (status);
create index if not exists financial_events_review_idx   on financial_events (review_status);

-- Now that financial_events exists, wire the deferred FK from journal_entries.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'journal_entries_financial_event_fk') then
    alter table journal_entries
      add constraint journal_entries_financial_event_fk
      foreign key (financial_event_id) references financial_events(id) on delete set null;
  end if;
end $$;
