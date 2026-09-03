-- ════════════════════════════════════════════════════════════
-- AIRPIV — Fare Intelligence: PILOT seed for airline_fare_rules (§34)
-- Run once in Supabase's SQL Editor AFTER airline_fare_rules.sql.
-- ════════════════════════════════════════════════════════════
--
-- ⚠️ READ BEFORE RUNNING — these rows are inserted INACTIVE on purpose.
--
-- Core principle: "Better to say unknown than to show an incorrect baggage
-- allowance." Nothing here is invented, but airline fare-family baggage does
-- change, so this seed is a *starting set to be verified*, not ground truth:
--
--   • active      = false   → the matching engine ignores them until an admin
--                             flips them on (getFareRulesForAirline filters
--                             active=true). So running this file changes
--                             NOTHING a customer sees.
--   • confidence  = MEDIUM  → even once active, a fare-specific match is shown
--                             as "confirmed" only at MEDIUM+; keep it MEDIUM
--                             until a human has checked the source and bumped
--                             it (and set last_verified).
--   • last_verified = NULL  → set it in the admin CMS when you verify a row.
--
-- Rollout (§34): verify each row against its source_url in the Fare Rules
-- admin page, set last_verified, then set active=true — airline by airline —
-- instead of activating everything at once.
--
-- Scope: this file seeds LUFTHANSA only, as a fully-worked, well-documented
-- example of the three-fare-family shape (Light / Classic / Flex) across the
-- three independent baggage types. Add other pilot carriers (Condor, Iberia,
-- BA, AF, KLM, Ryanair, easyJet) the same way once each has been verified from
-- the airline's official baggage page — do NOT bulk-insert unverified guesses.
--
-- Idempotent-ish: re-running inserts duplicates. To reseed, delete the pilot
-- rows first: delete from airline_fare_rules where source_reference = 'pilot-seed-v1';
-- ════════════════════════════════════════════════════════════

insert into airline_fare_rules
  (airline_iata, fare_family, cabin_class, baggage_type, included, pieces, weight_kg, dimensions,
   source_type, source_url, source_reference, confidence, effective_from, active, created_by)
values
  -- ── Lufthansa · Economy Light ─────────────────────────────────────
  ('LH','Economy Light','economy','personal_item', true, 1, null, '40 x 30 x 10 cm',
   'AIRLINE_OFFICIAL','https://www.lufthansa.com/de/en/free-baggage-allowance','pilot-seed-v1','MEDIUM', current_date, false, 'pilot-seed'),
  ('LH','Economy Light','economy','cabin', true, 1, 8, '55 x 40 x 23 cm',
   'AIRLINE_OFFICIAL','https://www.lufthansa.com/de/en/carry-on-baggage','pilot-seed-v1','MEDIUM', current_date, false, 'pilot-seed'),
  ('LH','Economy Light','economy','checked', false, 0, null, null,
   'AIRLINE_OFFICIAL','https://www.lufthansa.com/de/en/free-baggage-allowance','pilot-seed-v1','MEDIUM', current_date, false, 'pilot-seed'),

  -- ── Lufthansa · Economy Classic ───────────────────────────────────
  ('LH','Economy Classic','economy','personal_item', true, 1, null, '40 x 30 x 10 cm',
   'AIRLINE_OFFICIAL','https://www.lufthansa.com/de/en/free-baggage-allowance','pilot-seed-v1','MEDIUM', current_date, false, 'pilot-seed'),
  ('LH','Economy Classic','economy','cabin', true, 1, 8, '55 x 40 x 23 cm',
   'AIRLINE_OFFICIAL','https://www.lufthansa.com/de/en/carry-on-baggage','pilot-seed-v1','MEDIUM', current_date, false, 'pilot-seed'),
  ('LH','Economy Classic','economy','checked', true, 1, 23, '158 cm total',
   'AIRLINE_OFFICIAL','https://www.lufthansa.com/de/en/free-baggage-allowance','pilot-seed-v1','MEDIUM', current_date, false, 'pilot-seed'),

  -- ── Lufthansa · Economy Flex ──────────────────────────────────────
  ('LH','Economy Flex','economy','personal_item', true, 1, null, '40 x 30 x 10 cm',
   'AIRLINE_OFFICIAL','https://www.lufthansa.com/de/en/free-baggage-allowance','pilot-seed-v1','MEDIUM', current_date, false, 'pilot-seed'),
  ('LH','Economy Flex','economy','cabin', true, 1, 8, '55 x 40 x 23 cm',
   'AIRLINE_OFFICIAL','https://www.lufthansa.com/de/en/carry-on-baggage','pilot-seed-v1','MEDIUM', current_date, false, 'pilot-seed'),
  ('LH','Economy Flex','economy','checked', true, 1, 23, '158 cm total',
   'AIRLINE_OFFICIAL','https://www.lufthansa.com/de/en/free-baggage-allowance','pilot-seed-v1','MEDIUM', current_date, false, 'pilot-seed');

select count(*) || ' pilot fare rules seeded (INACTIVE — verify then activate)' as status
from airline_fare_rules where source_reference = 'pilot-seed-v1';
