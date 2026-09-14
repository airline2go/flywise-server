-- SEO internal-linking hot path
--
-- GET /route-pages/:slug/related filters published routes by origin_city OR
-- destination_city. Existing indexes cover the slug variants, but not these
-- exact city columns, so large published catalogues can fall back to scans.
-- Partial indexes keep the index small and aligned with the public endpoint.
-- Apply through the normal reviewed migration process; do not run directly
-- against production from an application request.

create index if not exists route_pages_published_origin_city_idx
  on public.route_pages (origin_city)
  where status = 'published';

create index if not exists route_pages_published_destination_city_idx
  on public.route_pages (destination_city)
  where status = 'published';
