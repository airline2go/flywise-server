-- Social Studio "Recommended Today" candidates: routes with a real price drop
-- (recent price vs. the average of earlier route_price_history observations) or
-- a high route_score, with their raw signals. The frontend applies the scoring
-- model. Called from GET /admin/content-opportunities.
create or replace function public.content_opportunities(limit_n int default 60)
returns table (
  slug text, origin_city text, destination_city text, origin_iata text, destination_iata text,
  origin_country text, destination_country text, origin_city_slug text, destination_city_slug text,
  route_score numeric, airline_count integer, direct_flight_available boolean, all_direct boolean,
  price_min numeric, price_currency text, price_trend text,
  price_drop_pct numeric, recent_price numeric, baseline_price numeric
)
language sql
stable
as $$
  with ph as (
    select route_origin_iata as o, route_destination_iata as d, price,
      row_number() over (partition by route_origin_iata, route_destination_iata order by observed_at desc) as rn
    from route_price_history
    where observed_at > now() - interval '120 days' and price is not null and price > 0
  ),
  drops as (
    select o, d, max(price) filter (where rn = 1) as recent, avg(price) filter (where rn > 1) as baseline
    from ph group by o, d having count(*) filter (where rn > 1) >= 1
  ),
  drop_pct as (
    select o, d, recent, baseline,
      case when baseline > 0 and recent < baseline
        then round(((baseline - recent) / baseline * 100)::numeric, 0) else 0 end as pct
    from drops
  )
  select rp.slug, rp.origin_city, rp.destination_city, rp.origin_iata, rp.destination_iata,
    rp.origin_country, rp.destination_country, rp.origin_city_slug, rp.destination_city_slug,
    rp.route_score, rp.airline_count, rp.direct_flight_available, rp.all_direct,
    rp.price_min, rp.price_currency, rp.price_trend,
    coalesce(dp.pct, 0) as price_drop_pct, dp.recent as recent_price, dp.baseline as baseline_price
  from route_pages rp
  left join drop_pct dp on dp.o = rp.origin_iata and dp.d = rp.destination_iata
  where rp.status = 'published' and (coalesce(dp.pct, 0) >= 5 or rp.route_score >= 65)
  order by (coalesce(dp.pct, 0) * 2 + coalesce(rp.route_score, 0)) desc
  limit greatest(1, least(limit_n, 200));
$$;
