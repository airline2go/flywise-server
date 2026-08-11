-- ============================================================
-- Airpiv — Payment ledger correctness (run once in Supabase SQL
-- Editor). Safe to re-run.
--
-- [F6 · PAYMENT-LEDGER] The `payments` row previously stored the Duffel
-- NET (supplier) amount in `amount` — so a €115 customer charge showed as
-- €100 in the ledger, mixing supplier cost with customer payment (brief
-- §8.1/§8.2). `amount` now records what the CUSTOMER actually paid via
-- Stripe; these additive columns hold the supplier cost and margin
-- separately, so the ledger reconciles against Stripe (customer) AND
-- Duffel (supplier) independently. Additive + nullable → existing rows and
-- older code keep working unchanged.
-- ============================================================

alter table payments add column if not exists supplier_amount numeric(10,2);
alter table payments add column if not exists margin_amount   numeric(10,2);
