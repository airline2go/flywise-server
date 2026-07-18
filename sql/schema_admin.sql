-- ============================================================
-- Airpiv — Admin Dashboard backend schema (run once in Supabase
-- SQL Editor). Safe to re-run: every statement is idempotent.
-- ============================================================

-- gen_random_uuid() needs pgcrypto (or pg 13+'s built-in gen_random_uuid,
-- which Supabase already ships with — this is just a safety net).
create extension if not exists pgcrypto;

-- ─── pending_bookings ───────────────────────────────────────────
-- [CRITICAL-FIX] This table was referenced by server.js's rememberBooking()
-- / getPendingBooking() / markPendingBooked() from the very first Stripe
-- integration — server.js wraps every read/write in try/catch and falls
-- back to an in-memory Map() when the query fails, so the absence of this
-- table never threw a visible error. But that in-memory fallback only
-- survives as long as the Node process itself does: a Render restart,
-- redeploy, or free-tier idle/cold-start between "customer clicks pay"
-- and "Stripe redirects back" wipes it, and bookFromSession() then fails
-- with "Buchungsdaten nicht gefunden oder abgelaufen" — Duffel never gets
-- called, no bookings row is ever written, and the booking silently never
-- reaches the admin dashboard despite the customer having paid. Creating
-- this table makes checkout-session state durable across restarts, which
-- is the whole reason this table existed in the code in the first place.
create table if not exists pending_bookings (
  session_id text primary key,
  payload jsonb not null,
  status text not null default 'pending',   -- pending | paid | booked | failed
  duffel_order_id text,
  duffel_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists pending_bookings_status_idx on pending_bookings (status);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pending_bookings_status_check') then
    alter table pending_bookings
      add constraint pending_bookings_status_check
      check (status in ('pending', 'paid', 'booked', 'failed'));
  end if;
end $$;

-- ─── payments ───────────────────────────────────────────────────
-- [CRITICAL-FIX] Same situation as pending_bookings above — referenced by
-- bookFromSession() as a best-effort payment audit log, silently no-op'd
-- by its own try/catch when missing. Recreating it here for a complete,
-- queryable record of every Stripe charge (useful for reconciliation,
-- even though `bookings.customer_paid` is the authoritative amount).
create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  stripe_session_id text,
  stripe_payment_id text,
  amount numeric(10,2),
  currency text not null default 'EUR',
  status text not null default 'paid'
);
create index if not exists payments_session_id_idx on payments (stripe_session_id);
create index if not exists payments_stripe_payment_id_idx on payments (stripe_payment_id);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'payments_status_check') then
    alter table payments
      add constraint payments_status_check
      check (status in ('paid', 'refunded', 'failed'));
  end if;
end $$;

-- ─── bookings ────────────────────────────────────────────────
-- One row per CONFIRMED booking. Written by bookFromSession() right
-- after Duffel confirms the order. This is the admin dashboard's
-- source of truth for revenue/profit/stats — separate from
-- pending_bookings (which is just transient checkout-session state).
create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  stripe_session_id text unique,
  duffel_order_id text,
  booking_reference text,
  origin text,
  destination text,
  route_label text,
  status text not null default 'confirmed',   -- confirmed | cancelled | refunded
  passenger_count int default 1,
  customer_email text,
  -- [ADMIN-CUSTOMER-INFO] Primary passenger's identity/contact details,
  -- captured at booking confirmation time from the same passenger payload
  -- already sent to Duffel/Stripe — lets the admin dashboard show who
  -- actually booked (name, phone, date of birth), not just their email.
  customer_name text,
  customer_phone text,
  customer_dob date,
  -- [GUEST-LINK] Set at booking time if the customer was logged in then.
  -- NULL means it was a guest checkout — the row is still findable later
  -- by customer_email so it can be linked to an account retroactively
  -- (see link_guest_bookings_to_user below).
  user_id uuid references auth.users(id) on delete set null,

  -- Money — every amount in the booking's currency, stored as numeric(10,2)
  currency text not null default 'EUR',
  duffel_amount numeric(10,2),       -- exact net amount paid to Duffel (ticket + ancillaries, no margin)
  ticket_margin numeric(10,2) default 0,      -- profit margin applied to the base fare
  ancillary_margin numeric(10,2) default 0,   -- profit margin applied to seats/baggage
  discount_amount numeric(10,2) default 0,    -- promo + loyalty discount combined
  promo_code text,
  loyalty_discount numeric(10,2) default 0,   -- loyalty portion of discount_amount, broken out for reporting
  loyalty_points_earned int default 0,        -- exact points awarded for THIS booking — needed to reverse precisely on cancellation
  customer_paid numeric(10,2),       -- what actually got charged via Stripe
  profit_margin numeric(10,2) generated always as (coalesce(ticket_margin,0) + coalesce(ancillary_margin,0)) stored
);

