const { validateGeneratedSeo } = require('../src/services/seo/quality');

describe('validateGeneratedSeo', () => {
  const route = { origin_city: 'Berlin', destination_city: 'Paris', airline_count: 2 };
  const good = {
    title: 'Flüge von Berlin nach Paris: Flugzeit, Preise und Tipps',
    metaDescription: 'Flüge von Berlin nach Paris vergleichen: Flugzeit, Airlines, Preise und praktische Tipps für die Reiseplanung.',
    introPlain: 'Berlin und Paris verbinden zwei wichtige europäische Reiseziele. Hier finden Reisende aktuelle Informationen zur Strecke, zu Flugzeit, Airlines und weiteren relevanten Faktoren für die Planung.',
    sections: [{ heading: 'Flugzeit', body: 'Informationen zur Flugzeit.' }, { heading: 'Airlines', body: 'Informationen zu Airlines.' }],
    faq: [{ question: 'Wie lange dauert der Flug?', answer: 'Die genaue Dauer hängt vom Angebot ab.' }, { question: 'Welche Airlines fliegen?', answer: 'Die verfügbaren Airlines werden aus den beobachteten Angeboten ermittelt.' }],
  };

  test('accepts a complete route page with verified evidence', () => {
    expect(validateGeneratedSeo(route, good).valid).toBe(true);
  });

  test('rejects a route without verified evidence by default', () => {
    const result = validateGeneratedSeo({ ...route, airline_count: 0, distance_km: 500 }, good);
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain('no verified flight evidence');
  });

  test('rejects duplicate FAQ questions', () => {
    const result = validateGeneratedSeo(route, { ...good, faq: [good.faq[0], good.faq[0]] });
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain('duplicate FAQ questions');
  });

  test('can run without evidence requirement for report-only callers', () => {
    expect(validateGeneratedSeo({ origin_city: 'Berlin', destination_city: 'Paris' }, good, { requireEvidence: false }).valid).toBe(true);
  });
});
