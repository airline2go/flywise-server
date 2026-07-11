// ═══════════════════════════════════════════════════════════════
// src/services/routeIntelligenceRefresh.js
// [ROUTE-INTELLIGENCE-1] Periodically recomputes route_pages.airline_count
// from the accumulating route_airlines table (airlines.sql) — every
// airline ever observed on a route, not just the last search's top-8
// (unlike the same-search approximation written inline by
// fetchAndCacheRoutePrice() in search.routes.js). Read-only with respect
// to site behavior — this never touches price, booking, or refresh_frequency
// logic. Same self-starting .unref() pattern as routeScore.js.
// ═══════════════════════════════════════════════════════════════

const supa = require('../clients/supabase');
const log = require('../utils/log');

const COMPUTE_INTERVAL_MS = 60 * 60 * 1000; // hourly — same cadence as routeScore.js

// [BOUNDED-FETCH-AGGREGATE-IN-JS] route_airlines has no built-in
// distinct-count-per-route query via the Supabase query builder — same
// "fetch bounded pages, aggregate in Node" pattern already used by
// admin-geo.routes.js's attachTranslationCounts().
async function computeAirlineCounts() {
  const counts = new Map(); // "ORIGIN-DEST" -> Set(airline_id)
  let from = 0;
  const pageSize = 1000;
  for (;;) {
    const { data: rows, error } = await supa.from('route_airlines')
      .select('route_origin_iata, route_destination_iata, airline_id')
      .range(from, from + pageSize - 1);
    if (error) { log('warn', 'route_intelligence_refresh_read_failed', { error: error.message }); return null; }
    if (!rows || !rows.length) break;

    for (const r of rows) {
      const key = `${r.route_origin_iata}-${r.route_destination_iata}`;
      if (!counts.has(key)) counts.set(key, new Set());
      counts.get(key).add(r.airline_id);
    }

    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return counts;
}

async function refreshRouteIntelligenceOnce() {
  if (!supa) return;
  try {
    const counts = await computeAirlineCounts();
    if (!counts) return;

    const { data: routePages, error: rpError } = await supa.from('route_pages').select('id, origin_iata, destination_iata');
    if (rpError) { log('warn', 'route_intelligence_refresh_route_pages_read_failed', { error: rpError.message }); return; }

    let updated = 0;
    for (const rp of routePages || []) {
      const key = `${rp.origin_iata}-${rp.destination_iata}`;
      const airlineCount = counts.has(key) ? counts.get(key).size : 0;
      const { error: updateErr } = await supa.from('route_pages').update({ airline_count: airlineCount }).eq('id', rp.id);
      if (updateErr) log('warn', 'route_intelligence_refresh_update_failed', { route: key, error: updateErr.message });
      else updated++;
    }
    log('info', 'route_intelligence_refreshed', { updated, routesWithAirlines: counts.size });
  } catch (e) {
    log('warn', 'route_intelligence_refresh_cycle_failed', { error: e.message });
  }
}

setTimeout(() => { refreshRouteIntelligenceOnce(); }, 60000).unref();
setInterval(() => { refreshRouteIntelligenceOnce(); }, COMPUTE_INTERVAL_MS).unref();

module.exports = { refreshRouteIntelligenceOnce, computeAirlineCounts };
