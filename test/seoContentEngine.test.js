const {
  generateRouteContent,
  assessRouteEligibility,
  hasManualContent,
  supportedLanguages,
  estimateDurationHours,
} = require('../src/services/seoContentEngine');

function route(overrides = {}) {
  return {
    slug: 'berlin-london',
    origin_iata: 'BER', destination_iata: 'LHR',
    origin_city: 'Berlin', destination_city: 'London',
    origin_country: 'DE', destination_country: 'GB',
    distance_km: 930, haul_type: 'short-haul',
    status: 'published',
    custom_title: null, custom_meta_description: null, custom_faq: null, intro_text: null,
    ...overrides,
  };
}

describe('quality gate', () => {
  test('eligible route with full data passes', () => {
    expect(assessRouteEligibility(route()).eligible).toBe(true);
  });

  test('missing distance is skipped', () => {
    const g = assessRouteEligibility(route({ distance_km: null }));
    expect(g.eligible).toBe(false);
    expect(g.reasons).toContain('missing distance_km');
  });

  test('unpublished route is skipped', () => {
    expect(assessRouteEligibility(route({ status: 'draft' })).eligible).toBe(false);
  });

  test('missing city name is skipped', () => {
    expect(assessRouteEligibility(route({ destination_city: '' })).eligible).toBe(false);
  });

  test('generateRouteContent returns skipped for insufficient data', () => {
    const res = generateRouteContent(route({ distance_km: 0 }), 'de');
    expect(res.skipped).toBe(true);
    expect(res.content).toBeUndefined();
  });
});

describe('manual content protection', () => {
  test.each([
    ['custom_title', { custom_title: 'Hand-written' }],
    ['custom_meta_description', { custom_meta_description: 'Hand-written' }],
    ['intro_text', { intro_text: 'Hand-written intro' }],
    ['custom_faq', { custom_faq: [{ question: 'q', answer: 'a' }] }],
  ])('hasManualContent true when %s set', (_label, overrides) => {
    expect(hasManualContent(route(overrides))).toBe(true);
  });

  test('empty custom_faq array is not manual content', () => {
    expect(hasManualContent(route({ custom_faq: [] }))).toBe(false);
  });

  test('route with any manual field is skipped by the engine', () => {
    const res = generateRouteContent(route({ intro_text: 'existing' }), 'de');
    expect(res.skipped).toBe(true);
    expect(res.reasons).toContain('manually edited content present');
  });
});

describe('content generation', () => {
  test('produces all required fields for a valid route', () => {
    const res = generateRouteContent(route(), 'de');
    expect(res.skipped).toBe(false);
    expect(res.content.title).toBeTruthy();
    expect(res.content.metaDescription).toBeTruthy();
    expect(res.content.intro.length).toBeGreaterThan(200);
    expect(res.content.faq.length).toBeGreaterThanOrEqual(3);
    res.content.faq.forEach((f) => {
      expect(f.question).toBeTruthy();
      expect(f.answer).toBeTruthy();
    });
  });

  test('weaves in real route-specific distance', () => {
    const res = generateRouteContent(route({ distance_km: 930 }), 'de');
    expect(res.content.intro).toContain('930');
  });

  test('unsupported language is skipped, not faked', () => {
    const res = generateRouteContent(route(), 'xx');
    expect(res.skipped).toBe(true);
  });

  test('same route is deterministic (stable for Google)', () => {
    const a = generateRouteContent(route(), 'de');
    const b = generateRouteContent(route(), 'de');
    expect(a.content.intro).toBe(b.content.intro);
    expect(a.content.title).toBe(b.content.title);
  });
});

describe('variation across routes — the core anti-duplication rule', () => {
  // Build many distinct short-haul routes and confirm the engine spreads them
  // across structurally different intro variants rather than reusing one.
  const cities = [
    ['berlin', 'Berlin', 'BER'], ['muenchen', 'Munich', 'MUC'], ['hamburg', 'Hamburg', 'HAM'],
    ['koeln', 'Cologne', 'CGN'], ['stuttgart', 'Stuttgart', 'STR'], ['wien', 'Vienna', 'VIE'],
    ['zuerich', 'Zurich', 'ZRH'], ['amsterdam', 'Amsterdam', 'AMS'], ['bruessel', 'Brussels', 'BRU'],
    ['prag', 'Prague', 'PRG'], ['warschau', 'Warsaw', 'WAW'], ['kopenhagen', 'Copenhagen', 'CPH'],
  ];
  const routes = [];
  for (let i = 0; i < cities.length; i++) {
    for (let j = 0; j < cities.length; j++) {
      if (i === j) continue;
      routes.push(route({
        slug: `${cities[i][0]}-${cities[j][0]}`,
        origin_city: cities[i][1], origin_iata: cities[i][2],
        destination_city: cities[j][1], destination_iata: cities[j][2],
        distance_km: 400 + ((i * 31 + j * 17) % 1000),
      }));
    }
  }

  test('intros use multiple distinct variant structures', () => {
    // Strip city/number specifics to compare the underlying template skeleton.
    const skeletons = new Set(
      routes.map((r) => {
        const res = generateRouteContent(r, 'de');
        return res.content.intro
          .replace(new RegExp(r.origin_city, 'g'), 'X')
          .replace(new RegExp(r.destination_city, 'g'), 'Y')
          .replace(/\d+/g, 'N')
          .slice(0, 60);
      })
    );
    // With 4 short-haul German variants, a healthy spread should surface most.
    expect(skeletons.size).toBeGreaterThanOrEqual(3);
  });

  test('titles vary across routes too', () => {
    const titleSkeletons = new Set(
      routes.map((r) => {
        const res = generateRouteContent(r, 'de');
        return res.content.title
          .replace(new RegExp(r.origin_city, 'g'), 'X')
          .replace(new RegExp(r.destination_city, 'g'), 'Y')
          .replace(new RegExp(r.origin_iata, 'g'), 'O')
          .replace(new RegExp(r.destination_iata, 'g'), 'D');
      })
    );
    expect(titleSkeletons.size).toBeGreaterThanOrEqual(2);
  });
});

describe('derived facts', () => {
  test('duration grows with distance and stays plausible', () => {
    expect(estimateDurationHours(900)).toBeLessThan(estimateDurationHours(6000));
    expect(estimateDurationHours(900)).toBeGreaterThanOrEqual(1);
  });

  test('supportedLanguages only lists languages with real variant pools', () => {
    const langs = supportedLanguages();
    expect(langs).toContain('de');
    expect(langs).toContain('en');
  });
});
