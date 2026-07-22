# Programmatic SEO Content System

Enriches **existing** published route pages with genuinely useful, data-composed content at scale (designed for 100,000+ pages). It never creates new pages.

## Philosophy — value first, similarity is only a metric

The goal is **maximum user value, maximum information uniqueness, and world-class SEO quality** — to compete with Skyscanner/Kayak/Google Flights on *information*, not on text variation. A low similarity score is a *consequence* of saying more real, route-specific things, never the objective.

Concretely, the engine commits to these principles (see the header of `engine.js`):

1. **Never hide useful information to make pages look different.** Every block whose real data is present always renders.
2. **Structure emerges from data.** A data-rich route naturally gets a longer, richer page; a data-poor route gets a shorter one. Nothing is randomly suppressed or reordered.
3. **Ordering is deterministic and data-driven** — sections are ordered by data salience (an unusually cheap route surfaces its price analysis higher), not by a seed.
4. **Uniqueness comes from real facts, not wording tricks.** The seeded RNG only picks minor phrasing *within* a block; it never decides which information appears.
5. **Similarity is a health metric**, a canary for accidental templating — never an optimization target.
6. **Adding data sources is easy** (see "Adding a data source"): each new source is one enricher + one block, no rewrite.

## Governing rules (and how each is enforced)

| Rule | Enforcement |
|------|-------------|
| Never overwrite manual content | Generated content is written to dedicated `seo_*` columns; the human override columns (`custom_title`, `custom_meta_description`, `custom_faq`, `intro_text`) are never touched and always win at render time (`effectiveRouteSeo`). |
| Never hide useful data | `assembleSections` renders **every** applicable block (only omitting the one the intro already opened on); `assembleFaq` renders **every** applicable FAQ. No caps, no random subset. |
| Structure from data, not randomness | Section order = data-salience weight (deterministic); FAQ order = fixed usefulness ranking; opening angle = highest-scoring real dimension. The seed affects wording only. |
| Use all available data | Blocks read `distance_km`, `haul_type`, `airline_count`, `direct_flight_available`/`all_direct`/`stop_distribution`, `avg/min_duration_min`, `price_min/max/avg`, `price_trend`, `route_score`(+confidence), `itinerary_count`, domestic/international — and any dimension a future enricher adds. |
| No invented facts | Every number rendered comes from the route row. A block that needs absent data does not render. |
| Skip when data insufficient | Quality gate skips routes missing distance/cities/haul; skips are reported, never counted as failures, never filled with filler. |
| Similarity is a metric, not a target | `similarity.js` (city-neutralized k-shingle Jaccard) reports mean/p95/max; the test asserts only generous canary bounds to catch a regression into templating (mean < 0.35, max < 0.85) and that materially-different-data pages stay distinct. Same-bucket routes are *allowed* to read similarly — that is data-driven honesty. |

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
2. **Context** — the enricher pipeline normalizes every real field and bucketizes it (e.g. price → budget/moderate/premium *relative to haul type*; directness → all-direct / mostly-direct / mixed / connections-only from `stop_distribution`). Each dimension present is flagged in `ctx.facts`.
3. **Opening angle** — each candidate angle (price / duration / airport / airline / destination / traveler / business / family / weekend / seasonal) scores itself on how *distinctive* that dimension is for this route; the **highest scorer wins** (deterministic, tie-broken by a fixed order). A cheap route opens on price, a nonstop route on convenience, a many-airline route on competition.
4. **Sections** — **every** block whose real data exists renders, ordered by data-salience weight (deterministic). The only omission is the single block whose theme the intro already covered, to avoid immediate repetition. Richer routes therefore get more sections *because they have more to say*, not by design quota.
5. **FAQ** — **every** applicable question renders, in a fixed usefulness order; answers branch on the route's data.
6. **Title / meta** — chosen from data-aware variant pools (e.g. include price "ab X €" only when price data exists; say "Direktflüge" only when `all_direct`).

