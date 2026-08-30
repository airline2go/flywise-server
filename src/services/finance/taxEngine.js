// ═══════════════════════════════════════════════════════════════
// src/services/finance/taxEngine.js
// [F-PHASE2 · TAX ENGINE] Configurable, versioned, NON-GUESSING tax
// classification. It NEVER contains a hard-coded VAT rate, reverse-charge, or
// revenue-recognition decision. It only:
//   1. finds the most specific ACTIVE, date-valid tax_rule_version whose
//      constrained dimensions all match the transaction context, and
//   2. returns exactly the values that approved version stores.
// If no approved rule matches → status REVIEW_REQUIRED, no numbers invented,
// and a tax_exception is raised for the accountant queue (spec Phase 6/7/23,
// non-negotiable rules 5, 15, 20).
//
// Pure matching lives in `matchRuleVersion()` (unit-tested without a DB). The
// DB-backed `classify()` loads candidate versions and persists the outcome.
// ═══════════════════════════════════════════════════════════════

// Dimensions a rule version may constrain. A null column on the version means
// "matches any" (wildcard); a non-null column must equal the context value.
const DIMENSIONS = [
  'transaction_type', 'service_type', 'supplier_type', 'customer_type',
  'customer_country', 'supplier_country', 'origin_country',
  'destination_country', 'route_type',
];

// Does one rule version match a context? Returns null if it does not, else the
// specificity score (count of constrained dimensions that matched) so the
// caller can pick the most specific rule.
function matchRuleVersion(version, ctx) {
  let score = 0;
  for (const dim of DIMENSIONS) {
    const rv = version[dim];
    if (rv == null || rv === '') continue;        // wildcard dimension
    const cv = ctx[dim];
    if (cv == null) return null;                   // context can't satisfy a constrained dim
    if (String(cv).toUpperCase() !== String(rv).toUpperCase()) return null;
    score += 1;
  }
  return score;
}

// Is a version usable as an authoritative production rule right now?
function isActiveVersion(version, onDate) {
  if (!version) return false;
  if (version.status !== 'ACTIVE') return false;   // APPROVED-but-not-ACTIVE is not yet in force
  const d = onDate ? new Date(onDate) : new Date();
  if (version.valid_from && new Date(version.valid_from) > d) return false;
  if (version.valid_until && new Date(version.valid_until) < d) return false;
  return true;
}

// Choose the best matching ACTIVE version for a context/date from a candidate
// list (already loaded). Returns { version, score } or null.
function selectRuleVersion(versions, ctx, onDate) {
  let best = null;
  for (const v of versions || []) {
    if (!isActiveVersion(v, onDate)) continue;
    const score = matchRuleVersion(v, ctx);
    if (score == null) continue;
    if (!best || score > best.score) best = { version: v, score };
  }
  return best;
}

// The REVIEW_REQUIRED result shape — no invented numbers, all outcome fields null.
function reviewRequiredResult(reason) {
  return {
    status: 'REVIEW_REQUIRED',
    reason: reason || 'no_active_rule_matched',
    tax_rule_id: null,
    tax_rule_version_id: null,
    direction: 'REVIEW_REQUIRED',
    vat_rate: null,
    taxable_percentage: null,
    output_vat_required: null,
    input_vat_allowed: null,
    reverse_charge: null,
    exemption_code: null,
    revenue_recognition: 'REVIEW_REQUIRED',
    legal_basis: null,
  };
}

// Translate an approved version into an authoritative result (values copied
// verbatim from the version — never derived).
function resultFromVersion(rule, version, score) {
  let direction = 'REVIEW_REQUIRED';
  if (version.reverse_charge === true) direction = 'REVERSE_CHARGE';
  else if (version.exemption_code) direction = 'EXEMPT';
  else if (version.output_vat_required === true) direction = 'OUTPUT';
  else if (version.input_vat_allowed === true) direction = 'INPUT';
  return {
    status: 'CLASSIFIED',
    reason: null,
    matched_score: score,
    tax_rule_id: rule ? rule.id : version.tax_rule_id,
    tax_rule_version_id: version.id,
    direction,
    vat_rate: version.vat_rate,
    taxable_percentage: version.taxable_percentage,
    output_vat_required: version.output_vat_required,
    input_vat_allowed: version.input_vat_allowed,
    reverse_charge: version.reverse_charge,
    exemption_code: version.exemption_code,
    revenue_recognition: version.revenue_recognition || 'REVIEW_REQUIRED',
    legal_basis: version.legal_basis,
  };
}

// DB-backed classification. `deps` = { supa, log }. Loads ACTIVE rule versions,
// selects the best match, and — when none matches — records a tax_exception.
// Returns the result object; NEVER throws on "no rule" (that is a valid,
// expected REVIEW_REQUIRED outcome), only on real DB errors.
async function classify(ctx, deps = {}) {
  const { supa, log } = deps;
  const onDate = ctx.transaction_date || new Date().toISOString();
  if (!supa) return reviewRequiredResult('no_database');

  // Load candidate ACTIVE versions with their rule. Kept small: only ACTIVE.
  const { data: versions, error } = await supa
    .from('tax_rule_versions')
    .select('*, tax_rules!inner(id, rule_code, status)')
    .eq('status', 'ACTIVE');
  if (error) {
    if (log) log('error', 'tax_classify_load_failed', { error: error.message });
    throw new Error('tax_rule_versions load failed: ' + error.message);
  }

  const best = selectRuleVersion(versions || [], ctx, onDate);
  if (!best) {
    // No approved/active rule → REVIEW_REQUIRED + exception. Never guess.
    const result = reviewRequiredResult('no_active_rule_matched');
    try {
      await supa.from('tax_exceptions').insert({
        exception_type: 'TAX_RULE_NOT_FOUND',
        entity_type: ctx.entity_type || 'financial_event',
        entity_id: ctx.entity_id || null,
        financial_event_id: ctx.financial_event_id || null,
        booking_id: ctx.booking_id || null,
        severity: 'REVIEW',
        details: { context: ctx },
      });
    } catch (e) {
      if (log) log('warn', 'tax_exception_insert_failed', { error: e.message });
    }
    return result;
  }
  const rule = best.version.tax_rules || null;
  return resultFromVersion(rule, best.version, best.score);
}

module.exports = {
  DIMENSIONS,
  matchRuleVersion,
  isActiveVersion,
  selectRuleVersion,
  reviewRequiredResult,
  resultFromVersion,
  classify,
};
