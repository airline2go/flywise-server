// ═══════════════════════════════════════════════════════════════
// src/config/fareIntelligence.js
// [FARE-INTEL] Central vocabulary for the Fare Intelligence / Baggage engine.
// Every baggage or fare-rule result carries a SOURCE (where the fact came
// from) and a CONFIDENCE (how strongly we can stand behind it). These are the
// ONLY allowed values, defined in ONE place so the engine, the admin CMS, the
// consistency validator and the frontend can never disagree about what
// "confirmed" means.
//
// CORE PRINCIPLE (Airpiv): "Better to say unknown than to show an incorrect
// baggage allowance." A value is presentable as a *fact* to the customer only
// when its confidence is HIGH (or MEDIUM for a fare-specific match). LOW and
// UNKNOWN must be surfaced as "may vary by fare", never as a guarantee.
// ═══════════════════════════════════════════════════════════════

// Where a piece of baggage/fare information originated.
const SOURCE = Object.freeze({
  DUFFEL: 'DUFFEL',                             // offer-specific, from the live Duffel offer — the authority
  AIRLINE_FARE_RULE: 'AIRLINE_FARE_RULE',       // verified rule matched on airline+fare family (+booking class)+cabin
  GENERAL_AIRLINE_POLICY: 'GENERAL_AIRLINE_POLICY', // airline+cabin only, no fare identified — NOT a confirmed fact
  MANUAL_ADMIN: 'MANUAL_ADMIN',                 // hand-entered by an admin (provenance recorded on the rule)
  AIRLINE_OFFICIAL: 'AIRLINE_OFFICIAL',         // sourced from the airline's own published policy page
  VERIFIED_PROVIDER: 'VERIFIED_PROVIDER',       // sourced from a trusted third-party data provider
  UNKNOWN: 'UNKNOWN',                           // we could not establish this at all
});

// How strongly the value can be presented. See CONFIDENCE_RANK for ordering.
const CONFIDENCE = Object.freeze({
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
  UNKNOWN: 'UNKNOWN',
});

const CONFIDENCE_RANK = Object.freeze({ HIGH: 3, MEDIUM: 2, LOW: 1, UNKNOWN: 0 });

// The three independent primary baggage types plus additional/extra baggage.
// They are NEVER merged into a single weight — each is resolved and displayed
// on its own (spec §5-§8).
const BAGGAGE_TYPE = Object.freeze({
  PERSONAL_ITEM: 'personal_item',
  CABIN: 'cabin',
  CHECKED: 'checked',
  ADDITIONAL: 'additional',
});

// source_type values an admin-entered rule may declare (spec §18).
const SOURCE_TYPE = Object.freeze({
  DUFFEL: 'DUFFEL',
  AIRLINE_OFFICIAL: 'AIRLINE_OFFICIAL',
  VERIFIED_PROVIDER: 'VERIFIED_PROVIDER',
  MANUAL_ADMIN: 'MANUAL_ADMIN',
  UNKNOWN: 'UNKNOWN',
});

// A confidence is "presentable as a confirmed fact" only at or above MEDIUM.
// The frontend uses this to decide between "1 × 23 kg" (confirmed) and
// "may vary by fare" (not confirmed). Kept here so the rule lives in one place.
function isConfirmed(confidence) {
  return CONFIDENCE_RANK[confidence] >= CONFIDENCE_RANK.MEDIUM;
}

function isValidSource(s) {
  return Object.prototype.hasOwnProperty.call(SOURCE, s);
}
function isValidConfidence(c) {
  return Object.prototype.hasOwnProperty.call(CONFIDENCE, c);
}

module.exports = {
  SOURCE,
  CONFIDENCE,
  CONFIDENCE_RANK,
  BAGGAGE_TYPE,
  SOURCE_TYPE,
  isConfirmed,
  isValidSource,
  isValidConfidence,
};
