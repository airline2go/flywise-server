-- Social Studio: content version history for social_posts (admin-owned).
-- RLS on with NO anon policy — only the service-role client (this server)
-- reaches it, like every other admin-owned table. A snapshot of a post's
-- content is written before each edit or revert, so changes are undoable.
-- Rows cascade-delete with their parent post.
create table if not exists public.social_post_versions (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.social_posts(id) on delete cascade,
  created_at timestamptz not null default now(),
  editor text,
  title text,
  body text,
  hashtags text[] not null default '{}',
  cta_label text,
  cta_url text,
  image_brief text,
  campaign text
);
create index if not exists social_post_versions_post_idx on public.social_post_versions (post_id, created_at desc);

alter table public.social_post_versions enable row level security;