Deterministic per slug (stable for Google). `generateRoutePage` also returns `dataCoverage` — the list of real dimensions that drove the page — stored in `seo_data_coverage` for transparency.

### Dynamic SEO blocks

Section blocks today (all applicable ones render): **Overview**, **Price analysis**, **Airline analysis**, **Direct-vs-connection analysis**, **Booking strategy**, **Seasonal insights**, **Popularity/demand**, **Airport detail**. Each answers a real user question (When should I book? Is a direct flight available? Which airlines fly this? Is it cheaper at certain times? Is it good for a weekend?) — no keyword stuffing.

### Adding a data source (the extensibility contract)

The architecture is built so future data sources — historical prices, best booking periods, airport guides, alternative airports, baggage rules, visa requirements, transport options, tourism/seasonality, demand trends, travel tips — plug in **without a rewrite**. Two steps:

**1. Add an enricher** (in `compose.js` or a new module, registered via `registerEnricher`). It reads the route row and/or joined `sources` and adds fields + `facts`, only when the data is real:

```js
// e.g. a "best booking period" source computed from price history
registerEnricher((ctx, route, sources) => {
  if (sources.bookingWindow) {                 // joined data the batch layer fetched
    ctx.bestBookingMonth = sources.bookingWindow.cheapestMonth;
    ctx.facts.add('bookingWindow');            // now blocks/angles can require it
  }
});
```

**2. Add a block** to the language pack's `BLOCKS` (and/or `FAQ_CANDIDATES`) that consumes the new fact:

```js
{
  id: 'booking-window',
  applicable: (c) => c.facts.has('bookingWindow'),
  weight: () => 0.75,
  render: (c) => ({
    heading: 'Bester Buchungszeitraum',
    body: `Für ${c.o}–${c.d} lagen die günstigsten Tarife zuletzt im ${c.bestBookingMonth}.`,
  }),
}
```

The batch layer passes joined data through `generateRoutePage(route, lang, sources)`. Nothing in `engine.js` changes — the new block renders automatically whenever its data is present, and is skipped everywhere it isn't. This is how the page grows toward world-class depth over time: more real data sources → more sections → more unique information per page.

## Storage & render contract

Generated content lives in dedicated columns (`sql/seo_generated_content.sql`):
`seo_title`, `seo_meta_description`, `seo_intro_html`, `seo_faq`, `seo_angle`, `seo_section_count`, `seo_data_coverage`, `seo_lang`, `seo_generated_at`.

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
The tests assert the **value-first** goals, not a low number:
- Quality gate & manual protection.
- **Information completeness** — every applicable section/FAQ renders (nothing withheld); a data-rich route yields a strictly richer page than a data-poor one.
- Data-driven divergence (cheap-direct vs expensive-connecting read very differently).
- **Extensibility** — a registered enricher adds a new data dimension from `sources` with no core change.
- Determinism (stable per slug); angle variety across the corpus.
- Similarity **health check** — generous canary bounds only (catch a regression into templating; not a target).
- `effectiveRouteSeo` manual-wins resolution.

## Adding a language

Write an independent `blocks.<lang>.js` (native authoring, never literal translation of German), register it in `engine.js`'s `PACKS`. `supportedLanguages()` and the batch/CLI pick it up automatically. Until then, that language is skipped rather than served machine-translated thin content.

## Scaling to 100k+ pages and toward world-class depth

- Composition is O(1) per page and pure (no I/O); batching writes in groups of 50 with a short pause.
- Only `seo_*` columns are written; refresh is idempotent per language.
- **The path to competing on information quality is adding data sources, not tuning wording.** Each new enricher + block (historical prices, booking windows, airport guides, alternative airports, baggage, visa, transport, tourism, seasonality, demand trends) makes every eligible page deeper and more unique automatically. Similarity falls out as a side effect; it is never the objective.
