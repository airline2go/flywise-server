// ═══════════════════════════════════════════════════════════════════════════
// src/services/seo/engine.js
// Assembles a complete route page from data-driven blocks.
//
// DESIGN PHILOSOPHY (deliberate — read before changing):
//   The goal is maximum USER VALUE and INFORMATION UNIQUENESS, not a low
//   similarity score. Concretely:
//     • Every block whose real data is present ALWAYS renders. Useful
//       information is never hidden to make pages look different.
//     • Structural differences emerge from the DATA: a data-rich route has
//       more applicable blocks and therefore a longer, richer page; a data-poor
//       route has fewer. Nothing is randomly suppressed or reordered.
//     • Section ORDER is deterministic and data-driven — blocks are ordered by
//       their data-salience weight (e.g. an unusually cheap route surfaces its
//       price analysis higher), not by a seed.
//     • The seeded RNG is used ONLY for minor wording choices within a block,
//       never to decide which information appears. Uniqueness comes from real,
//       route-specific facts, not from text shuffling.
//     • Similarity (see similarity.js) is a HEALTH METRIC that flags accidental
//       templating — it is never an optimization target.
//
// Extensibility: new data sources become new enrichers (compose.js) + new
// blocks (blocks.<lang>.js). This file needs no change to gain a data source.
// ═══════════════════════════════════════════════════════════════════════════

const { makeRng, pick, buildContext } = require('./compose');

const PACKS = {
  de: require('./blocks.de'),
};

// Normalizes punctuation artifacts from composing abbreviations (e.g. "Min.")
// at sentence ends: collapses runs of periods and space-before-period.
function tidy(s) {
  return s
    .replace(/\s+/g, ' ')
    .replace(/\.\s*\./g, '.')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();
}

function supportedLanguages() { return Object.keys(PACKS); }

// ─── Quality gate ───────────────────────────────────────────────
function hasManualContent(route) {
  return !!(route.custom_title || route.custom_meta_description ||
    (Array.isArray(route.custom_faq) ? route.custom_faq.length : route.custom_faq) ||
    route.intro_text);
}
function assessEligibility(route) {
  const reasons = [];
  if (!route) return { eligible: false, reasons: ['no route'] };
  if (route.status !== 'published') reasons.push(`status is '${route.status}'`);
  if (!route.origin_city || !route.destination_city) reasons.push('missing city name');
  if (!route.distance_km || route.distance_km <= 0) reasons.push('missing distance_km');
  if (!route.haul_type) reasons.push('missing haul_type');
  if (hasManualContent(route)) reasons.push('manually edited content present');
  return { eligible: reasons.length === 0, reasons };
}

// ─── Opening angle (deterministic, data-driven) ─────────────────
// The intro leads with the route's MOST DISTINCTIVE real dimension. Scoring is
// pure data; ties break by a fixed order so the choice is stable and explained
// by the data, not by a seed. (The seed only picks which phrasing of the chosen
// angle is used.)
function scoreAngles(c) {
  const s = {};
  if (c.facts.has('price')) s.price = c.priceB === 'budget' ? 3 : c.priceB === 'premium' ? 2.5 : 1.2;
  if (c.facts.has('duration') || c.km) s.duration = c.haul === 'long-haul' ? 2.4 : c.haul === 'short-haul' ? 1.6 : 1.0;
  if (c.facts.has('airlines')) s.airline = c.airlineB === 'many' ? 2.6 : c.airlineB === 'single' ? 2.0 : 0.9;
  if (c.facts.has('directness')) s.business = c.directB === 'all-direct' ? 1.8 : c.directB === 'connections-only' ? 2.2 : 1.0;
  if (c.facts.has('popularity')) s.destination = c.popB === 'high' ? 2.3 : 1.0;
  s.traveler = (s.traveler || 0) + 0.8;
  s.airport = (s.airport || 0) + 0.7;
  if (c.haul !== 'long-haul') s.weekend = (s.weekend || 0) + (c.haul === 'short-haul' ? 1.4 : 0.9);
  if (c.facts.has('priceTrend') || c.facts.has('popularity')) s.seasonal = (s.seasonal || 0) + 1.1;
  if (c.haul === 'long-haul') s.family = (s.family || 0) + 0.9;
  return s;
}
// Fixed tiebreak order (most informative first) so equal scores are resolved
// deterministically rather than by chance.
const ANGLE_TIEBREAK = ['price', 'airline', 'business', 'duration', 'destination', 'seasonal', 'weekend', 'family', 'airport', 'traveler'];

