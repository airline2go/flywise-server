const { seoCoreOnlyEnabled, isSeoCoreRoute } = require('./seoRouteCore');

function evidencePolicyEnforced() {
  if (process.env.SEO_EVIDENCE_POLICY_ENFORCED == null) return true;
  return process.env.SEO_EVIDENCE_POLICY_ENFORCED === '1'
    || process.env.SEO_EVIDENCE_POLICY_ENFORCED === 'true';
}

// [SEO-ROUTE-DEMAND-GATE] Strong-prune switch. The evidence gate keeps out
// routes with NO real flight data, but ~all published routes carry full
// evidence (duration/stops/price/itinerary), so evidence alone still exposes
// the entire ~1.7k templated route corpus to Google — which is what triggered
// the sitewide "scaled/thin content" demotion. When this gate is ON, a route
// is additionally required to show a genuine demand/quality signal (a real
// popularity score, scheduled weekly flights, or approved manual editorial
// content) to stay indexable; everything else becomes noindex,follow so link
// equity keeps flowing.
//
// Default OFF so the demand mechanism remains independently reversible. The
// recovery core below is the stronger controlled cohort gate.
function routeDemandGateEnabled() {
  return process.env.SEO_ROUTE_DEMAND_GATE === '1'
    || process.env.SEO_ROUTE_DEMAND_GATE === 'true';
}

function routeMinScore() {
  const n = Number(process.env.SEO_ROUTE_MIN_SCORE);
  return Number.isFinite(n) && n >= 0 ? n : 0.2;
}

function routeDataMaxAgeMs() {
  const days = Number(process.env.SEO_ROUTE_DATA_MAX_AGE_DAYS);
  const effectiveDays = Number.isFinite(days) && days > 0 ? days : 30;
  return effectiveDays * 24 * 60 * 60 * 1000;
}

function hasFreshRouteData(r, now = Date.now()) {
  if (!r) return false;
  const raw = r.insights_updated_at
    || (r.intelligence && r.intelligence.operational && r.intelligence.operational.updatedAt);
  if (!raw) return false;
  const t = new Date(raw).getTime();
  if (!Number.isFinite(t)) return false;
  const age = now - t;
  return age >= 0 && age <= routeDataMaxAgeMs();
}

function hasRouteDemandSignal(r) {
  if (!r) return false;
  if (validPositiveNumber(r.route_score) && Number(r.route_score) >= routeMinScore()) return true;
  if (validPositiveInteger(r.weekly_flights)) return true;
  return false;
}

function validPositiveInteger(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0;
}

function validPositiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

function hasRealStopDistribution(sd) {
  if (!sd || typeof sd !== 'object' || Array.isArray(sd)) return false;
  const entries = Object.entries(sd);
  if (!entries.length) return false;
  return entries.every(([key, value]) => /^\d+$/.test(String(key)) && Number.isInteger(Number(value)) && Number(value) >= 0)
    && entries.some(([, value]) => Number(value) > 0);
}

function hasVerifiedFlightEvidence(r) {
  if (!r) return false;
  if (validPositiveNumber(r.avg_duration_min)) return true;
  if (hasRealStopDistribution(r.stop_distribution)) return true;
  if (validPositiveInteger(r.price_sample_count)) return true;
  if (validPositiveInteger(r.itinerary_count)) return true;
  return false;
}

function hasManualEditorialContent(r) {
  return !!(r && (r.intro_text || (r.custom_faq && r.custom_faq.length)));
}

function hasLegacyRouteData(r) {
  return validPositiveNumber(r && r.distance_km)
    || validPositiveNumber(r && r.avg_duration_min)
    || validPositiveInteger(r && r.airline_count)
    || hasRealStopDistribution(r && r.stop_distribution);
}

function getRouteIndexabilityDecision(r, opts = {}) {
  const enforce = opts.enforce != null ? opts.enforce : evidencePolicyEnforced();
  const demandGate = opts.demandGate != null ? opts.demandGate : routeDemandGateEnabled();
  const coreOnly = opts.coreOnly != null ? opts.coreOnly : seoCoreOnlyEnabled();
  const evidence = hasVerifiedFlightEvidence(r);
  const manual = hasManualEditorialContent(r);
  const demand = hasRouteDemandSignal(r);
  const fresh = hasFreshRouteData(r, opts.now);
  const demandOk = !demandGate || manual || demand;
  const freshnessOk = !demandGate || manual || fresh;
  const policyIndexable = enforce
    ? ((evidence || manual) && demandOk && freshnessOk)
    : (hasLegacyRouteData(r) || manual);

  // The recovery cohort is versioned in git and only applies to real catalogue
  // rows. Test fixtures and defensive internal objects without a slug retain
  // their existing policy semantics; every public route row has a slug.
  const coreOk = !coreOnly || !r || !r.slug || isSeoCoreRoute(r.slug);
  const indexable = policyIndexable && coreOk;

  let reason;
  if (!coreOk) reason = 'OUTSIDE SEO CORE (pruned)';
  else if (enforce) {
    reason = (evidence || manual)
      ? (demandOk
        ? (freshnessOk
          ? (evidence ? 'VERIFIED FLIGHT EVIDENCE' : 'MANUAL EDITORIAL CONTENT')
          : 'STALE ROUTE DATA (pruned)')
        : 'NO DEMAND SIGNAL (pruned)')
      : 'NO VERIFIED FLIGHT EVIDENCE';
  } else reason = indexable ? 'LEGACY DATA/CONTENT' : 'NO DATA (legacy)';

  return {
    indexable,
    verifiedEvidence: evidence,
    manualContent: manual,
    demandSignal: demand,
    routeDataFresh: fresh,
    demandGate,
    coreOnly,
    inSeoCore: !r?.slug || isSeoCoreRoute(r.slug),
    enforce,
    reason,
    signals: {
      airline_count: r ? r.airline_count : null,
      avg_duration_min: r ? r.avg_duration_min : null,
      has_stop_distribution: hasRealStopDistribution(r && r.stop_distribution),
      price_sample_count: r ? r.price_sample_count : null,
      itinerary_count: r ? r.itinerary_count : null,
      distance_km: r ? r.distance_km : null,
      route_score: r ? r.route_score : null,
      weekly_flights: r ? r.weekly_flights : null,
      insights_updated_at: r ? r.insights_updated_at : null,
    },
  };
}

