-- ════════════════════════════════════════════════════════════
-- AIRPIV — Fare Intelligence: PILOT seed part 2 (§34 remaining carriers)
-- Run once in Supabase's SQL Editor AFTER airline_fare_rules.sql.
-- Companion to seed_fare_rules_pilot.sql (which seeds Lufthansa).
-- ════════════════════════════════════════════════════════════
--
-- ⚠️ Same posture as part 1 — these rows are INACTIVE and MEDIUM on purpose:
--   • active = false        → the engine ignores them until an admin activates.
--   • confidence = MEDIUM   → keep it MEDIUM until a human verifies the source.
--   • weight_kg = NULL where the airline publishes a DIMENSION limit rather
--     than a weight, or where the exact weight is not a stable, certain fact —
--     we assert pieces/included/dimensions (well-published, stable) and leave
--     the kg blank rather than guess one. "Better to say unknown."
--
-- The single MOST stable, certain fact per fare family is whether CHECKED
-- baggage is included — that is what most distinguishes a "Light"/"Basic"
-- fare from a fuller one, and it is what these rows encode with confidence.
-- Verify every value against the source_url in the Fare Rules admin page,
-- set last_verified, then activate — carrier by carrier (§34 rollout).
--
-- Reseed: delete from airline_fare_rules where source_reference = 'pilot-seed-v1'
--         and airline_iata in ('DE','IB','BA','AF','KL','FR','U2');
-- ════════════════════════════════════════════════════════════

insert into airline_fare_rules
  (airline_iata, fare_family, cabin_class, baggage_type, included, pieces, weight_kg, dimensions,
   source_type, source_url, source_reference, confidence, effective_from, active, created_by)
