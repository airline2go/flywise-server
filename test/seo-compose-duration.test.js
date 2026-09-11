// [P0.1 DATA-TRUTH] A distance-only route must never produce a flight duration
// anywhere — not in the composed facts, not in the intro/section text, not in
// the title, not in a FAQ. distance_km alone is NOT a flight-time signal.
// (Editorial policy: we never invent a duration we did not observe.)

const { buildContext, coreEnricher } = require('../src/services/seo/compose');
const { generateRoutePage, scoreAngles } = require('../src/services/seo/engine');

// A route with a real distance but NO observed duration/airlines/stops/price —
// the exact shape of the ~179 distance-only published routes.
const distanceOnly = {
  slug: 'testcity-otherplace',
  status: 'published',
  origin_city: 'Teststadt', destination_city: 'Zielstadt',
  origin_iata: 'TST', destination_iata: 'ZLS',
  origin_country: 'DE', destination_country: 'FR',
  distance_km: 1200, haul_type: 'medium-haul',
  avg_duration_min: null, min_duration_min: null,
  airline_count: 0, price_min: null, price_sample_count: 0,
  itinerary_count: 0, stop_distribution: null,
};

const withRealDuration = { ...distanceOnly, avg_duration_min: 130 };

test('1. distance only → composed duration stays null', () => {
  const c = buildContext(distanceOnly);
  expect(c.durMin).toBeNull();
  expect(c.fmtDur).toBeNull();
  expect(c.durationIsReal).toBe(false);
  expect(c.facts.has('duration')).toBe(false);
});

test('a real observed duration IS surfaced (fmtDur present, fact set)', () => {
  const c = buildContext(withRealDuration);
  expect(c.durMin).toBe(130);
  expect(c.fmtDur).toMatch(/Std|Min/);
  expect(c.facts.has('duration')).toBe(true);
});

test('2. distance only → the intro/page never renders a Flugzeit claim', () => {
  const page = generateRoutePage(distanceOnly, 'de');
  expect(page.skipped).toBe(false);
  const text = [page.content.title, page.content.introPlain,
    ...page.content.sections.map((s) => s.heading + ' ' + s.body)].join(' ');
  // No concrete duration string like "2 Std." / "45 Min." / "1 Std. 30 Min."
  expect(text).not.toMatch(/\d+\s*Std\./);
  expect(text).not.toMatch(/\d+\s*Min\./);
  // dataCoverage must not advertise a duration dimension
  expect(page.dataCoverage).not.toContain('duration');
});

test('2b. distance only → title says Distanz, never Flugzeit', () => {
  const page = generateRoutePage(distanceOnly, 'de');
  expect(page.content.title).not.toMatch(/Flugzeit/);
});

test('3. distance only → no duration FAQ is generated', () => {
  const page = generateRoutePage(distanceOnly, 'de');
  const qs = page.content.faq.map((f) => f.question).join(' | ');
  expect(qs).not.toMatch(/Wie lange dauert der Flug/);
});

test('3b. real duration → a duration FAQ IS generated with the real value', () => {
  const page = generateRoutePage(withRealDuration, 'de');
  const durFaq = page.content.faq.find((f) => /Wie lange dauert der Flug/.test(f.question));
  expect(durFaq).toBeTruthy();
  expect(durFaq.answer).toMatch(/Std|Min/);
});

test('4. distance only → the duration angle can never be selected from distance', () => {
  const c = buildContext(distanceOnly);
  const s = scoreAngles(c);
  expect(s.duration).toBeUndefined();
});
