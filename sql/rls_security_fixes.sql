-- ════════════════════════════════════════════════════════════
-- AIRPIV — FIXES ONLY (بدون Schema)
-- شغّله على داتابيز موجودة وشغالة
-- آمن للتشغيل أكثر من مرة
-- ════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════
-- PART 1: RLS — Row Level Security
-- ════════════════════════════════════════════════════════════

-- ⚠️ BEFORE RUNNING: passengers and reviews are NOT defined in
-- schema_admin.sql (they exist in your database some other way, if they
-- exist at all — running this against the real database already showed
-- that "referrals" doesn't exist despite being called from the
-- frontend code, so the same may be true here). This version is safe
-- either way: every table is existence-checked first, so a missing
-- table is skipped with a clear NOTICE instead of stopping the whole
-- script with an error like last time.
--
-- The policies below assume passengers/reviews' user_id columns are type
-- "uuid" (matching auth.uid()) — strongly implied by the frontend code
-- (these IDs come straight from Supabase Auth's signUp()/getSession()).
-- If a table turns out to use a different type, you'll see a clear
-- error for that specific block — tell me and I'll adjust just that part.

-- ════════════════════════════════════════════════════════════
-- [RLS-SECURITY-FIX] Enable Row-Level Security on every table
-- ════════════════════════════════════════════════════════════
-- WHY THIS IS CRITICAL: index.html embeds Supabase's public "anon" key
-- (SUPA_KEY) directly in client-side JavaScript — anyone can see it via
-- "View Source". Without RLS, that key gives full read/write/delete
-- access to every row in every table, straight from the browser,
-- bypassing the server entirely. Supabase's own dashboard flagged this
-- as a CRITICAL security issue.
--
-- WHY THIS IS SAFE TO RUN: the server (server.js) connects using
-- SUPABASE_SERVICE_KEY — a separate, more privileged "service role" key
-- that BYPASSES RLS entirely by design. Enabling RLS has ZERO effect on
-- the server's own database access.
--
-- IMPORTANT — index.html ALSO connects to Supabase directly from the
-- browser for several features, using real Supabase Auth
-- (signInWithPassword/signUp, confirmed in the actual frontend code) —
-- "Meine Buchungen" syncing and saved passenger profiles/reviews. These
-- are legitimate browser-side reads/writes by a genuinely logged-in
-- customer, scoped to their OWN data — the fix for these is NOT "deny
-- everyone" but the standard Supabase pattern: auth.uid() = user_id, so
-- each customer can only ever see/modify their own rows, never anyone
-- else's.
--
-- Safe to run multiple times (idempotent). Safe even if some tables
-- listed below don't exist in your database — those sections are
-- skipped automatically with a NOTICE, not an error.
-- ════════════════════════════════════════════════════════════

-- ─── Server-only tables: RLS enabled, ZERO public policies ─────
-- No browser code touches these directly — only server.js (service
-- role, bypasses RLS). Default-deny for the anon key is correct here.

do $$
declare
  t text;
begin
  foreach t in array array['pending_bookings','payments','promo_codes','admin_config','loyalty_accounts','invoices'] loop
    if exists (select 1 from information_schema.tables where table_schema='public' and table_name=t) then
      execute format('alter table %I enable row level security', t);
      raise notice 'RLS enabled on: %', t;
    else
      raise notice 'SKIPPED (table not found): %', t;
    end if;
  end loop;
end $$;

-- ─── bookings: RLS enabled, customer can access ONLY their own rows ──
-- [DISCOVERED] syncLocalBookingsToSupabase() in index.html reads/inserts
-- directly into this table from the browser (logged-in customer syncing
-- "Meine Buchungen" across devices) — filtered by user_id already in the
-- app code, but with no RLS the anon key could read/modify ANY
-- customer's bookings, not just their own. This policy enforces that
-- boundary at the database level.
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema='public' and table_name='bookings') then
    execute 'alter table bookings enable row level security';
    execute 'drop policy if exists "Users can view their own bookings" on bookings';
    execute 'create policy "Users can view their own bookings" on bookings for select using (auth.uid() = user_id)';
    execute 'drop policy if exists "Users can insert their own bookings" on bookings';
    execute 'create policy "Users can insert their own bookings" on bookings for insert with check (auth.uid() = user_id)';
    raise notice 'RLS + policies applied: bookings';
  else
    raise notice 'SKIPPED (table not found): bookings';
  end if;
end $$;

-- ─── passengers (saved passenger profiles): same auth.uid() pattern ──
-- [DISCOVERED] loadSavedPassengers() reads this directly from the
-- browser, scoped to the logged-in user — same fix as bookings.
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema='public' and table_name='passengers') then
    execute 'alter table passengers enable row level security';
    execute 'drop policy if exists "Users can view their own saved passengers" on passengers';
    execute 'create policy "Users can view their own saved passengers" on passengers for select using (auth.uid() = user_id)';
    execute 'drop policy if exists "Users can manage their own saved passengers" on passengers';
    execute 'create policy "Users can manage their own saved passengers" on passengers for all using (auth.uid() = user_id) with check (auth.uid() = user_id)';
    raise notice 'RLS + policies applied: passengers';
  else
    raise notice 'SKIPPED (table not found): passengers';
  end if;
end $$;

