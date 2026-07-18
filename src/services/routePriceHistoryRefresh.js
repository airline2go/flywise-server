// ═══════════════════════════════════════════════════════════════
// src/services/routePriceHistoryRefresh.js
// [ECONOMIC-INTELLIGENCE] Periodically aggregates route_price_history
// (append-only price points written by fetchAndCacheRoutePrice()) into
// durable per-route economic columns on route_pages: price_min / price_avg
// / price_max / price_sample_count / price_currency / price_trend. These
// feed routeIntelligence.js's `economic` snapshot and the route page's
// metrics block. Read-only with respect to site behavior (never touches
// price, booking, or refresh logic). Same self-starting .unref() pattern
// as routeIntelligenceRefresh.js / routeScore.js.
// ═══════════════════════════════════════════════════════════════

const supa = require('../clients/supabase');
const log = require('../utils/log');

const COMPUTE_INTERVAL_MS = 60 * 60 * 1000; // hourly — same cadence as the other refreshers
const WINDOW_DAYS = 90;                      // trailing window the aggregates describe
const MIN_SAMPLES_FOR_TREND = 4;            // below this, trend stays null (not enough signal)
const TREND_BAND = 0.03;                     // ±3% dead-band around "stable"

// Splits a route's time-ordered price points into an older majority and a
// recent tail (last third), and compares their means. Returns 'down'/'up'/
// 'stable', or null when there aren't enough points to say anything.
function computeTrend(sortedPrices) {
  if (sortedPrices.length < MIN_SAMPLES_FOR_TREND) return null;
  const splitAt = Math.floor((sortedPrices.length * 2) / 3);
  const older = sortedPrices.slice(0, splitAt);
  const recent = sortedPrices.slice(splitAt);
  if (!older.length || !recent.length) return null;
  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const olderMean = mean(older);
  const recentMean = mean(recent);
  if (olderMean <= 0) return null;
  const change = (recentMean - olderMean) / olderMean;
  if (change < -TREND_BAND) return 'down';
  if (change > TREND_BAND) return 'up';
  return 'stable';
}

// [BOUNDED-FETCH-AGGREGATE-IN-JS] Same "page through bounded reads, group
// in Node" pattern as routeIntelligenceRefresh.js — route_price_history has
// no per-route aggregate query via the Supabase builder.
async function computeRoutePriceStats() {
  const sinceIso = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const byRoute = new Map(); // "ORIGIN-DEST" -> { points:[{price,at}], currency }
  let from = 0;
  const pageSize = 1000;
  for (;;) {
    const { data: rows, error } = await supa.from('route_price_history')
      .select('route_origin_iata, route_destination_iata, price, currency, observed_at')
      .gte('observed_at', sinceIso)
      .order('observed_at', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) { log('warn', 'route_price_history_read_failed', { error: error.message }); return null; }
    if (!rows || !rows.length) break;
    for (const r of rows) {
      const key = `${r.route_origin_iata}-${r.route_destination_iata}`;
      if (!byRoute.has(key)) byRoute.set(key, { points: [], currency: r.currency || 'EUR' });
      const bucket = byRoute.get(key);
      bucket.points.push({ price: Number(r.price), at: r.observed_at });
      bucket.currency = r.currency || bucket.currency; // rows are asc, so this ends on the newest currency
    }
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return byRoute;
}

async function refreshRoutePriceHistoryOnce() {
  if (!supa) return;
  try {
    const byRoute = await computeRoutePriceStats();
    if (!byRoute) return;

    const { data: routePages, error: rpError } = await supa.from('route_pages').select('id, origin_iata, destination_iata');
    if (rpError) { log('warn', 'route_price_history_route_pages_read_failed', { error: rpError.message }); return; }

    const nowIso = new Date().toISOString();
    let updated = 0;
    for (const rp of routePages || []) {
      const bucket = byRoute.get(`${rp.origin_iata}-${rp.destination_iata}`);
      if (!bucket || !bucket.points.length) continue; // never overwrite real stats with nulls

      const prices = bucket.points.map((p) => p.price).filter((n) => Number.isFinite(n));
      if (!prices.length) continue;
      const sum = prices.reduce((a, b) => a + b, 0);
      const patch = {
        price_min: Math.min(...prices),
        price_max: Math.max(...prices),
        price_avg: Math.round((sum / prices.length) * 100) / 100,
        price_sample_count: prices.length,
        price_currency: bucket.currency,
        price_trend: computeTrend(prices), // bucket.points are time-ascending
        price_updated_at: nowIso,
      };
      const { error: updErr } = await supa.from('route_pages').update(patch).eq('id', rp.id);
      if (updErr) log('warn', 'route_price_history_update_failed', { route: `${rp.origin_iata}-${rp.destination_iata}`, error: updErr.message });
      else updated++;
    }
    log('info', 'route_price_history_refreshed', { updated, routesWithPrices: byRoute.size });
  } catch (e) {
    log('warn', 'route_price_history_refresh_cycle_failed', { error: e.message });
  }
}

setTimeout(() => { refreshRoutePriceHistoryOnce(); }, 90000).unref();
setInterval(() => { refreshRoutePriceHistoryOnce(); }, COMPUTE_INTERVAL_MS).unref();

module.exports = { refreshRoutePriceHistoryOnce, computeRoutePriceStats, computeTrend };
