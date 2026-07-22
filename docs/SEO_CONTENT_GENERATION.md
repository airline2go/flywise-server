# Programmatic SEO Content System

Enriches **existing** published route pages with unique, data-composed SEO content at scale (designed for 100,000+ pages). It never creates new pages. Every page is assembled from independent, data-driven blocks so that no two pages are near-duplicates — the failure mode "same paragraph, city names swapped" is explicitly measured against and rejected.

## Governing rules (and how each is enforced)

| Rule | Enforcement |
|------|-------------|
| Never overwrite manual content | Generated content is written to dedicated `seo_*` columns; the human override columns (`custom_title`, `custom_meta_description`, `custom_faq`, `intro_text`) are never touched and always win at render time (`effectiveRouteSeo`). |
| No template with swapped names | Pages are **composed** from data-driven blocks, not filled from one template. Similarity is measured on **city-neutralized** text, so swapped-name duplicates would score ~1.0 and fail the test. |
| Every page significantly different | Opening angle, section selection/order, headings, phrasing and FAQ set all vary by the route's real data plus a per-slug seeded PRNG. |
| Use all available data | Blocks read `distance_km`, `haul_type`, `airline_count`, `direct_flight_available`/`all_direct`/`stop_distribution`, `avg/min_duration_min`, `price_min/max/avg`, `price_trend`, `route_score`(+confidence), `itinerary_count`, domestic/international. |
| No invented facts | Every number rendered comes from the route row. A block that needs absent data does not render. |
| Skip when data insufficient | Quality gate skips routes missing distance/cities/haul; skips are reported, never counted as failures, never filled with filler. |
| Similarity < 40% | `test/seoEngine.test.js` builds a 380-page corpus and asserts mean / p95 / share-over-threshold all well under 0.40 (currently mean ≈ 0.17, p95 ≈ 0.29, <0.5% of pairs over 40%). |

## Architecture

```
src/services/seo/
  compose.js       seeded PRNG, context builder, data bucketization (price/airline/directness/popularity)
  blocks.de.js     German content library: 10 angle intros, 8 section blocks, 7 FAQ candidates, title/meta pools
  engine.js        quality gate + angle selection + dynamic section/FAQ assembly → full page
  similarity.js    k-shingle Jaccard, city-neutralized, corpus report (rule #9 measurement)
  effective.js     manual-wins-over-generated resolver used at render time
src/services/seoBatchProcessor.js   batch/single orchestration, writes seo_* columns
src/cli/generate-seo-content.js     CLI runner
sql/seo_generated_content.sql       dedicated generated columns
```

### How a page is assembled (per route)

1. **Quality gate** — enough real data? manual content present? → maybe skip.
2. **Context** — normalize every real field and bucketize it (e.g. price → budget/moderate/premium *relative to haul type*; directness → all-direct / mostly-direct / mixed / connections-only from `stop_distribution`).
3. **Opening angle** — each candidate angle (price / duration / airport / airline / destination / traveler / business / family / weekend / seasonal) scores itself on how *distinctive* that dimension is for this route; the composer seed-picks among the top few. A cheap route opens on price, a nonstop route on convenience, a many-airline route on competition.
4. **Sections** — only blocks whose real data exists are eligible; a data-scaled number are weight-selected and seed-ordered, so richer routes get more sections and not every page shows every section.
5. **FAQ** — 3–5 questions selected from applicable candidates; answers branch on the route's data.
6. **Title / meta** — chosen from data-aware variant pools (e.g. include price "ab X €" only when price data exists; say "Direktflüge" only when `all_direct`).

Everything is deterministic per slug (stable for Google) yet spread across routes.

### Dynamic SEO blocks

Available section blocks (rendered subset per page, never all): **Overview**, **Price analysis**, **Airline analysis**, **Direct-vs-connection analysis**, **Booking strategy**, **Seasonal insights**, **Popularity/demand**, **Airport detail**. Each answers a real user question (When should I book? Is a direct flight available? Which airlines fly this? Is it cheaper at certain times? Is it good for a weekend?) — no keyword stuffing.

## Storage & render contract

Generated content lives in dedicated columns (`sql/seo_generated_content.sql`):
`seo_title`, `seo_meta_description`, `seo_intro_html`, `seo_faq`, `seo_angle`, `seo_section_count`, `seo_lang`, `seo_generated_at`.

`GET /route-pages/:slug` attaches a resolved `seo` object:
```js
route.seo = {
  title, metaDescription, introHtml, faq,          // manual override wins, else generated
  source: { title, metaDescription, intro, faq },  // 'manual' | 'generated' | 'none'
  angle, generatedAt,
}
```
The SSG build reads `route.seo.*` and never needs to know the source. Because generated content is isolated in its own columns, it can be **refreshed** (`--force`) whenever a route's data changes, without ever colliding with — or being blocked by — a human edit.

## API (admin)

- `GET /admin/seo/statistics` — readiness: eligible / already-generated / skipped (manual vs. insufficient) + haul breakdown.
- `POST /admin/seo/route/:id` — body `{ language, dry_run, force }`. Returns `{ skipped, reasons }` or `{ angle, content }`.
- `POST /admin/seo/batch-generate` — `requireFullAdmin`, body `{ dry_run, force }`. Non-blocking; 409 if already running.
- `GET /admin/seo/batch-status` — live progress + last summary (updated / skipped / failed / angle distribution).

## CLI

```bash
node src/cli/generate-seo-content.js --stats            # readiness report
node src/cli/generate-seo-content.js --route-id=<id>    # one route (prints angle/sections)
node src/cli/generate-seo-content.js --dry-run          # preview whole batch, no writes
node src/cli/generate-seo-content.js                    # fill routes not yet generated
node src/cli/generate-seo-content.js --force            # refresh all after data changes
```

## Testing

```bash
npx jest test/seoEngine.test.js test/seoEffective.test.js
```
- Quality gate & manual protection.
- Page structure (title/meta/≥3 sections/3–5 FAQ) and determinism.
- Data-driven divergence (cheap-direct vs expensive-connecting read differently).
- **Rule #9**: 380-page corpus, city-neutralized pairwise similarity — mean/p95/tail all under threshold.
- Angle variety across the corpus (≥5 distinct opening angles used).
- `effectiveRouteSeo` manual-wins resolution.

## Adding a language

Write an independent `blocks.<lang>.js` (native authoring, never literal translation of German), register it in `engine.js`'s `PACKS`. `supportedLanguages()` and the batch/CLI pick it up automatically. Until then, that language is skipped rather than served machine-translated thin content.

## Scaling to 100k+ pages

- Composition is O(1) per page and pure (no I/O); batching writes in groups of 50 with a short pause.
- Only `seo_*` columns are written; refresh is idempotent per language.
- The similarity model degrades gracefully: as the corpus grows, add block variants / new blocks (more real data dimensions) to keep the tail down — the corpus test is the regression guard.
