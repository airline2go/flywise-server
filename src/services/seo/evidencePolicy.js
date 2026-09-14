// Conservative evidence policy for programmatic route SEO.
// A route may be structurally valid yet still lack observed flight evidence.
// This policy prevents bulk generation/indexing of pages that cannot substantiate
// flight-specific claims. It is intentionally pure and side-effect free.

const HARD_EVIDENCE_FIELDS = [
  'airline_count',
  'itinerary_count',
  'avg_duration_min',
  'min_duration_min',
  'price_sample_count',
];

function positiveNumber(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function evidenceSignals(route = {}) {
  return HARD_EVIDENCE_FIELDS.filter((field) => positiveNumber(route[field]));
}

function assessEvidence(route = {}) {
  const signals = evidenceSignals(route);
  return {
    verified: signals.length > 0,
    signals,
    reason: signals.length ? null : 'no verified flight evidence',
  };
}

function evidencePolicyEnabled(env = process.env) {
  return String(env.SEO_EVIDENCE_POLICY_ENFORCED || '').toLowerCase() === '1' ||
    String(env.SEO_EVIDENCE_POLICY_ENFORCED || '').toLowerCase() === 'true';
}

function assessSeoEvidence(route, env = process.env) {
  const evidence = assessEvidence(route);
  return {
    ...evidence,
    enforced: evidencePolicyEnabled(env),
    eligible: !evidencePolicyEnabled(env) || evidence.verified,
  };
}

module.exports = {
  HARD_EVIDENCE_FIELDS,
  evidenceSignals,
  assessEvidence,
  evidencePolicyEnabled,
  assessSeoEvidence,
};
