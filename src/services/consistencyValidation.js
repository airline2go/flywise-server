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

// [FARE-INTEL §26] Invariants a resolved baggage entry must satisfy before the
// frontend is allowed to render it as a confirmed fact. Pure checker over ONE
// baggage entry (personal_item / cabin / checked / additional) as produced by
// baggageEngine.resolveBaggage(). Returns an array of { code, detail }; empty
// means consistent. Catches the review's asks: a value shown as "included"
// must have a real source and a non-UNKNOWN confidence; pieces >= 0;
// weight_kg > 0 when present; a UNKNOWN entry must not carry a confirmed weight.
const { isValidSource, isValidConfidence, isConfirmed, SOURCE, CONFIDENCE } = require('../config/fareIntelligence');

function checkBaggageEntry(entry = {}, label = 'baggage') {
  const issues = [];
  if (!entry || typeof entry !== 'object') return issues;

  if (entry.source && !isValidSource(entry.source)) {
    issues.push({ code: 'baggage-bad-source', detail: `${label}: unknown source ${entry.source}` });
  }
  if (entry.confidence && !isValidConfidence(entry.confidence)) {
    issues.push({ code: 'baggage-bad-confidence', detail: `${label}: unknown confidence ${entry.confidence}` });
  }

  // §26.6/§26.7: anything presented as confirmed-included must have a real
  // source and a non-UNKNOWN confidence.
  if (entry.confirmed === true) {
    if (!entry.source || entry.source === SOURCE.UNKNOWN) {
      issues.push({ code: 'baggage-confirmed-without-source', detail: `${label}: confirmed but source is missing/UNKNOWN` });
    }
    if (entry.confidence === CONFIDENCE.UNKNOWN || entry.confidence === CONFIDENCE.LOW) {
      issues.push({ code: 'baggage-confirmed-low-confidence', detail: `${label}: confirmed but confidence=${entry.confidence}` });
    }
  }

  // §26.9: pieces never negative.
  if (entry.pieces != null && !(Number(entry.pieces) >= 0)) {
    issues.push({ code: 'baggage-negative-pieces', detail: `${label}: pieces=${entry.pieces}` });
  }
  // §26.10: a present weight must be > 0.
  if (entry.weight_kg != null && !(Number(entry.weight_kg) > 0)) {
    issues.push({ code: 'baggage-nonpositive-weight', detail: `${label}: weight_kg=${entry.weight_kg}` });
  }
  // A weight can only be "weight_confirmed" if its own provenance is confirmed.
  if (entry.weight_confirmed === true && !isConfirmed(entry.weight_confidence)) {
    issues.push({ code: 'baggage-weight-overclaim', detail: `${label}: weight_confirmed but weight_confidence=${entry.weight_confidence}` });
  }
  return issues;
}

// Check the whole resolved baggage object (all four types) at once.
function checkOfferBaggage(baggage = {}) {
  const issues = [];
  for (const key of ['personal_item', 'cabin', 'checked', 'additional']) {
    if (baggage[key]) issues.push(...checkBaggageEntry(baggage[key], key));
  }
  return issues;
}

module.exports = { checkRouteConsistency, checkBaggageEntry, checkOfferBaggage };
