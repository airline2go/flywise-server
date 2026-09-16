const { hasUnsupportedClaim, hasUnbackedFact, generatedFieldIsSafe, hasPriceEvidence } = require('../src/services/seo/truthfulness');
const { effectiveRouteSeo } = require('../src/services/seo/effective');
const { validateGeneratedSeo } = require('../src/services/seo/quality');

describe('generated route SEO truthfulness', () => {
  const route = { origin_city: 'London', destination_city: 'Zürich', distance_km: 800, avg_duration_min: 105, airline_count: 8, price_min: 41, price_avg: 65, price_currency: 'EUR', direct_flight_available: true };
  test('rejects unsupported booking-window and weekday-price claims', () => {
    expect(hasUnsupportedClaim('Ein Vorlauf von zwei bis drei Wochen ist ideal.')).toBe(true);
    expect(hasUnsupportedClaim('Dienstag und Mittwoch sind meist günstiger.')).toBe(true);
    expect(hasUnsupportedClaim('Early booking is better.')).toBe(true);
  });
  test('rejects unsupported airline-density, realtime-volume and weekend claims', () => {
    expect(hasUnsupportedClaim('Diese Dichte drückt die Preise.')).toBe(true);
    expect(hasUnsupportedClaim('Airpiv vergleicht in Echtzeit hunderte Airlines für diese Strecke.')).toBe(true);
    expect(hasUnsupportedClaim('Die Strecke eignet sich sehr gut für einen Wochenendtrip.')).toBe(true);
  });
  test('rejects direct-flight and alternate-airport claims when no route signal exists', () => {
    const unverified = { avg_duration_min: 105, airline_count: 2 };
    expect(hasUnsupportedClaim('Direktflüge sind verfügbar.')).toBe(false);
    expect(hasUnbackedFact(unverified, 'Direktflüge sind verfügbar.')).toBe(true);
    expect(hasUnsupportedClaim('Madrid wird auch von einem anderen Flughafen bedient.')).toBe(true);
  });
  test('allows factual route observations', () => {
    expect(hasUnsupportedClaim('Die beobachtete Flugzeit liegt bei rund 105 Minuten.')).toBe(false);
    expect(generatedFieldIsSafe(route, '8 Airlines sind im Routendatensatz vertreten.')).toBe(true);
    expect(generatedFieldIsSafe(route, 'Beobachtete Tarife beginnen bei etwa 41 EUR.')).toBe(true);
    expect(generatedFieldIsSafe(route, 'Direktflüge sind im beobachteten Datensatz vertreten.')).toBe(true);
  });
  test('rejects price claims when currency is missing', () => {
    expect(hasPriceEvidence({ price_min: 41, price_currency: null })).toBe(false);
    expect(hasUnbackedFact({ price_min: 41, price_currency: null }, 'Ab 41 €')).toBe(true);
  });
  test('effectiveRouteSeo keeps manual content and filters unsafe generated FAQ items', () => {
    const effective = effectiveRouteSeo({ ...route, custom_title: 'Manual title', seo_title: 'Flüge von London nach Zürich – Preise | Airpiv', seo_meta_description: 'Diese Dichte drückt die Preise auf dieser Strecke.', seo_intro_html: '<p>Ein Vorlauf von zwei bis drei Wochen ist ideal.</p>', seo_faq: [{ question: 'Wie lange?', answer: '105 Minuten beobachtet.' }, { question: 'Wann buchen?', answer: 'Zwei bis drei Wochen sind ideal.' }] });
    expect(effective.title).toBe('Manual title');
    expect(effective.metaDescription).toBeNull(); expect(effective.introHtml).toBeNull();
    expect(effective.faq).toEqual([{ question: 'Wie lange?', answer: '105 Minuten beobachtet.' }]);
    expect(effective.source.title).toBe('manual');
  });
  test('quality gate rejects unsupported generated claims before persistence', () => {
    const result = validateGeneratedSeo(route, { title: 'Flüge von London nach Zürich – Preise, Flugzeit & Airlines | Airpiv', metaDescription: 'Vergleiche Flugpreise, Flugzeit, Airlines und Direktflüge von London nach Zürich. Prüfe die verfügbaren Routendaten auf Airpiv.', introPlain: 'Ein Vorlauf von zwei bis drei Wochen ist ideal für diese Strecke.', sections: [{ heading: 'Airlines', body: '8 Airlines sind im Routendatensatz vertreten.' }, { heading: 'Buchungsstrategie', body: 'Dienstag und Mittwoch sind meist günstiger.' }], faq: [{ question: 'Wie lange?', answer: '105 Minuten beobachtet.' }, { question: 'Wann buchen?', answer: 'Zwei bis drei Wochen sind ideal.' }] });
    expect(result.valid).toBe(false); expect(result.reasons).toEqual(expect.arrayContaining(['unsupported intro claim', 'unsupported section claim', 'unsupported FAQ claim']));
  });
});
