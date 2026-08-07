-- Social Studio: audit trail for social_posts mutations (admin-owned).
-- RLS on with NO anon policy — only the service-role client (this server)
-- reaches it, like every other admin-owned table. Written fire-and-forget by
-- the admin CRUD endpoints and the auto-generation service, so a logging
-- failure never affects the mutation it records.
create table if not exists public.social_activity (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  action text not null,
  post_id uuid,
  subject_ref text,
  platform text,
  actor text,
  detail jsonb not null default '{}'::jsonb
);
create index if not exists social_activity_created_idx on public.social_activity (created_at desc);

alter table public.social_activity enable row level security;