create index if not exists bookings_created_at_idx on bookings (created_at desc);
create index if not exists bookings_status_idx on bookings (status);

-- [SCHEMA-DRIFT-FIX] create table ... if not exists is a no-op the moment
-- the table already exists — which it does on every database that's run
-- any earlier version of this script. That earlier version's bookings
-- table may be missing columns added in later revisions (this happened in
-- practice: user_id was added with its own ALTER below, but
-- customer_email/route_label/discount_amount/promo_code/loyalty_discount/
-- etc — all present in the create table above — never got the same
-- treatment, so a database that pre-dates them was missing them entirely
-- and any index or insert referencing them failed outright). Every column
-- the create table block above declares now also gets an explicit ALTER
-- here, so re-running this script always brings an existing table fully
-- up to date no matter how old it is. All of these are no-ops on a
-- brand-new table (the column already exists from the create table
-- above) and equally no-ops on an already-up-to-date table.
alter table bookings add column if not exists stripe_session_id text;
alter table bookings add column if not exists duffel_order_id text;
alter table bookings add column if not exists booking_reference text;
alter table bookings add column if not exists origin text;
alter table bookings add column if not exists destination text;
alter table bookings add column if not exists route_label text;
alter table bookings add column if not exists status text not null default 'confirmed';
alter table bookings add column if not exists passenger_count int default 1;
alter table bookings add column if not exists customer_email text;
alter table bookings add column if not exists customer_name text;
alter table bookings add column if not exists customer_phone text;
alter table bookings add column if not exists customer_dob date;
alter table bookings add column if not exists user_id uuid references auth.users(id) on delete set null;
alter table bookings add column if not exists currency text not null default 'EUR';
alter table bookings add column if not exists duffel_amount numeric(10,2);
alter table bookings add column if not exists ticket_margin numeric(10,2) default 0;
alter table bookings add column if not exists ancillary_margin numeric(10,2) default 0;
alter table bookings add column if not exists discount_amount numeric(10,2) default 0;
alter table bookings add column if not exists promo_code text;
alter table bookings add column if not exists loyalty_discount numeric(10,2) default 0;
alter table bookings add column if not exists loyalty_points_earned int default 0;
alter table bookings add column if not exists customer_paid numeric(10,2);
-- profit_margin is a GENERATED column — ADD COLUMN needs the full
-- "generated always as (...) stored" clause repeated, not just the type.
alter table bookings add column if not exists profit_margin numeric(10,2) generated always as (coalesce(ticket_margin,0) + coalesce(ancillary_margin,0)) stored;

-- Now that every column is guaranteed to exist, the indexes referencing
-- them are safe to create.
create index if not exists bookings_user_id_idx on bookings (user_id);
create index if not exists bookings_customer_email_lower_idx on bookings (lower(customer_email));

