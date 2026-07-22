const { effectiveRouteSeo, nonEmpty } = require('../src/services/seo/effective');

describe('effectiveRouteSeo — manual always wins over generated', () => {
  test('manual fields override generated ones', () => {
    const seo = effectiveRouteSeo({
      custom_title: 'Human title', seo_title: 'Generated title',
      custom_meta_description: 'Human meta', seo_meta_description: 'Generated meta',
      intro_text: 'Human intro', seo_intro_html: '<p>Generated intro</p>',
      custom_faq: [{ question: 'hq', answer: 'ha' }], seo_faq: [{ question: 'gq', answer: 'ga' }],
    });
    expect(seo.title).toBe('Human title');
    expect(seo.metaDescription).toBe('Human meta');
    expect(seo.introHtml).toBe('Human intro');
    expect(seo.faq[0].question).toBe('hq');
    expect(seo.source).toEqual({ title: 'manual', metaDescription: 'manual', intro: 'manual', faq: 'manual' });
  });

  test('falls back to generated when manual is empty', () => {
    const seo = effectiveRouteSeo({
      custom_title: null, seo_title: 'Generated title',
      custom_meta_description: '', seo_meta_description: 'Generated meta',
      intro_text: null, seo_intro_html: '<p>Generated intro</p>',
      custom_faq: [], seo_faq: [{ question: 'gq', answer: 'ga' }],
    });
    expect(seo.title).toBe('Generated title');
    expect(seo.metaDescription).toBe('Generated meta');
    expect(seo.introHtml).toBe('<p>Generated intro</p>');
    expect(seo.faq[0].question).toBe('gq');
    expect(seo.source.title).toBe('generated');
    expect(seo.source.faq).toBe('generated');
  });

  test('empty custom_faq array is treated as no manual FAQ', () => {
    const seo = effectiveRouteSeo({ custom_faq: [], seo_faq: [{ question: 'g', answer: 'g' }] });
    expect(seo.faq[0].question).toBe('g');
  });

  test('none when neither manual nor generated present', () => {
    const seo = effectiveRouteSeo({});
    expect(seo.title).toBeNull();
    expect(seo.faq).toBeNull();
    expect(seo.source.title).toBe('none');
  });

  test('nonEmpty helper', () => {
    expect(nonEmpty('x')).toBe(true);
    expect(nonEmpty('  ')).toBe(false);
    expect(nonEmpty([])).toBe(false);
    expect(nonEmpty([1])).toBe(true);
    expect(nonEmpty(null)).toBe(false);
  });
});
