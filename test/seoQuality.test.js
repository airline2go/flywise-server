const { validateGeneratedSeo } = require('../src/services/seo/quality');

describe('validateGeneratedSeo', () => {
  const route = { origin_city: 'Berlin', destination_city: 'Paris' };
  const good = {
    title: 'Flüge von Berlin nach Paris: Flugzeit, Preise und Tipps',
    metaDescription: 'Flüge von Berlin nach Paris vergleichen: Flugzeit, Airlines, Preise und praktische Tipps für die Reiseplanung.',
    introPlain: 'Berlin und Paris verbinden zwei wichtige europäische Reiseziele. Hier finden Reisende aktuelle Informationen zur Strecke, zu Flugzeit, Airlines und weiteren relevanten Faktoren für die Planung.',
    sections: [{ heading: 'Flugzeit', body: 'Informationen zur Flugzeit.' }, { heading: 'Airlines', body: 'Informationen zu Airlines.' }],
    faq: [{ question: 'Wie lange dauert der Flug?', answer: 'Die genaue Dauer hängt vom Angebot ab.' }, { question: 'Welche Airlines fliegen?', answer: 'Die verfügbaren Airlines werden aus den beobachteten Angeboten ermittelt.' }],
  };

  test('accepts a complete route page', () => {
    expect(validateGeneratedSeo(route, good).valid).toBe(true);
  });

  test('rejects weak metadata and thin content', () => {
    const result = validateGeneratedSeo(route, { title: 'Berlin Paris', metaDescription: 'Flüge', introPlain: 'Kurz', sections: [], faq: [] });
    expect(result.valid).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining([
      'title length outside 30-70',
      'meta length outside 90-170',
      'intro too short',
      'fewer than 2 sections',
      'fewer than 2 FAQ entries',
    ]));
  });
});
