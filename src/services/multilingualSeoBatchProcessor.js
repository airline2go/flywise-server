const supa = require('../clients/supabase');
const log = require('../utils/log');
const { generateRoutePage, supportedLanguages } = require('./seo/engine');
const { validateGeneratedSeo } = require('./seo/quality');
const { sortRoutesForSeo } = require('./seo/routePriority');

const SECONDARY_LANGUAGES = supportedLanguages().filter((language) => language !== 'de');
const BATCH_SIZE = 100;
const ROUTE_PAGE_FETCH_SIZE = 1000;

function buildTitleDisambiguationMap(routes) {
  const byTitle = new Map();
  for (const route of routes || []) {
    if (!route.slug || !route.origin_city || !route.destination_city || !route.origin_iata || !route.destination_iata) continue;
    const key = `${route.origin_city}|${route.destination_city}`;
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(route);
  }

  const map = new Map();
  for (const routesForTitle of byTitle.values()) {
    const uniquePairs = new Set(routesForTitle.map((route) => `${route.origin_iata}-${route.destination_iata}`));
    if (uniquePairs.size < 2) continue;

    const originVaries = new Set(routesForTitle.map((route) => route.origin_iata)).size > 1;
    const destinationVaries = new Set(routesForTitle.map((route) => route.destination_iata)).size > 1;
    for (const route of routesForTitle) {
      map.set(route.slug, { origin: originVaries, destination: destinationVaries });
    }
  }
  return map;
}

function qualifySeoText(text, route, qualification) {
  let result = String(text || '');
  const qualify = (city, iata, enabled) => {
    if (!enabled || !city || !iata) return;
    const label = `${city} (${iata})`;
    if (result.includes(label) || !result.includes(city)) return;
    result = result.replace(city, label);
  };
  qualify(route.origin_city, route.origin_iata, qualification.origin);
  qualify(route.destination_city, route.destination_iata, qualification.destination);
  return result;
}

function clampMetaDescription(text, maxLength = 170) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= maxLength) return value;
  const limit = Math.max(90, maxLength - 1);
  const cut = value.slice(0, limit).replace(/\s+\S*$/, '').trim();
  return `${cut}…`;
}

async function fetchRoutes() {
  if (!supa) throw new Error('Database not available');
  const allRoutes = [];
  for (let from = 0; ; from += ROUTE_PAGE_FETCH_SIZE) {
    const { data, error } = await supa
      .from('route_pages')
      .select('*')
      .eq('status', 'published')
      .order('created_at', { ascending: false })
      .range(from, from + ROUTE_PAGE_FETCH_SIZE - 1);
    if (error) throw new Error(error.message);
    allRoutes.push(...(data || []));
    if (!data || data.length < ROUTE_PAGE_FETCH_SIZE) break;
  }
  return sortRoutesForSeo(allRoutes);
}

async function processLocalizedRoutes({ language, limit = null, offset = 0, dryRun = false, force = false, progressCallback } = {}) {
  if (!SECONDARY_LANGUAGES.includes(language)) throw new Error(`Unsupported secondary SEO language: ${language}`);
  const allRoutes = await fetchRoutes();
  const safeOffset = Number.isInteger(offset) && offset >= 0 ? offset : 0;
  const routes = Number.isInteger(limit) && limit > 0
    ? allRoutes.slice(safeOffset, safeOffset + limit)
    : allRoutes.slice(safeOffset);
  const titleDisambiguation = buildTitleDisambiguationMap(allRoutes);
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
        if (gen.skipped) {
          skipped++;
          log('info', 'localized_route_seo_skipped', { route_id: route.id, language, reasons: gen.reasons || [] });
          continue;
        }

        const qualification = titleDisambiguation.get(route.slug);
        if (qualification) {
          gen.content.title = qualifySeoText(gen.content.title, route, qualification);
          gen.content.metaDescription = clampMetaDescription(qualifySeoText(gen.content.metaDescription, route, qualification));
        } else {
          gen.content.metaDescription = clampMetaDescription(gen.content.metaDescription);
        }

        const quality = validateGeneratedSeo(route, gen.content);
        if (!quality.valid) {
          qualityRejected++;
          log('warn', 'localized_route_seo_quality_rejected', {
            route_id: route.id,
            language,
            reasons: quality.reasons,
            metrics: quality.metrics,
          });
          continue;
        }
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
  return { language, offset: safeOffset, total: routes.length, processed, updated, skipped, failed, qualityRejected, dryRun, force };
}

module.exports = { SECONDARY_LANGUAGES, processLocalizedRoutes, fetchRoutes, BATCH_SIZE, buildTitleDisambiguationMap, qualifySeoText, clampMetaDescription };