function chooseAngle(c, rng, INTRO_ANGLES) {
  const scores = scoreAngles(c);
  const ranked = Object.entries(scores)
    .filter(([k]) => INTRO_ANGLES[k])
    .sort((a, b) => (b[1] - a[1]) || (ANGLE_TIEBREAK.indexOf(a[0]) - ANGLE_TIEBREAK.indexOf(b[0])));
  const angle = ranked.length ? ranked[0][0] : 'traveler';
  return { angle, intro: pick(rng, INTRO_ANGLES[angle])(c) };
}

// Which section block covers the same theme as an opening angle, so the intro
// and that section don't restate each other. (Angle id → block id.)
const ANGLE_TO_BLOCK = {
  price: 'price-analysis',
  airline: 'airline-analysis',
  business: 'direct-analysis',
  destination: 'popularity',
  seasonal: 'seasonal',
  airport: 'airport-detail',
};

// ─── Section assembly ───────────────────────────────────────────
// Render EVERY applicable block (nothing useful withheld), ordered by
// data-salience weight. `overview` is pinned first as the page's spine. The
// only omission is the single block whose theme the intro already opened on,
// to avoid immediate repetition — its information still surfaces via the intro.
function assembleSections(c, rng, BLOCKS, openingBlockId) {
  const applicable = BLOCKS.filter((b) => b.applicable(c));
  const overview = applicable.find((b) => b.id === 'overview');
  const rest = applicable
    .filter((b) => b.id !== 'overview' && b.id !== openingBlockId)
    // Deterministic, data-driven order: higher salience first; stable id tiebreak.
    .sort((a, b) => (b.weight(c) - a.weight(c)) || a.id.localeCompare(b.id));

  const ordered = overview ? [overview, ...rest] : rest;
  return ordered.map((b) => b.render(c, rng)).filter((s) => s && s.body && s.body.trim());
}

// Render EVERY applicable FAQ (each answers a distinct real user question),
// ordered by a fixed usefulness ranking — no random selection.
const FAQ_ORDER = ['duration', 'price-from', 'direct', 'airlines', 'book-when', 'cheaper-months', 'weekend'];
function assembleFaq(c, FAQ_CANDIDATES) {
  return FAQ_CANDIDATES
    .filter((f) => f.applicable(c))
    .sort((a, b) => {
      const ia = FAQ_ORDER.indexOf(a.id), ib = FAQ_ORDER.indexOf(b.id);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    })
    .map((f) => ({ question: f.q(c), answer: f.a(c) }));
}

// ─── Main entry ─────────────────────────────────────────────────
function generateRoutePage(route, language = 'de', sources = {}) {
  const gate = assessEligibility(route);
  if (!gate.eligible) return { skipped: true, reasons: gate.reasons };
  const pack = PACKS[language];
  if (!pack) return { skipped: true, reasons: [`language '${language}' has no block pack yet`] };

  const c = buildContext(route, sources);
  const rng = makeRng(c.slug + '|' + language); // wording only

  const { angle, intro: introRaw } = chooseAngle(c, rng, pack.INTRO_ANGLES);
  const openingBlockId = ANGLE_TO_BLOCK[angle] || null;
  const intro = tidy(introRaw);
  const sections = assembleSections(c, rng, pack.BLOCKS, openingBlockId)
    .map((s) => ({ heading: tidy(s.heading), body: tidy(s.body) }));
  const faq = assembleFaq(c, pack.FAQ_CANDIDATES)
    .map((f) => ({ question: tidy(f.question), answer: tidy(f.answer) }));
  const title = tidy(pick(rng, pack.TITLES)(c));
  const metaDescription = tidy(pick(rng, pack.METAS)(c));

  const bodyHtml = sections.map((s) => `<h2>${s.heading}</h2>\n<p>${s.body}</p>`).join('\n');
  const introFull = `<p>${intro}</p>\n${bodyHtml}`;

  return {
    skipped: false,
    angle,
    dataCoverage: Array.from(c.facts).sort(), // which real dimensions drove this page
    content: {
      title,
      metaDescription,
      intro: introFull,
      introPlain: [intro, ...sections.map((s) => s.body)].join(' '),
      sections,
      faq,
    },
  };
}

module.exports = {
  generateRoutePage,
  assessEligibility,
  hasManualContent,
  supportedLanguages,
  scoreAngles,
};
