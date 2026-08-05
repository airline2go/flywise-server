-- Social Studio: generated social-post queue (admin-owned).
-- RLS on with NO anon policy — only the service-role client (this server)
-- reaches it, like every other admin-owned table.
create table if not exists public.social_posts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  status text not null default 'draft'
    check (status in ('draft','pending_review','approved','scheduled','published','failed')),
  platform text not null,
  language text not null,
  template_type text not null,
  subject_type text,
  subject_ref text,
  title text,
  body text not null,
  hashtags text[] not null default '{}',
  cta_label text,
  cta_url text,
  image_brief text,
  scheduled_at timestamptz,
  published_at timestamptz,
  external_url text,
  metrics jsonb not null default '{}'::jsonb,
  created_by text,
  notes text
);
create index if not exists social_posts_status_idx on public.social_posts (status);
create index if not exists social_posts_scheduled_idx on public.social_posts (scheduled_at);
create index if not exists social_posts_created_idx on public.social_posts (created_at desc);

create or replace function public.social_posts_touch_updated_at()
returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

drop trigger if exists social_posts_set_updated_at on public.social_posts;
create trigger social_posts_set_updated_at
  before update on public.social_posts
  for each row execute function public.social_posts_touch_updated_at();

alter table public.social_posts enable row level security;
