-- Store generated SEO independently per route and locale.
-- Existing route_pages seo_* columns remain the primary German compatibility layer.
create table if not exists route_seo_locales (
  id bigserial primary key,
  route_page_id bigint not null references route_pages(id) on delete cascade,
  language text not null check (language in ('de','en','fr','es','it','nl','pl','tr')),
  seo_title text,
  seo_meta_description text,
  seo_intro_html text,
  seo_faq jsonb,
  seo_angle text,
  seo_section_count integer,
  seo_data_coverage jsonb,
  generated_at timestamptz,
  updated_at timestamptz not null default now(),
  unique(route_page_id, language)
);
create index if not exists route_seo_locales_route_idx on route_seo_locales(route_page_id);
create index if not exists route_seo_locales_language_idx on route_seo_locales(language);