-- [LEGACY-COLUMN-FIX] A very old version of this table used different
-- column names than the ones this script has used for a long time —
-- booking_ref instead of booking_reference, order_id instead of
-- duffel_order_id, total_amount instead of customer_paid. Those old
-- columns were never declared anywhere in this script, so nothing here
-- ever knew they existed. Critically, booking_ref was NOT NULL: every
-- single booking insert (which only ever writes booking_reference) was
-- silently REJECTED by Postgres with "null value in column booking_ref
-- violates not-null constraint" — caught by the server's try/catch (so
-- the customer's payment and Duffel order both succeeded, and they even
-- got a confirmation email) but the booking itself never made it into the
-- bookings table at all, so it could never show up in the admin dashboard
-- or "Meine Buchungen". DROP COLUMN IF EXISTS is safe to run even if a
-- given database never had these columns — it's simply a no-op for it.
alter table bookings drop column if exists booking_ref;
alter table bookings drop column if exists order_id;
alter table bookings drop column if exists total_amount;
alter table bookings drop column if exists airline;
alter table bookings drop column if exists departure_date;

create index if not exists bookings_user_id_idx on bookings (user_id);
-- [GUEST-LINK] Case-insensitive email lookup — the index this retroactive
-- linking relies on most. lower() because emails are matched
-- case-insensitively (Ahmed@x.com must find a booking made as ahmed@x.com).
create index if not exists bookings_customer_email_lower_idx on bookings (lower(customer_email));

-- [MISSING-INDEXES-FIX] duffel_order_id and booking_reference are looked
-- up constantly (every cancellation, refund, and "view booking" call —
-- confirmed 24 and 21 references respectively in server.js) but had no
-- index at all, forcing a full table scan on every one of those calls.
create index if not exists bookings_duffel_order_id_idx on bookings (duffel_order_id);
create index if not exists bookings_booking_reference_idx on bookings (booking_reference);

-- [MISSING-CONSTRAINTS-FIX] The column comment above has always
-- documented 'confirmed | cancelled | refunded' as the valid set —
-- nothing in the database enforced it until now. See
-- migration_status_constraints.sql for the full rationale.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'bookings_status_check') then
    alter table bookings
      add constraint bookings_status_check
      check (status in ('confirmed', 'cancelled', 'refunded'));
  end if;
end $$;

-- ─── link_guest_bookings_to_user() ─────────────────────────────
-- [GUEST-LINK] The core of "book as guest, link to account later". Call
-- this once right after a user signs up (or logs in) — it finds every
-- CONFIRMED booking made with this exact email address that has no
-- user_id yet (a guest checkout) and attaches it to this account. Matching
-- is by email only, case-insensitive, and only ever touches rows where
-- user_id is currently null — an already-linked booking (whether to this
-- account or another) is never reassigned. Returns the rows that were
-- just linked, so the caller can show "we found N earlier bookings".
create or replace function link_guest_bookings_to_user(p_user_id uuid, p_email text)
returns setof bookings
language plpgsql
security definer
as $$
begin
  return query
    update bookings
    set user_id = p_user_id
    where user_id is null
      and lower(customer_email) = lower(p_email)
      and status = 'confirmed'
    returning *;
end;
$$;

-- ─── promo_codes ─────────────────────────────────────────────
-- Replaces the hardcoded PROMO_CODES object that used to live in
-- index.html (visible to anyone via browser devtools, with no real
-- usage cap). The server is now the only place that validates codes.
create table if not exists promo_codes (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  code text unique not null,                  -- stored upper-case
  type text not null check (type in ('percent','fixed')),
  value numeric(10,2) not null,
  max_uses int,                                -- null = unlimited
  used_count int not null default 0,
  active boolean not null default true,
  expires_at timestamptz                       -- null = never expires
);

create index if not exists promo_codes_code_idx on promo_codes (code);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'promo_codes_value_check') then
    alter table promo_codes
      add constraint promo_codes_value_check
      check (value > 0 and (type <> 'percent' or value <= 100));
  end if;
end $$;