-- ─── reviews: anyone can read (reviews are meant to be public-facing),
-- but only the logged-in author can write their own review ──────────
-- [DISCOVERED] Reviews insert directly from the browser when a logged-in
-- customer leaves feedback. Reading is intentionally public (reviews are
-- meant to be displayed to other visitors); writing is restricted to
-- the review's own author.
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema='public' and table_name='reviews') then
    execute 'alter table reviews enable row level security';
    execute 'drop policy if exists "Anyone can read reviews" on reviews';
    execute 'create policy "Anyone can read reviews" on reviews for select using (true)';
    execute 'drop policy if exists "Users can insert their own reviews" on reviews';
    execute 'create policy "Users can insert their own reviews" on reviews for insert with check (auth.uid() = user_id)';
    raise notice 'RLS + policies applied: reviews';
  else
    raise notice 'SKIPPED (table not found): reviews';
  end if;
end $$;

-- ─── referrals: confirmed NOT to exist via a real error — skipped ────
-- index.html's referral-program code calls _sb.from('referrals'), but
-- those calls have been silently failing this whole time (no table to
-- read or write). See sql/referrals_system.sql, which creates the table
-- properly (server-only writes, no client insert/update policy at all).

-- ─── blog_posts: RLS enabled, public READ-ONLY for published posts ──
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema='public' and table_name='blog_posts') then
    execute 'alter table blog_posts enable row level security';
    execute 'drop policy if exists "Public can read published blog posts" on blog_posts';
    execute 'create policy "Public can read published blog posts" on blog_posts for select using (status = ''published'')';
    raise notice 'RLS + policy applied: blog_posts';
  else
    raise notice 'SKIPPED (table not found): blog_posts';
  end if;
end $$;

-- ─── route_pages: RLS enabled, public READ-ONLY for published routes ──
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema='public' and table_name='route_pages') then
    execute 'alter table route_pages enable row level security';
    execute 'drop policy if exists "Public can read published route pages" on route_pages';
    execute 'create policy "Public can read published route pages" on route_pages for select using (status = ''published'')';
    raise notice 'RLS + policy applied: route_pages';
  else
    raise notice 'SKIPPED (table not found): route_pages';
  end if;
end $$;

-- ════════════════════════════════════════════════════════════
-- After running: check the "Logs"/"Results" output in Supabase's SQL
-- Editor for the NOTICE lines above — they tell you exactly which
-- tables got secured and which were skipped because they don't exist.
-- server.js keeps working exactly as before for every endpoint (service
-- role bypasses RLS regardless).
-- ════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════
-- PART 2: RLS — error_logs
-- ════════════════════════════════════════════════════════════

-- ════════════════════════════════════════════════════════════
-- RLS FIX — error_logs (the one table missed by every prior script)
-- ════════════════════════════════════════════════════════════
-- Confirmed via a full re-read of rls_security_fix_v2.sql that every
-- other table in the project already has RLS coverage there
-- (pending_bookings, payments, promo_codes, admin_config,
-- loyalty_accounts, invoices, bookings, passengers, reviews, blog_posts,
-- route_pages). error_logs is the only one left — it's purely written
-- and read by server.js (the admin dashboard's error-log viewer goes
-- through the server, never directly from the browser), so it gets the
-- same server-only pattern: RLS enabled, zero public policies, which
-- means Supabase denies all anon-key access by default.
--
-- Safe to run multiple times. Has zero effect on server.js itself
-- (which uses SUPABASE_SERVICE_KEY, always bypasses RLS regardless).
-- ════════════════════════════════════════════════════════════

do $$
begin
  if exists (select 1 from information_schema.tables where table_schema='public' and table_name='error_logs') then
    execute 'alter table error_logs enable row level security';
    raise notice 'RLS enabled (server-only, zero public policies): error_logs';
  else
    raise notice 'SKIPPED (table not found): error_logs';
  end if;
end $$;


-- ════════════════════════════════════════════════════════════
-- PART 3: Security Advisor — Function Search Path
-- ════════════════════════════════════════════════════════════

ALTER FUNCTION public.link_guest_bookings_to_user(uuid, text)
  SET search_path = public;

REVOKE EXECUTE ON FUNCTION public.link_guest_bookings_to_user(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.link_guest_bookings_to_user(uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.link_guest_bookings_to_user(uuid, text) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.link_guest_bookings_to_user(uuid, text) TO service_role;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'issue_invoices'
  ) THEN
    EXECUTE 'ALTER FUNCTION public.issue_invoices() SET search_path = public';
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.issue_invoices() FROM PUBLIC';
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.issue_invoices() FROM anon';
    EXECUTE 'GRANT  EXECUTE ON FUNCTION public.issue_invoices() TO service_role';
    RAISE NOTICE 'Fixed: issue_invoices';
  ELSE
    RAISE NOTICE 'SKIPPED (not found): issue_invoices';
  END IF;
END $$;

DO $$
DECLARE
  func_name text;
  func_args text;
BEGIN
  FOR func_name, func_args IN
    SELECT p.proname, pg_get_function_identity_arguments(p.oid)
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef = true
      AND NOT EXISTS (
        SELECT 1 FROM pg_options_to_table(p.proconfig)
        WHERE option_name = 'search_path'
      )
  LOOP
    BEGIN
      EXECUTE format(
        'ALTER FUNCTION public.%I(%s) SET search_path = public',
        func_name, func_args
      );
      RAISE NOTICE 'Fixed search_path: public.%(%)', func_name, func_args;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Could not fix: public.%(%): %', func_name, func_args, SQLERRM;
    END;
  END LOOP;
END $$;

-- ════════════════════════════════════════════════════════════
-- تذكير يدوي:
-- Authentication → Settings → Enable "Leaked Password Protection"
-- ════════════════════════════════════════════════════════════

SELECT 'Airpiv fixes applied!' AS status;
