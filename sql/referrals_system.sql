-- ════════════════════════════════════════════════════════════
-- AIRPIV — Real, server-authoritative referral system
-- Run once in Supabase's SQL Editor. Safe to re-run (idempotent).
-- ════════════════════════════════════════════════════════════
--
-- CONTEXT: the referral feature in app.js has always called
-- _sb.from('referrals') directly from the browser — confirmed (by
-- you, running the earlier fixes script) that this table never
-- existed, so every referral has silently failed since launch: no
-- customer who invited a friend, and no friend who signed up via a
-- referral link, has ever actually received the €10 credit the UI
-- promised them.
--
-- This migration creates the table properly, this time:
--   - referrer_id / referred_id are REAL foreign keys to auth.users,
--     not a lossy one-way hash of the id (the old client code stored
--     only `referrer_code`, a hash with no way to look up who it
--     belonged to — there was no working code path to ever pay the
--     referrer, even hypothetically).
--   - booking_id is a REAL foreign key to bookings.id, not a
--     free-text booking reference the client could have sent
--     anything for.
--   - departure_date is populated ONLY by the server, from Duffel's
--     real confirmed order data — never accepted from the client.
--   - RLS: authenticated users can READ their own rows (as either
--     party) so the "my invites" list still works client-side, but
--     there is NO insert/update/delete policy for anyone but the
--     server's service-role key. All writes (creating a referral,
--     attaching a booking, paying out, reversing on cancellation)
--     now happen exclusively in flywise-server, using real,
--     server-verified data — mirrors the same pattern already
--     applied to every other financially-sensitive table.
-- ════════════════════════════════════════════════════════════

-- A stable, indexed referral code per account — same "AP-XXXXXX"
-- format the frontend has always displayed (referralCodeFor(userId),
-- a deterministic hash), but now computed and stored server-side so
-- a code can be looked back up to its owner (impossible with a bare
-- hash and no stored mapping). Backfilled lazily by the server the
-- first time each account is touched by the referral system — no
-- need to backfill every existing row here.
alter table loyalty_accounts add column if not exists referral_code text unique;
create index if not exists loyalty_accounts_referral_code_idx on loyalty_accounts (referral_code);

create table if not exists referrals (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  referrer_id uuid not null references auth.users(id) on delete cascade,
  referred_id uuid not null references auth.users(id) on delete cascade,
  referred_email text,
  booking_id uuid references bookings(id) on delete set null,
  departure_date timestamptz,
  status text not null default 'awaiting_booking' check (status in ('awaiting_booking','pending','completed','cancelled')),
  reward_referrer_paid boolean not null default false,
  reward_referred_paid boolean not null default false,
  constraint referrals_no_self_referral check (referrer_id <> referred_id),
  -- Each user can only ever be the REFERRED party once (they only sign
  -- up once) — this is what makes "who referred me" a clean 1:1 lookup.
  constraint referrals_referred_unique unique (referred_id)
);
create index if not exists referrals_referrer_id_idx on referrals (referrer_id);
create index if not exists referrals_booking_id_idx on referrals (booking_id);
create index if not exists referrals_status_idx on referrals (status);

alter table referrals enable row level security;
drop policy if exists "Users can view referrals they made or were referred by" on referrals;
create policy "Users can view referrals they made or were referred by"
  on referrals for select
  using (auth.uid() = referrer_id or auth.uid() = referred_id);
-- Deliberately no insert/update/delete policy for anon/authenticated —
-- every write goes through flywise-server's service-role key only.

select 'referrals system migration applied!' as status;
