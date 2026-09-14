# Multilingual route SEO

The route SEO engine now supports eight locales: `de`, `en`, `fr`, `es`, `it`, `nl`, `pl`, and `tr`.

Secondary locales are generated into `route_seo_locales` and never overwrite the primary German `route_pages.seo_*` columns. The localized generator is evidence-first and uses the same observed route facts as the German engine.

## Generation

```bash
node src/cli/generate-seo-content.js --language=en --limit=50
node src/cli/generate-seo-content.js --all-languages --limit=50
```

Use `--dry-run` to preview and `--force` only when intentionally refreshing an existing localized row.

## Database

Apply `sql/route_seo_locales.sql` through the reviewed Supabase migration process before running secondary-language generation.

The public route-serving layer should only advertise a locale when a corresponding `route_seo_locales` row exists. This keeps localized links and hreflang targets reciprocal and avoids publishing empty/404 locale pages.
