# RCA — Route-data quality: zero-line routes, duplicate records, and `-N` slugs

**Date:** 2026-09-04 · **Author:** Claude Code (session) · **Scope:** `route_pages`,
`route_airlines`, route generation + slug logic in `src/routes/admin.routes.js`.

This RCA covers the three related route-data defects surfaced by the flywise-app
SEO work (plan phases P0-4 / P0-5). It is **evidence + root cause only** — no
migration is executed here. Every proposed fix ships as its own small, reversible
change with a **dry-run first** (per the recovery plan's phase 4/5 and safety
rules #2/#3: no mass delete/noindex without a documented, testable policy).

The frontend already ships **symptom mitigations** that are correct and must stay
until the backend root cause is fixed: P0-28 (canonical-consolidate exact
duplicates), P0-29 (airport-qualify colliding titles). Those do **not** fix the
data; this document is the plan to fix the data.

---

## 1. Evidence (from the live DB, 2026-09-04)

| Metric | Value |
| --- | --- |
| `route_pages` total | 2347 |
| Routes with `airline_count = 0` | **595** |
| …of those, having ANY row in `route_airlines` (for their IATA pair) | **0** |
| Distinct airport pairs with >1 route record (exact duplicates) | **11** groups / 22 rows |
| Slugs matching `-[0-9]+$` | 26 |
| Routes whose `status <> 'published'` | 0 (every route is `published`) |

Key derived facts:

- **Category A is empty.** Not a single zero-line route has airline rows that
  merely fail to reach the frontend — so this is **not** an API/pipeline gap.
  The airline data is genuinely **absent** in `route_airlines`.
- `airports` table holds only **52** rows, while `route_pages` references far
  more airports. Many *major* airports (HEL, MXP, NCE, KWI, JED, OSL, MAN, BUD)
  are **absent** from `airports`. So "airport not in `airports`" is **not** a
  reliable served/unserved signal — presence in `route_airlines` is.

### Zero-line classification (595), by whether each endpoint is EVER served

| Category | Count | Meaning | Example airports |
| --- | --- | --- | --- |
| **C — unserved airport** | **275** | ≥1 endpoint never appears in `route_airlines` at all | XFW (83), DWC (78), NRN (42), KSF (42), TOJ (34) |
| **D — real airports, this pair has no flights** | **320** | both endpoints are served elsewhere, but this specific pair has no `route_airlines` rows | HEL, MXP, NCE, KWI, JED, OSL, MAN, BUD |
| **A — data present, not reaching FE** | **0** | — | — |

### The 11 exact-duplicate groups (same `origin_iata`,`destination_iata`)

Each is a **city-name slug** + an **IATA-pair slug** for the *same* pair with the
*same* `airline_count` — i.e. one route stored twice under two naming schemes:

| Pair | Winner (keep) | Loser (consolidate) | airline_count |
| --- | --- | --- | --- |
| AMS-VIE | `amsterdam-vienna` | `ams-vie` | 17 / 17 |
| AMS-ZRH | `amsterdam-zuerich` | `ams-zrh` | 17 / 17 |
| DUB-ZRH | `dublin-zuerich` | `dub-zrh` | 13 / 13 |
| FRA-BER | `frankfurt-berlin` | `fra-ber` | 15 / 15 |
| FRA-PMI | `frankfurt-palma-de-mallorca` | `fra-pmi` | 17 / 17 |
| IST-LHR | `istanbul-london` | `ist-lhr` | 17 / 17 |
| LIS-ZRH | `lisbon-zuerich` | `lis-zrh` | 21 / 21 |
| MAD-BER | `madrid-berlin` | `mad-ber` | 20 / 20 |
| MAD-ZRH | `madrid-zuerich` | `mad-zrh` | 18 / 18 |
| PMI-MUC | `palma-de-mallorca-munich` | `pmi-muc` | 19 / 19 |
| XFW-BER | `hamburg-berlin` (0) | `xfw-ber` (null) | **special — see §2.3** |

---

## 2. Root causes

### 2.1 Duplicate records (11) — two competing slug schemes for the same pair

`admin.routes.js` builds a route slug **two different ways**:

- **Bulk create** (`POST /admin/route-pages/bulk`, ~line 1008): IATA-based —
  `baseSlug = (oCode + '-' + dCode).toLowerCase()` → `ams-vie`.
- **Single create** (`POST /admin/route-pages`, ~line 393) and the
  `routePages.js` service: city-name-based via `slugify(seo.title)` →
  `amsterdam-vienna`.

The same airport pair created through both paths yields **two rows** with two
slugs. Neither path checks for an existing row on the *IATA pair* (only on the
*slug*), so the pair-level duplicate slips through. **This is the root cause of
the 11 duplicate groups.**

### 2.2 `-N` suffix slugs (26) — city-name slugs collide across airports

The single-create/`slugify` path derives the slug from **city names**, so two
*different* airport pairs that share a city pair collide, and the loop
`while (usedSlugs.has(slug)) slug = baseSlug + '-' + (n++)` appends `-2`, `-3`:

- `frankfurt-hamburg` (FRA-HAM) vs `frankfurt-hamburg-2` (FRA-**XFW**) vs
  `frankfurt-hamburg-3` (FRA-HAM again / another).

These are **not duplicates** — they are distinct airport pairs. The defect is
that a city-name slug cannot express *which* airport, so the suffix is assigned
non-deterministically. **P0-29 already differentiates their titles by airport;**
the data fix is to make slug generation airport-aware (or deterministic) so the
descriptive slug maps to a stable airport.

### 2.3 595 zero-line routes — generated without a flights check, never reaped

- Route generation inserts a page for **every** `(origin, destination)` pair fed
  to it, **without verifying real flights exist**. `route_airlines` is populated
  from a *separate* source (Duffel live search), so any generated pair the flight
  source doesn't cover has **zero** airline rows → a zero-line route.
- A reaper exists (`POST /admin/route-pages/health-check-batch`): it asks Duffel
  per route and flips dead routes to `status='dead'` (which hides them from
  visitors, since the public endpoint filters `status='published'`). But it only
  processes `last_health_check_at IS NULL` routes in **batches of 10**, driven by
  repeated **manual** frontend calls — so it **never finished** over all 595.
- Bulk-create defaults to `status:'draft'`, but the `routePages.js` service
  inserts `status:'published'` directly, and every one of the 595 is
  `published` — so they are live and indexable despite having no flights.
- ⚠️ The reaper's per-route Duffel call is exactly the kind of expensive
  backend-render load implicated in the 2026-08-18 crawler-CPU incident. Any
  cleanup that re-checks routes live must be rate-limited and off the hot path.

**Special case (XFW-BER):** the descriptive slug `hamburg-berlin` was assigned to
**XFW**-BER (Hamburg-Finkenwerder → Berlin, a zero-line unserved pair), while the
real HAM-BER pair got `hamburg-berlin-2`. This shows the slug↔airport mapping is
non-deterministic (§2.2) *and* that an unserved airport (§2.3) can capture the
clean slug. It should be handled in the Category-C pass, and the clean slug
reassigned to the served HAM-BER pair.

---

## 3. Correct backend fixes (each = its own PR, dry-run first, reversible)

| # | Target | Fix | Migration? | Dry-run output before running |
| --- | --- | --- | --- | --- |
| F1 | **Duplicates (11)** | Keep the city-name winner; delete the IATA-pair loser; add a 301 redirect loser→winner; drop loser from sitemap (already dropped by P0-28). | Yes (delete 11 rows) | List the 11 loser rows + confirm each winner is self-canonical live. |
| F2 | **Category C (275)** | Policy: an airport with **zero** `route_airlines` rows anywhere is unserved → set its routes `status='dead'` (hides + de-indexes). Reassign any clean slug held by an unserved airport to its served sibling (e.g. XFW-BER→HAM-BER). | Yes (status flip ~275) | List the 275 rows grouped by airport; confirm none has any `route_airlines` row. |
| F3 | **Category D (320)** | Do **not** noindex blindly (rule #3). Backfill `route_airlines` from the flights source for these real pairs; a pair still empty after backfill is a candidate for a *documented* noindex policy, decided separately. | Backfill job + optional later status flip | Count how many of 320 gain airlines after a bounded backfill run. |
| F4 | **Slug generation** | Make the generator deterministic + airport-aware: one scheme (prefer city-name with an airport qualifier on collision), and dedupe on the **IATA pair**, not just the slug, so §2.1 cannot recur. | Code change (no data migration) | Unit test: two paths for one pair yield one row; a city collision yields a stable, airport-qualified slug. |

**Ordering:** F1 (safe, tiny) → F2 (policy-gated, dry-run) → F4 (prevents
recurrence) → F3 (data backfill, largest, last). None is a mass change without a
reviewed dry-run.

## 4. Rollback

- F1: re-insert the 11 loser rows from the dry-run snapshot; remove the redirects.
- F2: flip the affected routes back to `status='published'` (keep the dry-run
  id list as the exact undo set).
- F3: backfill is additive; a bad backfill row is deletable by `first_seen_at`
  batch. A later noindex is a status flip, reversible like F2.
- F4: revert the commit; existing rows are unaffected.

## 5. What is explicitly NOT done here

- No rows deleted or status-changed by this document.
- No URLs changed. F1's redirects and F2's de-indexing are separate, reviewed PRs.
- No mass noindex of Category D on the assumption it is junk (rule #3).
