// ═══════════════════════════════════════════════════════════════
// src/services/routeIntelligence.js
// [ROUTE-INTELLIGENCE-1] Single shared "data object" shape assembled
// from a route_pages row — basic (geo/identity, already on the row),
// operational (the new columns written by fetchAndCacheRoutePrice()'s
// fire-and-forget update + refreshed periodically by
// routeIntelligenceRefresh.js), economic (deferred — stays null until
// the price-history phase exists; consumers must handle null, never
// assume it's populated).
//
// Attached by content.routes.js's GET /route-pages/:slug as
// `route.intelligence`, so the SSG build (flywise-app) has one stable
// shape to read from instead of ad hoc flat-field access scattered
// across render-flight-route.js.
// ═══════════════════════════════════════════════════════════════

function buildRouteIntelligenceSnapshot(route) {
  if (!route) return null;
  return {
    basic: {
      originCity: route.origin_city,
      destinationCity: route.destination_city,
      originCountry: route.origin_country,
      destinationCountry: route.destination_country,
      originIata: route.origin_iata,
      destinationIata: route.destination_iata,
      distanceKm: route.distance_km,
      haulType: route.haul_type,
      isDomestic: !!(route.origin_country && route.destination_country && route.origin_country === route.destination_country),
    },
    operational: {
      directFlightAvailable: route.direct_flight_available == null ? null : route.direct_flight_available,
      allDirect: route.all_direct == null ? null : route.all_direct,
      avgDurationMin: route.avg_duration_min == null ? null : route.avg_duration_min,
      minDurationMin: route.min_duration_min == null ? null : route.min_duration_min,
      stopDistribution: route.stop_distribution || null,
      airlineCount: route.airline_count == null ? null : route.airline_count,
      updatedAt: route.insights_updated_at || null,
    },
    // [ECONOMIC-INTELLIGENCE] Populated from the route_price_history
    // aggregates written by routePriceHistoryRefresh.js (price_* columns) and
    // the inline itinerary_count from the last search. Stays null as a whole
    // when the route has no observed price points yet — consumers must still
    // handle null, and every individual field is independently null when its
    // own signal is missing (e.g. priceTrend before MIN_SAMPLES_FOR_TREND).
    economic: (route.price_avg == null && route.price_min == null && route.itinerary_count == null)
      ? null
      : {
        priceMin: route.price_min == null ? null : Number(route.price_min),
        priceAvg: route.price_avg == null ? null : Number(route.price_avg),
        priceMax: route.price_max == null ? null : Number(route.price_max),
        currency: route.price_currency || null,
        sampleCount: route.price_sample_count == null ? null : route.price_sample_count,
        itineraryCount: route.itinerary_count == null ? null : route.itinerary_count,
        priceTrend: route.price_trend || null,
        updatedAt: route.price_updated_at || null,
      },
  };
}

module.exports = { buildRouteIntelligenceSnapshot };
