// ═══════════════════════════════════════════════════════════════
// src/services/seoApply.js
// [SEO-AI-OPTIMIZE §7/§9/§18] Apply an APPROVED optimization to a route's
// generated SEO fields, and roll it back to the exact previous values.
//
// SAFETY INVARIANTS:
//   • Writes happen ONLY here (server/Render) — the browser never touches
//     Supabase or route_pages.
//   • Only the four generated SEO columns are ever written:
//       seo_title, seo_meta_description, seo_intro_html, seo_faq
//     (plus seo_lang/seo_generated_at bookkeeping). slug, canonical,
//     indexability, hreflang, and all flight data are NEVER touched.
//   • Only fields the optimization actually proposes a change for are written —
//     an unchanged field keeps its current value.
//   • Before writing, the full previous values are captured into the
//     optimization row (applied_old_values) so rollback restores them exactly,
//     with no AI regeneration.
//   • Effective atomicity: the route_pages write is a single-row update (atomic).
//     If the follow-up audit write fails, the page write is compensated (reverted)
//     so a page is never left changed without a recorded audit trail.
//   • Manual override columns (custom_title/…) are never touched and still win at
//     render time — this only writes the generated layer, exactly like the
//     existing batch generator.
// ═══════════════════════════════════════════════════════════════

const supa = require('../clients/supabase');
const log = require('../utils/log');
const store = require('./seoOptimizationStore');

const SEO_FIELDS = ['seo_title', 'seo_meta_description', 'seo_intro_html', 'seo_faq'];

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Parse the generated content block ("intro paragraph\n\nQ: ..\nA: ..") into
// safe intro HTML + a [{question, answer}] FAQ array (the shape the renderer
// expects). Pure + tolerant: text is HTML-escaped, so nothing injects markup.
function parseContentBlock(text) {
  const raw = String(text || '').trim();
  if (!raw) return { introHtml: null, faq: [] };
  const firstQ = raw.search(/\n\s*Q:/i);
  const introPart = (firstQ === -1 ? raw : raw.slice(0, firstQ)).trim();
  const faqPart = firstQ === -1 ? '' : raw.slice(firstQ);

  const introHtml = introPart
    ? introPart.split(/\n{2,}/).map((p) => `<p>${escHtml(p.replace(/\s*\n\s*/g, ' ').trim())}</p>`).join('')
    : null;

  const faq = [];
  const re = /Q:\s*([\s\S]+?)\s*\nA:\s*([\s\S]+?)(?=\n\s*Q:|$)/gi;
  let m;
  while ((m = re.exec(faqPart)) !== null) {
    const question = m[1].replace(/\s*\n\s*/g, ' ').trim();
    const answer = m[2].replace(/\s*\n\s*/g, ' ').trim();
    if (question && answer) faq.push({ question, answer });
  }
  return { introHtml, faq };
}

// Build the route_pages patch from a stored suggestion — ONLY fields the
// optimization proposes a real change for. Returns { patch, changedKeys }.
function buildSeoPatch(suggestions) {
  const s = suggestions || {};
  const patch = {};
  if (s.title && s.title.changeRecommended && s.title.proposed) patch.seo_title = String(s.title.proposed);
  if (s.meta && s.meta.changeRecommended && s.meta.proposed) patch.seo_meta_description = String(s.meta.proposed);
  if (s.content && s.content.changeRecommended && s.content.proposed) {
    const { introHtml, faq } = parseContentBlock(s.content.proposed);
    if (introHtml) patch.seo_intro_html = introHtml;
    if (faq.length) patch.seo_faq = faq;
  }
  return { patch, changedKeys: Object.keys(patch) };
}

function pickSeoFields(route) {
  const out = {};
  for (const f of SEO_FIELDS) out[f] = route[f] == null ? null : route[f];
  out.seo_lang = route.seo_lang == null ? null : route.seo_lang;
  return out;
}

function err(status, message) { return Object.assign(new Error(message), { status }); }

