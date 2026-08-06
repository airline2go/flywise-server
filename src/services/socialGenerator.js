// [PORTED] Copy of flywise-app/web/lib/social/generator.js — keep in sync.
// Pure, dependency-free; used server-side by socialAutoGenerate.js so
// auto-generated posts match the studio's output exactly.
'use strict';

// [SOCIAL-STUDIO] Template-driven social-post generator — turns Airpiv's real
// flight/route/city/blog data into ready-to-post copy per platform and language
// (no LLM: deterministic, free, on-brand). Pure module: takes plain data
// objects, returns { body, hashtags, ctaLabel, ctaUrl, imageBrief, charCount,
// withinLimit }. Never fabricates prices — a price line is emitted ONLY when a
// real price is supplied, matching the site's "all data is real" principle.

const LANGUAGES = ['en', 'de', 'es', 'fr', 'it', 'nl', 'ar'];

// Per-platform shape: length budget, how many hashtags to attach, whether the
// copy leans on emoji, and whether a raw link belongs in the post (Instagram
// puts the link in bio, so we still generate the UTM link for the operator to
// place, but keep it out of the body).
const PLATFORMS = {
  facebook: { label: 'Facebook', maxLen: 2000, hashtags: 4, emoji: true, linkInBody: true },
  instagram: { label: 'Instagram', maxLen: 2200, hashtags: 12, emoji: true, linkInBody: false },
  x: { label: 'X', maxLen: 280, hashtags: 2, emoji: true, linkInBody: true },
  linkedin: { label: 'LinkedIn', maxLen: 2500, hashtags: 3, emoji: false, linkInBody: true },
  pinterest: { label: 'Pinterest', maxLen: 500, hashtags: 5, emoji: false, linkInBody: true },
  threads: { label: 'Threads', maxLen: 500, hashtags: 3, emoji: true, linkInBody: true },
};

const TEMPLATE_TYPES = ['flight_deal', 'city_guide', 'blog_promo'];

