# SEO — gated operations runbook (need owner approval to execute)

All SEO code/audits are shipped and merged. The steps below change production
data / URLs / indexing and are deliberately left for the owner to run in order.
Each is one approval away.

---

## A. Flight-data backfill (fills airline_count from real Duffel offers)
**Why:** 182 published routes are distance-only. Most (176) were never
health-checked/backfilled — likely real routes missing data (e.g. `ams-auh`,
`arn-hel`), not dead. Backfill first, kill nothing prematurely.

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

## B. Re-run the 182 report, then flip (only after A)
1. Re-run the evidence query (see `flywise-app/docs/seo/P0-1_indexability_report.md`)
   to get the NEW count of routes with still zero verified evidence.
2. Review that shortened list with the owner (buckets A–E).
3. Enable the policy: set env **`SEO_EVIDENCE_POLICY_ENFORCED=1`** on the backend
   (and the app, for the renderer) and redeploy. This is the ONLY switch — the
   code is already merged and defaults OFF. It flips exactly the routes with no
   verified evidence to `noindex` and drops them from the sitemap; URLs are kept.
   Rollback: unset the env var and redeploy.

## C. Delete the 10 duplicate losers + add the unique constraint (P1-1)
Safe now: the 10 losers have persistent 301s (P0-4), so deleting the rows keeps
the old URLs redirecting.
1. Verify preconditions:
   ```sql
   -- every redirect source has a published target:
   SELECT count(*) FROM route_redirects r
   WHERE NOT EXISTS (SELECT 1 FROM route_pages p WHERE p.slug=r.target_slug AND p.status='published');
   -- expect 0
   ```
2. Apply `flywise-server/sql/seo_p1_1_route_pair_unique.sql` (deletes losers in a
   guarded way, asserts 0 remaining published-pair dups, adds the partial unique
   index). It aborts itself if anything is off.
3. Confirm: `SELECT count(*) FROM (…published pair dups…)=0` and the old loser
   URLs still 301 (spot-check e.g. `/flights/ams-vie`).

## D. Finance / security migrations (P2-9) — SEPARATE PR, out of SEO scope
Live check found these are **NOT in production**: `webhook_events`,
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
  still 301 after the loser row is deleted (C).
- Blog post: 200; alternates reciprocal; x-default → de.
- Sitemap: index + every child 200 + valid XML; run `scripts/audit-sitemap.mjs --base=https://airpiv.com`.
- API: `api.airpiv.com/robots.txt` = Disallow:/ ; responses carry `X-Robots-Tag: noindex,nofollow`.
- Entity (airport): sitemap membership == renderer indexability (P0-10 feed).