// Apply an APPROVED optimization to its route. Returns { optimization, slug,
// oldValues, newValues }. Throws err(status, msg) on any guard/failure.
async function applyOptimization({ id, appliedBy }) {
  if (!supa) throw err(503, 'Datenbank nicht verfügbar');
  const opt = await store.getOptimization(id);
  if (!opt) throw err(404, 'Optimierung nicht gefunden');
  if (opt.status !== 'approved') throw err(409, `Nur APPROVED kann angewendet werden (aktuell: ${opt.status})`);

  const { data: route, error: rErr } = await supa.from('route_pages')
    .select('id, slug, seo_title, seo_meta_description, seo_intro_html, seo_faq, seo_lang')
    .eq('slug', opt.slug).maybeSingle();
  if (rErr) throw err(500, rErr.message);
  if (!route) throw err(404, `Route-Page nicht gefunden: ${opt.slug}`);
  // Never clobber a different language's generated content.
  if (route.seo_lang && opt.language && route.seo_lang !== opt.language) {
    throw err(409, `Sprach-Konflikt: Route-SEO ist "${route.seo_lang}", Optimierung ist "${opt.language}"`);
  }

  const { patch, changedKeys } = buildSeoPatch(opt.suggestions);
  if (!changedKeys.length) throw err(400, 'Keine anwendbaren Änderungen in dieser Optimierung');

  const oldValues = pickSeoFields(route);
  const nowIso = new Date().toISOString();
  const writePatch = { ...patch, seo_lang: opt.language || route.seo_lang || 'de', seo_generated_at: nowIso };

  // 1) The real change — a single-row atomic update.
  const { error: wErr } = await supa.from('route_pages').update(writePatch).eq('id', route.id);
  if (wErr) throw err(500, `Seiten-Aktualisierung fehlgeschlagen: ${wErr.message}`);

  // 2) Record the audit trail. If this fails, compensate by restoring the page
  //    so we never leave a changed page without a recorded rollback path.
  const newValues = { ...patch };
  try {
    const { data: updated, error: oErr } = await supa.from('seo_route_optimizations').update({
      status: 'applied',
      applied_at: nowIso,
      applied_by: appliedBy || null,
      route_page_id: route.id,
      applied_old_values: oldValues,
      applied_new_values: newValues,
      updated_at: nowIso,
    }).eq('id', id).select('*').maybeSingle();
    if (oErr) throw new Error(oErr.message);
    return { optimization: updated, slug: route.slug, oldValues, newValues };
  } catch (e) {
    // Compensation: revert the page to its previous values.
    try { await supa.from('route_pages').update(oldValues).eq('id', route.id); } catch { /* best-effort */ }
    log('error', 'seo_apply_audit_failed_reverted', { id, error: e.message });
    throw err(500, `Audit-Speicherung fehlgeschlagen, Änderung zurückgesetzt: ${e.message}`);
  }
}

// Roll an APPLIED optimization back to the exact captured previous values. No AI
// regeneration. Returns { optimization, slug, restored }.
async function rollbackOptimization({ id, rolledBackBy, reason }) {
  if (!supa) throw err(503, 'Datenbank nicht verfügbar');
  const opt = await store.getOptimization(id);
  if (!opt) throw err(404, 'Optimierung nicht gefunden');
  if (opt.status !== 'applied') throw err(409, `Nur APPLIED kann zurückgerollt werden (aktuell: ${opt.status})`);
  if (!opt.route_page_id || !opt.applied_old_values) throw err(409, 'Keine gespeicherten Vorherwerte für Rollback');

  const old = opt.applied_old_values;
  const restore = {};
  for (const f of SEO_FIELDS) if (f in old) restore[f] = old[f];
  if ('seo_lang' in old) restore.seo_lang = old.seo_lang;
  restore.seo_generated_at = new Date().toISOString();

  const { error: wErr } = await supa.from('route_pages').update(restore).eq('id', opt.route_page_id);
  if (wErr) throw err(500, `Rollback der Seite fehlgeschlagen: ${wErr.message}`);

  const nowIso = new Date().toISOString();
  const { data: updated, error: oErr } = await supa.from('seo_route_optimizations').update({
    status: 'rolled_back',
    rolled_back_at: nowIso,
    rolled_back_by: rolledBackBy || null,
    rollback_reason: reason ? String(reason).slice(0, 500) : null,
    updated_at: nowIso,
  }).eq('id', id).select('*').maybeSingle();
  if (oErr) throw err(500, oErr.message);
  return { optimization: updated, slug: opt.slug, restored: restore };
}

module.exports = { applyOptimization, rollbackOptimization, buildSeoPatch, parseContentBlock, SEO_FIELDS };