-- ─── admin_config ────────────────────────────────────────────
-- Simple key/value store for admin-tunable settings: profit tiers for
-- tickets, profit tiers for ancillaries (seats/baggage), invoice
-- numbering config, etc. One row per setting, value is JSON.
create table if not exists admin_config (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- Seed sensible defaults (no-op if already present)
insert into admin_config (key, value) values
  ('ticket_profit_tiers', '[
    {"from":0,"to":200,"pct":8,"fixed":5},
    {"from":200,"to":500,"pct":6,"fixed":8},
    {"from":500,"to":null,"pct":4,"fixed":10}
  ]'::jsonb)
on conflict (key) do nothing;

insert into admin_config (key, value) values
  ('ancillary_profit_tiers', '[
    {"from":0,"to":100,"pct":10,"fixed":1},
    {"from":100,"to":200,"pct":8,"fixed":2},
    {"from":200,"to":null,"pct":6,"fixed":3}
  ]'::jsonb)
on conflict (key) do nothing;

insert into admin_config (key, value) values
  ('invoice_config', '{
    "prefix": "AIRPIV",
    "nextNumber": 1,
    "companyName": "Airpiv",
    "companyAddress": "",
    "steuernummer": "",
    "taxMode": "kleinunternehmer"
  }'::jsonb)
on conflict (key) do nothing;

-- ─── loyalty_accounts ────────────────────────────────────────
-- One row per identity. Logged-in users are keyed by user_id — a real
-- Supabase Auth account (auth.users.id), durable across devices and
-- managed by Supabase's own battle-tested auth system (email+password,
-- Google OAuth, email verification, password reset — all handled by
-- Supabase itself, not custom code here). Anonymous visitors are keyed by
-- device_id (a client-generated UUID in localStorage) exactly as before.
-- Both columns are nullable and exactly one is set per row — enforced by
-- the check constraint below, not just convention.
create table if not exists loyalty_accounts (
  id uuid primary key default gen_random_uuid(),
  device_id uuid unique,
  user_id uuid unique references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  points int not null default 0,
  credit numeric(10,2) not null default 0,
  credit_used numeric(10,2) not null default 0,
  bookings_count int not null default 0,
  tier text not null default 'bronze',
  constraint loyalty_owner_check check (
    (device_id is not null and user_id is null) or
    (device_id is null and user_id is not null)
  )
);

-- [MISSING-INDEXES-FIX] Backs any tier-based admin filtering/reporting —
-- cheap to add proactively even on a small table today.
create index if not exists loyalty_accounts_tier_idx on loyalty_accounts (tier);

-- [TIER-DEMOTION-FIX] Counter used to determine loyalty tier — only ever
-- increases (earned via confirmed bookings), never decreases when points
-- are redeemed for credit. Without this, converting points to credit could
-- pull a customer's spendable `points` balance below a tier threshold
-- they'd already reached, demoting them purely for redeeming.
--
-- Backfill for existing rows: use whichever is HIGHER — the current
-- points balance, or the minimum points threshold for the tier already
-- stored on the account. This matters because an account may already have
-- redeemed points before this migration ever runs (e.g. a Silver member
-- down to a handful of spendable points) — backfilling from `points`
-- alone in that case would wrongly set lifetime_points below the Silver
-- threshold. Using the stored tier as a floor guarantees this migration
-- can only ever raise lifetime_points to match a tier already earned,
-- never silently demote anyone. (There's no history of past redemptions
-- to reconstruct the exact original total, so this floor is the safest
-- available estimate — and it's exact for any account that hasn't
-- redeemed anything yet, since points = lifetime_points in that case.)
alter table loyalty_accounts add column if not exists lifetime_points integer not null default 0;
update loyalty_accounts set lifetime_points = greatest(
  points,
  case tier when 'gold' then 10000 when 'silver' then 4000 else 0 end
) where lifetime_points = 0;
-- Deliberately NOT recomputing `tier` from the backfilled lifetime_points
-- here — the floor above guarantees lifetime_points can never read lower
-- than the account's already-stored tier, so tier is already correct and
-- needs no change. (An earlier version of this migration did recompute
-- tier from a naive points-only backfill, which could have wrongly
-- demoted an account back to Bronze — removed for that reason.)

