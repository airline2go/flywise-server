// [ADMIN-DUFFEL-MONITOR] Read-only admin endpoints for the exact outbound
// Duffel attempt audit. These endpoints query Supabase only: opening or
// refreshing the dashboard can never create a Duffel API request.
const rateLimit = require('../middleware/rateLimit');
const { requireFullAdmin } = require('../middleware/auth');
const supa = require('../clients/supabase');

const MAX_LIMIT = 100;
const MAX_OFFSET = 10000;

function parseDate(value, fallback) {
  if (!value) return fallback;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

function nextDay(date) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

function range(req) {
  const today = new Date();
  const defaultFrom = new Date(today);
  defaultFrom.setUTCDate(defaultFrom.getUTCDate() - 6);
  defaultFrom.setUTCHours(0, 0, 0, 0);
  const from = parseDate(req.query.from, defaultFrom);
  const to = parseDate(req.query.to, today);
  to.setUTCHours(0, 0, 0, 0);
  return { from, toExclusive: nextDay(to) };
}

function applyCommonFilters(query, req, from, toExclusive) {
  let q = query.gte('started_at', from.toISOString()).lt('started_at', toExclusive.toISOString());
  if (req.query.source) q = q.eq('source', String(req.query.source).slice(0, 100));
  if (req.query.trigger) q = q.eq('trigger', String(req.query.trigger).slice(0, 100));
  if (req.query.status) q = q.eq('status', String(req.query.status).slice(0, 40));
  if (req.query.routeOrigin) q = q.eq('route_origin', String(req.query.routeOrigin).slice(0, 20));
  if (req.query.routeDestination) q = q.eq('route_destination', String(req.query.routeDestination).slice(0, 20));
  if (req.query.actorUserId) q = q.eq('actor_user_id', String(req.query.actorUserId).slice(0, 100));
  return q;
}

module.exports = (app) => {
  app.get('/admin/duffel-api/usage', rateLimit('admin', 120, 60000), requireFullAdmin, async (req, res) => {
    try {
      if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
      const { from, toExclusive } = range(req);

      const [daily, bySource, totals] = await Promise.all([
        supa.from('duffel_api_usage_daily')
          .select('*')
          .gte('day', from.toISOString().slice(0, 10))
          .lt('day', toExclusive.toISOString().slice(0, 10))
          .order('day', { ascending: true }),
        supa.from('duffel_api_usage_by_source')
          .select('*')
          .order('billable_attempts', { ascending: false }),
        applyCommonFilters(
          supa.from('duffel_api_call_audit').select('id,request_id,operation_id,status,success,billable_attempt,duration_ms,duffel_request_id,source,trigger,started_at,completed_at', { count: 'exact', head: true }),
          req, from, toExclusive,
        ),
      ]);

      if (daily.error) throw new Error(daily.error.message);
      if (bySource.error) throw new Error(bySource.error.message);
      if (totals.error) throw new Error(totals.error.message);

      // Views provide the unfiltered period totals. When source/trigger/etc.
      // filters are active, calculate exact filtered totals from a bounded
      // audit slice so the numbers shown beside the filters remain truthful.
      let filteredTotals = {
        outbound_attempts: totals.count || 0,
        billable_attempts: 0,
        logical_operations: 0,
        successful_attempts: 0,
        failed_or_incomplete_attempts: 0,
      };

      const hasFilters = ['source', 'trigger', 'status', 'routeOrigin', 'routeDestination', 'actorUserId']
        .some((key) => req.query[key]);
      if (hasFilters) {
        const filtered = await applyCommonFilters(
          supa.from('duffel_api_call_audit').select('operation_id,success,status,billable_attempt'),
          req, from, toExclusive,
        ).limit(5000);
        if (filtered.error) throw new Error(filtered.error.message);
        const rows = filtered.data || [];
        filteredTotals.billable_attempts = rows.filter((r) => r.billable_attempt).length;
        filteredTotals.successful_attempts = rows.filter((r) => r.success === true).length;
        filteredTotals.failed_or_incomplete_attempts = rows.filter((r) => r.success !== true).length;
        filteredTotals.logical_operations = new Set(rows.map((r) => r.operation_id).filter(Boolean)).size;
      } else {
        filteredTotals = (daily.data || []).reduce((acc, row) => ({
          outbound_attempts: acc.outbound_attempts + Number(row.outbound_attempts || 0),
          billable_attempts: acc.billable_attempts + Number(row.billable_attempts || 0),
          logical_operations: acc.logical_operations + Number(row.logical_operations || 0),
          successful_attempts: acc.successful_attempts + Number(row.successful_attempts || 0),
          failed_or_incomplete_attempts: acc.failed_or_incomplete_attempts + Number(row.failed_or_incomplete_attempts || 0),
        }), filteredTotals);
      }

      const sourceRows = bySource.data || [];
      const integrity = await supa.from('duffel_api_call_audit')
        .select('id,status,success,duffel_request_id,started_at')
        .gte('started_at', from.toISOString())
        .lt('started_at', toExclusive.toISOString())
        .order('started_at', { ascending: false })
        .limit(5000);
      if (integrity.error) throw new Error(integrity.error.message);
      const now = Date.now();
      const integrityRows = integrity.data || [];
      const staleStarted = integrityRows.filter((r) => r.status === 'started' && now - new Date(r.started_at).getTime() > 10 * 60 * 1000).length;
      const successfulMissingRequestId = integrityRows.filter((r) => r.success === true && !r.duffel_request_id).length;

      res.json({
        ok: true,
        from: from.toISOString(),
        to: new Date(toExclusive.getTime() - 1).toISOString(),
        totals: filteredTotals,
        daily: daily.data || [],
        bySource: sourceRows,
        integrity: {
          stale_started_attempts: staleStarted,
          successful_missing_duffel_request_id: successfulMissingRequestId,
          sampled_rows: integrityRows.length,
        },
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/admin/duffel-api/attempts', rateLimit('admin', 120, 60000), requireFullAdmin, async (req, res) => {
    try {
      if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
      const { from, toExclusive } = range(req);
      const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), MAX_LIMIT);
      const offset = Math.min(Math.max(Number.parseInt(req.query.offset, 10) || 0, 0), MAX_OFFSET);
      let q = applyCommonFilters(
        supa.from('duffel_api_call_audit').select([
          'id', 'request_id', 'operation_id', 'attempt_no', 'method', 'endpoint', 'source', 'trigger',
          'actor_user_id', 'actor_ip', 'actor_user_agent', 'search_session_id', 'route_origin', 'route_destination',
          'started_at', 'completed_at', 'status', 'http_status', 'success', 'billable_attempt', 'duration_ms',
          'duffel_request_id', 'duffel_client_correlation_id', 'error_code', 'error_message', 'metadata',
        ].join(','), { count: 'exact' }),
        req, from, toExclusive,
      );
      if (req.query.q) {
        const term = String(req.query.q).replace(/[(),]/g, '').slice(0, 80);
        if (term) q = q.or(`endpoint.ilike.%${term}%,source.ilike.%${term}%,trigger.ilike.%${term}%,route_origin.ilike.%${term}%,route_destination.ilike.%${term}%,duffel_request_id.ilike.%${term}%`);
      }
      const { data, error, count } = await q.order('started_at', { ascending: false }).range(offset, offset + limit - 1);
      if (error) throw new Error(error.message);
      res.json({ ok: true, rows: data || [], count: count || 0, limit, offset });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
};
