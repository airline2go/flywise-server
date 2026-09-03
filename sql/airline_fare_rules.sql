-- ════════════════════════════════════════════════════════════
-- AIRPIV — Fare Intelligence: airline_fare_rules
-- Run once in Supabase's SQL Editor. Safe to re-run (idempotent).
-- ════════════════════════════════════════════════════════════
--
-- CONTEXT: Duffel is the authority for the live offer (price, segments,
-- and any baggage IT actually returns). But NDC/Duffel frequently omit the
-- included-baggage weight, and never expose per-fare-family rules for
-- change/refund/seat/meal. This table is the ENRICHMENT layer: verified,
-- sourced, admin-curated fare rules that the Rule Engine layers UNDER the
-- Duffel offer-specific data — used only to fill gaps Duffel leaves, never
-- to override a value Duffel confirmed, and never to invent a fact.
--
-- Matching (see src/services/fareRules.js) walks a precision ladder:
--   airline + fare_family + booking_class + cabin   → HIGH
--   airline + fare_family + cabin                    → HIGH
--   airline + booking_class + cabin                  → MEDIUM
--   airline + cabin  (general policy, no fare id)    → LOW  (never "confirmed")
-- A row is one (baggage or fare) rule for one fare context. Baggage types are
-- kept separate (personal_item / cabin / checked / additional) — never merged.
--
-- PROVENANCE + VERSIONING: every row records where it came from, who entered
-- it, when it was last verified, and the [effective_from, effective_until)
-- window it applies to. Airline policies change: instead of destructively
-- editing a historical rule, close it (set effective_until) and insert a new
-- one (effective_from = the change date), so we can always answer "which rule
-- was in force on date X, and why did Airpiv say 23 kg?".
-- ════════════════════════════════════════════════════════════

create table if not exists airline_fare_rules (
  id uuid primary key default gen_random_uuid(),

  -- ── Fare context this rule applies to ──────────────────────────────
  -- airline_iata is denormalized (not just airline_id) so the engine can match
  -- straight from a Duffel offer's marketing_carrier without a join.
  airline_id      uuid references airlines(id) on delete cascade,
  airline_iata    text not null,                 -- e.g. "LH"
  fare_family     text,                           -- e.g. "Economy Light" (null = applies regardless of fare family)
  cabin_class     text,                           -- e.g. "economy" | "premium_economy" | "business" | "first"
  booking_class   text,                           -- e.g. "K" (RBD / fare basis letter), null = any

  -- ── What the rule asserts ──────────────────────────────────────────
  baggage_type    text check (baggage_type in ('personal_item','cabin','checked','additional')),
  included        boolean,                        -- true=included, false=explicitly not included, null=unknown
  pieces          integer check (pieces is null or pieces >= 0),
  weight_kg       numeric check (weight_kg is null or weight_kg > 0),
  dimensions      text,                           -- free-form, e.g. "40 x 30 x 20 cm"

  -- ── Fare conditions (data model ready for later phases: change/refund/…) ──
  change_allowed    boolean,
  change_fee        numeric check (change_fee is null or change_fee >= 0),
  change_fee_currency text,
  refund_allowed    boolean,
  refund_fee        numeric check (refund_fee is null or refund_fee >= 0),
  refund_fee_currency text,
  seat_selection    text,                         -- e.g. "included" | "paid" | "not_available"
  meal_included     boolean,
  priority_included boolean,

  -- ── Provenance / confidence (spec §18) ─────────────────────────────
  source_type     text not null default 'MANUAL_ADMIN'
                    check (source_type in ('DUFFEL','AIRLINE_OFFICIAL','VERIFIED_PROVIDER','MANUAL_ADMIN','UNKNOWN')),
  source_url      text,
  source_reference text,
  confidence      text not null default 'MEDIUM'
                    check (confidence in ('HIGH','MEDIUM','LOW','UNKNOWN')),

  -- ── Versioning + verification (spec §19, §35) ──────────────────────
  effective_from  date not null default current_date,
  effective_until date,                           -- null = still in force; must be > effective_from when set
  last_verified   date,
  active          boolean not null default true,

  -- ── Audit (spec §35) ───────────────────────────────────────────────
  created_by      text,                           -- admin email/id who entered it
  updated_by      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint fare_rules_effective_window check (effective_until is null or effective_until > effective_from)
);

-- The precision-ladder lookup is always scoped by airline first, then narrowed.
create index if not exists afr_airline_idx  on airline_fare_rules (airline_iata, cabin_class, fare_family);
create index if not exists afr_active_idx   on airline_fare_rules (airline_iata) where active = true;
create index if not exists afr_effective_idx on airline_fare_rules (effective_from, effective_until);

-- Keep updated_at honest.
create or replace function afr_touch_updated_at() returns trigger as $$
begin
  new.updated_at := now();
  return new;
end; $$ language plpgsql;
drop trigger if exists afr_touch on airline_fare_rules;
create trigger afr_touch before update on airline_fare_rules
  for each row execute function afr_touch_updated_at();

-- [RLS-SECURITY-FIX] Service-role only. The public API never reads this table
-- directly — the Rule Engine runs server-side with the service key and only
-- ever emits already-resolved, confidence-gated results. Same posture as
-- route_airlines / api_logs.
alter table airline_fare_rules enable row level security;
-- (No public policy: with RLS enabled and no permissive policy, anon/auth
--  roles get zero rows; the service role bypasses RLS.)

select 'airline_fare_rules migration applied!' as status;
