// ═══════════════════════════════════════════════════════════════
// src/services/seoOptimizer.js
// [SEO-AI-OPTIMIZE] Generates a BEFORE / PROPOSED SEO optimization for ONE
// route page using Claude, entirely server-side. This is the trusted layer
// that holds ANTHROPIC_API_KEY (Render env) — the browser NEVER sees the key;
// the Next.js admin only forwards the route's already-extracted, NON-secret
// page signals here and gets recommendations back.
//
// ADVISORY ONLY: it proposes a title/meta/H1 + a unique content block for a
// human to review. It writes nothing to any page and applies nothing.
//
// Hard guardrails (enforced in the prompt): never invent a price, airline,
// flight time, distance, query, or GSC metric; use only the city names read
// from the real H1/title and the `verifiedFacts` extracted off the page;
// write in the page language; keep the "| Airpiv" brand; and propose a change
// only when a real trigger exists, otherwise "no change recommended".
// ═══════════════════════════════════════════════════════════════

const env = require('../config/env');
const log = require('../utils/log');

const DEFAULT_MODEL = 'claude-sonnet-5';
// Languages the prompt is allowed to WRITE. Any other language returns an
// "unsupported_language" result so the caller can fall back to its own
// deterministic rules rather than the model guessing a translation.
const SUPPORTED_LANGS = new Set(['de', 'en']);

const SYSTEM_PROMPT = [
  'You are an SEO editor for Airpiv, a flight-route information site. You produce a',
  'BEFORE / PROPOSED comparison for ONE route page: an optional new <title>, meta',
  'description, H1, and a unique content block. You are advisory only — a human',
  'reviews and applies every suggestion. Follow these rules exactly; they are hard',
  'constraints, not preferences.',
  '',
  'FACTUAL GROUNDING (never fabricate):',
  '- Use ONLY the city names you can read in the provided H1/title. Never invent or',
  '  guess a city, airport, or country. If you cannot extract a clean origin+',
  '  destination pair, set cities to null and set changeRecommended=false with a',
  '  short reason asking for manual review.',
  '- NEVER invent a price, fare, airline, flight duration, distance, departure time,',
  '  search query, click, impression, position, or any other metric. You may mention',
  '  a FACET word (e.g. "Direktflüge"/"Direct Flights", "Preise"/"Prices",',
  '  "Entfernung"/"Distance", "Flugzeit"/"Flight Time") ONLY when the page content',
  '  flags say the page actually exposes that information.',
  '',
  'LANGUAGE & INTENT:',
  '- Write proposals in the page language: "de" → German, "en" → English.',
  '- Lead the title/meta with the DOMINANT search intent when one is given and the',
  '  page supports it. Do not stuff more than ~2 facets; avoid keyword spam.',
  '',
  'WHEN TO PROPOSE (otherwise return current + changeRecommended=false, proposed=null):',
  '- TITLE: propose only if the current title is missing, is longer than ~65',
  '  characters (risking truncation), OR there is a real CTR opportunity AND the',
  '  current title does not lead with the dominant intent. Keep the brand suffix',
  '  "| Airpiv". Aim for <= 60 characters before the brand.',
  '- META: propose only if the current meta is missing, OR there is a real CTR',
  '  opportunity and a question-style meta answering the dominant intent would help.',
  '- H1: propose only if the current H1 is missing or clearly weak. A clear route H1',
  '  ("Flüge von X nach Y" / "Flights from X to Y") is fine — do not churn it.',
  '- A "real CTR opportunity" means: impressions are meaningful and the average',
  '  position is competitive while clicks/CTR are low. If no GSC data is provided,',
  '  there is no CTR opportunity — only propose for missing/oversized elements.',
  '',
  'CONTENT (unique, ranking-strong body copy — always produce this):',
  '- Write a UNIQUE intro paragraph for THIS route plus 2-3 FAQ question/answer',
  '  pairs, in the page language, that read naturally and would help a searcher.',
  '- Ground every sentence ONLY in: the real city names, the dominant intent, the',
  '  page content flags, and the `verifiedFacts` object (distance, flightTime,',
  '  airlines). You MUST NOT state any number, duration, distance, price, or airline',
  '  that is not present in `verifiedFacts`. If a fact is missing, write about it',
  '  qualitatively ("see the route section above") — never invent a value.',
  '- The content must be unique per route — never a boilerplate paragraph with the',
  '  names swapped in. Put it in content.proposed as plain text: the intro paragraph,',
  '  then each FAQ as two lines "Q: ..." then "A: ...", separated by a blank line.',
  '  Set content.current to null, content.changeRecommended to true, and list the',
  '  verifiedFacts you actually used in content.factsUsed (e.g. "distance: 1.100 km").',
  '  If cities are unparseable, set content.proposed=null and changeRecommended=false.',
  '',
  'SCOPE: propose only title/meta/H1 and this content block. Never propose changing',
  'the site architecture, URL, canonical, hreflang, schema, or global templates.',
  '',
  'OUTPUT: reply with ONLY a single JSON object, no markdown code fence, in exactly',
  'this shape (every field required):',
  '{"cities":{"origin":"..","destination":".."}|null,"opportunity":true|false,',
  ' "dominantIntent":"..","title":{"current":..|null,"proposed":..|null,',
  ' "changeRecommended":true|false,"reason":".."},"meta":{same shape},',
  ' "h1":{same shape},"content":{"current":null,"proposed":..|null,',
  ' "changeRecommended":true|false,"reason":"..","factsUsed":["..",...]}}',
  '`reason` fields may be written in Arabic (the operator reads Arabic); everything',
  'shown to end users (title/meta/h1/content proposed) MUST be in the page language.',
].join('\n');

