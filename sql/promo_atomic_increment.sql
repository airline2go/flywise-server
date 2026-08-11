-- ============================================================
-- Airpiv — Atomic promo usage increment (run once in Supabase SQL
-- Editor). Safe to re-run.
--
-- [F8 · PROMO-RACE] incrementPromoUsage() used to read used_count then
-- write used_count+1 in two round-trips — two concurrent checkouts could
-- both read the same value and both write the same +1, so used_count could
-- exceed max_uses (a promo redeemed beyond its cap). This function does the
-- check-and-increment in a single atomic UPDATE guarded by the cap, and
-- returns whether the increment actually happened (brief §27.3/§27.4).
-- ============================================================

create or replace function public.increment_promo_usage(p_promo_id uuid)
returns boolean
language plpgsql
security definer
as $$
declare
  v_updated int;
begin
  update promo_codes
     set used_count = used_count + 1
   where id = p_promo_id
     and (max_uses is null or used_count < max_uses);
  get diagnostics v_updated = row_count;
  return v_updated > 0;   -- false = cap already reached (or id not found)
end;
$$;
