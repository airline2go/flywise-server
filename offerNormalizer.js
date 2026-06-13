'use strict';

// ── Helpers ───────────────────────────────────────────────

function safeFloat(v, fallback = 0) {
  const n = parseFloat(v);
  return isNaN(n) ? fallback : n;
}

/**
 * Convert an ISO 8601 duration string (e.g. PT2H30M) to minutes.
 * Handles hours, minutes, and seconds. Returns 0 for invalid input.
 *
 * @param {string} iso
 * @returns {number}
 */
function isoToMin(iso) {
  if (!iso || typeof iso !== 'string') return 0;
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return 0;
  const h   = parseInt(m[1] || '0', 10);
  const min = parseInt(m[2] || '0', 10);
  const sec = parseInt(m[3] || '0', 10);
  return h * 60 + min + Math.round(sec / 60);
}

/**
 * Normalise a single flight slice from the Duffel response.
 *
 * @param {object|null} sl
 * @returns {object|null}
 */
function normSlice(sl) {
  if (!sl || typeof sl !== 'object') return null;
  const segs = Array.isArray(sl.segments) ? sl.segments : [];
  const last = segs[segs.length - 1];

  return {
    orig:  sl.origin?.iata_code      || segs[0]?.origin?.iata_code   || null,
    dest:  sl.destination?.iata_code || last?.destination?.iata_code  || null,
    dep:   segs[0]?.departing_at                                       || null,
    arr:   last?.arriving_at                                           || null,
    dur:   isoToMin(sl.duration),
    stops: Math.max(0, segs.length - 1),
    segs:  segs.map(s => ({
      from: s.origin?.iata_code               || null,
      to:   s.destination?.iata_code          || null,
      dep:  s.departing_at                    || null,
      arr:  s.arriving_at                     || null,
      dur:  isoToMin(s.duration),
      fn:   s.marketing_carrier_flight_number || null,
      al:   [
        s.marketing_carrier?.iata_code || 'XX',
        s.marketing_carrier?.name      || 'Unknown',
      ],
    })),
  };
}

/**
 * Normalise a raw Duffel offer object to the FlyWise API shape.
 * Returns null for falsy / non-object input (safe to use in .filter(Boolean)).
 *
 * @param {object} offer - raw Duffel offer
 * @returns {object|null}
 */
function normalizeOffer(offer) {
  if (!offer || typeof offer !== 'object') return null;

  const slices   = Array.isArray(offer.slices)        ? offer.slices        : [];
  const outbound = slices[0]                           || null;
  const inbound  = slices[1]                           || null;
  const firstPax = Array.isArray(offer.passengers)     ? offer.passengers[0] : null;
  const bags     = Array.isArray(firstPax?.baggages)   ? firstPax.baggages   : [];
  const al0      = Array.isArray(outbound?.segments)   ? outbound.segments[0] : null;
  const price    = safeFloat(offer.total_amount, 0);

  return {
    id:           offer.id            || null,
    isDuffel:     true,
    raw_offer_id: offer.id            || null,
    al: [
      al0?.marketing_carrier?.iata_code || 'XX',
      al0?.marketing_carrier?.name      || 'Unknown',
    ],
    price,
    currency:    offer.total_currency  || 'EUR',
    hasCabin:    bags.some(b => b?.type === 'carry_on' && Number(b?.quantity) > 0),
    hasChecked:  bags.some(b => b?.type === 'checked'  && Number(b?.quantity) > 0),
    co2:         null, // Duffel does not provide emissions data for this offer type
    outbound:    normSlice(outbound),
    inbound:     normSlice(inbound),
    expires_at:  offer.expires_at      || null,
    conditions:  offer.conditions && typeof offer.conditions === 'object'
      ? offer.conditions : {},
  };
}

module.exports = { normalizeOffer, isoToMin, normSlice };
