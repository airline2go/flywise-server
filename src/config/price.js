// ═══════════════════════════════════════════════════════════════
// src/config/price.js
// [PRICE-SNAPSHOT] Single source of truth for how a route "from" price is
// defined, how fresh it must be to count as *live*, and the fixed assumptions
// every displayed price is quoted under. Every price the frontend shows —
// hero, meta description, average, FAQ, JSON-LD Offer — must trace back to a
// snapshot built here. No component may compute, age, or re-label a price on
// its own. Changing the freshness window is a one-line, one-place edit (or an
// env override), and it governs BOTH "is this live?" and "serve fresh vs
// revalidate", so the two can never drift apart again.
// ═══════════════════════════════════════════════════════════════

// [CENTRAL-TTL] The single freshness/TTL knob. A price is "live" only while it
// is younger than this; a cached price older than this is served stale-while-
// revalidate and must never be presented as live. Overridable from the env
// (Render) without a code change; defaults to 24h — long enough that a route
// priced once a day never flips to "not live" between refreshes, short enough
// that a "live" claim is honest. Replaces the hard-coded 12h that used to live
// inline in /route-price.
const FRESHNESS_HOURS = Number(process.env.PRICE_FRESHNESS_HOURS) > 0
  ? Number(process.env.PRICE_FRESHNESS_HOURS)
  : 24;
const PRICE_FRESHNESS_MS = FRESHNESS_HOURS * 60 * 60 * 1000;

// [FIXED-ASSUMPTIONS] The exact basis every route "from" price is quoted on —
// mirrors the Duffel offer_request in fetchAndCacheRoutePrice (one slice = one
// way, one adult passenger, economy cabin). Exposed so the frontend renders
// these verbatim and can never imply a different basis (e.g. round-trip) for
// one part of the page than another.
const PRICE_ASSUMPTIONS = Object.freeze({ tripType: 'one-way', passengers: 1, cabin: 'economy' });

// True iff `checkedAt` is within the single central freshness window.
// Pure and side-effect-free so both the server and its tests agree exactly.
function isPriceLive(checkedAt, now = Date.now()) {
  if (!checkedAt) return false;
  const t = new Date(checkedAt).getTime();
  if (!Number.isFinite(t)) return false;
  const age = now - t;
  return age >= 0 && age <= PRICE_FRESHNESS_MS;
}

// Build the canonical price snapshot returned to the frontend. `source` records
// where THIS value came from: 'live' (just fetched from Duffel), 'cache' (fresh
// cache hit), 'stale-cache' (served stale while a background refresh runs), or
// 'none' (no price available). `isLive` is ALWAYS derived here from checkedAt
// against the central TTL — never passed in — so a stale value can never be
// tagged live by a careless caller. `offersCount` is the route-specific number
// of itineraries compared in the priced search (the honest, per-route trust
// figure that replaces the site-wide daily counter).
function buildPriceSnapshot(input = {}, now = Date.now()) {
  const { price = null, currency = null, checkedAt = null, source = 'none', offersCount = null } = input;
  const hasPrice = price != null && Number.isFinite(Number(price));
  return {
    price: hasPrice ? Number(price) : null,
    currency: hasPrice ? (currency || 'EUR') : null,
    checkedAt: checkedAt || null,
    source,
    offersCount: offersCount == null ? null : Number(offersCount),
    tripType: PRICE_ASSUMPTIONS.tripType,
    passengers: PRICE_ASSUMPTIONS.passengers,
    cabin: PRICE_ASSUMPTIONS.cabin,
    isLive: hasPrice ? isPriceLive(checkedAt, now) : false,
    freshnessMs: PRICE_FRESHNESS_MS,
  };
}

module.exports = {
  PRICE_FRESHNESS_MS,
  PRICE_FRESHNESS_HOURS: FRESHNESS_HOURS,
  PRICE_ASSUMPTIONS,
  isPriceLive,
  buildPriceSnapshot,
};
