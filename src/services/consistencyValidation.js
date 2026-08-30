// ═══════════════════════════════════════════════════════════════
// src/services/consistencyValidation.js
// [CONSISTENCY-GUARD] Central invariants a route page must satisfy before its
// data is trusted, so contradictions are caught by the system instead of by a
// human reading the live page. Pure checker (no I/O) → unit-testable, and
// callable from a periodic job, a CLI, or a pre-publish hook. Returns an array
// of { code, detail } violations; an empty array means consistent.
//
// Covers the review's P1 validation asks:
//   • airline_count            === unique route_airlines
//   • displayed price          === canonical price
//   • live === true            ⇒ checkedAt within the central freshness TTL
//   • stop_distribution buckets sum to a positive total when present
// ═══════════════════════════════════════════════════════════════

const { isPriceLive } = require('../config/price');

// route: a route_pages-shaped object. ctx carries the values only known at
// display/compute time: uniqueRouteAirlines (distinct route_airlines count),
// displayedPrice / canonicalPrice, and live / checkedAt for the shown price.
function checkRouteConsistency(route = {}, ctx = {}) {
  const issues = [];

  if (route.airline_count != null && ctx.uniqueRouteAirlines != null
      && Number(route.airline_count) !== Number(ctx.uniqueRouteAirlines)) {
    issues.push({
      code: 'airline-count-mismatch',
      detail: `airline_count=${route.airline_count} but unique route_airlines=${ctx.uniqueRouteAirlines}`,
    });
  }

  if (ctx.displayedPrice != null && ctx.canonicalPrice != null
      && Number(ctx.displayedPrice) !== Number(ctx.canonicalPrice)) {
    issues.push({
      code: 'price-mismatch',
      detail: `displayed price=${ctx.displayedPrice} but canonical price=${ctx.canonicalPrice}`,
    });
  }

  if (ctx.live === true && !isPriceLive(ctx.checkedAt)) {
    issues.push({
      code: 'live-but-stale',
      detail: `live=true but checkedAt=${ctx.checkedAt} is older than the freshness TTL`,
    });
  }

  const sd = route.stop_distribution;
  if (sd && typeof sd === 'object') {
    const total = Object.values(sd).reduce((s, v) => s + Number(v || 0), 0);
    if (!(total > 0)) issues.push({ code: 'stop-distribution-empty', detail: 'stop_distribution has no positive total' });
  }

  return issues;
}

module.exports = { checkRouteConsistency };
