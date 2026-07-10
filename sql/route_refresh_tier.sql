-- ════════════════════════════════════════════════════════════
-- AIRPIV — Route price-refresh tiering (SEO-only vs Live-Pricing)
-- Run once in Supabase's SQL Editor. Safe to re-run (idempotent).
-- ════════════════════════════════════════════════════════════
--
-- CONTEXT: every published route used to be warmed identically by
-- warmRoutePricesOnce() — any published route with a price-cache entry
-- older than 12h got refreshed, with no way to say "this route is
-- SEO-only, never proactively refresh it" vs "keep this one fresh."
-- That single field is now the whole tiering mechanism: 'none' means
-- SEO-only (a visitor can still trigger an on-demand price fetch via
-- the existing GET /route-price cache-miss path — it's just never
-- proactively kept warm by the background cycle), anything else is a
-- Live-Pricing route refreshed on that cadence.
-- ════════════════════════════════════════════════════════════

alter table route_pages add column if not exists refresh_frequency text
  not null default 'none' check (refresh_frequency in ('none', '6h', '12h', '24h'));

-- [NO-REGRESSION] Existing published routes were already being kept
-- warm (roughly every ~12h under the old blanket rule) — back-fill them
-- to '24h' once, so nothing currently live silently goes stale the
-- moment this ships. Only NEW routes (created after this migration)
-- default to 'none' via the admin UI's own form default.
--
-- This must run EXACTLY ONCE, ever — not "every time refresh_frequency
-- happens to still be 'none'" (a naive `where refresh_frequency = 'none'`
-- guard would keep re-applying itself and silently clobber an admin's
-- later deliberate choice to mark some published route SEO-only again).
-- A one-time marker in admin_config (the same key/value table every
-- other admin-tunable setting already lives in) makes re-running this
-- whole file afterward genuinely a no-op, as the header promises.
do $$
begin
  if not exists (select 1 from admin_config where key = 'route_refresh_tier_backfill_done') then
    update route_pages set refresh_frequency = '24h' where status = 'published';
    insert into admin_config (key, value) values ('route_refresh_tier_backfill_done', 'true'::jsonb)
      on conflict (key) do nothing;
  end if;
end $$;

create index if not exists route_pages_refresh_frequency_idx on route_pages (refresh_frequency);

select 'route refresh-tier migration applied!' as status;
