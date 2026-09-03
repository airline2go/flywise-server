// ═══════════════════════════════════════════════════════════════
// src/services/fareConditionsEngine.js
// [FARE-INTEL] Same layered, confidence-scored resolution as baggageEngine,
// but for the fare CONDITIONS the spec earmarks for later phases (§24, §25):
// change, refund, seat selection, meal, priority. Duffel offer-specific data
// wins (L1, HIGH); verified fare rules fill the gaps (L2/L3); anything we
// cannot establish is UNKNOWN — never a cheerful "Free changes" we can't back.
//
// Pure/synchronous: the caller passes the offer's Duffel `conditions` object
// and the candidate airline_fare_rules rows. A positive claim (changeable /
// refundable / meal included) is only marked `confirmed` when its confidence
// is HIGH/MEDIUM, so the frontend shows it as a fact only when it truly is one.
// ═══════════════════════════════════════════════════════════════

const { SOURCE, CONFIDENCE, isConfirmed } = require('../config/fareIntelligence');
const { matchLevel, confidenceForLevel, isRuleEffective } = require('./fareRules');

const RANK = { HIGH: 3, MEDIUM: 2, LOW: 1, UNKNOWN: 0 };

// Highest-precision effective rule whose `field` is non-null for this context.
function bestRuleFor(field, ctx, rules, asOf) {
  let best = null, bestLevel = 0;
  for (const r of (rules || [])) {
    if (r[field] == null || r[field] === '') continue;
    if (!isRuleEffective(r, asOf)) continue;
    const lvl = matchLevel(r, ctx);
    if (lvl == null) continue;
    if (lvl > bestLevel) { best = r; bestLevel = lvl; }
  }
  if (!best) return null;
  const isGeneral = bestLevel <= 1;
  let confidence = confidenceForLevel(bestLevel);
  if (best.confidence && RANK[best.confidence] < RANK[confidence]) confidence = best.confidence;
  return {
    rule: best, level: bestLevel, isGeneral,
    source: isGeneral ? SOURCE.GENERAL_AIRLINE_POLICY
      : (best.source_type === 'AIRLINE_OFFICIAL' ? SOURCE.AIRLINE_OFFICIAL
        : best.source_type === 'VERIFIED_PROVIDER' ? SOURCE.VERIFIED_PROVIDER
        : SOURCE.AIRLINE_FARE_RULE),
    confidence,
    matched_rule_id: best.id || null,
    source_url: best.source_url || null,
  };
}

function unknownEntry(extra = {}) {
  return Object.assign({
    source: SOURCE.UNKNOWN, confidence: CONFIDENCE.UNKNOWN, matched_rule_id: null, confirmed: false,
  }, extra);
}

// Duffel offer-specific change/refund live under offer.conditions.
function duffelPolicy(node) {
  if (!node || node.allowed == null) return null;
  return {
    allowed: node.allowed === true,
    fee: node.penalty_amount != null ? Number(node.penalty_amount) : null,
    fee_currency: node.penalty_currency || null,
  };
}

function resolveChange(duffelConditions, ctx, rules, asOf) {
  const d = duffelPolicy(duffelConditions && duffelConditions.change_before_departure);
  if (d) {
    return {
      allowed: d.allowed, fee: d.fee, fee_currency: d.fee_currency,
      source: SOURCE.DUFFEL, confidence: CONFIDENCE.HIGH, matched_rule_id: null,
      confirmed: true,
    };
  }
  const m = bestRuleFor('change_allowed', ctx, rules, asOf);
  if (m) {
    return {
      allowed: m.rule.change_allowed === true,
      fee: m.rule.change_fee != null ? Number(m.rule.change_fee) : null,
      fee_currency: m.rule.change_fee_currency || null,
      source: m.source, confidence: m.confidence, matched_rule_id: m.matched_rule_id,
      source_url: m.source_url, confirmed: isConfirmed(m.confidence),
    };
  }
  return unknownEntry({ allowed: null, fee: null, fee_currency: null });
}

function resolveRefund(duffelConditions, ctx, rules, asOf) {
  const d = duffelPolicy(duffelConditions && duffelConditions.refund_before_departure);
  if (d) {
    return {
      refundable: d.allowed, fee: d.fee, fee_currency: d.fee_currency,
      source: SOURCE.DUFFEL, confidence: CONFIDENCE.HIGH, matched_rule_id: null,
      confirmed: true,
    };
  }
  const m = bestRuleFor('refund_allowed', ctx, rules, asOf);
  if (m) {
    return {
      refundable: m.rule.refund_allowed === true,
      fee: m.rule.refund_fee != null ? Number(m.rule.refund_fee) : null,
      fee_currency: m.rule.refund_fee_currency || null,
      source: m.source, confidence: m.confidence, matched_rule_id: m.matched_rule_id,
      source_url: m.source_url, confirmed: isConfirmed(m.confidence),
    };
  }
  return unknownEntry({ refundable: null, fee: null, fee_currency: null });
}

// Boolean-ish rule fields (meal_included / priority_included) and the free-form
// seat_selection string — rule-sourced only (Duffel doesn't expose them simply).
function resolveBoolField(field, valueKey, ctx, rules, asOf) {
  const m = bestRuleFor(field, ctx, rules, asOf);
  if (!m) return unknownEntry({ [valueKey]: null });
  return {
    [valueKey]: m.rule[field] === true,
    source: m.source, confidence: m.confidence, matched_rule_id: m.matched_rule_id,
    source_url: m.source_url, confirmed: isConfirmed(m.confidence),
  };
}

function resolveSeat(ctx, rules, asOf) {
  const m = bestRuleFor('seat_selection', ctx, rules, asOf);
  if (!m) return unknownEntry({ seat_selection: null });
  return {
    seat_selection: m.rule.seat_selection,
    source: m.source, confidence: m.confidence, matched_rule_id: m.matched_rule_id,
    source_url: m.source_url, confirmed: isConfirmed(m.confidence),
  };
}

// Main entry point. Returns { change, refund, seat, meal, priority, meta }.
function resolveFareConditions({ duffelConditions = null, ctx = {}, rules = [], asOf = new Date() } = {}) {
  const change = resolveChange(duffelConditions, ctx, rules, asOf);
  const refund = resolveRefund(duffelConditions, ctx, rules, asOf);
  const seat = resolveSeat(ctx, rules, asOf);
  const meal = resolveBoolField('meal_included', 'included', ctx, rules, asOf);
  const priority = resolveBoolField('priority_included', 'included', ctx, rules, asOf);
  return {
    change, refund, seat, meal, priority,
    meta: { resolvedAt: new Date(asOf).toISOString() },
  };
}

module.exports = { resolveFareConditions, bestRuleFor };
