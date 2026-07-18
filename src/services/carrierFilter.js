// ═══════════════════════════════════════════════════════════════
// src/services/carrierFilter.js
// [CARRIER-FILTER] Single source of truth for deciding whether a carrier
// observed in a Duffel offer is a REAL, operating airline worth surfacing
// on public route/airline pages — or a placeholder/test artifact that must
// never be stored or displayed.
//
// Duffel's TEST environment returns a synthetic carrier "Duffel Airways"
// (IATA "ZZ") on every offer. Relying on "just use a live token" to keep it
// off the site is fragile: the token is an env-var an operator can get
// wrong, and normalizeOffer.js already falls back to "XX"/"Unknown" when a
// real carrier is missing its code/name. This filter makes the exclusion
// defensive and token-independent — the same rule applies at ingestion
// (search.routes.js) and can be reused by any cleanup job.
// ═══════════════════════════════════════════════════════════════

// IATA codes that are never a real operating carrier:
//  - ZZ: Duffel's test-mode airline ("Duffel Airways")
//  - XX: normalizeOffer.js's placeholder when marketing_carrier.iata_code is absent
const EXCLUDED_IATA = new Set(['ZZ', 'XX']);

// Names that are never a real operating carrier (compared case-insensitively):
//  - "Duffel Airways": the test-mode carrier's display name
//  - "Unknown": normalizeOffer.js's placeholder when marketing_carrier.name is absent
const EXCLUDED_NAMES = new Set(['duffel airways', 'unknown']);

// Returns true when the (iata, name) pair should be EXCLUDED from storage
// and from any public-facing airline list. Either signal alone is enough —
// a live offer that (however unlikely) carried only one of the two markers
// should still be filtered out.
function isExcludedCarrier(iata, name) {
  if (iata && EXCLUDED_IATA.has(String(iata).trim().toUpperCase())) return true;
  if (name && EXCLUDED_NAMES.has(String(name).trim().toLowerCase())) return true;
  return false;
}

module.exports = { isExcludedCarrier, EXCLUDED_IATA, EXCLUDED_NAMES };