values
  -- ══ Condor (DE) — Economy Light / Classic / Best ══════════════════
  ('DE','Economy Light','economy','personal_item', true, 1, null, null,
   'AIRLINE_OFFICIAL','https://www.condor.com/eu/flight-preparation/baggage/hand-baggage.jsp','pilot-seed-v1','MEDIUM', current_date, false, 'pilot-seed'),
  ('DE','Economy Light','economy','cabin', true, 1, 8, '55 x 40 x 20 cm',
   'AIRLINE_OFFICIAL','https://www.condor.com/eu/flight-preparation/baggage/hand-baggage.jsp','pilot-seed-v1','MEDIUM', current_date, false, 'pilot-seed'),
  ('DE','Economy Light','economy','checked', false, 0, null, null,
   'AIRLINE_OFFICIAL','https://www.condor.com/eu/flight-preparation/baggage/checked-baggage.jsp','pilot-seed-v1','MEDIUM', current_date, false, 'pilot-seed'),
  ('DE','Economy Classic','economy','cabin', true, 1, 8, '55 x 40 x 20 cm',
   'AIRLINE_OFFICIAL','https://www.condor.com/eu/flight-preparation/baggage/hand-baggage.jsp','pilot-seed-v1','MEDIUM', current_date, false, 'pilot-seed'),
  ('DE','Economy Classic','economy','checked', true, 1, 23, null,
   'AIRLINE_OFFICIAL','https://www.condor.com/eu/flight-preparation/baggage/checked-baggage.jsp','pilot-seed-v1','MEDIUM', current_date, false, 'pilot-seed'),
  ('DE','Economy Best','economy','cabin', true, 1, 8, '55 x 40 x 20 cm',
   'AIRLINE_OFFICIAL','https://www.condor.com/eu/flight-preparation/baggage/hand-baggage.jsp','pilot-seed-v1','MEDIUM', current_date, false, 'pilot-seed'),
  ('DE','Economy Best','economy','checked', true, 1, 23, null,
   'AIRLINE_OFFICIAL','https://www.condor.com/eu/flight-preparation/baggage/checked-baggage.jsp','pilot-seed-v1','MEDIUM', current_date, false, 'pilot-seed'),

  -- ══ Iberia (IB) — Basic / Optima ══════════════════════════════════
  ('IB','Basic','economy','personal_item', true, 1, null, '40 x 30 x 15 cm',
   'AIRLINE_OFFICIAL','https://www.iberia.com/us/luggage/','pilot-seed-v1','MEDIUM', current_date, false, 'pilot-seed'),
  ('IB','Basic','economy','cabin', true, 1, 10, '56 x 40 x 25 cm',
   'AIRLINE_OFFICIAL','https://www.iberia.com/us/luggage/','pilot-seed-v1','MEDIUM', current_date, false, 'pilot-seed'),
  ('IB','Basic','economy','checked', false, 0, null, null,
   'AIRLINE_OFFICIAL','https://www.iberia.com/us/luggage/','pilot-seed-v1','MEDIUM', current_date, false, 'pilot-seed'),
  ('IB','Optima','economy','cabin', true, 1, 10, '56 x 40 x 25 cm',
   'AIRLINE_OFFICIAL','https://www.iberia.com/us/luggage/','pilot-seed-v1','MEDIUM', current_date, false, 'pilot-seed'),
  ('IB','Optima','economy','checked', true, 1, 23, '158 cm total',
   'AIRLINE_OFFICIAL','https://www.iberia.com/us/luggage/','pilot-seed-v1','MEDIUM', current_date, false, 'pilot-seed'),

  -- ══ British Airways (BA) — Basic (hand only) / standard Economy ════
  ('BA','Economy Basic','economy','personal_item', true, 1, 23, '40 x 30 x 15 cm',
   'AIRLINE_OFFICIAL','https://www.britishairways.com/en-gb/information/baggage-essentials','pilot-seed-v1','MEDIUM', current_date, false, 'pilot-seed'),
  ('BA','Economy Basic','economy','cabin', true, 1, 23, '56 x 45 x 25 cm',
   'AIRLINE_OFFICIAL','https://www.britishairways.com/en-gb/information/baggage-essentials','pilot-seed-v1','MEDIUM', current_date, false, 'pilot-seed'),
  ('BA','Economy Basic','economy','checked', false, 0, null, null,
   'AIRLINE_OFFICIAL','https://www.britishairways.com/en-gb/information/baggage-essentials','pilot-seed-v1','MEDIUM', current_date, false, 'pilot-seed'),
  ('BA','Economy','economy','cabin', true, 1, 23, '56 x 45 x 25 cm',
   'AIRLINE_OFFICIAL','https://www.britishairways.com/en-gb/information/baggage-essentials','pilot-seed-v1','MEDIUM', current_date, false, 'pilot-seed'),
  ('BA','Economy','economy','checked', true, 1, 23, '90 x 75 x 43 cm',
   'AIRLINE_OFFICIAL','https://www.britishairways.com/en-gb/information/baggage-essentials','pilot-seed-v1','MEDIUM', current_date, false, 'pilot-seed'),

  -- ══ Air France (AF) — Economy Light / Standard ════════════════════
  ('AF','Light','economy','cabin', true, 1, 12, '55 x 35 x 25 cm',
   'AIRLINE_OFFICIAL','https://www.airfrance.us/information/bagages/bagage-en-soute-taille-poids','pilot-seed-v1','MEDIUM', current_date, false, 'pilot-seed'),
  ('AF','Light','economy','checked', false, 0, null, null,
   'AIRLINE_OFFICIAL','https://www.airfrance.us/information/bagages/bagage-en-soute-taille-poids','pilot-seed-v1','MEDIUM', current_date, false, 'pilot-seed'),
  ('AF','Standard','economy','cabin', true, 1, 12, '55 x 35 x 25 cm',
   'AIRLINE_OFFICIAL','https://www.airfrance.us/information/bagages/bagage-en-soute-taille-poids','pilot-seed-v1','MEDIUM', current_date, false, 'pilot-seed'),
  ('AF','Standard','economy','checked', true, 1, 23, '158 cm total',
   'AIRLINE_OFFICIAL','https://www.airfrance.us/information/bagages/bagage-en-soute-taille-poids','pilot-seed-v1','MEDIUM', current_date, false, 'pilot-seed'),

  -- ══ KLM (KL) — Economy Light / Standard ═══════════════════════════
  ('KL','Light','economy','cabin', true, 1, 12, '55 x 35 x 25 cm',
   'AIRLINE_OFFICIAL','https://www.klm.com/information/baggage/baggage-allowance','pilot-seed-v1','MEDIUM', current_date, false, 'pilot-seed'),
  ('KL','Light','economy','checked', false, 0, null, null,
   'AIRLINE_OFFICIAL','https://www.klm.com/information/baggage/baggage-allowance','pilot-seed-v1','MEDIUM', current_date, false, 'pilot-seed'),
  ('KL','Standard','economy','cabin', true, 1, 12, '55 x 35 x 25 cm',
   'AIRLINE_OFFICIAL','https://www.klm.com/information/baggage/baggage-allowance','pilot-seed-v1','MEDIUM', current_date, false, 'pilot-seed'),
  ('KL','Standard','economy','checked', true, 1, 23, '158 cm total',
   'AIRLINE_OFFICIAL','https://www.klm.com/information/baggage/baggage-allowance','pilot-seed-v1','MEDIUM', current_date, false, 'pilot-seed'),

  -- ══ Ryanair (FR) — Basic / Regular+Priority ═══════════════════════
  -- Basic: personal item only (fits under the seat); no cabin bag, no checked.
  ('FR','Basic','economy','personal_item', true, 1, null, '40 x 20 x 25 cm',
   'AIRLINE_OFFICIAL','https://www.ryanair.com/gb/en/plan-trip/flying-with-us/baggage-policy','pilot-seed-v1','MEDIUM', current_date, false, 'pilot-seed'),
  ('FR','Basic','economy','cabin', false, 0, null, null,
   'AIRLINE_OFFICIAL','https://www.ryanair.com/gb/en/plan-trip/flying-with-us/baggage-policy','pilot-seed-v1','MEDIUM', current_date, false, 'pilot-seed'),
  ('FR','Basic','economy','checked', false, 0, null, null,
   'AIRLINE_OFFICIAL','https://www.ryanair.com/gb/en/plan-trip/flying-with-us/baggage-policy','pilot-seed-v1','MEDIUM', current_date, false, 'pilot-seed'),
  -- Priority & 2 Cabin Bags: personal item + a 10 kg cabin bag.
  ('FR','Priority','economy','personal_item', true, 1, null, '40 x 20 x 25 cm',
   'AIRLINE_OFFICIAL','https://www.ryanair.com/gb/en/plan-trip/flying-with-us/baggage-policy','pilot-seed-v1','MEDIUM', current_date, false, 'pilot-seed'),
  ('FR','Priority','economy','cabin', true, 1, 10, '55 x 40 x 20 cm',
   'AIRLINE_OFFICIAL','https://www.ryanair.com/gb/en/plan-trip/flying-with-us/baggage-policy','pilot-seed-v1','MEDIUM', current_date, false, 'pilot-seed'),
  ('FR','Priority','economy','checked', false, 0, null, null,
   'AIRLINE_OFFICIAL','https://www.ryanair.com/gb/en/plan-trip/flying-with-us/baggage-policy','pilot-seed-v1','MEDIUM', current_date, false, 'pilot-seed'),

  -- ══ easyJet (U2) — Standard / Plus (large cabin) ══════════════════
  -- Standard: one small cabin bag under the seat; no checked included.
  ('U2','Standard','economy','cabin', true, 1, 15, '45 x 36 x 20 cm',
   'AIRLINE_OFFICIAL','https://www.easyjet.com/en/help/baggage/cabin-bags-and-hold-luggage','pilot-seed-v1','MEDIUM', current_date, false, 'pilot-seed'),
  ('U2','Standard','economy','checked', false, 0, null, null,
   'AIRLINE_OFFICIAL','https://www.easyjet.com/en/help/baggage/cabin-bags-and-hold-luggage','pilot-seed-v1','MEDIUM', current_date, false, 'pilot-seed'),
  ('U2','Plus','economy','cabin', true, 1, 15, '56 x 45 x 25 cm',
   'AIRLINE_OFFICIAL','https://www.easyjet.com/en/help/baggage/cabin-bags-and-hold-luggage','pilot-seed-v1','MEDIUM', current_date, false, 'pilot-seed'),
  ('U2','Plus','economy','checked', false, 0, null, null,
   'AIRLINE_OFFICIAL','https://www.easyjet.com/en/help/baggage/cabin-bags-and-hold-luggage','pilot-seed-v1','MEDIUM', current_date, false, 'pilot-seed');

select airline_iata, count(*) as rules
from airline_fare_rules
where source_reference = 'pilot-seed-v1'
group by airline_iata order by airline_iata;
