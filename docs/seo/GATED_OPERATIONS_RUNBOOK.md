# SEO — gated operations runbook

All SEO code changes are shipped through reviewed PRs. Production data/indexing changes remain deliberately gated.

---

## A. Current production SEO state — VERIFIED

**Audit date: 2026-09-17**

- **1,753** published route pages in the current catalogue.
- The controlled SEO recovery cohort is **70 versioned core routes** in `src/services/seoRouteCore.js`.
- **70/70 core routes are published and have verified flight evidence in the current database audit.**
- **70/70 core routes have fresh route insights** within the 30-day operational freshness window.
- **70/70 core routes currently have stale-or-missing generated SEO relative to the latest operational/pricing timestamps.** The generated-copy refresh guard is deployed, but the production batch has **not** been run.
- Across the full published catalogue, **1,752 of 1,753 routes currently have stale generated SEO timestamps**. This is why broad batch generation is explicitly prohibited during recovery.
- No route rows were created or restored as part of this recovery work.

The earlier 2,063-route / 317-route and 1,746-route figures in older versions of this document were stale and must not be used for operational decisions.

## B. Evidence-policy and demand-gate state — VERIFIED / GATED

The strict indexability policy is implemented in `src/services/indexability.js` and is shared by route rendering, public route lists, and sitemap feeds.

- Verified flight evidence is required when the evidence policy is enforced.
- The current recovery runtime uses the **70-route core fence** for the SEO batch writer.
- Current core database signals show **51/70** core routes with the demand signal defined by `route_score >= 0.2` or `weekly_flights > 0`.
- `weekly_flights` is currently null across the audited core set, so the live demand signal currently comes from `route_score`.
- Routes without the demand signal may remain `200 + noindex` during the gated recovery phase; this is an indexability decision, not a routing error.
- Do not disable or weaken the demand/evidence gates merely to increase sitemap size.

Before changing either `SEO_EVIDENCE_POLICY_ENFORCED` or `SEO_ROUTE_DEMAND_GATE`, verify backend and frontend runtime configuration and run a production render/sitemap parity check.

## C. Core-only SEO batch — DONE / SAFE BY DEFAULT

`src/services/seoBatchProcessor.js` now fences batch processing to the versioned 70-route cohort by default through `seoRouteCore.js`.

- Normal batch processing no longer targets the whole 1,753-route catalogue.
- Stale generated copy can be refreshed without `force` once a batch is explicitly started.
- Manual editorial fields are not overwritten; generation writes only the dedicated `seo_*` columns.
- The batch remains protected by the existing eligibility and deterministic quality gates.
- Readiness statistics remain catalogue-wide for monitoring, while writes are core-only by default.

**Operational rule:** never run a broad batch for this recovery. The intended production operation is an authenticated `dry_run` for the core cohort first, followed by the same core-only batch after the preview is accepted.

## D. Sitemap parity — DONE / VERIFIED

The sitemap route feed uses the same canonical `routeIndexable()` policy as route rendering.

- The route sitemap selector now includes the demand inputs (`route_score`, `weekly_flights`) required by the canonical demand gate.
- Sitemap paging remains explicit and bounded by the raw row count so filtered pages do not terminate pagination early.
- The frontend recovery sitemap remains core-only and excludes explicit noindex core routes.
- A route being absent from `sitemap-routes.xml` is expected when the canonical indexability verdict is false.

## E. Duplicate route-pair policy — DONE / VERIFIED

The published route-pair uniqueness work is complete. Exact duplicate airport-pair URLs are handled by the canonical/redirect policy; genuine multi-airport city-pair routes remain distinct and receive qualified localized SEO content where required.

Do not use `--force` regeneration casually; any regeneration must pass the existing SEO quality gate.

## F. Route-price SEO safety — DONE / VERIFIED

Route-page indicative pricing follows the user-visit refresh architecture:

- crawlers/bots remain cache-only and must not trigger Duffel searches;
- a real browser visit can trigger a fresh route-price search;
- concurrent real visitors share one in-flight request;
- live failures fall back to the stored indicative price;
- no time-based refresh is introduced by this SEO flow.

Do not trigger Duffel searches as part of SEO generation or crawler audits.

## G. Production verification checklist

Run after relevant deployments:

- Route: `200` + self-canonical + correct locale metadata + `index,follow` when indexable.
- Core route with an active noindex verdict: `200 + noindex,follow`, absent from sitemap, with no hreflang block emitted.
- Exact duplicate loser: persistent redirect to the canonical airport-pair URL.
- Localized route: reciprocal hreflang set and locale-specific title/meta when indexable.
- Sitemap: index + every child `200` + valid XML; use the repository sitemap audit script.
- API: `robots.txt` remains disallowed for crawl/indexing and API responses retain intended robots headers.
- Entity pages: sitemap membership matches renderer indexability.
- Runtime logs: investigate unexpected `5xx`; expected Bot Guard `403` and stale/external `404` traffic are not themselves route-rendering failures.

## H. Current recovery sequence

1. Keep the 70-route core frozen.
2. Use the authenticated admin SEO batch endpoint in `dry_run` mode; verify the result stays at the 70-route core and records quality skips instead of inventing content.
3. Run the same core-only batch without `force` to refresh stale generated copy that passes the existing eligibility and quality gates.
4. Re-check the database for the core stale count and sample representative routes across indexable/noindex outcomes.
5. Rebuild/revalidate affected route pages and verify the core sitemap against live robots/canonical output.
6. Monitor Search Console after its normal reporting delay; do not interpret same-day data as SEO impact.
7. Keep the core frozen until the recovery cohort remains stable; any expansion must be a reviewed 10–20 route change backed by current evidence.

## I. Deferred / out of current SEO scope

- Blog expansion/listing work is intentionally deferred.
- Finance/security migrations are separate work and must not be bundled with SEO.
- No route deletion/restoration is part of this SEO continuation.
