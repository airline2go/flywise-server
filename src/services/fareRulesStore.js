// ═══════════════════════════════════════════════════════════════
// src/services/fareRulesStore.js
// [FARE-INTEL] Thin data-access + observability layer between the pure engine
// (fareRules.js / baggageEngine.js) and Supabase. Keeps the engine pure while
// giving callers a simple, cached "give me this airline's candidate rules"
// call and a structured log of every applied match (spec §27) so we can always
// answer "why did Airpiv say 23 kg for this ticket?".
// ═══════════════════════════════════════════════════════════════

const supa = require('../clients/supabase');
const log = require('../utils/log');

// A single search normalizes dozens of offers, often for the same handful of
// carriers. Cache each airline's active rules briefly so we hit Supabase once
// per airline per search burst, not once per offer.
const CACHE_TTL_MS = 60 * 1000;
const _cache = new Map(); // iata -> { at, rules }

// Fetch the active, in-force candidate rules for one airline. Returns [] on any
// error or when the DB is unavailable — the engine then falls back to
// Duffel-only + UNKNOWN, never inventing a value.
async function getFareRulesForAirline(iata) {
  const code = (iata || '').toUpperCase();
  if (!code || !supa) return [];
  const hit = _cache.get(code);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.rules;
  try {
    const { data, error } = await supa
      .from('airline_fare_rules')
      .select('*')
      .eq('airline_iata', code)
      .eq('active', true);
    if (error) throw new Error(error.message);
    const rules = data || [];
    _cache.set(code, { at: Date.now(), rules });
    return rules;
  } catch (err) {
    log('warn', '[fare-rules] fetch failed for ' + code + ': ' + err.message);
    return [];
  }
}

// Prefetch rules for a set of airline codes in one round trip, returning a
// { IATA: rules[] } map to hand into normalizeOffer — mirrors how ticketTiers
// is fetched once per search and passed in, not re-fetched per offer.
async function getFareRulesByAirlines(iataCodes = []) {
  const codes = [...new Set((iataCodes || []).map(c => (c || '').toUpperCase()).filter(Boolean))];
  const map = {};
  if (!codes.length || !supa) {
    for (const c of codes) map[c] = [];
    return map;
  }
  try {
    const { data, error } = await supa
      .from('airline_fare_rules')
      .select('*')
      .in('airline_iata', codes)
      .eq('active', true);
    if (error) throw new Error(error.message);
    for (const c of codes) map[c] = [];
    for (const row of (data || [])) {
      const c = (row.airline_iata || '').toUpperCase();
      (map[c] = map[c] || []).push(row);
      _cache.set(c, { at: Date.now(), rules: map[c] });
    }
    return map;
  } catch (err) {
    log('warn', '[fare-rules] batch fetch failed: ' + err.message);
    for (const c of codes) map[c] = [];
    return map;
  }
}

// [OBSERVABILITY §27] Emit one structured line per baggage type actually
// resolved from a rule (not Duffel, not UNKNOWN), so a rule application is
// traceable. Cheap and best-effort — never throws into the request path.
function logBaggageResolution(offerId, ctx, baggage) {
  try {
    for (const key of ['personal_item', 'cabin', 'checked', 'additional']) {
      const e = baggage?.[key];
      if (!e || !e.matched_rule_id) continue;
      log('info', '[fare-rules] applied', {
        offer_id: offerId || null,
        airline: ctx.airline || null,
        fare_family: ctx.fareFamily || null,
        booking_class: ctx.bookingClass || null,
        cabin: ctx.cabin || null,
        baggage_type: e.type,
        matched_rule_id: e.matched_rule_id,
        source: e.source,
        confidence: e.confidence,
        timestamp: new Date().toISOString(),
      });
    }
  } catch (_) { /* observability must never break resolution */ }
}

function _clearCache() { _cache.clear(); }

module.exports = {
  getFareRulesForAirline,
  getFareRulesByAirlines,
  logBaggageResolution,
  _clearCache,
};
