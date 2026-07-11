// ═══════════════════════════════════════════════════════════════
// src/services/routeTraffic.js
// [ROUTE-SCORE-4A] First-party route-page traffic logging — the
// tracking pipeline routeScore.js reads from. Fire-and-forget insert,
// same shape as apiLogs.js's recordApiLog(): never throws into the
// caller, never slows down the real request.
//
// A raw event's route_slug can be null (a /search/{IATA}-{IATA}
// landing that didn't arrive via a route-page CTA click — no way to
// attribute it to one specific route_pages row when several language
// variants share the same origin/destination pair). The daily rollup
// still records these under a synthetic per-pair key so they stay
// visible/auditable, they just don't contribute to any single route's
// score (which is keyed by the real route_pages.slug).
// ═══════════════════════════════════════════════════════════════

const supa = require('../clients/supabase');
const log = require('../utils/log');
const { getAdminConfig } = require('./adminConfig');

const EVENT_TYPES = ['impression', 'click', 'booking_start'];
const RAW_EVENT_RETENTION_DAYS_DEFAULT = 90;
const ROLLUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // once a day is enough — rollup isn't time-critical

function directKey(originIata, destinationIata) {
  const o = (originIata || '').toUpperCase();
  const d = (destinationIata || '').toUpperCase();
  return '(direct):' + o + '-' + d;
}

function recordRouteTrafficEvent({ eventType, slug, originIata, destinationIata, language }) {
  if (!supa) return;
  if (!EVENT_TYPES.includes(eventType)) return;
  try {
    supa.from('route_traffic_events').insert({
      event_type: eventType,
      route_slug: slug || null,
      origin_iata: originIata ? String(originIata).toUpperCase() : null,
      destination_iata: destinationIata ? String(destinationIata).toUpperCase() : null,
      language: language || null,
    }).then(({ error }) => {
      if (error) log('warn', 'route_traffic_event_insert_failed', { error: error.message });
    });
  } catch (e) {
    log('warn', 'route_traffic_event_insert_failed', { error: e.message });
  }
}

// Aggregates yesterday-and-earlier raw events (anything not already
// rolled up) into route_traffic_daily, then prunes raw rows past the
// configured retention window. The rollup itself (route_traffic_daily)
// is never pruned — it's the permanent record.
async function rollupAndPruneRouteTraffic() {
  if (!supa) return;
  try {
    const retentionDays = await getAdminConfig('route_traffic_retention_days', RAW_EVENT_RETENTION_DAYS_DEFAULT);
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    // Roll up everything older than "now minus a small safety margin"
    // (an hour) so we never aggregate an event that's still mid-flight
    // for the current day's bucket while a request is being written.
    const rollupBefore = new Date(Date.now() - 60 * 60 * 1000);

    let from = 0;
    const pageSize = 1000;
    const buckets = new Map(); // "slug|day" -> {slug, day, impressions, clicks, booking_starts}

    for (;;) {
      const { data: rows, error } = await supa.from('route_traffic_events')
        .select('event_type, route_slug, origin_iata, destination_iata, created_at')
        .lt('created_at', rollupBefore.toISOString())
        .range(from, from + pageSize - 1);
      if (error) { log('warn', 'route_traffic_rollup_read_failed', { error: error.message }); return; }
      if (!rows || !rows.length) break;

      for (const r of rows) {
        const day = r.created_at.slice(0, 10); // YYYY-MM-DD
        const slug = r.route_slug || directKey(r.origin_iata, r.destination_iata);
        const key = slug + '|' + day;
        if (!buckets.has(key)) buckets.set(key, { route_slug: slug, day, impressions: 0, clicks: 0, booking_starts: 0 });
        const b = buckets.get(key);
        if (r.event_type === 'impression') b.impressions++;
        else if (r.event_type === 'click') b.clicks++;
        else if (r.event_type === 'booking_start') b.booking_starts++;
      }

      if (rows.length < pageSize) break;
      from += pageSize;
    }

    if (buckets.size) {
      // Merge into existing rollup rows rather than overwrite — a slug/day
      // bucket may already have counts from a previous rollup cycle if
      // events kept trickling in for an already-rolled-up day.
      const keys = Array.from(buckets.values()).map((b) => ({ route_slug: b.route_slug, day: b.day }));
      const { data: existing, error: existingErr } = await supa.from('route_traffic_daily')
        .select('route_slug, day, impressions, clicks, booking_starts')
        .in('route_slug', keys.map((k) => k.route_slug));
      if (existingErr) log('warn', 'route_traffic_rollup_existing_read_failed', { error: existingErr.message });

      const existingMap = new Map();
      (existing || []).forEach((e) => existingMap.set(e.route_slug + '|' + e.day, e));

      const upserts = Array.from(buckets.values()).map((b) => {
        const prior = existingMap.get(b.route_slug + '|' + b.day);
        return {
          route_slug: b.route_slug,
          day: b.day,
          impressions: (prior ? prior.impressions : 0) + b.impressions,
          clicks: (prior ? prior.clicks : 0) + b.clicks,
          booking_starts: (prior ? prior.booking_starts : 0) + b.booking_starts,
        };
      });

      const { error: upsertErr } = await supa.from('route_traffic_daily').upsert(upserts, { onConflict: 'route_slug,day' });
      if (upsertErr) { log('warn', 'route_traffic_rollup_upsert_failed', { error: upsertErr.message }); return; }

      const { error: deleteErr } = await supa.from('route_traffic_events').delete().lt('created_at', rollupBefore.toISOString());
      if (deleteErr) log('warn', 'route_traffic_rollup_delete_failed', { error: deleteErr.message });
      else log('info', 'route_traffic_rolled_up', { buckets: buckets.size });
    }

    // Prune raw rows past retention regardless of rollup status (a row
    // this old has certainly already been rolled up in a prior cycle).
    const { error: pruneErr } = await supa.from('route_traffic_events').delete().lt('created_at', cutoff.toISOString());
    if (pruneErr) log('warn', 'route_traffic_prune_failed', { error: pruneErr.message });
  } catch (e) {
    log('warn', 'route_traffic_rollup_cycle_failed', { error: e.message });
  }
}

// Starts ~1 minute after boot, then once a day — same .unref() pattern
// as warmRoutePricesOnce() in search.routes.js, so these timers never
// keep the process alive on their own during shutdown.
setTimeout(() => { rollupAndPruneRouteTraffic(); }, 60000).unref();
setInterval(() => { rollupAndPruneRouteTraffic(); }, ROLLUP_INTERVAL_MS).unref();

module.exports = { recordRouteTrafficEvent, rollupAndPruneRouteTraffic, EVENT_TYPES };
