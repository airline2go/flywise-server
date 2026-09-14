# SEO — gated operations runbook (need owner approval to execute)

All SEO code/audits are shipped and merged. The steps below change production
data / URLs / indexing and are deliberately left for the owner to run in order.
Each is one approval away.

---

## A. Flight-data backfill (fills airline_count from real Duffel offers)
**Current state (2026-09-14):** 2,063 published routes. Of these, 317 currently
have `airline_count = 0`; 139 of those already have other hard flight evidence
(duration / stops / itinerary), while 178 have no hard flight evidence at all.
Do the Duffel backfill before any indexability flip — kill nothing prematurely.

**How (operational — admin endpoint, Duffel-backed):** repeatedly POST
`/admin/route-pages/backfill-airlines-batch` (admin auth) until `remaining` = 0.
It is bounded (10/run), rate-limited (2 concurrent, 0.5s gaps), never marks a
route dead, and now (P1-2) revalidates affected pages per batch.
```
# pseudo-loop (ops runs against production api with the admin token)
while :; do
  r=$(curl -sS -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
        https://api.airpiv.com/admin/route-pages/backfill-airlines-batch)
  echo "$r"; echo "$r" | grep -q '"remaining":0' && break; sleep 2
done
```
Also run the P0-3-safe health-check the same way
(`/admin/route-pages/health-check-batch`) — multi-date, streak-based, never dead
on one empty date or an API error.

## B. Re-run the evidence report, then flip (only after A)
1. Re-run the evidence query (see `flywise-app/docs/seo/P0-1_indexability_report.md`)
   to get the NEW count of routes with still zero verified evidence.
2. Review that shortened list with the owner (buckets A–E).
3. Enable the policy: set env **`SEO_EVIDENCE_POLICY_ENFORCED=1`** on the backend
   (and the app, for the renderer) and redeploy. This is the ONLY switch — the
   code is already merged and defaults OFF. It flips exactly the routes with no
   verified evidence to `noindex` and drops them from the sitemap; URLs are kept.
   Rollback: unset the env var and redeploy.

## C. Duplicate published route pairs (P1-1) — DONE / VERIFIED
The guarded migration `sql/seo_p1_1_route_pair_unique.sql` was already applied.
Production now has **0 published pair duplicates** and the partial unique index
`uq_route_pages_published_pair` is present. The 10 loser URLs retain persistent
301 redirects through `route_redirects`.

No further production migration is required for C.

## D. Finance / security migrations (P2-9) — SEPARATE PR, out of SEO scope
Live check found these are NOT in production: `webhook_events`,
`booking_idempotency`, `payment_ledger`, and the promo atomic-increment RPC
(SQL files exist in `flywise-server/sql/`). Apply them in a dedicated,
reviewed finance/security PR (not mixed with SEO), then re-verify RLS + indexes
+ required RPCs. Do NOT bundle with the SEO deploy.

## E. P0-5 full blog listings (needs the A/B/C decision)
- **A (recommended):** server-render `/blog` (German) with crawlable `<a>` links
  + `301 /blog.html → /blog` via the persistent-redirect mechanism; optionally
  `/it/blog` (1 post). No empty listings for the 6 zero-post languages.
- **B:** keep `/blog.html`, make its article links crawlable via a build step.
- **C:** ship only the already-merged broken-hreflang fix.
Choose one; then P2-5 (crawlable blog listing) is covered by A/B.

---
### Production verification checklist (run after B/C)
- Route (data-backed): 200 + self-canonical + `index,follow`.
- No-evidence route (post-flip): `noindex,follow` + absent from sitemap; URL still 200.
- Duplicate loser: `/flights/ams-vie` → 301 → `/flights/amsterdam-vienna` (200);
  still 301 after the loser row was deleted (C).
- Blog post: 200; alternates reciprocal; x-default → de.
- Sitemap: index + every child 200 + valid XML; run `scripts/audit-sitemap.mjs --base=https://airpiv.com`.
- API: `api.airpiv.com/robots.txt` = Disallow:/ ; responses carry `X-Robots-Tag: noindex,nofollow`.
- Entity (airport): sitemap membership == renderer indexability (P0-10 feed).
