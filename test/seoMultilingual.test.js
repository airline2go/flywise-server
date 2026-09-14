const { generateRoutePage, supportedLanguages } = require('../src/services/seo/engine');

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

  test('secondary locales are not blocked by German manual content', () => {
    const manual = { ...route, custom_title: 'Human editorial title' };
    expect(generateRoutePage(manual, 'de').skipped).toBe(true);
    expect(generateRoutePage(manual, 'en').skipped).toBe(false);
  });
});
