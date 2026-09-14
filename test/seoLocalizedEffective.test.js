const { effectiveLocalizedRouteSeo } = require('../src/services/seo/localizedEffective');

describe('localized effective SEO', () => {
  test('resolves generated localized fields without touching manual route fields', () => {
    const result = effectiveLocalizedRouteSeo({
      language: 'fr',
      seo_title: 'Vols Berlin Paris',
      seo_meta_description: 'Comparez les vols.',
      seo_intro_html: '<p>Intro</p>',
      seo_faq: [{ question: 'Q', answer: 'A' }],
      seo_angle: 'price',
      seo_generated_at: '2026-09-14T00:00:00Z',
      seo_data_coverage: ['price'],
    });
    expect(result.language).toBe('fr');
    expect(result.source).toBe('localized-generated');
    expect(result.title).toBe('Vols Berlin Paris');
    expect(result.faq).toHaveLength(1);
  });
});
