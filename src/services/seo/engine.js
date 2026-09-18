// Route SEO engine: evidence-first, deterministic assembly, locale-aware packs.
const { makeRng, pick, buildContext } = require('./compose');
const { makePack } = require('./blocks.secondary');
const { makeArabicPack } = require('./blocks.ar');
const { buildSecondaryTitle, buildSecondaryMeta, buildSecondaryIntro } = require('./secondaryMetadata');
const { generatedFieldIsSafe } = require('./truthfulness');
const de = require('./blocks.de');

const SECONDARY = ['en', 'fr', 'es', 'it', 'nl', 'tr', 'ar'];
const PACKS = { de, ...Object.fromEntries(SECONDARY.filter((lang) => lang !== 'ar').map((lang) => [lang, makePack(lang)])), ar: makeArabicPack() };

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
function safeSecondarySection(route, language) {
  const labels = {
    en: { heading: 'Route information', body: 'Review the stored route information for ' + route.origin_city + ' and ' + route.destination_city + ' shown on this page.' },
    fr: { heading: 'Informations sur la route', body: 'Consultez les informations enregistrées pour la liaison entre ' + route.origin_city + ' et ' + route.destination_city + ' affichées sur cette page.' },
    es: { heading: 'Información de la ruta', body: 'Consulta la información registrada de la ruta entre ' + route.origin_city + ' y ' + route.destination_city + ' que aparece en esta página.' },
    it: { heading: 'Informazioni sulla rotta', body: 'Consulta le informazioni registrate sulla rotta tra ' + route.origin_city + ' e ' + route.destination_city + ' mostrate in questa pagina.' },
    nl: { heading: 'Route-informatie', body: 'Controleer de opgeslagen route-informatie voor ' + route.origin_city + ' en ' + route.destination_city + ' op deze pagina.' },
    tr: { heading: 'Rota bilgileri', body: route.origin_city + ' ile ' + route.destination_city + ' için bu sayfada gösterilen kayıtlı rota bilgilerini inceleyin.' },
  };
  return labels[language] || labels.en;
}
function safeSecondaryFaq(route, language) {
  const labels = {
    en: { question: 'What route information is shown on this page?', answer: 'Use the stored route information for ' + route.origin_city + ' and ' + route.destination_city + ' shown on this page.' },
    fr: { question: 'Quelles informations de route sont affichées sur cette page ?', answer: 'Utilisez les informations de route enregistrées pour ' + route.origin_city + ' et ' + route.destination_city + ' affichées sur cette page.' },
    es: { question: '¿Qué información de la ruta aparece en esta página?', answer: 'Usa la información registrada de la ruta entre ' + route.origin_city + ' y ' + route.destination_city + ' que aparece en esta página.' },
    it: { question: 'Quali informazioni sulla rotta sono mostrate in questa pagina?', answer: 'Usa le informazioni registrate sulla rotta tra ' + route.origin_city + ' e ' + route.destination_city + ' mostrate in questa pagina.' },
    nl: { question: 'Welke route-informatie staat op deze pagina?', answer: 'Gebruik de opgeslagen routegegevens voor ' + route.origin_city + ' en ' + route.destination_city + ' die op deze pagina staan.' },
    tr: { question: 'Bu sayfada hangi rota bilgileri gösteriliyor?', answer: route.origin_city + ' ve ' + route.destination_city + ' için bu sayfada gösterilen kayıtlı rota bilgilerini kullanın.' },
  };
  return labels[language] || labels.en;
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
  const intro=language !== 'de' && language !== 'ar' ? buildSecondaryIntro(route, language) : tidy(introRaw);
  let sections=assembleSections(c,rng,pack.BLOCKS,openingBlockId).map((s)=>({heading:tidy(s.heading),body:tidy(s.body)}));
  let faq=assembleFaq(c,pack.FAQ_CANDIDATES).map((f)=>({question:tidy(f.question),answer:tidy(f.answer)}));
  if (language !== 'de' && language !== 'ar') {
    sections = sections.map((section) => generatedFieldIsSafe(route, (section.heading || '') + ' ' + (section.body || ''))
      ? section : safeSecondarySection(route, language));
    faq = faq.map((item) => generatedFieldIsSafe(route, (item.question || '') + ' ' + (item.answer || ''))
      ? item : safeSecondaryFaq(route, language));
  }
  const title=language !== 'de' && language !== 'ar'
    ? buildSecondaryTitle(route, language)
    : tidy(pick(rng,pack.TITLES)(c));
  const metaDescription=language !== 'de' && language !== 'ar'
    ? buildSecondaryMeta(route, language)
    : tidy(pick(rng,pack.METAS)(c));
  const bodyHtml=sections.map((s)=>`<h2>${s.heading}</h2>\n<p>${s.body}</p>`).join('\n');
  return { skipped:false, angle, dataCoverage:Array.from(c.facts).sort(), content:{title,metaDescription,intro:`<p>${intro}</p>\n${bodyHtml}`,introPlain:[intro,...sections.map((s)=>s.body)].join(' '),sections,faq} };
}
module.exports={generateRoutePage,assessEligibility,hasManualContent,supportedLanguages,scoreAngles};
