const { generateRoutePage } = require('../src/services/seo/engine');
const { validateGeneratedSeo } = require('../src/services/seo/quality');

const ROUTE = {
  id: 'test-route',
  slug: 'berlin-madrid',
  status: 'published',
  origin_city: 'Berlin',
  destination_city: 'Madrid',
  origin_iata: 'BER',
  destination_iata: 'MAD',
  origin_country: 'Germany',
  destination_country: 'Spain',
  distance_km: 1870,
  haul_type: 'medium-haul',
  airline_count: 4,
  itinerary_count: 20,
  avg_duration_min: 180,
  min_duration_min: 165,
  price_min: 90,
  price_max: 420,
  price_avg: 180,
  price_currency: 'EUR',
  price_sample_count: 12,
  price_trend: 'stable',
  stop_distribution: { '0': 12, '1': 8 },
};

describe('secondary route SEO quality', () => {
  test.each(['en', 'fr', 'es', 'it', 'nl', 'tr', 'ar'])('generates valid %s metadata', (language) => {
    const generated = generateRoutePage(ROUTE, language);
    expect(generated.skipped).toBe(false);
    expect(generated.content.title.length).toBeGreaterThanOrEqual(30);
    expect(generated.content.title.length).toBeLessThanOrEqual(70);
    expect(generated.content.metaDescription.length).toBeGreaterThanOrEqual(90);
    expect(generated.content.metaDescription.length).toBeLessThanOrEqual(170);

    const quality = validateGeneratedSeo(ROUTE, generated.content);
    expect(quality.valid).toBe(true);
    expect(quality.reasons).toEqual([]);
  });
});
