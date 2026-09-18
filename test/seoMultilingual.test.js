const { generateRoutePage, supportedLanguages } = require('../src/services/seo/engine');
const { validateGeneratedSeo } = require('../src/services/seo/quality');
const { buildTitleDisambiguationMap, qualifySeoText, clampMetaDescription } = require('../src/services/multilingualSeoBatchProcessor');

const route = {
  id: '00000000-0000-0000-0000-000000000001', slug: 'berlin-paris', status: 'published',
  origin_city: 'Berlin', origin_iata: 'BER', origin_country: 'DE',
  destination_city: 'Paris', destination_iata: 'CDG', destination_country: 'FR',
  distance_km: 878, haul_type: 'short-haul', airline_count: 6, itinerary_count: 20,
  all_direct: true, direct_flight_available: true, stop_distribution: { '0': 10, '1': 0 },
  avg_duration_min: 105, min_duration_min: 95, price_min: 49, price_max: 220,
  price_avg: 90, price_currency: 'EUR', price_trend: 'stable', price_sample_count: 20,
  route_score: 80, route_score_confidence: 'high',
  custom_title: null, custom_meta_description: null, custom_faq: null, intro_text: null,
};

describe('multilingual route SEO', () => {
  test('supports all eight target locales', () => {
    expect(supportedLanguages()).toEqual(expect.arrayContaining(['de','en','fr','es','it','nl','tr','ar']));
    expect(supportedLanguages()).toHaveLength(8);
  });

  test.each(['en','fr','es','it','nl','tr','ar'])('generates native secondary content for %s', (language) => {
    const result = generateRoutePage(route, language);
    expect(result.skipped).toBe(false);
    expect(result.content.title).toBeTruthy();
    expect(result.content.metaDescription).toBeTruthy();
    expect(result.content.sections.length).toBeGreaterThanOrEqual(3);
    expect(result.content.faq.length).toBeGreaterThanOrEqual(3);
  });

  test('secondary locales can render evidence-backed routes without distance', () => {
    const missingDistance = {
      ...route,
      slug: 'madrid-alicante',
      distance_km: null,
      avg_duration_min: 101,
      min_duration_min: 70,
      itinerary_count: 56,
      price_sample_count: 13,
    };
    for (const language of ['en', 'fr', 'es', 'it', 'nl', 'tr']) {
      const result = generateRoutePage(missingDistance, language);
      expect(result.skipped).toBe(false);
      expect(validateGeneratedSeo(missingDistance, result.content).valid).toBe(true);
    }
  });

  test('secondary metadata stays truthfulness-safe for sparse route evidence', () => {
    const sparse = {
      ...route,
      slug: 'cgd-dub',
      origin_city: 'Changde',
      origin_iata: 'CGD',
      destination_city: 'Dublin',
      destination_iata: 'DUB',
      distance_km: 9084,
      haul_type: 'long-haul',
      airline_count: 5,
      itinerary_count: null,
      avg_duration_min: null,
      min_duration_min: null,
      price_min: 542.23,
      price_max: 542.23,
      price_avg: 542.23,
      price_currency: 'EUR',
      price_trend: null,
      price_sample_count: 1,
      direct_flight_available: null,
      all_direct: null,
      stop_distribution: null,
    };
    for (const language of ['en', 'fr', 'es', 'it', 'nl', 'tr']) {
      const result = generateRoutePage(sparse, language);
      expect(result.skipped).toBe(false);
      expect(result.content.title.length).toBeGreaterThanOrEqual(30);
      expect(result.content.title.length).toBeLessThanOrEqual(70);
      expect(result.content.metaDescription.length).toBeGreaterThanOrEqual(90);
      expect(result.content.metaDescription.length).toBeLessThanOrEqual(170);
      expect(validateGeneratedSeo(sparse, result.content).valid).toBe(true);
    }
  });

  test('secondary locales are not blocked by German manual content', () => {
    const manual = { ...route, custom_title: 'Human editorial title' };
    expect(generateRoutePage(manual, 'de').skipped).toBe(true);
    expect(generateRoutePage(manual, 'en').skipped).toBe(false);
  });

  test('qualifies only genuinely colliding city-pair routes', () => {
    const a = { ...route, slug: 'fra-ham', origin_city: 'Frankfurt', origin_iata: 'FRA', destination_city: 'Hamburg', destination_iata: 'HAM' };
    const b = { ...route, slug: 'fra-xfw', origin_city: 'Frankfurt', origin_iata: 'FRA', destination_city: 'Hamburg', destination_iata: 'XFW' };
    const c = { ...route, slug: 'ber-par', origin_city: 'Berlin', origin_iata: 'BER', destination_iata: 'CDG', destination_city: 'Paris' };
    const map = buildTitleDisambiguationMap([a, b, c]);

    expect(map.get('fra-ham')).toEqual({ origin: false, destination: true });
    expect(map.get('fra-xfw')).toEqual({ origin: false, destination: true });
    expect(map.has('ber-par')).toBe(false);

    expect(qualifySeoText('Flights from Frankfurt to Hamburg for cheap fares', a, map.get('fra-ham')))
      .toBe('Flights from Frankfurt to Hamburg (HAM) for cheap fares');
    expect(qualifySeoText('Flights from Berlin to Paris', c, { origin: false, destination: false }))
      .toBe('Flights from Berlin to Paris');
  });

  test('clamps a disambiguated meta description back inside the quality gate', () => {
    const duplicate = { ...route, slug: 'pmi-lhr', origin_city: 'Palma de Mallorca', origin_iata: 'PMI', destination_city: 'London', destination_iata: 'LHR' };
    const long = 'Compare flights from Palma de Mallorca to London using route data on fares, airlines, flight time and direct options. Use the available route evidence when planning your trip.';
    const qualified = qualifySeoText(long, duplicate, { origin: true, destination: true });
    const clamped = clampMetaDescription(qualified);

    expect(qualified.length).toBeGreaterThan(170);
    expect(clamped.length).toBeLessThanOrEqual(170);
    expect(clamped.length).toBeGreaterThanOrEqual(90);
    expect(clamped).toContain('Palma de Mallorca (PMI)');
    expect(clamped).toContain('London (LHR)');
  });

  test.each(['fr','es','it','nl','tr'])('does not leak English or German secondary prose into %s', (language) => {
    const result = generateRoutePage(route, language);
    expect(result.skipped).toBe(false);
    const text = [
      result.content.intro,
      result.content.introPlain,
      ...result.content.sections.map((section) => section.heading + ' ' + section.body),
      ...result.content.faq.map((item) => item.question + ' ' + item.answer),
    ].join(' ');
    expect(text).not.toMatch(/Observed flight time|are represented in the route data|Direct and connecting options|Check terminal and ground-transport/i);
    expect(text).not.toMatch(/\bStd\.\b|\bMin\.\b|\bshort-haul\b|\bmedium-haul\b|\blong-haul\b/);
  });
});
