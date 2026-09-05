// [P1-2] Pure helpers for building the revalidation `entities` payload from a
// route row, and de-duplicating many routes' entities into one batched payload.
// Extracted from admin.routes.js so they can be unit-tested without the route
// handler's DB/Duffel wiring.

// A route change affects its own page plus the entity pages that share its
// connectivity graph: both countries, both cities, and both airports.
function routeEntities(route) {
  const entities = [{ type: 'route', slug: route.slug }];
  if (route.origin_country) entities.push({ type: 'country', slug: route.origin_country });
  if (route.destination_country) entities.push({ type: 'country', slug: route.destination_country });
  if (route.origin_city_slug) entities.push({ type: 'city', slug: route.origin_city_slug });
  if (route.destination_city_slug) entities.push({ type: 'city', slug: route.destination_city_slug });
  if (route.origin_iata) entities.push({ type: 'airport', slug: route.origin_iata });
  if (route.destination_iata) entities.push({ type: 'airport', slug: route.destination_iata });
  return entities;
}

// Merge many routes' entity lists into ONE de-duplicated payload (keyed by
// type+slug) so a batch job fires a single revalidation call, not thousands.
function dedupeEntities(lists) {
  const seen = new Set();
  const out = [];
  for (const e of (lists || []).flat()) {
    if (!e || !e.type || !e.slug) continue;
    const k = `${e.type}:${e.slug}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

module.exports = { routeEntities, dedupeEntities };
