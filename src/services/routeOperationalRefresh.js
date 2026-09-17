const supa = require('../clients/supabase');
const env = require('../config/env');
const log = require('../utils/log');
const {
  fetchAndCacheRoutePrice,
} = require('../routes/search.routes');

const MAX_AGE_MS = (() => {
  const days = Number(process.env.SEO_ROUTE_DATA_MAX_AGE_DAYS);
  const effectiveDays = Number.isFinite(days) && days > 0 ? days : 30;
  return effectiveDays * 24 * 60 * 60 * 1000;
})();

const BATCH_SIZE = 25;
const DELAY_MS = 2000;
const INTERVAL_MS = 15 * 60 * 1000;
const START_DELAY_MS = 45000;

let running = false;

function hasDemandSignal(route) {
  if (!route) return false;
  const score = Number(route.route_score);
  if (Number.isFinite(score) && score >= 0.2) return true;
  const weekly = Number(route.weekly_flights);
  if (Number.isInteger(weekly) && weekly > 0) return true;
  return !!(route.intro_text || (route.custom_faq && route.custom_faq.length));
}

function isFresh(route, now = Date.now()) {
  if (!route || !route.insights_updated_at) return false;
  const t = new Date(route.insights_updated_at).getTime();
  return Number.isFinite(t) && now >= t && (now - t) <= MAX_AGE_MS;
}

function priority(route, now = Date.now()) {
  if (!route || !route.insights_updated_at) return Number.MIN_SAFE_INTEGER;
  const t = new Date(route.insights_updated_at).getTime();
  if (!Number.isFinite(t)) return Number.MIN_SAFE_INTEGER;
  return now - t;
}

function pickRefreshRoutes(routes, now = Date.now()) {
  const byPair = new Map();
  for (const route of routes || []) {
    if (!hasDemandSignal(route)) continue;
    if (!route.origin_iata || !route.destination_iata) continue;
    const key = `${String(route.origin_iata).toUpperCase()}_${String(route.destination_iata).toUpperCase()}`;
    const candidate = { ...route, origin_iata: String(route.origin_iata).toUpperCase(), destination_iata: String(route.destination_iata).toUpperCase() };
    const existing = byPair.get(key);
    if (!existing || priority(candidate, now) > priority(existing, now)) byPair.set(key, candidate);
  }
  return Array.from(byPair.values())
    .sort((a, b) => {
      const aFresh = isFresh(a, now) ? 1 : 0;
      const bFresh = isFresh(b, now) ? 1 : 0;
      if (aFresh !== bFresh) return aFresh - bFresh;
      return priority(b, now) - priority(a, now);
    })
    .slice(0, BATCH_SIZE);
}

async function fetchDemandRoutePages() {
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supa.from('route_pages')
      .select('id,origin_iata,destination_iata,route_score,weekly_flights,intro_text,custom_faq,insights_updated_at,status')
      .eq('status', 'published')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const batch = data || [];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  return rows;
}

async function refreshOperationalDemandRoutesOnce() {
  if (!supa || !env.SEO_ROUTE_OPERATIONAL_REFRESH_ENABLED || running) return { updated: 0, selected: 0, skipped: true };
  running = true;
  try {
    const now = Date.now();
    const routes = await fetchDemandRoutePages();
    const selected = pickRefreshRoutes(routes, now);
    let updated = 0;
    for (const route of selected) {
      try {
        await fetchAndCacheRoutePrice(route.origin_iata, route.destination_iata, 21, `route_price_${route.origin_iata}_${route.destination_iata}`);
        updated++;
        log('info', 'seo_operational_route_refreshed', {
          route: `${route.origin_iata}-${route.destination_iata}`,
          staleBeforeRefresh: !isFresh(route, now),
        });
      } catch (error) {
        log('warn', 'seo_operational_route_refresh_failed', {
          route: `${route.origin_iata}-${route.destination_iata}`,
          error: error.message,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
    }
    log('info', 'seo_operational_refresh_cycle', { selected: selected.length, updated, demandRoutes: routes.filter(hasDemandSignal).length });
    return { updated, selected: selected.length, skipped: false };
  } catch (error) {
    log('warn', 'seo_operational_refresh_cycle_failed', { error: error.message });
    return { updated: 0, selected: 0, skipped: false, error: error.message };
  } finally {
    running = false;
  }
}

if (env.SEO_ROUTE_OPERATIONAL_REFRESH_ENABLED) {
  setTimeout(() => { refreshOperationalDemandRoutesOnce(); }, START_DELAY_MS).unref();
  setInterval(() => { refreshOperationalDemandRoutesOnce(); }, INTERVAL_MS).unref();
}

module.exports = {
  hasDemandSignal,
  isFresh,
  pickRefreshRoutes,
  fetchDemandRoutePages,
  refreshOperationalDemandRoutesOnce,
};
