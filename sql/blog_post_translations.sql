-- ═══════════════════════════════════════════════════════════════
-- blog_post_translations
-- [MULTILANG-BLOG] Per-language translations of a blog post. German is the
-- source language and lives in blog_posts itself (title/content/slug); this
-- table holds every OTHER language (en, ar, es, fr, it, nl, tr, …), one row
-- per (post, language). Adding a language never needs a schema change — just
-- another row. Replaces the old fixed title_en/content_en/slug_en columns on
-- blog_posts (kept for now during the transition; backfilled below).
-- ═══════════════════════════════════════════════════════════════

create table if not exists blog_post_translations (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references blog_posts(id) on delete cascade,
  language text not null,                       -- 'en','ar','es','fr','it','nl','tr' (never 'de' — that's the base row)
  slug text not null,                           -- URL slug in this language (unique per language)
  title text not null,
  meta_description text,
  excerpt text,
  content text not null,                        -- translated HTML body (tags/URLs preserved verbatim)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (post_id, language),
  unique (language, slug)
);

create index if not exists blog_post_translations_post_idx on blog_post_translations (post_id);
create index if not exists blog_post_translations_lang_slug_idx on blog_post_translations (language, slug);

-- Public read, but only for translations whose parent post is published —
-- same visibility rule as blog_posts' own RLS policy.
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema='public' and table_name='blog_post_translations') then
    execute 'alter table blog_post_translations enable row level security';
    execute 'drop policy if exists "Public can read translations of published posts" on blog_post_translations';
    execute 'create policy "Public can read translations of published posts" on blog_post_translations for select using (exists (select 1 from blog_posts p where p.id = post_id and p.status = ''published''))';
    raise notice 'RLS + policy applied: blog_post_translations';
  end if;
end $$;

-- [BACKFILL] Move the existing English translation (the old _en columns) into
-- the new table so nothing is lost. Idempotent: on conflict, refresh the row.
insert into blog_post_translations (post_id, language, slug, title, meta_description, excerpt, content)
select id, 'en', slug_en, title_en, meta_description_en, meta_description_en, content_en
from blog_posts
where slug_en is not null and title_en is not null and content_en is not null
on conflict (post_id, language) do update set
  slug = excluded.slug,
  title = excluded.title,
  meta_description = excluded.meta_description,
  excerpt = excluded.excerpt,
  content = excluded.content,
  updated_at = now();
