// ═══════════════════════════════════════════════════════════════
// src/services/routeScore.js
// [ROUTE-SCORE-4A] Computes route_pages.route_score +
// route_score_confidence from route_traffic_daily (routeTraffic.js's
// rollup). Read-only with respect to site behavior — nothing here
// ever touches refresh_frequency; that's Phase 4B, gated behind its
// own observation period. Hourly self-starting job, same .unref()
// pattern as warmRoutePricesOnce() in search.routes.js.
//
// Score favors booking intent over raw traffic, per the explicit
// Phase 4 revision: score = impressions·w1 + clicks·w2 +
// booking_starts·w3 + CTR·w4, every term recency-decayed
// (weight = exp(-ageDays / halfLifeDays)) so a route's older traffic
// naturally matters less than its recent traffic. All weights/windows
// are admin-tunable via admin_config['route_score_config'] — nothing
// here is hardcoded in a way that needs a code change to retune.
//
// route_score_confidence exists because a score built on a handful of
// impressions makes a much weaker claim than the same score built on
// thousands — surfaced alongside the score in the admin UI so thin
// data is never read as equivalent to well-observed data.
// ═══════════════════════════════════════════════════════════════

const supa = require('../clients/supabase');
const log = require('../utils/log');
const { getAdminConfig } = require('./adminConfig');

const DEFAULT_ROUTE_SCORE_CONFIG = {
  halfLifeDays: 7,
  lookbackDays: 30,
  impressionWeight: 1,
  clickWeight: 10,
  bookingWeight: 100,
  ctrWeight: 50,
  confidenceLowMax: 100,   // decayed impressions below this → 'low'
  confidenceHighMin: 1000, // decayed impressions at/above this → 'high'
};
const COMPUTE_INTERVAL_MS = 60 * 60 * 1000; // hourly — cheap to keep fresh

function daysAgo(dayStr) {
  const day = new Date(dayStr + 'T00:00:00Z');
  const now = new Date();
  const nowUtcDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return Math.max(0, Math.round((nowUtcDay - day) / (24 * 60 * 60 * 1000)));
}

function computeConfidence(decayedImpressions, cfg) {
  if (decayedImpressions >= cfg.confidenceHighMin) return 'high';
  if (decayedImpressions >= cfg.confidenceLowMax) return 'medium';
  return 'low';
}

async function computeRouteScoresOnce() {
  if (!supa) return;
  try {
    const cfg = Object.assign({}, DEFAULT_ROUTE_SCORE_CONFIG, await getAdminConfig('route_score_config', {}));
    const lookbackCutoff = new Date(Date.now() - cfg.lookbackDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // route_traffic_daily is keyed by route_slug, which may include
    // synthetic "(direct):BER-PAR" rows (see routeTraffic.js) that
    // don't correspond to any real route_pages row — those simply
    // never match a slug below and are harmlessly ignored here; they
    // remain visible in the raw daily table for admin auditing.
    const byRoute = new Map(); // slug -> {decayedImpressions, decayedClicks, decayedBookings}
    let from = 0;
    const pageSize = 1000;
    for (;;) {
      const { data: rows, error } = await supa.from('route_traffic_daily')
        .select('route_slug, day, impressions, clicks, booking_starts')
        .gte('day', lookbackCutoff)
        .range(from, from + pageSize - 1);
      if (error) { log('warn', 'route_score_read_failed', { error: error.message }); return; }
      if (!rows || !rows.length) break;

      for (const r of rows) {
        const age = daysAgo(r.day);
        const decay = Math.exp(-age / cfg.halfLifeDays);
        if (!byRoute.has(r.route_slug)) byRoute.set(r.route_slug, { decayedImpressions: 0, decayedClicks: 0, decayedBookings: 0 });
        const b = byRoute.get(r.route_slug);
        b.decayedImpressions += r.impressions * decay;
        b.decayedClicks += r.clicks * decay;
        b.decayedBookings += r.booking_starts * decay;
      }

      if (rows.length < pageSize) break;
      from += pageSize;
    }

    const { data: routePages, error: rpError } = await supa.from('route_pages').select('id, slug');
    if (rpError) { log('warn', 'route_score_route_pages_read_failed', { error: rpError.message }); return; }

    let updated = 0;
    for (const rp of routePages || []) {
      const traffic = byRoute.get(rp.slug) || { decayedImpressions: 0, decayedClicks: 0, decayedBookings: 0 };
      const ctr = traffic.decayedImpressions > 0 ? traffic.decayedClicks / traffic.decayedImpressions : 0;
      const score = cfg.impressionWeight * traffic.decayedImpressions
        + cfg.clickWeight * traffic.decayedClicks
        + cfg.bookingWeight * traffic.decayedBookings
        + cfg.ctrWeight * ctr;
      const confidence = computeConfidence(traffic.decayedImpressions, cfg);

      const { error: updateErr } = await supa.from('route_pages').update({
        route_score: Math.round(score * 100) / 100,
        route_score_confidence: confidence,
        route_score_updated_at: new Date().toISOString(),
      }).eq('id', rp.id);
      if (updateErr) log('warn', 'route_score_update_failed', { slug: rp.slug, error: updateErr.message });
      else updated++;
    }
    log('info', 'route_scores_computed', { updated, routesWithTraffic: byRoute.size });
  } catch (e) {
    log('warn', 'route_score_compute_cycle_failed', { error: e.message });
  }
}

setTimeout(() => { computeRouteScoresOnce(); }, 45000).unref();
setInterval(() => { computeRouteScoresOnce(); }, COMPUTE_INTERVAL_MS).unref();

module.exports = { computeRouteScoresOnce, DEFAULT_ROUTE_SCORE_CONFIG };
