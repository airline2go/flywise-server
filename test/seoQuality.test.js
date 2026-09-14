const { validateGeneratedSeo, hasEvidence } = require('../src/services/seo/quality');

describe('validateGeneratedSeo', () => {
  const route = { origin_city: 'Berlin', destination_city: 'Paris', airline_count: 4, itinerary_count: 20 };
  const good = {
    title: 'Flüge von Berlin nach Paris: Flugzeit, Preise und Tipps',
    metaDescription: 'Flüge von Berlin nach Paris vergleichen: Flugzeit, Airlines, Preise und praktische Tipps für die Reiseplanung.',
    introPlain: 'Berlin und Paris verbinden zwei wichtige europäische Reiseziele. Hier finden Reisende aktuelle Informationen zur Strecke, zu Flugzeit, Airlines und weiteren relevanten Faktoren für die Planung.',
    sections: [{ heading: 'Flugzeit', body: 'Informationen zur Flugzeit.' }, { heading: 'Airlines', body: 'Informationen zu Airlines.' }],
    faq: [{ question: 'Wie lange dauert der Flug?', answer: 'Die genaue Dauer hängt vom Angebot ab.' }, { question: 'Welche Airlines fliegen?', answer: 'Die verfügbaren Airlines werden aus den beobachteten Angeboten ermittelt.' }],
  };

  test('accepts a complete, evidence-backed route page', () => {
    expect(validateGeneratedSeo(route, good).valid).toBe(true);
  });

  test('rejects a structurally weak page', () => {
    const result = validateGeneratedSeo(route, { title: 'Berlin Paris', metaDescription: 'Flüge', introPlain: 'Kurz', sections: [], faq: [] });
    expect(result.valid).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining([
      'title length outside 30-70', 'meta length outside 90-170', 'intro too short',
      'fewer than 2 sections', 'fewer than 2 FAQ entries',
    ]));
  });

  test('rejects a polished-looking page when the route has no verified evidence', () => {
    const result = validateGeneratedSeo({ origin_city: 'Berlin', destination_city: 'Paris', distance_km: 878 }, good);
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain('no verified flight evidence');
  });

  test('allows explicit report-only validation without evidence requirement', () => {
    expect(validateGeneratedSeo({ origin_city: 'Berlin', destination_city: 'Paris' }, good, { requireEvidence: false }).valid).toBe(true);
  });

  test('rejects duplicate FAQ questions', () => {
    const content = { ...good, faq: [good.faq[0], { ...good.faq[0] }] };
    expect(validateGeneratedSeo(route, content).reasons).toContain('duplicate FAQ questions');
  });

  test('recognizes all canonical evidence signals', () => {
    expect(hasEvidence({ airline_count: 1 })).toBe(true);
    expect(hasEvidence({ avg_duration_min: 90 })).toBe(true);
    expect(hasEvidence({ price_sample_count: 1 })).toBe(true);
    expect(hasEvidence({ itinerary_count: 1 })).toBe(true);
    expect(hasEvidence({ stop_distribution: { '0': 1 } })).toBe(true);
    expect(hasEvidence({ distance_km: 900, airline_count: 0 })).toBe(false);
  });
});
