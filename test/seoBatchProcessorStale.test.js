const { shouldSkipGeneratedSeo } = require('../src/services/seoBatchProcessor');

describe('SEO batch generated-copy refresh policy', () => {
  test('skips current generated copy when force is off', () => {
    const route = {
      seo_generated_at: '2026-09-17T17:00:00Z',
      seo_lang: 'de',
      insights_updated_at: '2026-09-17T16:00:00Z',
      price_updated_at: '2026-09-17T16:30:00Z',
    };
    expect(shouldSkipGeneratedSeo(route, 'de', false)).toBe(true);
  });

  test('does not skip stale generated copy when operational data is newer', () => {
    const route = {
      seo_generated_at: '2026-09-17T12:00:00Z',
      seo_lang: 'de',
      insights_updated_at: '2026-09-17T16:00:00Z',
    };
    expect(shouldSkipGeneratedSeo(route, 'de', false)).toBe(false);
  });

  test('does not skip stale generated copy when pricing data is newer', () => {
    const route = {
      seo_generated_at: '2026-09-17T12:00:00Z',
      seo_lang: 'de',
      price_updated_at: '2026-09-17T17:00:00Z',
    };
    expect(shouldSkipGeneratedSeo(route, 'de', false)).toBe(false);
  });

  test('force always bypasses the skip guard', () => {
    const route = {
      seo_generated_at: '2026-09-17T17:00:00Z',
      seo_lang: 'de',
      insights_updated_at: '2026-09-17T16:00:00Z',
    };
    expect(shouldSkipGeneratedSeo(route, 'de', true)).toBe(false);
  });

  test('language mismatch does not suppress generation', () => {
    const route = {
      seo_generated_at: '2026-09-17T17:00:00Z',
      seo_lang: 'de',
      insights_updated_at: '2026-09-17T16:00:00Z',
    };
    expect(shouldSkipGeneratedSeo(route, 'en', false)).toBe(false);
  });
});
