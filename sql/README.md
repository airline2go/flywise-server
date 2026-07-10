# Database migrations

There is no migration tool/runner here — these are plain `.sql` files, run
manually, once each, in Supabase's SQL Editor. Every statement in every
file is idempotent (`if not exists` / `drop policy if exists` / etc.), so
re-running any file is always safe.

Run order (oldest first — a fresh database should run them in this order;
an existing one only needs whichever haven't been run yet):

1. `schema_admin.sql` — the full base schema (tables, indexes, the
   `link_guest_bookings_to_user` function).
2. `migration_status_constraints.sql` — `CHECK` constraints on the
   `status` columns (`bookings`, `payments`, `pending_bookings`) and on
   `promo_codes.value`.
3. `rls_security_fixes.sql` — enables Row Level Security on every table,
   with server-only tables getting zero public policies and
   customer-owned tables (`bookings`, `passengers`, `reviews`) getting
   `auth.uid() = user_id` policies; also hardens `search_path` on
   `SECURITY DEFINER` functions.
4. `route_pages_dead_status.sql` — adds the `'dead'` status value to
   `route_pages` (routes confirmed to have no real flights, distinct from
   `'draft'`) and its health-check tracking column.
5. `missing_indexes.sql` — indexes on hot lookup columns
   (`duffel_order_id`, `booking_reference`, `stripe_payment_id`,
   `loyalty_accounts.tier`) that predate this file's existence.
6. `referrals_system.sql` — the `referrals` table (real
   `referrer_id`/`referred_id`/`booking_id` foreign keys, RLS with
   server-only writes) and `loyalty_accounts.referral_code`. Needed by
   `src/services/referrals.js` / `src/routes/referral.routes.js`.
7. `admin_staff.sql` — real per-admin accounts (`admin_users`,
   `admin_sessions`) with two roles (`admin` full access, `staff`
   restricted from margins/credit/staff-management), a general
   `admin_activity_log`, and a full credit-movement ledger
   (`loyalty_transactions`, `admin_credit_log`). The legacy
   `ADMIN_TOKEN` env var keeps working unchanged as a permanent
   fallback — this migration is purely additive. Needed by
   `src/services/adminAuth.js` / `src/routes/admin-staff.routes.js` /
   `src/routes/admin-customers.routes.js`.
8. `route_refresh_tier.sql` — adds `route_pages.refresh_frequency`
   (`'none'`/`'6h'`/`'12h'`/`'24h'`) so each route can be tagged
   SEO-only (never proactively refreshed, still price-able on-demand
   when a real visitor loads the page) vs. Live-Pricing at a chosen
   cadence — the mechanism `warmRoutePricesOnce()` in
   `src/routes/search.routes.js` now reads instead of treating every
   published route identically. One-time backfill (tracked via an
   `admin_config` marker so re-running the file is still safe) sets
   existing published routes to `'24h'` so nothing currently kept warm
   silently goes stale the moment this ships.
9. `api_logs.sql` — logs one row per logical Duffel API call (via the
   shared `duffel()` wrapper in `src/services/duffel.js`; retries
   collapse to a single row, and the isolated health-check path is
   excluded), tagged with a category (`search`/`booking`/`other`) and,
   for the route-pricing call sites only, `route_origin`/
   `route_destination`. Powers the admin API-monitoring dashboard
   (`GET /admin/api-logs/stats`). Server-only RLS, same as
   `admin_activity_log`/`error_logs`.

10. `geo_i18n.sql` — the Geo CMS foundation for the 7-language SEO
    expansion (Phase 3A). Adds a real `airports` table (Airport-Identity-
    First: IATA code -> airport row -> city -> country, instead of
    deriving airport data live from whichever `route_pages` row mentions
    it first, as `GET /airports/:code` used to) plus `city_translations`/
    `country_translations`/`airport_translations` — one row per
    (entity, language) covering all 7 platform languages (en, de, ar,
    es, fr, it, nl). Backfills the `de` translation for every existing
    city/country from its own `name` column (always reliable), and
    best-effort backfills the other 6 languages for the ~62 cities / 34
    countries already known from `flywise-app`'s `build/data.js`
    dictionaries, matched by slug/code — any city/country outside that
    known set (auto-created later from a new route) simply starts with
    only the `de` seed until filled in via the new admin "Airports &
    Cities" page. One-time backfill tracked via an `admin_config`
    marker, same idempotency pattern as `route_refresh_tier.sql`. Needed
    by `src/routes/admin-geo.routes.js` and the rewritten
    `GET /airports/:code` in `src/routes/content.routes.js`.

As of this writing, the first seven have been run against the live
database. `route_refresh_tier.sql` (#8) and `api_logs.sql` (#9) are new
and still need to be run once before the route-tiering admin UI and the
API-monitoring dashboard have any effect. `geo_i18n.sql` (#10) is also
new and needs to be run once before the Geo CMS / multi-language SEO
pages have any effect.
