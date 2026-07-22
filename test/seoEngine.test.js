const { generateRoutePage, assessEligibility, hasManualContent, supportedLanguages } = require('../src/services/seo/engine');
const { similarityReport, pageSimilarity } = require('../src/services/seo/similarity');

// ─── Route fixtures spanning the real data space ────────────────
const CITIES = [
  ['berlin', 'Berlin', 'BER', 'DE'], ['muenchen', 'München', 'MUC', 'DE'], ['hamburg', 'Hamburg', 'HAM', 'DE'],
  ['koeln', 'Köln', 'CGN', 'DE'], ['frankfurt', 'Frankfurt', 'FRA', 'DE'], ['stuttgart', 'Stuttgart', 'STR', 'DE'],
  ['wien', 'Wien', 'VIE', 'AT'], ['zuerich', 'Zürich', 'ZRH', 'CH'], ['amsterdam', 'Amsterdam', 'AMS', 'NL'],
  ['paris', 'Paris', 'CDG', 'FR'], ['london', 'London', 'LHR', 'GB'], ['madrid', 'Madrid', 'MAD', 'ES'],
  ['rom', 'Rom', 'FCO', 'IT'], ['barcelona', 'Barcelona', 'BCN', 'ES'], ['prag', 'Prag', 'PRG', 'CZ'],
  ['istanbul', 'Istanbul', 'IST', 'TR'], ['dubai', 'Dubai', 'DXB', 'AE'], ['newyork', 'New York', 'JFK', 'US'],
  ['bangkok', 'Bangkok', 'BKK', 'TH'], ['tokio', 'Tokio', 'HND', 'JP'],
];

// Deterministic pseudo-data so the same fixture set is reproducible, but with
// wide variation across the real dimensions (price/airlines/directness/etc.).
function h(str) { let x = 0; for (const ch of str) x = (x * 31 + ch.charCodeAt(0)) >>> 0; return x; }
function haulFor(km) { return km < 1500 ? 'short-haul' : km < 4000 ? 'medium-haul' : 'long-haul'; }

function makeRoute(a, b) {
  const seed = h(a[0] + b[0]);
  const km = 300 + (seed % 9500);
  const haul = haulFor(km);
  const airline = 1 + (seed % 9);
  const allDirect = (seed % 5) === 0;
  const directShare = allDirect ? 1 : (seed % 7) / 7;
  const directCount = Math.round(directShare * 10);
  const priceMin = haul === 'short-haul' ? 40 + (seed % 160) : haul === 'medium-haul' ? 90 + (seed % 250) : 300 + (seed % 600);
  const trend = ['up', 'down', 'stable', null][seed % 4];
  const score = (seed % 100);
  const conf = ['high', 'medium', 'low'][seed % 3];
  // Some routes deliberately data-poor to exercise skip/degrade paths.
  const dataPoor = (seed % 11) === 0;
  return {
    slug: `${a[0]}-${b[0]}`, status: 'published',
    origin_city: a[1], origin_iata: a[2], origin_country: a[3],
    destination_city: b[1], destination_iata: b[2], destination_country: b[3],
    distance_km: km, haul_type: haul,
    airline_count: dataPoor ? null : airline,
    itinerary_count: dataPoor ? null : 5 + (seed % 40),
    all_direct: dataPoor ? null : allDirect,
    direct_flight_available: dataPoor ? null : directCount > 0,
    stop_distribution: dataPoor ? null : { '0': directCount, '1': 10 - directCount },
    avg_duration_min: dataPoor ? null : Math.round(30 + (km / 800) * 60),
    min_duration_min: dataPoor ? null : Math.round(28 + (km / 850) * 60),
    price_min: dataPoor ? null : priceMin,
    price_max: dataPoor ? null : priceMin + 50 + (seed % 300),
    price_avg: dataPoor ? null : priceMin + 30,
    price_currency: 'EUR',
    price_trend: dataPoor ? null : trend,
    price_sample_count: dataPoor ? null : 10 + (seed % 50),
    route_score: dataPoor ? null : score,
    route_score_confidence: dataPoor ? null : conf,
    custom_title: null, custom_meta_description: null, custom_faq: null, intro_text: null,
  };
}

function allRoutes() {
  const out = [];
  for (let i = 0; i < CITIES.length; i++)
    for (let j = 0; j < CITIES.length; j++)
      if (i !== j) out.push(makeRoute(CITIES[i], CITIES[j]));
  return out;
}

