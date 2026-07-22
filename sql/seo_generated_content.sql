-- ═══════════════════════════════════════════════════════════════
-- seo_generated_content
-- Dedicated columns for PROGRAMMATICALLY GENERATED route-page SEO content,
-- kept strictly separate from the hand-editable override columns
-- (custom_title / custom_meta_description / custom_faq / intro_text).
--
-- Why separate columns instead of reusing the override columns:
--   • Manual content must always win at render time — the override columns
--     are the human's, never touched by the generator.
--   • Generated content can be REFRESHED whenever the route's underlying data
--     changes (new prices, airline counts, directness), without ever colliding
--     with — or being blocked by — a human edit. Writing into the override
--     columns would make a generated route look "manually edited" and freeze it.
--   • The render layer resolves effective content as: manual ?? generated
--     (see effectiveRouteSeo() in src/services/seo/effective.js and the
--     /route-pages/:slug response).
--
-- Idempotent: safe to re-run.
-- ═══════════════════════════════════════════════════════════════

alter table route_pages add column if not exists seo_title text;
alter table route_pages add column if not exists seo_meta_description text;
alter table route_pages add column if not exists seo_intro_html text;         -- composed <p>/<h2> body
alter table route_pages add column if not exists seo_faq jsonb;               -- [{question, answer}]
alter table route_pages add column if not exists seo_angle text;             -- opening angle used (analytics/debug)
alter table route_pages add column if not exists seo_section_count int;      -- number of assembled sections
alter table route_pages add column if not exists seo_data_coverage jsonb;    -- real data dimensions that drove the page (transparency/analytics)
alter table route_pages add column if not exists seo_lang text;              -- language the content was generated in
alter table route_pages add column if not exists seo_generated_at timestamptz;

-- Only-generated routes are cheap to find/refresh; index the generation stamp.
create index if not exists route_pages_seo_generated_idx on route_pages (seo_generated_at);
