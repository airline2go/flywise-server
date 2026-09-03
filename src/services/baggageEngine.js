// ═══════════════════════════════════════════════════════════════
// src/services/baggageEngine.js
// [FARE-INTEL] The resolver that turns "what Duffel returned" + "what our
// verified fare rules say" into ONE canonical, per-type baggage answer the
// frontend can trust. It enforces the source hierarchy (spec §11):
//
//   LEVEL 1  Duffel offer-specific data        → source DUFFEL,   HIGH
//   LEVEL 2  verified airline FARE-specific rule → AIRLINE_FARE_RULE, HIGH/MEDIUM
//   LEVEL 3  general airline/cabin policy        → GENERAL_AIRLINE_POLICY, LOW
//            (never presented as a confirmed fact — "may vary by fare")
//   —        nothing                             → UNKNOWN
//
// The three primary baggage types (personal_item, cabin, checked) plus
// additional are resolved INDEPENDENTLY and never merged into one weight
// (spec §5-§8). Each result carries its own source + confidence + matched rule
// so a later audit can answer "why did Airpiv say 23 kg?" (spec §27).
//
// This module is pure/synchronous: the caller fetches the candidate rules
// (getFareRulesForAirline) and passes them in. Zero invented values — a type
// with no Duffel data and no matching rule comes back UNKNOWN, not a default.
// ═══════════════════════════════════════════════════════════════

const { SOURCE, CONFIDENCE, BAGGAGE_TYPE, isConfirmed } = require('../config/fareIntelligence');
const { matchBaggageRule } = require('./fareRules');

// Map a Duffel baggage entry's type to our canonical type. Duffel only emits
// carry_on / checked; personal items are never a Duffel type, so they can only
// come from a fare rule.
function duffelTypeToCanonical(t) {
  if (t === 'carry_on') return BAGGAGE_TYPE.CABIN;
  if (t === 'checked') return BAGGAGE_TYPE.CHECKED;
  return null;
}

function bagWeight(bag) {
  if (!bag) return null;
  if (bag.weight != null) return Number(bag.weight);
  if (bag.maximum_weight_kg != null) return Number(bag.maximum_weight_kg);
  return null;
}

// Build the LEVEL-1 (Duffel offer-specific) view keyed by canonical type from
// the raw Duffel baggage array found on a segment's passenger entry. Only real,
// offer-specific facts — quantity is what Duffel actually returned.
function duffelBaggageMap(bags) {
  const map = {};
  if (!Array.isArray(bags)) return map;
  for (const b of bags) {
    const type = duffelTypeToCanonical(b.type);
    if (!type) continue;
    const qty = b.quantity != null ? Number(b.quantity) : null;
    // Duffel telling us quantity 0 IS an offer-specific fact: this offer does
    // not include this bag (spec §8 "0 checked bags", TEST 6/10).
    map[type] = {
      included: qty != null ? qty > 0 : null,
      pieces: qty,
      weight_kg: bagWeight(b),
      dimensions: null,
    };
  }
  return map;
}

// Produce the canonical entry for ONE baggage type by layering the sources.
function resolveType(type, duffelEntry, ctx, rules, asOf) {
  // ── LEVEL 1: Duffel offer-specific. Duffel is the authority. ──────────
  if (duffelEntry) {
    const hasWeight = duffelEntry.weight_kg != null;
    // When Duffel confirms the bag is included but omits the weight, we may
    // enrich ONLY the missing weight from a fare rule — without ever changing
    // Duffel's included/pieces decision (spec §16: policy enriches, never
    // overrides). The included/pieces facts stay DUFFEL/HIGH.
    let weight = duffelEntry.weight_kg;
    let dimensions = duffelEntry.dimensions;
    let weightSource = SOURCE.DUFFEL;
    let weightConfidence = CONFIDENCE.HIGH;
    let matchedRuleId = null;
    let sourceUrl = null;

    if (!hasWeight && duffelEntry.included) {
      const rule = matchBaggageRule(type, ctx, rules, asOf);
      if (rule && rule.weight_kg != null) {
        weight = rule.weight_kg;
        // The weight is only as trustworthy as the fare match behind it.
        weightSource = rule.source;
        weightConfidence = rule.confidence;
        matchedRuleId = rule.matched_rule_id;
        sourceUrl = rule.source_url;
        if (rule.dimensions && !dimensions) dimensions = rule.dimensions;
      }
    }

    return finalize({
      type,
      included: duffelEntry.included,
      pieces: duffelEntry.pieces,
      weight_kg: weight,
      dimensions: dimensions || null,
      // The ENTRY's source reflects the strongest fact (the inclusion decision,
      // always from Duffel here); weight provenance is carried separately so an
      // enriched weight is never mistaken for a Duffel-confirmed one.
      source: SOURCE.DUFFEL,
      confidence: CONFIDENCE.HIGH,
      matched_rule_id: matchedRuleId,
      source_url: sourceUrl,
      weight_source: weightSource,
      weight_confidence: weightConfidence,
    });
  }

  // ── LEVEL 2/3: no Duffel data → fall back to verified fare rules. ─────
  const rule = matchBaggageRule(type, ctx, rules, asOf);
  if (rule) {
    return finalize({
      type,
      included: rule.included,
      pieces: rule.pieces,
      weight_kg: rule.weight_kg,
      dimensions: rule.dimensions,
      source: rule.source,
      confidence: rule.confidence,
      matched_rule_id: rule.matched_rule_id,
      source_url: rule.source_url,
      last_verified: rule.last_verified,
      effective_from: rule.effective_from,
      effective_until: rule.effective_until,
      weight_source: rule.source,
      weight_confidence: rule.confidence,
    });
  }

  // ── Nothing: UNKNOWN. We do NOT guess. ───────────────────────────────
  return finalize({
    type,
    included: null,
    pieces: null,
    weight_kg: null,
    dimensions: null,
    source: SOURCE.UNKNOWN,
    confidence: CONFIDENCE.UNKNOWN,
    matched_rule_id: null,
    weight_source: SOURCE.UNKNOWN,
    weight_confidence: CONFIDENCE.UNKNOWN,
  });
}

