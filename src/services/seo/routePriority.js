// SEO batch ordering: prioritize routes with the strongest real-world evidence and
// the highest information density before weaker eligible routes. This changes
// ordering only; the existing eligibility + quality gates remain authoritative.
function routeSeoPriorityScore(route) {
  if (!route) return -Infinity;
  let score = 0;
  if (route.airline_count > 0) score += 40;
  if (route.itinerary_count > 0) score += 30;
  if (route.price_sample_count > 0) score += 25;
  if (route.avg_duration_min > 0) score += 20;
  if (route.stop_distribution && typeof route.stop_distribution === 'object' && Object.keys(route.stop_distribution).length) score += 15;
  if (route.price_min != null) score += 10;
  if (route.route_score != null) score += 8;
  if (route.direct_flight_available != null) score += 5;
  if (route.distance_km != null) score += 2;
  // Prefer refreshes of existing SEO only when force is explicitly requested;
  // default batches should first cover pages that have no generated SEO.
  if (!route.seo_generated_at) score += 12;
  return score;
}

function sortRoutesForSeo(routes) {
  return [...(routes || [])].sort((a, b) => {
    const delta = routeSeoPriorityScore(b) - routeSeoPriorityScore(a);
    if (delta !== 0) return delta;
    const ac = a && a.created_at ? new Date(a.created_at).getTime() : 0;
    const bc = b && b.created_at ? new Date(b.created_at).getTime() : 0;
    return bc - ac;
  });
}

module.exports = { routeSeoPriorityScore, sortRoutesForSeo };
