// ═══════════════════════════════════════════════════════════════
// src/services/seoOptimizationStore.js
// [SEO-AI-OPTIMIZE §16-18] Persistence for generated SEO optimizations. Each
// generated suggestion is stored in public.seo_route_optimizations (service-role
// only) so recommendations aren't lost, a route's history is auditable, and a
// human review lifecycle (generated → reviewed → approved/rejected → applied)
// can be tracked. This is an audit/record layer ONLY — nothing here writes to a
// live page. All functions degrade gracefully (return null / []) when Supabase
// isn't configured, exactly like the rest of the backend.
// ═══════════════════════════════════════════════════════════════

const supa = require('../clients/supabase');
const log = require('../utils/log');

const TABLE = 'seo_route_optimizations';
const STATUSES = ['generated', 'reviewed', 'approved', 'rejected', 'applied'];
// Which timestamp column a status transition stamps (audit trail).
const STATUS_STAMP = { reviewed: 'reviewed_at', approved: 'approved_at', applied: 'applied_at' };

// Store one generated optimization. Best-effort: a storage failure never breaks
// generation (the suggestion is still returned to the operator). Returns the new
// row's id, or null when storage is unavailable/failed.
async function storeOptimization({ slug, language, source, model, dominantIntent, gsc, suggestions, createdBy }) {
  if (!supa || !slug || !suggestions) return null;
  const s = suggestions || {};
  const record = {
    slug,
    language: language || 'de',
    source: source || 'ai',
    model: model || null,
    dominant_intent: dominantIntent || null,
    gsc: gsc || null,
    suggestions,
    proposed_title: (s.title && s.title.proposed) || null,
    proposed_meta: (s.meta && s.meta.proposed) || null,
    status: 'generated',
    created_by: createdBy || null,
    updated_at: new Date().toISOString(),
  };
  try {
    const { data, error } = await supa.from(TABLE).insert(record).select('id').single();
    if (error) throw new Error(error.message);
    return data ? data.id : null;
  } catch (e) {
    log('warn', 'seo_optimization_store_failed', { slug, error: e.message });
    return null;
  }
}

// List a route's stored optimizations, newest first. Returns [] on any problem.
async function listOptimizations({ slug, language, limit }) {
  if (!supa || !slug) return [];
  try {
    let q = supa.from(TABLE)
      .select('id, slug, language, source, model, dominant_intent, proposed_title, proposed_meta, status, created_by, created_at, updated_at, reviewed_by, reviewed_at, approved_at, applied_at')
      .eq('slug', slug)
      .order('created_at', { ascending: false })
      .limit(Math.min(50, Math.max(1, limit || 20)));
    if (language) q = q.eq('language', language);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data || [];
  } catch (e) {
    log('warn', 'seo_optimization_list_failed', { slug, error: e.message });
    return [];
  }
}

// Fetch one stored optimization in full (incl. the suggestions JSON).
async function getOptimization(id) {
  if (!supa || !id) return null;
  try {
    const { data, error } = await supa.from(TABLE).select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(error.message);
    return data || null;
  } catch (e) {
    log('warn', 'seo_optimization_get_failed', { id, error: e.message });
    return null;
  }
}

// Transition a stored optimization's review status (audit: who + when). Returns
// the updated row, or throws with a `.status` for the route to map to HTTP.
async function updateOptimizationStatus({ id, status, reviewedBy }) {
  if (!supa) throw Object.assign(new Error('Datenbank nicht verfügbar'), { status: 503 });
  if (!id) throw Object.assign(new Error('id erforderlich'), { status: 400 });
  if (!STATUSES.includes(status)) throw Object.assign(new Error(`Ungültiger Status (erlaubt: ${STATUSES.join(', ')})`), { status: 400 });
  const patch = { status, updated_at: new Date().toISOString() };
  if (reviewedBy) patch.reviewed_by = reviewedBy;
  if (STATUS_STAMP[status]) patch[STATUS_STAMP[status]] = new Date().toISOString();
  const { data, error } = await supa.from(TABLE).update(patch).eq('id', id).select('*').maybeSingle();
  if (error) throw Object.assign(new Error(error.message), { status: 500 });
  if (!data) throw Object.assign(new Error('Optimierung nicht gefunden'), { status: 404 });
  return data;
}

module.exports = { storeOptimization, listOptimizations, getOptimization, updateOptimizationStatus, STATUSES, TABLE };