-- ─── loyalty_config (in admin_config) ─────────────────────────
-- Every number in the loyalty program, admin-editable instead of hardcoded
-- in the frontend JS. `tiers` mirrors the profit-tier shape for
-- consistency: { from, to(nullable), creditEur }[] — the credit amount
-- usable when the booking subtotal falls in that range. `maxCreditPerBooking`
-- is an absolute ceiling enforced server-side regardless of what the
-- frontend (or a tampered localStorage value) requests. `pointsPerEuroRedeem`
-- is how many points convert to €1.00 of credit via POST /loyalty/redeem.
insert into admin_config (key, value) values
  ('loyalty_config', '{
    "welcomeCreditEur": 10.0,
    "welcomePoints": 100,
    "pointsPerEuro": 2,
    "pointsPerEuroRedeem": 400,
    "maxCreditPerBooking": 5.0,
    "tiers": [
      {"from": 0,   "to": 75,  "creditEur": 1},
      {"from": 75,  "to": 149, "creditEur": 2},
      {"from": 149, "to": 224, "creditEur": 3},
      {"from": 224, "to": 299, "creditEur": 4},
      {"from": 299, "to": null, "creditEur": 5}
    ]
  }'::jsonb)
on conflict (key) do nothing;

-- ─── invoices ────────────────────────────────────────────────
-- [ADMIN-INVOICE] Real, centrally-stored invoice register — replaces the
-- old localStorage-only counter + log, which could duplicate or skip
-- numbers across devices/browser-data-clears (a real problem under
-- German §14 UStG, which requires a gap-free sequential invoice number).
--
-- invoice_seq is a Postgres SEQUENCE: nextval() is atomic at the database
-- level, so two admins clicking "issue invoice" at the exact same moment
-- can never receive the same number, even without any application-level
-- locking. This is the actual fix — not just moving the same unsafe
-- counter logic from localStorage into a table column.
create sequence if not exists invoice_seq start 1;

create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  invoice_number text unique not null,   -- e.g. "AIRPIV-2026-0001", built from invoice_seq + admin's prefix/year
  seq_number bigint not null,            -- the raw sequence value, kept separately from the formatted string
  created_at timestamptz not null default now(),
  booking_id uuid references bookings(id) on delete set null,
  booking_reference text,
  customer_name text,
  customer_address text,
  amount numeric(10,2) not null default 0,
  currency text not null default 'EUR',
  fields jsonb                            -- snapshot of route/airline/PNR etc. at issue time, for reprinting later
);
create index if not exists invoices_created_at_idx on invoices (created_at desc);
create index if not exists invoices_booking_id_idx on invoices (booking_id);

-- ─── countries ───────────────────────────────────────────────
-- [COUNTRY-PAGES] Created on-demand only — a row is added here the first
-- time a published route_pages entry touches that country (via
-- ensureCountryExists() in server.js), never pre-populated for every
-- country in the world. This is what keeps country.html from ever
-- becoming "thin content": a country page only exists once there's at
-- least one real route linked to it.
-- ─── cities ──────────────────────────────────────────────────
-- [CITY-PAGES] Same on-demand creation pattern as countries — a row
-- only exists once a published route_pages entry touches that city,
-- created automatically via ensureCityExists() in server.js.
--
-- city_slug is the STABLE matching key (lowercase, accent-stripped via
-- the same slugify() already used for blog/route slugs) — route_pages'
-- origin_city/destination_city are free-text display names that could
-- vary slightly in capitalization across different routes for the same
-- real city (e.g. "Berlin" vs "berlin "); matching on the normalized
-- slug instead of the raw text avoids silently treating those as two
-- different cities.
--
-- airport_codes is an array that GROWS over time as new routes reveal
-- additional airports serving the same city (e.g. a route via LGW
-- discovered after LHR was already on file for London) — appended to,
-- never overwritten, by ensureCityExists().
create table if not exists countries (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  code text unique not null,                    -- ISO country code, e.g. "DE"
  name text not null,                            -- display name, e.g. "Deutschland"
  intro_text text,                               -- optional hand-written description; falls back to a generic template if empty
  status text not null default 'published' check (status in ('draft','published'))
);
create index if not exists countries_code_idx on countries (code);
create index if not exists countries_status_idx on countries (status);

