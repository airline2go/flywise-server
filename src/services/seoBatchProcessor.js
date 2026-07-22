// ═══════════════════════════════════════════════════════════════════════════
// src/services/seoBatchProcessor.js
// Batch processes all route pages, cities, and countries to generate and apply
// unique SEO content. Processes in batches to manage database load.
// ═══════════════════════════════════════════════════════════════════════════

const supa = require('../clients/supabase');
const log = require('../utils/log');
const {
  generateRouteIntroText,
  generateRouteTitle,
  generateMetaDescription,
  generateRouteFaq,
  estimateFlightDuration,
  BEST_TIME_ADVICE,
  MONEY_SAVING_TIPS,
  CITY_INTROS,
  COUNTRY_INTROS
} = require('./seoContentGenerator');

const SUPPORTED_LANGUAGES = ['en', 'de', 'fr', 'es', 'it', 'nl', 'ar', 'tr'];
const BATCH_SIZE = 50;

// Fetch all route pages that need SEO content
async function fetchRoutePagesForUpdate() {
  if (!supa) throw new Error('Database not available');

  const { data, error } = await supa
    .from('route_pages')
    .select('*')
    .eq('status', 'published')
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);
  return data || [];
}

// Fetch all cities
async function fetchCitiesForUpdate() {
  if (!supa) throw new Error('Database not available');

  const { data, error } = await supa
    .from('cities')
    .select('*')
    .eq('status', 'published');

  if (error) throw new Error(error.message);
  return data || [];
}

// Fetch all countries
async function fetchCountriesForUpdate() {
  if (!supa) throw new Error('Database not available');

  const { data, error } = await supa
    .from('countries')
    .select('*')
    .eq('status', 'published');

  if (error) throw new Error(error.message);
  return data || [];
}

// Generate SEO content for a route
function generateRouteContent(route, language) {
  try {
    const duration = estimateFlightDuration(route.distance_km || 1000);

    const intro = generateRouteIntroText(
      route.origin_city,
      route.destination_city,
      route.distance_km || 1000,
      route.haul_type || 'short-haul',
      language
    );

    const title = generateRouteTitle(
      route.origin_city,
      route.destination_city,
      language
    );

    const metaDescription = generateMetaDescription(
      route.origin_city,
      route.destination_city,
      route.haul_type || 'short-haul',
      language
    );

    const faq = generateRouteFaq(
      route.origin_city,
      route.destination_city,
      route.distance_km || 1000,
      duration,
      route.haul_type || 'short-haul',
      language
    );

    return {
      intro,
      title,
      metaDescription,
      faq
    };
  } catch (err) {
    log('warn', 'seo_content_generation_failed', {
      route: `${route.origin_city}-${route.destination_city}`,
      language,
      error: err.message
    });
    return null;
  }
}

// Update route page with SEO content
async function updateRoutePageSEO(routeId, route, language, content) {
  if (!supa) throw new Error('Database not available');

  const updateData = {};

  // Only set fields if they don't already have manual custom content
  if (!route.custom_title) updateData.custom_title = content.title;
  if (!route.custom_meta_description) updateData.custom_meta_description = content.metaDescription;
  if (!route.custom_faq) updateData.custom_faq = content.faq;
  if (!route.intro_text) updateData.intro_text = content.intro;

  if (Object.keys(updateData).length === 0) return true;

  const { error } = await supa
    .from('route_pages')
    .update(updateData)
    .eq('id', routeId);

  if (error) {
    log('warn', 'route_seo_update_failed', { route_id: routeId, error: error.message });
    return false;
  }

  return true;
}

// Process routes in batches
async function processRoutes(progressCallback) {
  try {
    const routes = await fetchRoutePagesForUpdate();
    const totalRoutes = routes.length;
    let processed = 0;
    let updated = 0;
    let failed = 0;

    log('info', 'seo_batch_start', { total_routes: totalRoutes });

    for (let i = 0; i < routes.length; i += BATCH_SIZE) {
      const batch = routes.slice(i, i + BATCH_SIZE);

      for (const route of batch) {
        try {
          // Generate content for all supported languages
          const allLanguageContent = {};
          for (const lang of SUPPORTED_LANGUAGES) {
            allLanguageContent[lang] = generateRouteContent(route, lang);
          }

          // Update the route (using primary language first)
          const primaryLangContent = allLanguageContent['en'] || allLanguageContent['de'];
          if (primaryLangContent) {
            const success = await updateRoutePageSEO(route.id, route, 'primary', primaryLangContent);
            if (success) {
              updated++;
            } else {
              failed++;
            }
          }

          processed++;
          if (progressCallback) {
            progressCallback({
              processed,
              total: totalRoutes,
              updated,
              failed,
              current: `${route.origin_city} → ${route.destination_city}`
            });
          }
        } catch (err) {
          failed++;
          processed++;
          log('warn', 'route_processing_error', {
            route: route.id,
            error: err.message
          });
        }
      }

      // Batch sleep to avoid database overload
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    log('info', 'seo_batch_complete', {
      total: totalRoutes,
      processed,
      updated,
      failed
    });

    return { processed, updated, failed, total: totalRoutes };
  } catch (err) {
    log('error', 'seo_batch_process_failed', { error: err.message });
    throw err;
  }
}

// Process a single route
async function processSingleRoute(routeId, language = 'en') {
  try {
    if (!supa) throw new Error('Database not available');

    const { data: route, error } = await supa
      .from('route_pages')
      .select('*')
      .eq('id', routeId)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!route) throw new Error(`Route ${routeId} not found`);

    const content = generateRouteContent(route, language);
    if (!content) throw new Error('Failed to generate SEO content');

    await updateRoutePageSEO(routeId, language, content);

    log('info', 'single_route_seo_generated', {
      route_id: routeId,
      language,
      route: `${route.origin_city}-${route.destination_city}`
    });

    return content;
  } catch (err) {
    log('error', 'single_route_processing_failed', {
      route_id: routeId,
      error: err.message
    });
    throw err;
  }
}

// Check if a route page already has manual SEO content
function hasManualSEOContent(route) {
  return !!(route.custom_title || route.custom_meta_description || route.custom_faq || route.intro_text);
}

// Generate summary statistics
async function generateStatistics() {
  try {
    const routes = await fetchRoutePagesForUpdate();
    const withManual = routes.filter(r => hasManualSEOContent(r)).length;
    const withoutManual = routes.length - withManual;

    return {
      total_routes: routes.length,
      with_manual_seo: withManual,
      without_manual_seo: withoutManual,
      ready_for_generation: withoutManual,
      languages_supported: SUPPORTED_LANGUAGES.length
    };
  } catch (err) {
    log('error', 'statistics_generation_failed', { error: err.message });
    throw err;
  }
}

module.exports = {
  processRoutes,
  processSingleRoute,
  generateStatistics,
  fetchRoutePagesForUpdate,
  fetchCitiesForUpdate,
  fetchCountriesForUpdate,
  generateRouteContent,
  hasManualSEOContent,
  SUPPORTED_LANGUAGES,
  BATCH_SIZE
};
