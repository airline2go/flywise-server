// Route SEO engine: evidence-first, deterministic assembly, locale-aware packs.
const { makeRng, pick, buildContext } = require('./compose');
const { makePack } = require('./blocks.secondary');
const de = require('./blocks.de');

const SECONDARY = ['en', 'fr', 'es', 'it', 'nl', 'pl', 'tr'];
const PACKS = { de, ...Object.fromEntries(SECONDARY.map((lang) => [lang, makePack(lang)])) };

function tidy(s) {
  return String(s || '').replace(/\s+/g, ' ').replace(/\.\s*\./g, '.').replace(/\s+([.,;:!?])/g, '$1').trim();
}
function supportedLanguages() { return Object.keys(PACKS); }
function hasManualContent(route) {
  return !!(route.custom_title || route.custom_meta_description ||
    (Array.isArray(route.custom_faq) ? route.custom_faq.length : route.custom_faq) || route.intro_text);
}
function assessEligibility(route, { allowManual = false } = {}) {
  const reasons = [];
  if (!route) return { eligible: false, reasons: ['no route'] };
  if (route.status !== 'published') reasons.push(`status is '${route.status}'`);
  if (!route.origin_city || !route.destination_city) reasons.push('missing city name');
  if (!route.distance_km || route.distance_km <= 0) reasons.push('missing distance_km');
  if (!route.haul_type) reasons.push('missing haul_type');
  if (!allowManual && hasManualContent(route)) reasons.push('manually edited content present');
  return { eligible: reasons.length === 0, reasons };
}
function scoreAngles(c) {
  const s = {};
  if (c.facts.has('price')) s.price = c.priceB === 'budget' ? 3 : c.priceB === 'premium' ? 2.5 : 1.2;
  if (c.facts.has('duration')) s.duration = c.haul === 'long-haul' ? 2.4 : c.haul === 'short-haul' ? 1.6 : 1;
  if (c.facts.has('airlines')) s.airline = c.airlineB === 'many' ? 2.6 : c.airlineB === 'single' ? 2 : .9;
  if (c.facts.has('directness')) s.business = c.directB === 'all-direct' ? 1.8 : c.directB === 'connections-only' ? 2.2 : 1;
  if (c.facts.has('popularity')) s.destination = c.popB === 'high' ? 2.3 : 1;
  s.traveler = .8; s.airport = .7;
  if (c.haul !== 'long-haul') s.weekend = c.haul === 'short-haul' ? 1.4 : .9;
  if (c.facts.has('priceTrend') || c.facts.has('popularity')) s.seasonal = 1.1;
  if (c.haul === 'long-haul') s.family = .9;
  return s;
}
const ANGLE_TIEBREAK = ['price','airline','business','duration','destination','seasonal','weekend','family','airport','traveler'];
function chooseAngle(c, rng, INTRO_ANGLES) {
  const scores = scoreAngles(c);
  const ranked = Object.entries(scores).filter(([k]) => INTRO_ANGLES[k])
    .sort((a,b) => (b[1]-a[1]) || (ANGLE_TIEBREAK.indexOf(a[0])-ANGLE_TIEBREAK.indexOf(b[0])));
  const angle = ranked.length ? ranked[0][0] : 'traveler';
  return { angle, intro: pick(rng, INTRO_ANGLES[angle])(c) };
}
const ANGLE_TO_BLOCK = { price:'price-analysis', airline:'airline-analysis', business:'direct-analysis', destination:'popularity', seasonal:'seasonal', airport:'airport-detail' };
function assembleSections(c, rng, BLOCKS, openingBlockId) {
  const applicable = BLOCKS.filter((b) => b.applicable(c));
  const overview = applicable.find((b) => b.id === 'overview');
  const rest = applicable.filter((b) => b.id !== 'overview' && b.id !== openingBlockId)
    .sort((a,b) => (b.weight(c)-a.weight(c)) || a.id.localeCompare(b.id));
  return (overview ? [overview,...rest] : rest).map((b) => b.render(c,rng)).filter((s)=>s&&s.body&&s.body.trim());
}
const FAQ_ORDER = ['duration','price-from','direct','airlines','book-when','cheaper-months','weekend'];
function assembleFaq(c, candidates) {
  return candidates.filter((f)=>f.applicable(c)).sort((a,b)=>{
    const ia=FAQ_ORDER.indexOf(a.id), ib=FAQ_ORDER.indexOf(b.id); return (ia===-1?99:ia)-(ib===-1?99:ib);
  }).map((f)=>({question:f.q(c),answer:f.a(c)}));
}
function generateRoutePage(route, language='de', sources={}) {
  const allowManual = language !== 'de';
  const gate = assessEligibility(route, { allowManual });
  if (!gate.eligible) return { skipped:true, reasons:gate.reasons };
  const pack = PACKS[language];
  if (!pack) return { skipped:true, reasons:[`language '${language}' has no block pack`] };
  const c=buildContext(route,sources);
  const rng=makeRng(`${c.slug}|${language}`);
  const {angle,intro:introRaw}=chooseAngle(c,rng,pack.INTRO_ANGLES);
  const openingBlockId=ANGLE_TO_BLOCK[angle]||null;
  const intro=tidy(introRaw);
  const sections=assembleSections(c,rng,pack.BLOCKS,openingBlockId).map((s)=>({heading:tidy(s.heading),body:tidy(s.body)}));
  const faq=assembleFaq(c,pack.FAQ_CANDIDATES).map((f)=>({question:tidy(f.question),answer:tidy(f.answer)}));
  const title=tidy(pick(rng,pack.TITLES)(c));
  const metaDescription=tidy(pick(rng,pack.METAS)(c));
  const bodyHtml=sections.map((s)=>`<h2>${s.heading}</h2>\n<p>${s.body}</p>`).join('\n');
  return { skipped:false, angle, dataCoverage:Array.from(c.facts).sort(), content:{title,metaDescription,intro:`<p>${intro}</p>\n${bodyHtml}`,introPlain:[intro,...sections.map((s)=>s.body)].join(' '),sections,faq} };
}
module.exports={generateRoutePage,assessEligibility,hasManualContent,supportedLanguages,scoreAngles};