// Fold a display name into a hashtag token: strip diacritics/punctuation/spaces
// so "São Paulo" -> "SaoPaulo", "Málaga" -> "Malaga", "New York" -> "NewYork".
function hashtagize(name) {
  const cleaned = String(name || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss').replace(/[øØ]/g, 'o').replace(/[æÆ]/g, 'ae')
    .replace(/[œŒ]/g, 'oe').replace(/[łŁ]/g, 'l').replace(/[đðÐ]/g, 'd')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim();
  if (!cleaned) return '';
  return '#' + cleaned.split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
}

// Localized generic hashtags (brand + travel), used to pad up to the platform's
// hashtag budget after the entity-specific ones.
// Brand tag first so it survives even a small hashtag budget.
const GENERIC_TAGS = {
  en: ['#Airpiv', '#Travel', '#Flights', '#CheapFlights'],
  de: ['#Airpiv', '#Reisen', '#Flüge', '#GünstigeFlüge'],
  es: ['#Airpiv', '#Viajar', '#Vuelos', '#VuelosBaratos'],
  fr: ['#Airpiv', '#Voyage', '#Vols', '#VolsPasChers'],
  it: ['#Airpiv', '#Viaggi', '#Voli', '#VoliEconomici'],
  nl: ['#Airpiv', '#Reizen', '#Vluchten', '#GoedkopeVluchten'],
  ar: ['#Airpiv', '#سفر', '#طيران', '#رحلات_رخيصة'],
};

function pick(map, lang) {
  return map[lang] || map.en;
}

// Build the hashtag list: entity names first (city/country/airline), then
// generic brand/travel tags, de-duplicated, capped at the platform budget.
function buildHashtags(entities, lang, max) {
  const out = [];
  const seen = new Set();
  const add = (tag) => {
    if (!tag) return;
    const key = tag.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(tag);
  };
  (entities || []).forEach((name) => add(hashtagize(name)));
  pick(GENERIC_TAGS, lang).forEach(add);
  return out.slice(0, Math.max(1, max || 4));
}

// Internal-link URL for the post's subject, with campaign UTM params so social
// traffic and any bookings it drives are attributable in GA4. Mirrors the
// site's routing: German is unprefixed, every other language is /<lang>/....
function buildCtaUrl(subject, lang, platform, campaign) {
  const prefix = lang === 'de' ? '' : `${lang}/`;
  let path = prefix;
  if (subject && subject.slug) {
    if (subject.type === 'route') path = `${prefix}flights/${subject.slug}`;
    else if (subject.type === 'city') path = `${prefix}city/${subject.slug}`;
    else if (subject.type === 'country') path = `${prefix}country/${subject.slug}`;
    else if (subject.type === 'blog') path = `${prefix}blog/${subject.slug}`;
  }
  const qs = new URLSearchParams({
    utm_source: platform,
    utm_medium: 'social',
    utm_campaign: campaign,
    utm_content: lang,
  });
  return `https://airpiv.com/${path}?${qs.toString()}`;
}

// Direct-flight clause per language (only stated when the data says so).
const DIRECT_LINE = {
  en: { yes: 'Direct flights available.', no: '' },
  de: { yes: 'Direktflüge verfügbar.', no: '' },
  es: { yes: 'Vuelos directos disponibles.', no: '' },
  fr: { yes: 'Vols directs disponibles.', no: '' },
  it: { yes: 'Voli diretti disponibili.', no: '' },
  nl: { yes: 'Directe vluchten beschikbaar.', no: '' },
  ar: { yes: 'تتوفر رحلات مباشرة.', no: '' },
};

// Copy templates. Each returns { title, body, ctaLabel }. Placeholders are
// already-localized/real strings from the caller's data. Emoji are added by the
// platform layer, so the base copy stays clean.
const COPY = {
  flight_deal: {
    en: (d) => ({ title: `${d.origin} → ${d.destination}`, body: `Fly ${d.origin} → ${d.destination}${d.price ? ` from ${d.price}` : ''}. ${d.direct}Compare 600+ airlines and book the smart way with Airpiv.`, ctaLabel: 'Search flights' }),
    de: (d) => ({ title: `${d.origin} → ${d.destination}`, body: `Von ${d.origin} nach ${d.destination}${d.price ? ` ab ${d.price}` : ''}. ${d.direct}Vergleiche 600+ Airlines und buche clever mit Airpiv.`, ctaLabel: 'Flüge suchen' }),
    es: (d) => ({ title: `${d.origin} → ${d.destination}`, body: `Vuela de ${d.origin} a ${d.destination}${d.price ? ` desde ${d.price}` : ''}. ${d.direct}Compara 600+ aerolíneas y reserva con Airpiv.`, ctaLabel: 'Buscar vuelos' }),
    fr: (d) => ({ title: `${d.origin} → ${d.destination}`, body: `Volez de ${d.origin} à ${d.destination}${d.price ? ` dès ${d.price}` : ''}. ${d.direct}Comparez 600+ compagnies et réservez malin avec Airpiv.`, ctaLabel: 'Rechercher des vols' }),
    it: (d) => ({ title: `${d.origin} → ${d.destination}`, body: `Vola da ${d.origin} a ${d.destination}${d.price ? ` da ${d.price}` : ''}. ${d.direct}Confronta 600+ compagnie e prenota con Airpiv.`, ctaLabel: 'Cerca voli' }),
    nl: (d) => ({ title: `${d.origin} → ${d.destination}`, body: `Vlieg van ${d.origin} naar ${d.destination}${d.price ? ` vanaf ${d.price}` : ''}. ${d.direct}Vergelijk 600+ airlines en boek slim met Airpiv.`, ctaLabel: 'Vluchten zoeken' }),
    ar: (d) => ({ title: `${d.origin} → ${d.destination}`, body: `سافر من ${d.origin} إلى ${d.destination}${d.price ? ` ابتداءً من ${d.price}` : ''}. ${d.direct}قارن أكثر من 600 شركة طيران واحجز بذكاء مع Airpiv.`, ctaLabel: 'ابحث عن رحلات' }),
  },
  city_guide: {
    en: (d) => ({ title: `Discover ${d.city}`, body: `Thinking of ${d.city}${d.country ? `, ${d.country}` : ''}? See the best routes, prices and travel tips — then find your flight with Airpiv.`, ctaLabel: `Explore ${d.city}` }),
    de: (d) => ({ title: `${d.city} entdecken`, body: `Lust auf ${d.city}${d.country ? `, ${d.country}` : ''}? Entdecke die besten Verbindungen, Preise und Reisetipps — und finde deinen Flug mit Airpiv.`, ctaLabel: `${d.city} entdecken` }),
    es: (d) => ({ title: `Descubre ${d.city}`, body: `¿Pensando en ${d.city}${d.country ? `, ${d.country}` : ''}? Descubre las mejores rutas, precios y consejos — y encuentra tu vuelo con Airpiv.`, ctaLabel: `Explorar ${d.city}` }),
    fr: (d) => ({ title: `Découvrez ${d.city}`, body: `Envie de ${d.city}${d.country ? `, ${d.country}` : ''} ? Découvrez les meilleures liaisons, prix et conseils — et trouvez votre vol avec Airpiv.`, ctaLabel: `Explorer ${d.city}` }),
    it: (d) => ({ title: `Scopri ${d.city}`, body: `Sogni ${d.city}${d.country ? `, ${d.country}` : ''}? Scopri le migliori rotte, prezzi e consigli — e trova il tuo volo con Airpiv.`, ctaLabel: `Esplora ${d.city}` }),
    nl: (d) => ({ title: `Ontdek ${d.city}`, body: `Zin in ${d.city}${d.country ? `, ${d.country}` : ''}? Ontdek de beste routes, prijzen en reistips — en vind je vlucht met Airpiv.`, ctaLabel: `Ontdek ${d.city}` }),
    ar: (d) => ({ title: `اكتشف ${d.city}`, body: `تفكّر في ${d.city}${d.country ? `، ${d.country}` : ''}؟ اكتشف أفضل المسارات والأسعار ونصائح السفر — ثم جد رحلتك مع Airpiv.`, ctaLabel: `اكتشف ${d.city}` }),
  },
  blog_promo: {
    en: (d) => ({ title: d.title, body: `${d.title}${d.excerpt ? ` — ${d.excerpt}` : ''} Read it on the Airpiv Journal.`, ctaLabel: 'Read the article' }),
    de: (d) => ({ title: d.title, body: `${d.title}${d.excerpt ? ` — ${d.excerpt}` : ''} Jetzt im Airpiv Journal lesen.`, ctaLabel: 'Artikel lesen' }),
    es: (d) => ({ title: d.title, body: `${d.title}${d.excerpt ? ` — ${d.excerpt}` : ''} Léelo en el Airpiv Journal.`, ctaLabel: 'Leer el artículo' }),
    fr: (d) => ({ title: d.title, body: `${d.title}${d.excerpt ? ` — ${d.excerpt}` : ''} À lire sur l'Airpiv Journal.`, ctaLabel: `Lire l'article` }),
    it: (d) => ({ title: d.title, body: `${d.title}${d.excerpt ? ` — ${d.excerpt}` : ''} Leggilo sull'Airpiv Journal.`, ctaLabel: `Leggi l'articolo` }),
    nl: (d) => ({ title: d.title, body: `${d.title}${d.excerpt ? ` — ${d.excerpt}` : ''} Lees het in het Airpiv Journal.`, ctaLabel: 'Lees het artikel' }),
    ar: (d) => ({ title: d.title, body: `${d.title}${d.excerpt ? ` — ${d.excerpt}` : ''} اقرأه في مدونة Airpiv.`, ctaLabel: 'اقرأ المقال' }),
  },
};

const IMAGE_BRIEF = {
  flight_deal: (d) => `Bright travel photo of ${d.destination} (landmark or skyline), warm natural light, space for a price badge, no text overlay.`,
  city_guide: (d) => `Iconic wide shot of ${d.city}, golden hour, vibrant and inviting, no text overlay.`,
  blog_promo: () => `Editorial travel photo matching the article's destination, clean and modern, room for a title overlay.`,
};

// Prepend a leading emoji for platforms that lean on emoji.
const LEAD_EMOJI = { flight_deal: '✈️', city_guide: '📍', blog_promo: '📝' };

function truncate(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)).replace(/\s+\S*$/, '').trim() + '…';
}

