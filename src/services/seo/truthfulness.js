// Conservative truthfulness guard for generated route SEO.
// Manual editor content never passes through this module.
const { validCurrency, validPositivePrice } = require('./compose');

const UNSUPPORTED = [
  /\b(?:zwei|drei|vier|sechs|acht)\s*(?:bis|-|–)\s*(?:drei|vier|acht)\s+wochen\b/i,
  /\b(?:dienstag|mittwoch|freitag|sonntag)\b[^.]{0,90}\b(?:günstiger|billiger|günstigsten)\b/i,
  /\babflüge?\s+unter\s+der\s+woche\b[^.]{0,90}\b(?:günstiger|billiger)\b/i,
  /\bfrühes?\s+buchen\b[^.]{0,90}\b(?:zahlt|lohnt|erspar)/i,
  /\b(?:early booking|book early|cheaper on weekdays|weekday departures)\b/i,
  /\bdichte\b[^.]{0,100}\bdrückt\s+die\s+preise\b/i,
  /\bschwanken\s+die\s+preise\s+weniger\b/i,
  /\bverlässlichere\s+ersparnis\b/i,
  /\bgünstigere\s+preisklasse\b/i,
  /\bspürbar\s+besseren\s+tarif\b/i,
  /\b(?:nebensaison|low\s+season)\b[^.]{0,100}\b(?:ruhiger|günstiger|cheaper|quieter)\b/i,
  /\beignet\s+sich\b[^.]{0,70}\b(?:sehr\s+gut|gut|bedingt)\b[^.]{0,50}\bwochenend/i,
  /\b(?:echter\s+wettbewerb|servicequalität)\b/i,
  /\bzieht\s+reisende\b[^.]{0,100}\b(?:das\s+ganze\s+jahr|ganzjährig)\b/i,
  /\b(?:can save time|can widen schedule choice|can make the trip easier)\b/i,
  /\b(?:kann\s+zeit\s+sparen|auswahl\s+erweitern|reise\s+leichter\s+machen)\b/i,
  /\b(?:echtzeit|in\s+real[- ]?time)\b[^.]{0,80}\b(?:hunderte|hundreds|600\+?)\b[^.]{0,40}\b(?:airlines?|fluggesellschaften)\b/i,
  /\b(?:andere|anderen|alternative|other|alternate|alternativen?)\b[^.]{0,80}\b(?:flughäfen?|airports?|aéroports?|aeropuertos?|aeroporti|havaalanları)\b/i,
];

function text(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function hasUnsupportedClaim(value) {
  const t = text(value);
  return !!t && UNSUPPORTED.some((re) => re.test(t));
}

function hasPriceEvidence(route) {
  const c = validCurrency(route && route.price_currency);
  return !!c && [route && route.price_min, route && route.price_avg, route && route.price_max]
    .some((v) => validPositivePrice(v) != null);
}

function hasDirectEvidence(route) {
  if (route && typeof route.direct_flight_available === 'boolean') return true;
  const sd = route && route.stop_distribution;
  if (!sd || typeof sd !== 'object' || Array.isArray(sd)) return false;
  const entries = Object.entries(sd);
  if (!entries.length) return false;
  return entries.every(([k, v]) => /^\d+$/.test(String(k)) && Number.isInteger(Number(v)) && Number(v) >= 0)
    && entries.some(([, v]) => Number(v) > 0);
}

function hasUnbackedFact(route, value) {
  const t = text(value).toLowerCase();
  if (!t) return false;
  if (/\b(?:flugzeit|flight\s*time|duration|durée|duración|durata|süre)\b/i.test(t)
      && !(Number(route && route.avg_duration_min) > 0 || Number(route && route.min_duration_min) > 0)) return true;
  if ((/\b(?:€|eur|gbp|chf|usd|\$|£)\b/i.test(t) || /\b(?:ab|from|starting)\s+\d+/i.test(t)) && !hasPriceEvidence(route)) return true;
  if (/\b(?:airlines?|fluggesellschaften|aerolíneas|compagnie|havayolları)\b/i.test(t)
      && !(Number(route && route.airline_count) > 0)) return true;
  if (/\b(?:km|kilometer|kilometre|distanz|distance|entfernung)\b/i.test(t)
      && !(Number(route && route.distance_km) > 0)) return true;
  if (/\b(?:direktflüge?|direct\s+flights?|vols?\s+directs?|vuelos\s+directos|voli\s+diretti|directe\s+vluchten|direktflug|direktflüge|رحلات\s+مباشرة)\b/i.test(t)
      && !hasDirectEvidence(route)) return true;
  return false;
}

function generatedFieldIsSafe(route, value) {
  return !hasUnsupportedClaim(value) && !hasUnbackedFact(route, value);
}

module.exports = { text, hasUnsupportedClaim, hasUnbackedFact, generatedFieldIsSafe, hasPriceEvidence, hasDirectEvidence };
