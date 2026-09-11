-- ════════════════════════════════════════════════════════════
-- reviews_system.sql
-- [REVIEWS-P0] User-generated reviews for the Airpiv experience.
--
-- The public.reviews table already EXISTS in the live database (created
-- outside of these SQL files — the same way `passengers`/`referrals` did),
-- but it was never defined here and only carries the minimal shape the old
-- browser-side feedback card wrote to:
--     id, user_id, booking_ref, stars, comment, created_at
-- rls_security_fixes.sql already anticipated it (public read + author-only
-- insert, existence-guarded).
--
-- This migration is ADDITIVE and idempotent — it re-declares that base
-- table (create-if-not-exists, matching the live shape exactly so a fresh
-- database gets it too), then adds the columns the real reviews system
-- needs, without dropping or renaming anything the old card relies on
-- (`stars`, `booking_ref` stay). Safe to run against the live database or
-- a fresh one, any number of times.
--
-- Run order: after schema_admin.sql / rls_security_fixes.sql (which owns
-- the base RLS enable) and after route_pages exists.
-- ════════════════════════════════════════════════════════════

-- ─── 1. Base table (matches the current live shape; no-op if present) ───
create table if not exists public.reviews (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid,
  booking_ref text,
  stars      integer,
  comment    text,
  created_at timestamptz default now()
);

-- ─── 2. Additive columns for the real reviews system ───
-- rating: the canonical 1–5 overall score (kept in sync with the legacy
-- `stars` column by the server on write; `stars` is retained only so the
-- old browser card keeps working until the new frontend fully ships).
alter table public.reviews add column if not exists rating integer;

-- Linkage — the server sets these; never trusted from the browser.
alter table public.reviews add column if not exists booking_id uuid
  references public.bookings(id) on delete set null;
alter table public.reviews add column if not exists route_id uuid
  references public.route_pages(id) on delete set null;

-- Moderation lifecycle + trust flag. New reviews start 'pending'; only the
-- server (service key) ever flips `verified` after proving a real booking.
alter table public.reviews add column if not exists status text not null default 'pending';
alter table public.reviews add column if not exists verified boolean not null default false;

-- Optional per-dimension sub-ratings (§2 of the plan — only what the user
-- actually experienced; all nullable).
alter table public.reviews add column if not exists search_experience_rating   integer;
alter table public.reviews add column if not exists price_transparency_rating  integer;
alter table public.reviews add column if not exists information_rating         integer;
alter table public.reviews add column if not exists booking_experience_rating  integer;

-- Presentation / provenance.
alter table public.reviews add column if not exists author_name text;   -- user-chosen display name only (privacy §30)
alter table public.reviews add column if not exists country     text;   -- optional display country
alter table public.reviews add column if not exists language    text;   -- BCP-47-ish code the review was written in
alter table public.reviews add column if not exists liked_tags  jsonb;  -- the "What did you like?" checkboxes (§7)
alter table public.reviews add column if not exists updated_at  timestamptz default now();

-- ─── 3. Value constraints (dropped-then-added so re-runs are clean) ───
alter table public.reviews drop constraint if exists reviews_rating_check;
alter table public.reviews add  constraint reviews_rating_check
  check (rating is null or (rating between 1 and 5));

alter table public.reviews drop constraint if exists reviews_subratings_check;
alter table public.reviews add  constraint reviews_subratings_check check (
  (search_experience_rating  is null or search_experience_rating  between 1 and 5) and
  (price_transparency_rating is null or price_transparency_rating between 1 and 5) and
  (information_rating        is null or information_rating         between 1 and 5) and
  (booking_experience_rating is null or booking_experience_rating between 1 and 5)
);

alter table public.reviews drop constraint if exists reviews_status_check;
alter table public.reviews add  constraint reviews_status_check
  check (status in ('pending', 'published', 'rejected', 'deleted'));

-- ─── 4. Anti-duplicate + hot-path indexes ───
-- One review per (user, booking) — only enforced when a booking is linked.
create unique index if not exists reviews_user_booking_uidx
  on public.reviews (user_id, booking_id) where booking_id is not null;

-- Route reviews section: fetch published reviews for a route, newest first.
create index if not exists reviews_route_status_idx
  on public.reviews (route_id, status, created_at desc);

-- Central /reviews page + global aggregate.
create index if not exists reviews_status_created_idx
  on public.reviews (status, created_at desc);

-- ─── 5. updated_at trigger (same pattern as social_posts / afr) ───
create or replace function public.reviews_touch_updated_at()
returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

drop trigger if exists reviews_set_updated_at on public.reviews;
create trigger reviews_set_updated_at
  before update on public.reviews
  for each row execute function public.reviews_touch_updated_at();

-- ─── 6. One-time backfill of the pre-existing rows ───
-- Rows that predate this system have no `rating`/`status`. Mirror stars →
-- rating always (cheap + idempotent), and publish the legacy rows once —
-- guarded by an admin_config marker so re-running never republishes a row
-- an admin has since moved back to pending/rejected/deleted.
update public.reviews set rating = stars where rating is null and stars is not null;

do $$
begin
  if not exists (select 1 from admin_config where key = 'reviews_system_backfill_done') then
    update public.reviews set status = 'published' where status = 'pending';
    insert into admin_config (key, value) values ('reviews_system_backfill_done', 'true'::jsonb)
      on conflict (key) do nothing;
  end if;
end $$;

-- ─── 7. RLS: public reads only PUBLISHED rows (or the author's own) ───
-- The base enable + author-insert policy come from rls_security_fixes.sql.
-- Here we tighten the read policy so pending/rejected/deleted rows are
-- never exposed to the anon key (§21/§30 — no hidden content leak). The
-- server uses the service-role key and bypasses RLS for moderation/SSR.
alter table public.reviews enable row level security;

drop policy if exists "Anyone can read reviews" on public.reviews;
drop policy if exists "Public can read published reviews" on public.reviews;
create policy "Public can read published reviews" on public.reviews
  for select using (status = 'published' or auth.uid() = user_id);

-- Author-only insert (kept identical to rls_security_fixes.sql; re-declared
-- idempotently so this file is self-contained on a fresh database).
drop policy if exists "Users can insert their own reviews" on public.reviews;
create policy "Users can insert their own reviews" on public.reviews
  for insert with check (auth.uid() = user_id);

-- No public update/delete policy: edits, moderation and deletion are
-- server-only (service-role key), never the browser.

select 'reviews system migration applied!' as status;
