// ═══════════════════════════════════════════════════════════════
// src/services/fareRules.js
// [FARE-INTEL] The Rule Engine matching layer. Given a fare CONTEXT
// (airline + fare family + booking class + cabin, whatever the offer actually
// specifies) and a set of candidate rules, it walks a precision ladder and
// returns the single best rule for a baggage type, tagged with the confidence
// that match precision earns.
//
// This module is PURE and I/O-free (no DB, no network) so it is fully unit-
// testable and the same logic runs in tests, a CLI, or a request. Fetching the
// candidate rows from Supabase is done by the caller (baggageEngine.js) and
// handed in here as a plain array.
//
// Matching precision → confidence (spec §12, §13):
//   1. airline + fare_family + booking_class + cabin  → HIGH
//   2. airline + fare_family + cabin                  → HIGH
//   3. airline + booking_class + cabin                → MEDIUM
//   4. airline + cabin        (no fare identified)    → LOW   (general policy)
//   5. no match                                       → UNKNOWN
//
// The golden rule (spec §12): NEVER fall back to a less precise match when the
// fare family IS known but a rule for it is not — inferring Economy-Classic's
// 23 kg for an Economy-Light offer would mislead. So once we know the fare
// family, a general (airline+cabin, family-less) rule for a DIFFERENT allowance
// is not allowed to stand in as a confirmed fact; it is only ever returned at
// LOW confidence, which the frontend renders as "may vary by fare".
// ═══════════════════════════════════════════════════════════════

const { SOURCE, CONFIDENCE, SOURCE_TYPE } = require('../config/fareIntelligence');

function norm(v) {
  return v == null ? null : String(v).trim().toLowerCase();
}
function normUpper(v) {
  return v == null ? null : String(v).trim().toUpperCase();
}

// Is `rule` in force on `asOf` (a Date or ISO/date string)? A rule applies when
// active, and asOf ∈ [effective_from, effective_until). An expired rule (spec
// §9 TEST 9) can never be used as current confirmed data.
function isRuleEffective(rule, asOf = new Date()) {
  if (!rule || rule.active === false) return false;
  const t = new Date(asOf).getTime();
  if (!Number.isFinite(t)) return false;
  if (rule.effective_from) {
    const from = new Date(rule.effective_from).getTime();
    if (Number.isFinite(from) && t < from) return false;
  }
  if (rule.effective_until) {
    const until = new Date(rule.effective_until).getTime();
    // effective_until is exclusive — the day it takes effect the OLD rule is done.
    if (Number.isFinite(until) && t >= until) return false;
  }
  return true;
}

// Precision level a rule matches the context at, or null if it can't apply.
// Higher number = more precise. Cabin is required to match when the context
// specifies one; a rule for a different cabin never applies.
function matchLevel(rule, ctx) {
  const rAirline = normUpper(rule.airline_iata);
  const cAirline = normUpper(ctx.airline);
  if (!rAirline || rAirline !== cAirline) return null;

  const rCabin = norm(rule.cabin_class);
  const cCabin = norm(ctx.cabin);
  // If the rule pins a cabin, the context must match it. A cabin-less rule
  // (rCabin null) is airline-wide and may apply to any cabin.
  if (rCabin && cCabin && rCabin !== cCabin) return null;
  if (rCabin && !cCabin) return null; // rule is cabin-specific but we don't know the cabin → can't safely apply

  const rFamily = norm(rule.fare_family);
  const cFamily = norm(ctx.fareFamily);
  const rBooking = normUpper(rule.booking_class);
  const cBooking = normUpper(ctx.bookingClass);

  // A rule that pins a fare family only applies when the family is known AND equal.
  if (rFamily) {
    if (!cFamily || rFamily !== cFamily) return null;
  }
  // A rule that pins a booking class only applies when it's known AND equal.
  if (rBooking) {
    if (!cBooking || rBooking !== cBooking) return null;
  }

  const familyMatch = !!(rFamily && cFamily && rFamily === cFamily);
  const bookingMatch = !!(rBooking && cBooking && rBooking === cBooking);
  const cabinMatch = !!(rCabin && cCabin && rCabin === cCabin);

  // Ladder (spec §12).
  if (familyMatch && bookingMatch && cabinMatch) return 4; // airline+family+booking+cabin → HIGH
  if (familyMatch && cabinMatch) return 3;                 // airline+family+cabin → HIGH
  if (bookingMatch && cabinMatch) return 2;                // airline+booking+cabin → MEDIUM
  if (cabinMatch) return 1;                                // airline+cabin → LOW (general policy)
  // Fare-family match without a cabin match still identifies the fare precisely.
  if (familyMatch) return 3;
  return null;
}

