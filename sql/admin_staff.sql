-- ════════════════════════════════════════════════════════════
-- AIRPIV — Admin identity, staff roles, and financial audit trail
-- Run once in Supabase's SQL Editor. Safe to re-run (idempotent).
-- ════════════════════════════════════════════════════════════
--
-- CONTEXT: admin access has always been a single shared secret
-- (ADMIN_TOKEN) — anyone who knows it is fungibly "the admin," with no
-- way to tell who actually did what, and no way to grant someone
-- restricted access (e.g. day-to-day operations, but never profit
-- margins or customer credit). This migration adds real per-admin
-- accounts with two fixed roles ('admin' = full access, 'staff' =
-- everything except margins/credit/staff-management), session tokens,
-- a general activity log, and a full credit-movement ledger — all
-- purely additive. The legacy ADMIN_TOKEN keeps working exactly as
-- before as a permanent fallback; nothing here changes that path.
--
-- RLS: every table below is server-only — zero policies for anon/
-- authenticated. All reads/writes go exclusively through flywise-
-- server's service-role key, same pattern as admin_config/
-- pending_bookings/referrals.
-- ════════════════════════════════════════════════════════════

create table if not exists admin_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text not null,
  password_hash text not null,
  role text not null default 'staff' check (role in ('admin', 'staff')),
  active boolean not null default true,
  created_by_admin_id uuid references admin_users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists admin_users_email_idx on admin_users (lower(email));

create table if not exists admin_sessions (
  token_hash text primary key,
  admin_user_id uuid not null references admin_users(id) on delete cascade,
  role text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists admin_sessions_admin_user_id_idx on admin_sessions (admin_user_id);
create index if not exists admin_sessions_expires_at_idx on admin_sessions (expires_at);

-- General audit trail for admin actions across the whole panel (staff
-- CRUD, credit top-ups, and — lightly — margin config changes), not
-- just the credit-specific log below.
create table if not exists admin_activity_log (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid references admin_users(id) on delete set null,
  action text not null,
  target_type text,
  target_id text,
  metadata jsonb,
  created_at timestamptz not null default now()
);
create index if not exists admin_activity_log_admin_user_id_idx on admin_activity_log (admin_user_id);
create index if not exists admin_activity_log_created_at_idx on admin_activity_log (created_at);

-- Full ledger of every credit-balance movement (not just admin top-ups)
-- — mirrors loyalty_accounts' own device_id/user_id "exactly one owner"
-- pattern, so anonymous-device accounts can be logged too, not just
-- registered users.
create table if not exists loyalty_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  device_id uuid,
  type text not null check (type in ('admin_credit', 'reward', 'refund', 'booking_usage')),
  amount numeric(10,2) not null,
  balance_after numeric(10,2) not null,
  created_by_admin_id uuid references admin_users(id) on delete set null,
  note text,
  created_at timestamptz not null default now(),
  constraint loyalty_transactions_owner_check check (
    (device_id is not null and user_id is null) or
    (device_id is null and user_id is not null)
  )
);
create index if not exists loyalty_transactions_user_id_idx on loyalty_transactions (user_id);
create index if not exists loyalty_transactions_device_id_idx on loyalty_transactions (device_id);
create index if not exists loyalty_transactions_created_at_idx on loyalty_transactions (created_at);

-- Admin-top-up-specific view, kept alongside the general ledger above
-- since "who gave what to whom and why" is a screen an owner will
-- actually want to read directly, without joining through
-- loyalty_transactions.
create table if not exists admin_credit_log (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid references admin_users(id) on delete set null,
  target_user_id uuid not null references auth.users(id) on delete cascade,
  amount numeric(10,2) not null,
  old_balance numeric(10,2) not null,
  new_balance numeric(10,2) not null,
  reason text,
  created_at timestamptz not null default now()
);
create index if not exists admin_credit_log_target_user_id_idx on admin_credit_log (target_user_id);

alter table admin_users enable row level security;
alter table admin_sessions enable row level security;
alter table admin_activity_log enable row level security;
alter table loyalty_transactions enable row level security;
alter table admin_credit_log enable row level security;
-- Deliberately no insert/select/update/delete policy for anon/authenticated
-- on any of the five tables above — every access goes through
-- flywise-server's service-role key only.

select 'admin staff/roles/audit migration applied!' as status;