// Main entry point. `subject` = { type, slug }. `data` supplies the localized,
// real display values the copy interpolates (origin/destination/price/direct,
// or city/country, or title/excerpt) plus `entities` (names to hashtag).
function generateSocialPost({ type, platform, lang, subject = {}, data = {} }) {
  const t = TEMPLATE_TYPES.includes(type) ? type : 'flight_deal';
  const p = PLATFORMS[platform] ? platform : 'facebook';
  const l = LANGUAGES.includes(lang) ? lang : 'en';
  const spec = PLATFORMS[p];

  const direct = data.directFlight ? pick(DIRECT_LINE, l).yes + ' ' : '';
  const copy = pick(COPY[t], l)({ ...data, direct });

  const hashtags = buildHashtags(data.entities || [], l, spec.hashtags);
  const ctaUrl = buildCtaUrl(subject, l, p, type);
  const imageBrief = (IMAGE_BRIEF[t] || IMAGE_BRIEF.flight_deal)(data);

  // Compose the body: optional lead emoji, copy, CTA label + link (unless the
  // platform keeps links out of the body), then hashtags — trimmed to budget.
  const lead = spec.emoji ? `${LEAD_EMOJI[t]} ` : '';
  const linkPart = spec.linkInBody ? `\n\n👉 ${copy.ctaLabel}: ${ctaUrl}` : '';
  const tagPart = hashtags.length ? `\n\n${hashtags.join(' ')}` : '';
  let body = `${lead}${copy.body}${linkPart}${tagPart}`;
  // If over budget, drop the link first (keep message + tags), then truncate.
  if (body.length > spec.maxLen) {
    body = `${lead}${copy.body}${tagPart}`;
    if (body.length > spec.maxLen) body = truncate(`${lead}${copy.body}`, spec.maxLen);
  }

  return {
    type: t,
    platform: p,
    language: l,
    title: copy.title,
    body,
    hashtags,
    ctaLabel: copy.ctaLabel,
    ctaUrl,
    imageBrief,
    charCount: body.length,
    withinLimit: body.length <= spec.maxLen,
  };
}

module.exports = {
  LANGUAGES,
  PLATFORMS,
  TEMPLATE_TYPES,
  hashtagize,
  buildHashtags,
  buildCtaUrl,
  generateSocialPost,
};
