// ═══════════════════════════════════════════════════════════════════════
// src/services/indexabilityData.js
// ─────────────────────────────────────────────────────────────────────────
// Loads the raw rows the indexability rules need (the published route set and
// the airline→route observation rows) and memoizes them for a short window.
//
// Why the cache: the sitemap index pulls /route-pages, /cities, /countries,
// /airports and /airlines back-to-back when it regenerates. Cities, countries
// and airports all derive their `indexable` flag from the SAME published-route
// connectivity, so without memoization each of those requests would re-scan the
// full route table. A small TTL collapses one regeneration cycle's reads into a
// single scan — keeping API/DB load minimal even at hundreds of thousands of
// rows — while staying fresh enough that a publish/unpublish shows up quickly.
//
// PostgREST caps a single response at (by default) 1000 rows, so the route scan
// pages explicitly with .range() until a short page signals the end — correct
// beyond 1000 routes, which is the whole point of a scalable sitemap.
// ═══════════════════════════════════════════════════════════════════════
const supa = require('../clients/supabase');
const { buildConnectivity, airlineRouteCounts } = require('./indexability');

const PAGE = 1000;
const TTL_MS = 60 * 1000; // 60s: one sitemap regeneration cycle reuses one scan

let cache = null; // { at, connectivity, airlineCounts }

async function fetchAllPublishedRoutes() {
  const cols = 'origin_iata,destination_iata,origin_city_slug,destination_city_slug,origin_country,destination_country';
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supa.from('route_pages')
      .select(cols)
      .eq('status', 'published')
      .order('slug', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const batch = data || [];
    out.push(...batch);
    if (batch.length < PAGE) break;
  }
  return out;
}

async function fetchObservedAirlineRows() {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supa.from('route_airlines')
      .select('airline_id,route_origin_iata,route_destination_iata')
      .order('airline_id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const batch = data || [];
    out.push(...batch);
    if (batch.length < PAGE) break;
  }
  return out;
}

// Returns { connectivity, airlineCounts } — connectivity for city/country/
// airport rules, airlineCounts (Map airline_id -> min(count,2)) for airlines.
async function getIndexabilityData() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache;
  const routes = await fetchAllPublishedRoutes();
  const connectivity = buildConnectivity(routes);
  const observed = await fetchObservedAirlineRows();
  const airlineCounts = airlineRouteCounts(observed, routes);
  cache = { at: Date.now(), connectivity, airlineCounts };
  return cache;
}

// Test/ops hook — drop the memoized scan so the next call reloads.
function clearIndexabilityCache() { cache = null; }

module.exports = { getIndexabilityData, clearIndexabilityCache };
