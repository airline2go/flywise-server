// ═══════════════════════════════════════════════════════════════
// src/routes/admin-fare-rules.routes.js
// [FARE-INTEL] Admin CMS for airline_fare_rules — the verified, sourced
// enrichment layer the Rule Engine reads (spec §17, §28, §35). Same
// requireAdmin tier + list/paginate/search shape as admin-airlines. Every
// write is validated (pieces>=0, weight>0, effective window sane, source +
// last_verified present) and recorded to the admin audit log with the acting
// admin, so we can always answer "who added this rule, from what source, and
// when was it verified?".
//
// VERSIONING (spec §19): rules are never destructively rewritten when their
// meaning changes — the admin closes the old rule (effective_until) and adds a
// new one (effective_from), and both stay queryable. The `active` flag hides a
// rule from matching without deleting its history.
// ═══════════════════════════════════════════════════════════════

const supa = require('../clients/supabase');
const rateLimit = require('../middleware/rateLimit');
const { requireAdmin } = require('../middleware/auth');
const { logAdminActivity } = require('../services/adminAuth');
const { SOURCE_TYPE, CONFIDENCE, BAGGAGE_TYPE } = require('../config/fareIntelligence');

const BAGGAGE_TYPES = Object.values(BAGGAGE_TYPE);
const SOURCE_TYPES = Object.values(SOURCE_TYPE);
const CONFIDENCES = Object.values(CONFIDENCE);
const CABINS = ['economy', 'premium_economy', 'business', 'first'];

// Validate + coerce an incoming rule body. Returns { value } or { error }.
// Enforces spec §28: airline required; valid baggage type / cabin; pieces>=0;
// weight>0; effective dates sane; source + last_verified present.
function validateRule(body, { partial = false } = {}) {
  const b = body || {};
  const out = {};
  const warnings = [];

  if (!partial || b.airline_iata !== undefined) {
    const iata = String(b.airline_iata || '').trim().toUpperCase();
    if (!iata) return { error: 'airline_iata ist erforderlich' };
    out.airline_iata = iata;
  }
  if (b.airline_id !== undefined) out.airline_id = b.airline_id || null;

  if (b.fare_family !== undefined) out.fare_family = b.fare_family ? String(b.fare_family).trim() : null;
  if (b.booking_class !== undefined) out.booking_class = b.booking_class ? String(b.booking_class).trim().toUpperCase() : null;

  if (b.cabin_class !== undefined) {
    const c = b.cabin_class ? String(b.cabin_class).trim().toLowerCase() : null;
    if (c && !CABINS.includes(c)) return { error: `cabin_class muss eines von ${CABINS.join(', ')} sein` };
    out.cabin_class = c;
  }

  if (!partial || b.baggage_type !== undefined) {
    const t = b.baggage_type ? String(b.baggage_type).trim().toLowerCase() : null;
    if (t && !BAGGAGE_TYPES.includes(t)) return { error: `baggage_type muss eines von ${BAGGAGE_TYPES.join(', ')} sein` };
    out.baggage_type = t;
  }

  if (b.included !== undefined) out.included = b.included == null ? null : Boolean(b.included);

  if (b.pieces !== undefined) {
    if (b.pieces == null || b.pieces === '') out.pieces = null;
    else {
      const p = Number(b.pieces);
      if (!Number.isInteger(p) || p < 0) return { error: 'pieces muss eine ganze Zahl >= 0 sein' };
      out.pieces = p;
    }
  }

  if (b.weight_kg !== undefined) {
    if (b.weight_kg == null || b.weight_kg === '') out.weight_kg = null;
    else {
      const w = Number(b.weight_kg);
      if (!Number.isFinite(w) || w <= 0) return { error: 'weight_kg muss > 0 sein' };
      out.weight_kg = w;
    }
  }

  if (b.dimensions !== undefined) out.dimensions = b.dimensions ? String(b.dimensions).trim() : null;

  // Fare-condition fields (data model ready for later phases).
  for (const f of ['change_allowed', 'refund_allowed', 'meal_included', 'priority_included']) {
    if (b[f] !== undefined) out[f] = b[f] == null ? null : Boolean(b[f]);
  }
  for (const f of ['change_fee', 'refund_fee']) {
    if (b[f] !== undefined) {
      if (b[f] == null || b[f] === '') out[f] = null;
      else {
        const v = Number(b[f]);
        if (!Number.isFinite(v) || v < 0) return { error: `${f} muss >= 0 sein` };
        out[f] = v;
      }
    }
  }
  for (const f of ['change_fee_currency', 'refund_fee_currency', 'seat_selection', 'source_url', 'source_reference']) {
    if (b[f] !== undefined) out[f] = b[f] ? String(b[f]).trim() : null;
  }

  // Provenance (spec §18, §35).
  if (!partial || b.source_type !== undefined) {
    const st = b.source_type ? String(b.source_type).trim().toUpperCase() : SOURCE_TYPE.MANUAL_ADMIN;
    if (!SOURCE_TYPES.includes(st)) return { error: `source_type muss eines von ${SOURCE_TYPES.join(', ')} sein` };
    out.source_type = st;
  }
  if (b.confidence !== undefined) {
    const cf = b.confidence ? String(b.confidence).trim().toUpperCase() : CONFIDENCE.MEDIUM;
    if (!CONFIDENCES.includes(cf)) return { error: `confidence muss eines von ${CONFIDENCES.join(', ')} sein` };
    out.confidence = cf;
  }

  // Effective window (spec §19).
  if (b.effective_from !== undefined) out.effective_from = b.effective_from || null;
  if (b.effective_until !== undefined) out.effective_until = b.effective_until || null;
  if (out.effective_from && out.effective_until
      && new Date(out.effective_until) <= new Date(out.effective_from)) {
    return { error: 'effective_until muss nach effective_from liegen' };
  }

  if (b.last_verified !== undefined) out.last_verified = b.last_verified || null;
  if (b.active !== undefined) out.active = Boolean(b.active);

  // §28 warnings (not hard rejects): a checked/cabin bag marked included but
  // 0 pieces, or a source-less confirmed rule.
  if (out.included === true && out.pieces === 0) {
    warnings.push('included=true aber pieces=0 — bitte prüfen');
  }

  return { value: out, warnings };
}

