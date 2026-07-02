// ═══════════════════════════════════════════════════════════════
// src/services/routePages.js
// حساب المسافة الحقيقية بين مطارين (Haversine)، وتصنيف الرحلة
// قصيرة/طويلة المدى، وإنشاء صفحات الدول/المدن تلقائياً أول مرة
// مسار جديد يلمسها — كل ده لصفحات SEO.
// ═══════════════════════════════════════════════════════════════

const supa = require('./supabase');
const log = require('./log');

// ─── [ROUTE-PAGES] Distance + haul classification ──────────────
// Standard great-circle (Haversine) distance between two points,
// returned in kilometers. Used to compute a real, verifiable distance
// for SEO route pages — never a fabricated/guessed number.
function haversineDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in km
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}
// 1500km is a standard aviation-industry rule of thumb for where
// short-haul (typically narrow-body) operations give way to long-haul —
// an objective, defensible threshold, not an arbitrary content-writing
// choice.
function classifyHaul(distanceKm) {
  return distanceKm < 1500 ? 'short-haul' : 'long-haul';
}

// [COUNTRY-PAGES] ISO code -> German display name, covering the
// countries realistically relevant to a German-market flight platform
// (Europe + major long-haul destinations). Falls back to the raw ISO
// code for anything not listed — still usable, just less polished —
// rather than failing to create the country page at all.
const COUNTRY_NAMES_DE = {
  DE: 'Deutschland', AT: 'Österreich', CH: 'Schweiz', GB: 'Vereinigtes Königreich',
  FR: 'Frankreich', ES: 'Spanien', IT: 'Italien', PT: 'Portugal', NL: 'Niederlande',
  BE: 'Belgien', LU: 'Luxemburg', PL: 'Polen', CZ: 'Tschechien', SK: 'Slowakei',
  HU: 'Ungarn', RO: 'Rumänien', BG: 'Bulgarien', GR: 'Griechenland', HR: 'Kroatien',
  SI: 'Slowenien', DK: 'Dänemark', SE: 'Schweden', NO: 'Norwegen', FI: 'Finnland',
  IE: 'Irland', IS: 'Island', TR: 'Türkei', RU: 'Russland', UA: 'Ukraine',
  US: 'USA', CA: 'Kanada', MX: 'Mexiko', BR: 'Brasilien', AR: 'Argentinien',
  AE: 'Vereinigte Arabische Emirate', SA: 'Saudi-Arabien', QA: 'Katar', KW: 'Kuwait',
  EG: 'Ägypten', MA: 'Marokko', TN: 'Tunesien', JO: 'Jordanien', LB: 'Libanon',
  IL: 'Israel', IN: 'Indien', TH: 'Thailand', JP: 'Japan', CN: 'China',
  KR: 'Südkorea', SG: 'Singapur', MY: 'Malaysia', ID: 'Indonesien', VN: 'Vietnam',
  AU: 'Australien', NZ: 'Neuseeland', ZA: 'Südafrika',
};

// [COUNTRY-PAGES] Auto-creates a countries row the first time a route
// touches that country — never pre-populated for the whole world, only
// on-demand as real routes get published, avoiding empty/thin country
// pages entirely. Fire-and-forget: a failure here must never block route
// creation itself (the route is the important part; the country page is
// a nice-to-have derived from it).
async function ensureCountryExists(isoCode) {
  if (!isoCode || !supa) return;
  try {
    const { data: existing } = await supa.from('countries').select('id').eq('code', isoCode).maybeSingle();
    if (existing) return;
    const name = COUNTRY_NAMES_DE[isoCode] || isoCode;
    await supa.from('countries').insert({ code: isoCode, name, status: 'published' });
    log('info', 'country_auto_created', { code: isoCode, name });
  } catch (e) {
    log('warn', 'ensure_country_exists_failed', { code: isoCode, error: e.message });
  }
}

// [CITY-PAGES] Auto-creates (or updates) a cities row whenever a
// published route touches a city — mirrors ensureCountryExists(), with
// the added complexity that airport_codes GROWS over time: the first
// route for "London" might only reveal LHR; a later route via LGW must
// append to the existing array, not overwrite it (and must not add a
// duplicate if the same airport shows up again). citySlug is computed
// by the caller via slugify() — the same normalization already used for
// blog/route slugs — so "Berlin" and "berlin " from two different routes
// correctly resolve to the same city row instead of silently creating
// two near-duplicate cities.
async function ensureCityExists(citySlug, displayName, countryCode, airportCode) {
  if (!citySlug || !supa) return;
  try {
    const { data: existing } = await supa.from('cities').select('id, airport_codes').eq('city_slug', citySlug).maybeSingle();
    if (existing) {
      if (airportCode && !(existing.airport_codes || []).includes(airportCode)) {
        await supa.from('cities').update({ airport_codes: [...(existing.airport_codes || []), airportCode] }).eq('id', existing.id);
        log('info', 'city_airport_added', { city_slug: citySlug, airport: airportCode });
      }
      return;
    }
    await supa.from('cities').insert({
      city_slug: citySlug,
      name: displayName,
      country_code: countryCode || null,
      airport_codes: airportCode ? [airportCode] : [],
      status: 'published',
    });
    log('info', 'city_auto_created', { city_slug: citySlug, name: displayName });
  } catch (e) {
    log('warn', 'ensure_city_exists_failed', { city_slug: citySlug, error: e.message });
  }
}

module.exports = {
  haversineDistanceKm,
  classifyHaul,
  COUNTRY_NAMES_DE,
  ensureCountryExists,
  ensureCityExists,
};
