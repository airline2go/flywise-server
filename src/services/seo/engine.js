// ═══════════════════════════════════════════════════════════════════════════
// src/services/seo/engine.js
// Assembles a complete, unique route page from data-driven blocks.
//
// Pipeline per route:
//   1. Quality gate — enough real data? manual content present? → maybe skip.
//   2. buildContext — normalize + bucketize all real route data.
//   3. Choose an OPENING ANGLE from the route's most distinctive fact (so a
//      cheap route opens on price, a nonstop route on convenience, etc.),
//      seed-rotated among the top candidates so similar routes still differ.
//   4. Select a SUBSET of section blocks: only those whose real data exists,
//      weighted by relevance, count/order seed-varied → not every page shows
//      every section.
//   5. Select a SUBSET of FAQ questions likewise.
//   6. Pick title/meta variants.
// Everything is deterministic per slug (stable for Google) yet spread across
// routes (no near-duplicates).
// ═══════════════════════════════════════════════════════════════════════════

const { makeRng, pick, weightedPick, buildContext } = require('./compose');

const PACKS = {
  de: require('./blocks.de'),
};

// Normalizes punctuation artifacts from composing abbreviations (e.g. "Min.")
// at sentence ends: collapses runs of periods and space-before-period, without
// touching legitimate content.
function tidy(s) {
  return s
    .replace(/\s+/g, ' ')
    .replace(/\.\s*\./g, '.')   // "Min. ." or "Min.." → "Min."
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

// ─── Angle scoring ──────────────────────────────────────────────
// Each candidate angle scores itself on how distinctive that dimension is for
// THIS route. The composer takes the top few and seed-picks among them, so the
// opening reflects real data yet varies across similar routes.
function scoreAngles(c) {
  const s = {};
  if (c.facts.has('price')) s.price = c.priceB === 'budget' ? 3 : c.priceB === 'premium' ? 2.5 : 1.2;
  if (c.facts.has('duration') || c.km) s.duration = c.haul === 'long-haul' ? 2.4 : c.haul === 'short-haul' ? 1.6 : 1.0;
  if (c.facts.has('airlines')) s.airline = c.airlineB === 'many' ? 2.6 : c.airlineB === 'single' ? 2.0 : 0.9;
  if (c.facts.has('directness')) {
    s.business = c.directB === 'all-direct' ? 1.8 : c.directB === 'connections-only' ? 2.2 : 1.0;
  }
  if (c.facts.has('popularity')) s.destination = c.popB === 'high' ? 2.3 : 1.0;
  // Always-available softer angles so every route has ≥3 candidates.
  s.traveler = (s.traveler || 0) + 0.8;
  s.airport = (s.airport || 0) + 0.7;
  if (c.haul !== 'long-haul') s.weekend = (s.weekend || 0) + (c.haul === 'short-haul' ? 1.4 : 0.9);
  if (c.facts.has('priceTrend') || c.facts.has('popularity')) s.seasonal = (s.seasonal || 0) + 1.1;
  if (c.haul === 'long-haul') s.family = (s.family || 0) + 0.9;
  return s;
}

function chooseAngle(c, rng, INTRO_ANGLES) {
  const scores = scoreAngles(c);
  const ranked = Object.entries(scores)
    .filter(([k]) => INTRO_ANGLES[k])
    .sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return { angle: 'traveler', intro: pick(rng, INTRO_ANGLES.traveler)(c) };
  // Seed-pick among the top 3 (or fewer) to spread similar routes apart.
  const topN = ranked.slice(0, Math.min(3, ranked.length));
  const chosen = topN[Math.floor(rng() * topN.length)][0];
  return { angle: chosen, intro: pick(rng, INTRO_ANGLES[chosen])(c) };
}

// ─── Section assembly ───────────────────────────────────────────
function assembleSections(c, rng, BLOCKS, excludeAngleId) {
  const applicable = BLOCKS
    .filter((b) => b.applicable(c))
    // Avoid leading a section with the same theme the intro already opened on.
    .filter((b) => !(excludeAngleId && b.id === excludeAngleId))
    .map((b) => ({ block: b, weight: b.weight(c) }));

  // Overview is a spine — always keep it if present. Pick a data-scaled number
  // of the rest: richer routes (more real facts) earn more sections.
  const overview = applicable.find((x) => x.block.id === 'overview');
  const rest = applicable.filter((x) => x.block.id !== 'overview');
  const richness = c.facts.size; // 0..8
  const targetExtra = Math.min(rest.length, 3 + Math.floor(richness / 2)); // 3..7
  const chosen = weightedPick(rng, rest, targetExtra);

  const ordered = [];
  if (overview) ordered.push(overview.block);
  // Order chosen blocks by weight but nudge with the seed so order varies.
  chosen
    .map((x) => x.block)
    .sort((a, b) => b.weight(c) + rng() * 0.4 - (a.weight(c) + rng() * 0.4))
    .forEach((b) => ordered.push(b));

  return ordered.map((b) => b.render(c, rng)).filter((s) => s && s.body && s.body.trim());
}

function assembleFaq(c, rng, FAQ_CANDIDATES) {
  const applicable = FAQ_CANDIDATES.filter((f) => f.applicable(c));
  // 3–5 questions, seed-shuffled so different routes surface different sets.
  const n = Math.max(3, Math.min(5, applicable.length));
  const shuffled = weightedPick(rng, applicable.map((f) => ({ f, weight: 1 })), n).map((x) => x.f);
  return shuffled.map((f) => ({ question: f.q(c), answer: f.a(c) }));
}

// ─── Main entry ─────────────────────────────────────────────────
function generateRoutePage(route, language = 'de') {
  const gate = assessEligibility(route);
  if (!gate.eligible) return { skipped: true, reasons: gate.reasons };
  const pack = PACKS[language];
  if (!pack) return { skipped: true, reasons: [`language '${language}' has no block pack yet`] };

  const c = buildContext(route);
  const rng = makeRng(c.slug + '|' + language);

  const { angle, intro: introRaw } = chooseAngle(c, rng, pack.INTRO_ANGLES);
  const intro = tidy(introRaw);
  const sections = assembleSections(c, rng, pack.BLOCKS, angle)
    .map((s) => ({ heading: tidy(s.heading), body: tidy(s.body) }));
  const faq = assembleFaq(c, rng, pack.FAQ_CANDIDATES)
    .map((f) => ({ question: tidy(f.question), answer: tidy(f.answer) }));
  const title = tidy(pick(rng, pack.TITLES)(c));
  const metaDescription = tidy(pick(rng, pack.METAS)(c));

  // Flatten sections into an HTML intro/body. The intro_text column stores the
  // opening; sections render as <h2>+<p>. FAQ stored separately as JSON.
  const bodyHtml = sections.map((s) => `<h2>${s.heading}</h2>\n<p>${s.body}</p>`).join('\n');
  const introFull = `<p>${intro}</p>\n${bodyHtml}`;

  return {
    skipped: false,
    angle,
    sectionIds: sections.length,
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
