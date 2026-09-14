const supa = require('../clients/supabase');
const log = require('../utils/log');
const { generateRoutePage, supportedLanguages } = require('./seo/engine');
const { validateGeneratedSeo } = require('./seo/quality');
const { sortRoutesForSeo } = require('./seo/routePriority');

const SECONDARY_LANGUAGES = supportedLanguages().filter((language) => language !== 'de');
const BATCH_SIZE = 100;

async function fetchRoutes() {
  if (!supa) throw new Error('Database not available');
  const { data, error } = await supa.from('route_pages').select('*').eq('status', 'published').order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return sortRoutesForSeo(data || []);
}

async function processLocalizedRoutes({ language, limit = null, dryRun = false, force = false, progressCallback } = {}) {
  if (!SECONDARY_LANGUAGES.includes(language)) throw new Error(`Unsupported secondary SEO language: ${language}`);
  const allRoutes = await fetchRoutes();
  const routes = Number.isInteger(limit) && limit > 0 ? allRoutes.slice(0, limit) : allRoutes;
  let processed = 0, updated = 0, skipped = 0, failed = 0, qualityRejected = 0;

  for (let i = 0; i < routes.length; i += BATCH_SIZE) {
    const batch = routes.slice(i, i + BATCH_SIZE);
    for (const route of batch) {
      processed++;
      try {
        if (!force && !dryRun) {
          const { data: existing, error } = await supa.from('route_seo_locales').select('id,seo_generated_at').eq('route_page_id', route.id).eq('language', language).maybeSingle();
          if (error) throw new Error(error.message);
          if (existing && existing.seo_generated_at) { skipped++; continue; }
        }
        const gen = generateRoutePage(route, language);
        if (gen.skipped) { skipped++; continue; }
        const quality = validateGeneratedSeo(route, gen.content);
        if (!quality.valid) { qualityRejected++; continue; }
        const row = {
          route_page_id: route.id,
          language,
          seo_title: gen.content.title,
          seo_meta_description: gen.content.metaDescription,
          seo_intro_html: gen.content.intro,
          seo_faq: gen.content.faq,
          seo_angle: gen.angle,
          seo_section_count: gen.content.sections.length,
          seo_data_coverage: gen.dataCoverage || null,
          seo_generated_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        if (!dryRun) {
          const { error } = await supa.from('route_seo_locales').upsert(row, { onConflict: 'route_page_id,language' });
          if (error) throw new Error(error.message);
        }
        updated++;
      } catch (error) {
        failed++;
        log('warn', 'localized_route_seo_failed', { route_id: route.id, language, error: error.message });
      }
      if (progressCallback) progressCallback({ processed, total: routes.length, updated, skipped, failed, qualityRejected, language });
    }
    if (!dryRun) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { language, total: routes.length, processed, updated, skipped, failed, qualityRejected, dryRun, force };
}

module.exports = { SECONDARY_LANGUAGES, processLocalizedRoutes, fetchRoutes, BATCH_SIZE };