// The compact, factual context the model is allowed to use. We forward only the
// already-extracted, real page signals — nothing is fetched or invented here.
function buildUserContent({ elements, gsc, dominantIntent, language }) {
  const c = (elements && elements.content) || {};
  const ctr = gsc && gsc.impressions && gsc.clicks != null ? gsc.clicks / gsc.impressions : null;
  return JSON.stringify({
    lang: language,
    dominantIntent: dominantIntent || 'flight',
    current: {
      title: (elements && elements.title) || null,
      titleLength: (elements && elements.titleLength) || 0,
      metaDescription: (elements && elements.metaDescription) || null,
      h1: (elements && elements.h1) || null,
    },
    contentFlags: {
      hasFlightTime: !!c.hasFlightTime,
      hasDirectInfo: !!c.hasDirectInfo,
      hasPrice: !!c.hasPrice,
      hasDistance: !!c.hasDistance,
      hasAirlines: !!c.hasAirlines,
      faqCount: c.faqCount || 0,
    },
    // The ONLY concrete facts the model may state — extracted off the real page.
    verifiedFacts: (elements && elements.facts) || {},
    gsc: gsc
      ? {
        impressions: gsc.impressions == null ? null : gsc.impressions,
        clicks: gsc.clicks == null ? null : gsc.clicks,
        position: gsc.position == null ? null : gsc.position,
        ctr: ctr == null ? null : `${Number((ctr * 100).toFixed(2))}%`,
      }
      : null,
  }, null, 2);
}

// One suggestion sub-node ({current, proposed, changeRecommended, reason}) — a
// tolerant coercion that never throws and never fabricates a value.
function coerceNode(node, extra) {
  const n = node && typeof node === 'object' ? node : {};
  const out = {
    current: n.current == null ? null : String(n.current),
    proposed: n.proposed == null ? null : String(n.proposed),
    changeRecommended: !!n.changeRecommended,
    reason: n.reason == null ? '' : String(n.reason),
  };
  if (extra && extra.factsUsed) {
    out.current = null; // content has no single "current" value to diff
    out.factsUsed = Array.isArray(n.factsUsed) ? n.factsUsed.map((x) => String(x)).slice(0, 12) : [];
  }
  return out;
}

// Tolerant parse of the model reply into the canonical suggestion shape. Handles
// a ```json fence AND any prose the model may wrap around the object (e.g. "Here
// is the JSON:") by falling back to the outermost {…} span. Returns null on any
// problem so a bad reply degrades to the caller's fallback.
function tryParse(s) { try { return JSON.parse(s); } catch { return null; } }
function parseSuggestion(text) {
  if (!text) return null;
  const cleaned = String(text).trim().replace(/```json/gi, '').replace(/```/g, '').trim();
  let parsed = tryParse(cleaned);
  if (!parsed) {
    // Extract the outermost JSON object span and try again.
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first !== -1 && last > first) parsed = tryParse(cleaned.slice(first, last + 1));
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const cities = parsed.cities && typeof parsed.cities === 'object' && parsed.cities.origin && parsed.cities.destination
    ? { origin: String(parsed.cities.origin), destination: String(parsed.cities.destination) }
    : null;
  return {
    cities,
    opportunity: !!parsed.opportunity,
    dominantIntent: parsed.dominantIntent ? String(parsed.dominantIntent) : 'flight',
    title: coerceNode(parsed.title),
    meta: coerceNode(parsed.meta),
    h1: coerceNode(parsed.h1),
    content: coerceNode(parsed.content, { factsUsed: true }),
  };
}

// Generate a route optimization. Returns one of:
//   { source: 'ai', model, suggestions }        — a usable AI suggestion
//   { source: 'unsupported_language' }           — lang the prompt won't write
//   { source: 'unavailable', reason }            — no key / HTTP / parse / timeout
// It never throws and never returns a fabricated value.
async function generateRouteOptimization({ elements, gsc, dominantIntent, language }) {
  const lang = typeof language === 'string' && language ? language : 'de';
  if (!env.ANTHROPIC_API_KEY) return { source: 'unavailable', reason: 'no_api_key' };
  if (!SUPPORTED_LANGS.has(lang)) return { source: 'unsupported_language' };

  const model = env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  const ctrl = new AbortController();
  // 50s: a cold backend + a longer completion can exceed 30s; the frontend proxy
  // allows 60s, so this stays comfortably inside that budget.
  const timer = setTimeout(() => ctrl.abort(), 50000);
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `Analyze this route page and return ONLY the JSON suggestion.\n\n${buildUserContent({ elements, gsc, dominantIntent, language: lang })}` }],
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) { log('warn', 'seo_optimize_ai_http', { status: resp.status }); return { source: 'unavailable', reason: `http_${resp.status}` }; }
    const json = await resp.json();
    if (json.stop_reason === 'refusal') return { source: 'unavailable', reason: 'refusal' };
    const text = json.content && json.content[0] && json.content[0].text;
    const suggestions = parseSuggestion(text);
    if (!suggestions) return { source: 'unavailable', reason: 'parse_failed' };
    return { source: 'ai', model, suggestions };
  } catch (e) {
    log('warn', 'seo_optimize_ai_failed', { error: e.message });
    return { source: 'unavailable', reason: e.name === 'AbortError' ? 'timeout' : 'error' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { generateRouteOptimization, parseSuggestion, buildUserContent, SUPPORTED_LANGS };