function confidenceForLevel(level) {
  switch (level) {
    case 4: return CONFIDENCE.HIGH;
    case 3: return CONFIDENCE.HIGH;
    case 2: return CONFIDENCE.MEDIUM;
    case 1: return CONFIDENCE.LOW;
    default: return CONFIDENCE.UNKNOWN;
  }
}

// Map a rule's declared source_type to the engine's SOURCE vocabulary.
function sourceForRule(rule) {
  switch (rule.source_type) {
    case SOURCE_TYPE.AIRLINE_OFFICIAL: return SOURCE.AIRLINE_OFFICIAL;
    case SOURCE_TYPE.VERIFIED_PROVIDER: return SOURCE.VERIFIED_PROVIDER;
    case SOURCE_TYPE.DUFFEL: return SOURCE.DUFFEL;
    case SOURCE_TYPE.MANUAL_ADMIN: return SOURCE.MANUAL_ADMIN;
    default: return SOURCE.AIRLINE_FARE_RULE;
  }
}

// Resolve the single best rule of `baggageType` for `ctx` from `rules`.
// Returns null when nothing applies. The returned object is a normalized
// "match" carrying the confidence the precision earns and full provenance for
// observability (spec §27).
//
// IMPORTANT (spec §12 golden rule): when the fare family is known, a level-1
// (airline+cabin, family-less) general-policy rule is capped at LOW confidence
// and marked general — so it can be shown as "may vary", never as a fact that
// might contradict the real fare. When the family is UNKNOWN, a level-1 match
// is likewise LOW (we haven't identified the fare, spec §11 LEVEL 3).
function matchBaggageRule(baggageType, ctx, rules, asOf = new Date()) {
  if (!Array.isArray(rules) || !rules.length) return null;
  let best = null;
  let bestLevel = 0;
  for (const rule of rules) {
    if (rule.baggage_type !== baggageType) continue;
    if (!isRuleEffective(rule, asOf)) continue;
    const level = matchLevel(rule, ctx);
    if (level == null) continue;
    if (level > bestLevel) {
      best = rule;
      bestLevel = level;
    }
  }
  if (!best) return null;

  const fareFamilyKnown = norm(ctx.fareFamily) != null;
  const isGeneral = bestLevel <= 1; // airline+cabin only → general airline policy
  let confidence = confidenceForLevel(bestLevel);

  // Rules may declare a confidence CEILING (an admin marking a hand-entered
  // rule LOW). The match confidence can never exceed the rule's own ceiling.
  if (best.confidence && rankOf(best.confidence) < rankOf(confidence)) {
    confidence = best.confidence;
  }

  return {
    baggageType,
    matched_rule_id: best.id || null,
    matchLevel: bestLevel,
    isGeneralPolicy: isGeneral,
    fareFamilyKnown,
    source: isGeneral ? SOURCE.GENERAL_AIRLINE_POLICY : sourceForRule(best),
    confidence,
    included: best.included != null ? best.included : null,
    pieces: best.pieces != null ? Number(best.pieces) : null,
    weight_kg: best.weight_kg != null ? Number(best.weight_kg) : null,
    dimensions: best.dimensions || null,
    source_url: best.source_url || null,
    source_reference: best.source_reference || null,
    last_verified: best.last_verified || null,
    effective_from: best.effective_from || null,
    effective_until: best.effective_until || null,
  };
}

const RANK = { HIGH: 3, MEDIUM: 2, LOW: 1, UNKNOWN: 0 };
function rankOf(c) { return RANK[c] != null ? RANK[c] : 0; }

module.exports = {
  isRuleEffective,
  matchLevel,
  confidenceForLevel,
  matchBaggageRule,
};