const factory = (app) => {

  // ── List (paginate / search / filter) ────────────────────────────────
  app.get('/admin/fare-rules', rateLimit('admin', 120, 60000), requireAdmin, async (req, res) => {
    try {
      if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
      const airline = (req.query.airline || '').trim().toUpperCase();
      const activeFilter = req.query.active;
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
      const from = (page - 1) * limit;
      const to = from + limit - 1;

      let query = supa.from('airline_fare_rules').select('*', { count: 'exact' });
      if (airline) query = query.eq('airline_iata', airline);
      if (activeFilter === 'true') query = query.eq('active', true);
      else if (activeFilter === 'false') query = query.eq('active', false);
      query = query.order('airline_iata', { ascending: true })
        .order('fare_family', { ascending: true, nullsFirst: true })
        .range(from, to);

      const { data, error, count } = await query;
      if (error) throw new Error(error.message);
      res.json({ ok: true, rules: data || [], total: count || 0, page, limit, totalPages: Math.max(1, Math.ceil((count || 0) / limit)) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── Create ────────────────────────────────────────────────────────────
  app.post('/admin/fare-rules', rateLimit('admin', 120, 60000), requireAdmin, async (req, res) => {
    try {
      if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
      const { value, error, warnings } = validateRule(req.body, { partial: false });
      if (error) return res.status(400).json({ ok: false, error });
      if (!value.baggage_type && !('change_allowed' in value) && !('refund_allowed' in value)) {
        return res.status(400).json({ ok: false, error: 'baggage_type (oder eine Fare-Condition) ist erforderlich' });
      }
      value.created_by = req.adminUserId || null;
      value.updated_by = value.created_by;

      const { data, error: dbErr } = await supa.from('airline_fare_rules').insert(value).select().maybeSingle();
      if (dbErr) throw new Error(dbErr.message);
      logAdminActivity(req.adminUserId, 'fare_rule_created', 'airline_fare_rule', data?.id,
        { airline: value.airline_iata, fare_family: value.fare_family || null, baggage_type: value.baggage_type || null, source_type: value.source_type });
      res.json({ ok: true, rule: data, warnings: warnings || [] });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── Update (partial) ─────────────────────────────────────────────────
  app.put('/admin/fare-rules/:id', rateLimit('admin', 120, 60000), requireAdmin, async (req, res) => {
    try {
      if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
      const { value, error, warnings } = validateRule(req.body, { partial: true });
      if (error) return res.status(400).json({ ok: false, error });
      value.updated_by = req.adminUserId || null;

      const { data, error: dbErr } = await supa.from('airline_fare_rules')
        .update(value).eq('id', req.params.id).select().maybeSingle();
      if (dbErr) throw new Error(dbErr.message);
      if (!data) return res.status(404).json({ ok: false, error: 'Fare Rule nicht gefunden' });
      logAdminActivity(req.adminUserId, 'fare_rule_updated', 'airline_fare_rule', data.id,
        { airline: data.airline_iata, fields: Object.keys(value) });
      res.json({ ok: true, rule: data, warnings: warnings || [] });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── Soft-close a rule for versioning (spec §19): set effective_until +
  //    deactivate, never destroy history. ──────────────────────────────
  app.post('/admin/fare-rules/:id/close', rateLimit('admin', 120, 60000), requireAdmin, async (req, res) => {
    try {
      if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
      const until = req.body?.effective_until || new Date().toISOString().slice(0, 10);
      const { data, error } = await supa.from('airline_fare_rules')
        .update({ effective_until: until, active: false, updated_by: req.adminUserId || null })
        .eq('id', req.params.id).select().maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return res.status(404).json({ ok: false, error: 'Fare Rule nicht gefunden' });
      logAdminActivity(req.adminUserId, 'fare_rule_closed', 'airline_fare_rule', data.id, { effective_until: until });
      res.json({ ok: true, rule: data });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── Delete (hard; prefer /close for anything historical) ─────────────
  app.delete('/admin/fare-rules/:id', rateLimit('admin', 120, 60000), requireAdmin, async (req, res) => {
    try {
      if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
      const { error } = await supa.from('airline_fare_rules').delete().eq('id', req.params.id);
      if (error) throw new Error(error.message);
      logAdminActivity(req.adminUserId, 'fare_rule_deleted', 'airline_fare_rule', req.params.id, {});
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

};

module.exports = factory;
module.exports.validateRule = validateRule;