function routeIndexable(r, opts = {}) {
  return getRouteIndexabilityDecision(r, opts).indexable;
}
function cityIndexable(city, distinctDestinations) {
  return distinctDestinations >= 2 || !!city.intro_text;
}
function airportIndexable(airport, distinctDestinations) {
  return distinctDestinations >= 2 || !!(airport.terminal_info || airport.transit_options || airport.traveler_tips);
}
function countryIndexable(country, connectivityScore) {
  return connectivityScore >= 2 || !!country.intro_text;
}
function airlineIndexable(airline, publishedRouteCount) {
  return publishedRouteCount >= 2 || !!airline.intro_text;
}
function buildConnectivity(routes, opts = {}) {
  const enforce = opts.enforce != null ? opts.enforce : evidencePolicyEnforced();
  const demandGate = opts.demandGate != null ? opts.demandGate : routeDemandGateEnabled();
  const coreOnly = opts.coreOnly != null ? opts.coreOnly : seoCoreOnlyEnabled();
  const cityDest = new Map();
  const airportDest = new Map();
  const countryExt = new Map();
  const countryDomestic = new Map();
  const addTo = (map, key, val) => {
    if (!key || !val) return;
    let set = map.get(key);
    if (!set) { set = new Set(); map.set(key, set); }
    set.add(val);
  };
  for (const r of routes || []) {
    if (enforce) {
      const ev = hasVerifiedFlightEvidence(r);
      const man = hasManualEditorialContent(r);
      const demandOk = !demandGate || man || hasRouteDemandSignal(r);
      const freshnessOk = !demandGate || man || hasFreshRouteData(r);
      const coreOk = !coreOnly || !r?.slug || isSeoCoreRoute(r.slug);
      if (!((ev || man) && demandOk && freshnessOk && coreOk)) continue;
    } else if (coreOnly && r?.slug && !isSeoCoreRoute(r.slug)) {
      continue;
    }
    addTo(cityDest, r.origin_city_slug, r.destination_city_slug);
    addTo(cityDest, r.destination_city_slug, r.origin_city_slug);
    addTo(airportDest, r.origin_iata, r.destination_city_slug);
    addTo(airportDest, r.destination_iata, r.origin_city_slug);
    const oc = r.origin_country;
    const dc = r.destination_country;
    if (oc && dc && oc === dc) {
      countryDomestic.set(oc, (countryDomestic.get(oc) || 0) + 1);
    } else {
      if (oc) addTo(countryExt, oc, r.destination_city_slug || r.destination_iata);
      if (dc) addTo(countryExt, dc, r.origin_city_slug || r.origin_iata);
    }
  }
  return { cityDest, airportDest, countryExt, countryDomestic };
}
function cityDestinationCount(connectivity, citySlug) {
  const s = connectivity.cityDest.get(citySlug);
  return s ? s.size : 0;
}
function airportDestinationCount(connectivity, iata) {
  const s = connectivity.airportDest.get(iata);
  return s ? s.size : 0;
}
function countryConnectivityScore(connectivity, code) {
  const ext = connectivity.countryExt.get(code);
  const dom = connectivity.countryDomestic.get(code) || 0;
  return (ext ? ext.size : 0) + dom;
}
function airlineRouteCounts(observedRows, publishedRoutes) {
  const separator = String.fromCharCode(0);
  const publishedPairs = new Set();
  for (const r of publishedRoutes || []) {
    if (r.origin_iata && r.destination_iata) publishedPairs.add(`${r.origin_iata}${separator}${r.destination_iata}`);
  }
  const seenPairsByAirline = new Map();
  const counts = new Map();
  for (const o of observedRows || []) {
    const id = o.airline_id;
    if (id == null) continue;
    const pair = `${o.route_origin_iata}${separator}${o.route_destination_iata}`;
    if (!publishedPairs.has(pair)) continue;
    let seen = seenPairsByAirline.get(id);
    if (!seen) { seen = new Set(); seenPairsByAirline.set(id, seen); }
    if (seen.size >= 2) continue;
    if (!seen.has(pair)) {
      seen.add(pair);
      counts.set(id, seen.size);
    }
  }
  return counts;
}
module.exports = {
  hasVerifiedFlightEvidence,
  hasManualEditorialContent,
  hasFreshRouteData,
  routeDataMaxAgeMs,
  getRouteIndexabilityDecision,
  evidencePolicyEnforced,
  routeDemandGateEnabled,
  routeMinScore,
  hasRouteDemandSignal,
  routeIndexable,
  cityIndexable,
  airportIndexable,
  countryIndexable,
  airlineIndexable,
  buildConnectivity,
  cityDestinationCount,
  airportDestinationCount,
  countryConnectivityScore,
  airlineRouteCounts,
};
