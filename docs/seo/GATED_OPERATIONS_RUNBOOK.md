# SEO — gated operations runbook

All SEO code changes are shipped through reviewed PRs. Production data/indexing changes remain deliberately gated.

---

## A. Current production SEO state — VERIFIED

**Audit date: 2026-09-15**

- **1,746** published route pages.
- **0** published routes missing German title/meta/intro/FAQ.
- **1,746** localized rows in each supported secondary locale: `en`, `fr`, `es`, `it`, `nl`, `tr`, `ar`.
- **0** missing localized title/meta/intro/FAQ rows in those seven locales.
- **0** duplicate localized SEO-title groups after the multi-airport disambiguation fix.
- **0** published routes currently failing the strict verified-evidence/manual-content audit.
- **0** routes are scheduled for deletion or restoration as part of this SEO work.
- **Polish is not a supported/generated locale.**

The earlier 2,063-route / 317-route figures in this document were stale and must not be used for operational decisions.

## B. Evidence-policy flip — NOT YET ENABLED

The strict policy is implemented in `src/services/indexability.js` and defaults OFF.

Before enabling `SEO_EVIDENCE_POLICY_ENFORCED=1`, verify both backend and frontend runtime configuration and perform a production render/sitemap parity check. Do not enable it merely because the database audit is clean.

Current database audit shows:

- published routes: **1,746**
- strict no-evidence routes: **0**
- projected indexability drop from the strict evidence gate: **0 routes**

Therefore no evidence backfill is currently required for the existing published set. The policy switch is still a separate deployment decision and has not been assumed enabled.

## C. Duplicate route-pair policy — DONE / VERIFIED

The published route-pair uniqueness work is complete. Exact duplicate airport-pair URLs are handled by the canonical/redirect policy; genuine multi-airport city-pair routes remain distinct and now receive qualified localized SEO content where required.

The localized SEO generator now prevents recurrence of same-city-pair title/meta collisions by qualifying the varying airport endpoint. Do not use `--force` regeneration casually; any regeneration must pass the existing SEO quality gate.

## D. Route-price SEO safety — DONE / VERIFIED

Route-page indicative pricing follows the user-visit refresh architecture:

- crawlers/bots remain cache-only and must not trigger Duffel searches;
- a real browser visit can trigger a fresh route-price search;
- concurrent real visitors share one in-flight request;
- live failures fall back to the stored indicative price;
- no time-based refresh is introduced by this SEO flow.

Do not trigger Duffel searches as part of SEO generation or crawler audits.

## E. Production verification checklist

Run after relevant deployments:

- Route: `200` + self-canonical + correct locale metadata + `index,follow` when indexable.
- Strict no-evidence route, if one ever exists after the policy flip: `noindex,follow`, absent from sitemap, URL remains `200`.
- Exact duplicate loser: persistent redirect to the canonical airport-pair URL.
- Localized route: reciprocal hreflang set and locale-specific title/meta.
- Sitemap: index + every child `200` + valid XML; use the repository sitemap audit script.
- API: `robots.txt` remains disallowed for crawl/indexing and API responses retain the intended robots headers.
- Entity pages: sitemap membership must match renderer indexability.

## F. Deferred / out of current SEO scope

- Blog expansion/listing work is intentionally deferred.
- Finance/security migrations are separate work and must not be bundled with SEO.
- No route deletion/restoration is part of this SEO continuation.
