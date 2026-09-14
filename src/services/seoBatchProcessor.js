const supa = require('../clients/supabase');
const log = require('../utils/log');
const { generateRoutePage, assessEligibility, supportedLanguages } = require('./seo/engine');
const { validateGeneratedSeo } = require('./seo/quality');
const { sortRoutesForSeo } = require('./seo/routePriority');

const BATCH_SIZE = 50;
const PRIMARY_LANGUAGE = 'de';

async function fetchRoutePagesForUpdate() {
  if (!supa) throw new Error('Database not available');
  const { data, error } = await supa.from('route_pages').select('*').eq('status', 'published').order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return sortRoutesForSeo(data || []);
}

async function writeGenerated(route, gen, language, { dryRun = false, force = false } = {}) {
  if (!force && route.seo_generated_at && route.seo_lang === language) return { updated: false, reason: 'already generated' };
  const patch = { seo_title: gen.content.title, seo_meta_description: gen.content.metaDescription, seo_intro_html: gen.content.intro, seo_faq: gen.content.faq, seo_angle: gen.angle, seo_section_count: gen.content.sections.length, seo_data_coverage: gen.dataCoverage || null, seo_lang: language, seo_generated_at: new Date().toISOString() };
  if (dryRun) return { updated: true, preview: patch };
  const { error } = await supa.from('route_pages').update(patch).eq('id', route.id);
  if (error) { log('warn', 'route_seo_write_failed', { route_id: route.id, error: error.message }); return { updated: false, error: error.message }; }
  return { updated: true };
}

function recordQualityRejection(qualityReasons, reasons) { for (const reason of reasons || []) qualityReasons[reason] = (qualityReasons[reason] || 0) + 1; }

async function processRoutes(progressCallback, { dryRun = false, force = false, language = PRIMARY_LANGUAGE } = {}) {
  const routes = await fetchRoutePagesForUpdate();
  const total = routes.length; let processed = 0, updated = 0, skipped = 0, failed = 0, qualityRejected = 0;
  const skipReasons = {}, qualityReasons = {}, angleCounts = {};
  log('info', 'seo_batch_start', { total, dryRun, force, language });
  for (let i = 0; i < routes.length; i += BATCH_SIZE) {
    for (const route of routes.slice(i, i + BATCH_SIZE)) {
      processed++;
      try {
        const gen = generateRoutePage(route, language);
        if (gen.skipped) { skipped++; for (const r of gen.reasons) skipReasons[r] = (skipReasons[r] || 0) + 1; }
        else {
          const quality = validateGeneratedSeo(route, gen.content);
          if (!quality.valid) { qualityRejected++; recordQualityRejection(qualityReasons, quality.reasons); log('info', 'route_seo_quality_rejected', { route_id: route.id, language, reasons: quality.reasons, metrics: quality.metrics }); }
          else { const w = await writeGenerated(route, gen, language, { dryRun, force }); if (w.error) failed++; else if (w.updated) { updated++; angleCounts[gen.angle] = (angleCounts[gen.angle] || 0) + 1; } else skipped++; }
        }
      } catch (err) { failed++; log('warn', 'route_processing_error', { route: route.id, error: err.message }); }
      if (progressCallback) progressCallback({ processed, total, updated, skipped, failed, qualityRejected, current: `${route.origin_city} → ${route.destination_city}` });
    }
    if (!dryRun) await new Promise((r) => setTimeout(r, 100));
  }
  const summary = { total, processed, updated, skipped, failed, qualityRejected, skipReasons, qualityReasons, angleCounts, dryRun, force, language };
  log('info', 'seo_batch_complete', summary); return summary;
}

async function processSingleRoute(routeId, language = PRIMARY_LANGUAGE, { dryRun = false, force = true } = {}) {
  if (!supa) throw new Error('Database not available');
  const { data: route, error } = await supa.from('route_pages').select('*').eq('id', routeId).maybeSingle();
  if (error) throw new Error(error.message); if (!route) throw new Error(`Route ${routeId} not found`);
  const gen = generateRoutePage(route, language);
  if (gen.skipped) return { skipped: true, reasons: gen.reasons };
  const quality = validateGeneratedSeo(route, gen.content);
  if (!quality.valid) return { skipped: true, qualityRejected: true, reasons: quality.reasons, metrics: quality.metrics };
  const w = await writeGenerated(route, gen, language, { dryRun, force });
  return { skipped: false, angle: gen.angle, content: gen.content, ...w };
}

async function generateStatistics() {
  const routes = await fetchRoutePagesForUpdate(); let eligible = 0, manual = 0, insufficient = 0, alreadyGenerated = 0;
  const reasonCounts = {}, haulCounts = {};
  for (const route of routes) {
    if (route.seo_generated_at) alreadyGenerated++;
    const gate = assessEligibility(route);
    if (gate.eligible) { eligible++; haulCounts[route.haul_type] = (haulCounts[route.haul_type] || 0) + 1; continue; }
    if (gate.reasons.includes('manually edited content present')) manual++; else insufficient++;
    for (const r of gate.reasons) reasonCounts[r] = (reasonCounts[r] || 0) + 1;
  }
  return { total_published_routes: routes.length, eligible_for_generation: eligible, already_generated: alreadyGenerated, skipped_manual_content: manual, skipped_insufficient_data: insufficient, skip_reason_breakdown: reasonCounts, eligible_by_haul: haulCounts, languages_supported: supportedLanguages() };
}

module.exports = { processRoutes, processSingleRoute, generateStatistics, fetchRoutePagesForUpdate, writeGenerated, BATCH_SIZE, PRIMARY_LANGUAGE };