-- [RLS-SECURITY-FIX] Enabled immediately, not as a later follow-up —
-- same public-read-if-published pattern as blog_posts/route_pages.
alter table countries enable row level security;
drop policy if exists "Public can read published countries" on countries;
create policy "Public can read published countries"
  on countries for select
  using (status = 'published');

create table if not exists cities (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  city_slug text unique not null,                -- normalized matching key, e.g. "london"
  name text not null,                            -- display name, e.g. "London"
  country_code text references countries(code),  -- which country this city belongs to
  airport_codes text[] not null default '{}',    -- e.g. ['LHR','LGW'] — grows as more routes reveal more airports
  intro_text text,                               -- optional hand-written description; falls back to a generic template if empty
  status text not null default 'published' check (status in ('draft','published'))
);
create index if not exists cities_slug_idx on cities (city_slug);
create index if not exists cities_country_idx on cities (country_code);
create index if not exists cities_status_idx on cities (status);

alter table cities enable row level security;
drop policy if exists "Public can read published cities" on cities;
create policy "Public can read published cities"
  on cities for select
  using (status = 'published');

-- ─── route_pages ─────────────────────────────────────────────
-- [ROUTE-PAGES] Self-serve SEO route landing pages (e.g.
-- "Flüge Berlin nach London"), same self-serve pattern as blog_posts —
-- the admin adds a route from the dashboard, no developer involvement
-- needed per page. The public flight-route.html?slug=... page reads the
-- matching row here and fetches a live "from" price via GET /route-price
-- using origin_iata/destination_iata — the price itself is never stored
-- here (it would go stale); only the route metadata and optional
-- hand-written SEO text are.
create table if not exists route_pages (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  slug text unique not null,                    -- e.g. "berlin-london"
  origin_iata text not null,                    -- e.g. "BER"
  destination_iata text not null,               -- e.g. "LHR"
  origin_city text not null,                    -- e.g. "Berlin" — display name
  destination_city text not null,               -- e.g. "London"
  -- [ROUTE-PAGES-DISTANCE] Captured once from the airport search results
  -- at creation time (Duffel includes lat/lng on airport objects) —
  -- never re-fetched on every page view, and never user-entered.
  origin_lat numeric, origin_lng numeric,
  destination_lat numeric, destination_lng numeric,
  distance_km int,                               -- computed via Haversine formula server-side — a real, verifiable number, never guessed
  haul_type text,                                -- 'short-haul' | 'medium-haul' | 'long-haul', computed from distance_km
  -- [COUNTRY-PAGES] Captured automatically from the airport search
  -- results at creation time (Duffel's iata_country_code) — never
  -- manually entered. This is what lets country.html query "all routes
  -- touching this country" without any per-route manual tagging.
  origin_country text,                           -- ISO country code, e.g. "DE"
  destination_country text,                      -- e.g. "GB"
  -- [CITY-PAGES] Normalized matching key (lowercase, accent-stripped via
  -- slugify()) — never the raw origin_city/destination_city free text,
  -- which could vary slightly in capitalization across routes for the
  -- same real city.
  origin_city_slug text,
  destination_city_slug text,
  intro_text text,                               -- optional hand-written SEO paragraph; falls back to a generic template if empty
  -- [ROUTE-SEO-OVERRIDES] Optional — when empty, the page falls back to
  -- its existing automatic title/description generation exactly as
  -- before. When filled in, these take priority. Purely additive: no
  -- existing route's rendered output changes unless the admin explicitly
  -- sets one of these.
  custom_title text,
  custom_meta_description text,
  -- [ROUTE-FAQ-OVERRIDE] Optional — array of {question, answer} objects as
  -- JSON. Null/empty falls back to the existing 3 generic auto-generated
  -- FAQ questions exactly as before. Purely additive.
  custom_faq jsonb,
  -- [DEAD-ROUTES] 'dead' = فحصنا فعلياً ولقينا مفيش رحلات حقيقية على
  -- Duffel لتاريخ نموذجي قريب — مختلف عن 'draft' (لسه ما اتراجعتش).
  status text not null default 'draft' check (status in ('draft','published','dead')),
  last_health_check_at timestamptz
);
alter table route_pages add column if not exists custom_title text;
alter table route_pages add column if not exists custom_meta_description text;
alter table route_pages add column if not exists custom_faq jsonb;
alter table route_pages add column if not exists last_health_check_at timestamptz;
create index if not exists route_pages_status_idx on route_pages (status);
create index if not exists route_pages_health_check_idx on route_pages (last_health_check_at);
-- [SCHEMA-DRIFT-FIX] Same pattern as every other table in this file —
-- explicit ALTERs alongside CREATE TABLE in case an earlier version of
-- this script already ran against this database before these columns
-- existed.
alter table route_pages add column if not exists origin_lat numeric;
alter table route_pages add column if not exists origin_lng numeric;
alter table route_pages add column if not exists destination_lat numeric;
alter table route_pages add column if not exists destination_lng numeric;
alter table route_pages add column if not exists distance_km int;
alter table route_pages add column if not exists haul_type text;
alter table route_pages add column if not exists origin_country text;
alter table route_pages add column if not exists destination_country text;
alter table route_pages add column if not exists origin_city_slug text;
alter table route_pages add column if not exists destination_city_slug text;
create index if not exists route_pages_origin_city_slug_idx on route_pages (origin_city_slug);
create index if not exists route_pages_dest_city_slug_idx on route_pages (destination_city_slug);
create index if not exists route_pages_status_idx on route_pages (status);
create index if not exists route_pages_slug_idx on route_pages (slug);
-- [BLOG-SYSTEM] Self-serve blog — the admin writes and publishes posts
-- directly from the dashboard (POST/PUT/DELETE /admin/blog-posts), no
-- developer involvement needed per post. The public blog.html /
-- blog-post.html pages read only status='published' rows; 'draft' rows
-- are visible only in the admin dashboard until explicitly published.
-- ─── error_logs ──────────────────────────────────────────────
-- [ERROR-LOGS] Captures every error/fatal/critical-level log() call from
-- server.js automatically — log() itself writes here now, not just to
-- Render's console (which gets truncated/rotated over time on the free
-- tier, making past errors impossible to review later). The admin
-- dashboard reads this table directly; nothing here requires editing
-- any of the 20+ existing log('error', ...) call sites individually.
create table if not exists error_logs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  level text not null,                 -- 'error' | 'fatal' | 'warn'
  message text not null,
  meta jsonb,                          -- whatever context was passed to log() — session_id, error details, etc.
  source text                          -- optional: which subsystem (stripe/duffel/email/server) — derived from the message when possible
);
create index if not exists error_logs_created_at_idx on error_logs (created_at desc);
create index if not exists error_logs_level_idx on error_logs (level);

create table if not exists blog_posts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,                    -- null until first published
  slug text unique not null,                   -- URL-safe identifier, e.g. "guenstige-fluege-buchen-tricks"
  title text not null,
  meta_description text,                       -- for the <meta name="description"> tag — falls back to a trimmed excerpt if empty
  excerpt text,                                -- short summary shown on the blog index page
  content text not null,                       -- HTML body of the post
  cover_image_url text,                        -- optional hero image, shown on index + as the post's og:image
  author text default 'Airpiv Team',
  status text not null default 'draft' check (status in ('draft','published')),
  views_count int not null default 0
);
create index if not exists blog_posts_status_published_idx on blog_posts (status, published_at desc);
create index if not exists blog_posts_slug_idx on blog_posts (slug);
