// ═══════════════════════════════════════════════════════════════
// src/services/normalizeOffer.js
// بيحوّل عرض Duffel الخام لشكل موحّد يفهمه الفرونت إند، وبيطبّق
// هامش الربح على السعر المعروض — نفس حساب computeTieredMargin
// المستخدم وقت الدفع بالظبط، عشان السعر اللي العميل شايفه وهو
// بيدوّر يفضل مطابق تماماً للي هيتحصّل منه فعلياً.
// ═══════════════════════════════════════════════════════════════

const { computeTieredMargin } = require('./adminConfig');

// ─── Normalize Offer ──────────────────────────────────────
// [PRICING-FIX] normalizeOffer applies the admin's ticket profit margin to
// the price shown in search results — previously this returned Duffel's
// raw net total_amount untouched, so customers saw one price while
// browsing and a completely different (correct, margin-included) price
// only at checkout. ticketTiers is fetched ONCE by the caller and passed
// in here (not re-fetched per offer) since a single search can normalize
// dozens of offers — same computeTieredMargin() math used by
// computeAuthoritativePricing() at payment time, so the number a customer
// sees while searching and the number they're actually charged always
// agree from the very first look.
function normalizeOffer(offer, ticketTiers) {
  if (!offer) return null;
  const slices = offer.slices || [];
  const outbound = slices[0];
  const inbound = slices[1] || null;

  function normSlice(sl) {
    if (!sl) return null;
    const segs = sl.segments || [];
    return {
      orig: sl.origin?.iata_code || segs[0]?.origin?.iata_code,
      dest: sl.destination?.iata_code || segs[segs.length - 1]?.destination?.iata_code,
      dep: segs[0]?.departing_at,
      arr: segs[segs.length - 1]?.arriving_at,
      dur: isoToMin(sl.duration),
      stops: segs.length - 1,
      segs: segs.map(s => ({
        id: s.id,
        from: s.origin?.iata_code,
        to: s.destination?.iata_code,
        dep: s.departing_at,
        arr: s.arriving_at,
        dur: isoToMin(s.duration),
        fn: s.marketing_carrier_flight_number,
        al: [s.marketing_carrier?.iata_code || 'XX', s.marketing_carrier?.name || 'Unknown'],
      })),
    };
  }

  // Baggages live on the segment's passenger entry (Duffel puts them there),
  // with a fallback to the offer-level passenger if present.
  const segPaxBags = outbound?.segments?.[0]?.passengers?.[0]?.baggages;
  const bags = (Array.isArray(segPaxBags) && segPaxBags.length)
    ? segPaxBags
    : (offer.passengers?.[0]?.baggages || []);
  const al0 = outbound?.segments?.[0];

  // ── Real fare/brand data from Duffel (only what the airline actually sends) ──
  // Fare info lives on each segment's passenger entry. We read it from the
  // first segment of the outbound slice for the first passenger.
  const firstSegPax = outbound?.segments?.[0]?.passengers?.[0] || null;
  const cabin = firstSegPax?.cabin || null;

  // fare_brand_name can appear at offer level, slice level, or on the segment passenger.
  // Duffel commonly puts it on the SLICE, so check there too.
  const fareBrand = offer.fare_brand_name
    || outbound?.fare_brand_name
    || firstSegPax?.fare_brand_name
    || null;

  const cabinMarketingName = firstSegPax?.cabin_class_marketing_name
    || cabin?.marketing_name
    || null;

  const cabinClass = firstSegPax?.cabin_class || cabin?.name || null;

  // Amenities (wifi / seat / power) — only if the airline provides them
  let amenities = null;
  if (cabin?.amenities) {
    amenities = {};
    const am = cabin.amenities;
    if (am.wifi) amenities.wifi = { available: am.wifi.available === true || am.wifi.available === 'true', cost: am.wifi.cost || null };
    if (am.power) amenities.power = { available: am.power.available === true || am.power.available === 'true' };
    if (am.seat) amenities.seat = { type: am.seat.type || null, pitch: am.seat.pitch || null, legroom: am.seat.legroom || null };
    if (Object.keys(amenities).length === 0) amenities = null;
  }

  // Per-passenger baggage detail (counts) — real numbers only
  const cabinBag = bags.find(b => b.type === 'carry_on');
  const checkedBag = bags.find(b => b.type === 'checked');
  // Included-baggage weight, if the airline provides it (null otherwise)
  function bagWeight(bag) {
    if (!bag) return null;
    if (bag.weight != null) return Number(bag.weight);
    if (bag.maximum_weight_kg != null) return Number(bag.maximum_weight_kg);
    return null;
  }

  // [PRICING-FIX] netPrice is Duffel's real, unmodified total for ALL
  // passengers combined — Duffel never breaks total_amount down per
  // passenger, so this is the only number available. The fixed-amount
  // part of a tier (e.g. "+500€") is a per-passenger fee in this
  // business's pricing model, not a flat one-time charge on the whole
  // booking — a 3-passenger booking should add the fixed fee 3 times,
  // matching what 3 separate solo bookings would each pay. We approximate
  // each passenger's net share as netPrice / passengerCount (Duffel
  // doesn't expose individual passenger prices when types/ages differ,
  // so an equal split is the best available approximation), compute the
  // tiered margin per passenger on that share, then sum across all
  // passengers. This margin is for DISPLAY ONLY — kept alongside the net
  // price never sent to Duffel — but it directly drives the bottom line,
  // so getting the per-passenger math right here matters as much as it
  // does in computeAuthoritativePricing() at checkout.
  const netPrice = parseFloat(offer.total_amount || 0);
  const passengerCount = Math.max(1, (offer.passengers || []).length);
  const netPerPassenger = netPrice / passengerCount;
  const marginPerPassenger = computeTieredMargin(netPerPassenger, ticketTiers);
  const ticketMargin = Math.round(marginPerPassenger * passengerCount * 100) / 100;
  const displayPrice = Math.round((netPrice + ticketMargin) * 100) / 100;

  return {
    id: offer.id,
    isDuffel: true,
    raw_offer_id: offer.id,
    al: [al0?.marketing_carrier?.iata_code || 'XX', al0?.marketing_carrier?.name || 'Unknown'],
    price: displayPrice,
    netPrice: netPrice,
    margin: ticketMargin,
    currency: offer.total_currency || 'EUR',
    hasCabin: bags.some(b => b.type === 'carry_on' && b.quantity > 0),
    hasChecked: bags.some(b => b.type === 'checked' && b.quantity > 0),
    cabinBagQty: cabinBag ? cabinBag.quantity : null,
    checkedBagQty: checkedBag ? checkedBag.quantity : null,
    cabinBagWeightKg: bagWeight(cabinBag),
    checkedBagWeightKg: bagWeight(checkedBag),
    co2: (offer.total_emissions_kg != null) ? Math.round(Number(offer.total_emissions_kg)) : Math.round(parseFloat(offer.total_amount || 0) * 1.1),
    outbound: normSlice(outbound),
    inbound: normSlice(inbound),
    // [FIX] Multi-city support: expose EVERY slice of the offer (not just
    // the first two). A multi-city offer is one combined itinerary with one
    // total price — it must be rendered as a single card with N legs, never
    // split into N separate "offers" (Duffel doesn't price legs separately).
    allSlices: slices.map(normSlice),
    expires_at: offer.expires_at,
    conditions: offer.conditions || {},
    // ── Real fare brand data (null when the airline doesn't provide it) ──
    fare_brand_name: fareBrand,
    cabin_marketing_name: cabinMarketingName,
    cabin_class: cabinClass,
    amenities: amenities,
    // Hold price/space: airline lets you book without instant payment
    holdSpace: offer.payment_requirements ? (offer.payment_requirements.requires_instant_payment === false) : false,
    priceGuaranteeExpiresAt: offer.payment_requirements?.price_guarantee_expires_at || null,
    paymentRequiredBy: offer.payment_requirements?.payment_required_by || null,
    // Whether the airline requires passenger passport/identity documents for this offer
    identityDocsRequired: offer.passenger_identity_documents_required === true,
  };
}

function isoToMin(iso) {
  if (!iso) return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  return m ? parseInt(m[1] || 0) * 60 + parseInt(m[2] || 0) : 0;
}

module.exports = { normalizeOffer, isoToMin };