// Attach the derived `confirmed` flag and a stable shape. `confirmed` is what
// the frontend gates its "show as a fact vs. show as may-vary" decision on.
function finalize(entry) {
  return {
    type: entry.type,
    included: entry.included != null ? entry.included : null,
    pieces: entry.pieces != null ? entry.pieces : null,
    weight_kg: entry.weight_kg != null ? entry.weight_kg : null,
    dimensions: entry.dimensions || null,
    source: entry.source,
    confidence: entry.confidence,
    matched_rule_id: entry.matched_rule_id || null,
    source_url: entry.source_url || null,
    last_verified: entry.last_verified || null,
    effective_from: entry.effective_from || null,
    effective_until: entry.effective_until || null,
    // A weight enriched from a fare rule keeps its own, weaker provenance even
    // when the inclusion fact is HIGH from Duffel.
    weight_source: entry.weight_source || entry.source,
    weight_confidence: entry.weight_confidence || entry.confidence,
    // Presentable as a confirmed fact? (HIGH or MEDIUM). The weight is only
    // "confirmed" if BOTH the entry and the weight provenance are confirmed.
    confirmed: isConfirmed(entry.confidence),
    weight_confirmed: entry.weight_kg != null
      && isConfirmed(entry.weight_confidence || entry.confidence),
  };
}

// Main entry point. `ctx` = { airline, fareFamily, bookingClass, cabin }.
// `duffelBags` = the raw Duffel baggage array (segment passenger's `baggages`).
// `rules` = candidate airline_fare_rules rows for this airline.
// Returns { personal_item, cabin, checked, additional, meta }.
function resolveBaggage({ duffelBags = [], ctx = {}, rules = [], asOf = new Date() } = {}) {
  const dmap = duffelBaggageMap(duffelBags);

  const personal_item = resolveType(BAGGAGE_TYPE.PERSONAL_ITEM, dmap[BAGGAGE_TYPE.PERSONAL_ITEM], ctx, rules, asOf);
  const cabin = resolveType(BAGGAGE_TYPE.CABIN, dmap[BAGGAGE_TYPE.CABIN], ctx, rules, asOf);
  const checked = resolveType(BAGGAGE_TYPE.CHECKED, dmap[BAGGAGE_TYPE.CHECKED], ctx, rules, asOf);
  const additional = resolveType(BAGGAGE_TYPE.ADDITIONAL, dmap[BAGGAGE_TYPE.ADDITIONAL], ctx, rules, asOf);

  return {
    personal_item,
    cabin,
    checked,
    additional,
    meta: {
      ctx: {
        airline: ctx.airline || null,
        fareFamily: ctx.fareFamily || null,
        bookingClass: ctx.bookingClass || null,
        cabin: ctx.cabin || null,
      },
      resolvedAt: new Date(asOf).toISOString(),
      // Overall confidence for the offer's baggage = the weakest of the three
      // primary types that carry any assertion (so the card as a whole never
      // over-claims).
      hasAnyConfirmed: [personal_item, cabin, checked].some(e => e.confirmed),
    },
  };
}

module.exports = {
  resolveBaggage,
  duffelBaggageMap,
  duffelTypeToCanonical,
};
