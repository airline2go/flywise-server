-- Per-locale generated SEO storage. Never replaces the primary route_pages SEO fields.
create table if not exists route_seo_locales (
  id uuid primary key default gen_random_uuid(),
  route_page_id uuid not null references route_pages(id) on delete cascade,
  language text not null,
  seo_title text,
  seo_meta_description text,
  seo_intro_html text,
  seo_faq jsonb,
  seo_angle text,
  seo_section_count int,
  seo_data_coverage jsonb,
  seo_generated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(route_page_id, language)
);
create index if not exists route_seo_locales_language_idx on route_seo_locales(language);
create index if not exists route_seo_locales_route_idx on route_seo_locales(route_page_id);
