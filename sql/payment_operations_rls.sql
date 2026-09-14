-- Airpiv — Production hardening for the internal payment-operation ledger.
--
-- payment_operations contains Stripe authorization/capture/cancel state and
-- idempotency records. It is server-side data and must never be exposed through
-- the PostgREST anon/authenticated roles. The Node backend uses the Supabase
-- service_role key (see src/clients/supabase.js), so service_role retains access.
-- Safe to re-run.

alter table if exists public.payment_operations enable row level security;

revoke all on table public.payment_operations from public;
revoke all on table public.payment_operations from anon;
revoke all on table public.payment_operations from authenticated;

grant all on table public.payment_operations to service_role;