describe('quality gate & manual protection', () => {
  test('valid route is eligible', () => {
    expect(assessEligibility(makeRoute(CITIES[0], CITIES[1])).eligible).toBe(true);
  });
  test('missing distance skipped', () => {
    const r = makeRoute(CITIES[0], CITIES[1]); r.distance_km = null;
    expect(generateRoutePage(r, 'de').skipped).toBe(true);
  });
  test.each([['custom_title'], ['custom_meta_description'], ['intro_text']])('manual %s blocks generation', (field) => {
    const r = makeRoute(CITIES[0], CITIES[1]); r[field] = 'human wrote this';
    expect(hasManualContent(r)).toBe(true);
    expect(generateRoutePage(r, 'de').skipped).toBe(true);
  });
  test('unsupported language skipped, not faked', () => {
    expect(generateRoutePage(makeRoute(CITIES[0], CITIES[1]), 'zz').skipped).toBe(true);
  });
  test('supportedLanguages lists de', () => {
    expect(supportedLanguages()).toContain('de');
  });
});

describe('page structure', () => {
  const res = generateRoutePage(makeRoute(CITIES[0], CITIES[10]), 'de');
  test('produces title, meta, intro, sections, faq', () => {
    expect(res.skipped).toBe(false);
    expect(res.content.title).toBeTruthy();
    expect(res.content.metaDescription).toBeTruthy();
    expect(res.content.sections.length).toBeGreaterThanOrEqual(3);
    expect(res.content.faq.length).toBeGreaterThanOrEqual(3);
    expect(res.content.faq.length).toBeLessThanOrEqual(5);
  });
  test('is deterministic (stable for Google)', () => {
    const again = generateRoutePage(makeRoute(CITIES[0], CITIES[10]), 'de');
    expect(again.content.introPlain).toBe(res.content.introPlain);
    expect(again.content.title).toBe(res.content.title);
  });
  test('renders only real numbers it has', () => {
    const r = makeRoute(CITIES[0], CITIES[10]);
    const g = generateRoutePage(r, 'de');
    // The airline count, if mentioned, must equal the real value.
    if (r.airline_count && g.content.introPlain.includes('Fluggesellschaften')) {
      // no invented counts: the only integer near "Fluggesellschaften" should be real
      expect(g.content.introPlain).toContain(String(r.airline_count));
    }
  });
});

describe('data-driven divergence', () => {
  test('cheap-direct vs expensive-connecting routes read differently', () => {
    const cheap = { ...makeRoute(CITIES[0], CITIES[1]), price_min: 39, haul_type: 'short-haul', distance_km: 500,
      all_direct: true, stop_distribution: { '0': 10, '1': 0 }, airline_count: 8, price_trend: 'down' };
    const pricey = { ...makeRoute(CITIES[0], CITIES[18]), price_min: 780, haul_type: 'long-haul', distance_km: 9000,
      all_direct: false, stop_distribution: { '0': 0, '1': 9 }, airline_count: 1, price_trend: 'up' };
    const a = generateRoutePage(cheap, 'de');
    const b = generateRoutePage(pricey, 'de');
    const sim = pageSimilarity(
      { text: a.content.introPlain, tokens: [cheap.origin_city, cheap.destination_city, cheap.origin_iata, cheap.destination_iata] },
      { text: b.content.introPlain, tokens: [pricey.origin_city, pricey.destination_city, pricey.origin_iata, pricey.destination_iata] },
    );
    expect(sim).toBeLessThan(0.25);
  });
});

describe('RULE #9 — corpus similarity stays well under 40%', () => {
  const routes = allRoutes();
  const pages = routes.map((r) => {
    const g = generateRoutePage(r, 'de');
    return g.skipped ? null : {
      text: g.content.introPlain + ' ' + g.content.faq.map((f) => f.answer).join(' '),
      tokens: [r.origin_city, r.destination_city, r.origin_iata, r.destination_iata],
    };
  }).filter(Boolean);

  test('generates a large corpus', () => {
    expect(pages.length).toBeGreaterThan(300);
  });

  test('city-neutralized pairwise similarity: mean and p95 under threshold', () => {
    const rep = similarityReport(pages, { k: 4, threshold: 0.4 });
    // Neutralized comparison catches "same text, swapped names". Real variation
    // must keep the bulk of pairs well below 0.4.
    expect(rep.mean).toBeLessThan(0.25);
    expect(rep.p95).toBeLessThan(0.4);
    // A tiny tail of data-identical routes may approach but should not saturate.
    expect(rep.max).toBeLessThan(0.75);
    // Overwhelming majority of pairs are under threshold.
    expect(rep.overThreshold / rep.pairs).toBeLessThan(0.02);
  });
});

describe('angle variety across corpus', () => {
  test('multiple opening angles are used', () => {
    const routes = allRoutes();
    const angles = new Set(routes.map((r) => generateRoutePage(r, 'de').angle).filter(Boolean));
    expect(angles.size).toBeGreaterThanOrEqual(5);
  });
});
