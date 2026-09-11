// ═══════════════════════════════════════════════════════════════
// src/services/booking.js
// [CORE] أهم وأخطر ملف في السيرفر كله — منطق الحجز والتسعير
// الرسمي المشترك بين /confirm-payment وStripe webhook. أي تعديل
// هنا لازم يترفق بمراجعة دقيقة جداً قبل النشر، لأنه بيتحكم في:
// - حساب السعر الرسمي اللي العميل بيتحصّل منه فعلياً
// - حماية من تغيّر السعر بين الدفع والحجز (price drift protection)
// - استرداد الفلوس تلقائياً لو فشل الحجز بعد الدفع
// - كل عمليات القاعدة (bookings, payments) وتطبيق الولاء والإيميل
// ═══════════════════════════════════════════════════════════════

const supa = require('../clients/supabase');
const stripe = require('../clients/stripe');
const log = require('../utils/log');
const duffel = require('./duffel');
const { computeTieredMargin, getTicketProfitTiers, getAncillaryProfitTiers } = require('./adminConfig');
const { computeLoyaltyDiscount, applyLoyaltyForBooking } = require('./loyalty');
const { attachBookingIfReferred } = require('./referrals');
const { sendBookingConfirmationEmail, buildOrderSummaryForEmail } = require('./email');
const { getPendingBooking, markPendingBooked, setBookingStatus, setPaymentStatus } = require('./pendingBookings');
const { roundMoney } = require('../utils/money');
const {
  BOOKING_STATUS, PAYMENT_STATUS, SUPPLIER_STATUS,
  getPaymentIntentId, piIsAuthorized, authorizationExpiresAt,
  captureAuthorizedPayment, cancelAuthorization, alertCritical, errorWithCode,
} = require('./payments');

// [PAYMENT-LIFECYCLE] Release the customer's money the SAFE way when a
// supplier booking fails BEFORE capture (brief §8):
//   - manual-capture authorization (requires_capture) → CANCEL it. No
//     money moved, so there is NOTHING to refund — cancelling releases the
//     hold at zero cost (this is the whole point of the new architecture).
//   - immediate-capture payment method (money already taken) → a real
//     refund is the only option, exactly as the legacy flow did.
// Returns { cancelled, refunded }.
async function releaseAuthorizationOrRefund({ sessionId, session, paymentIntentId, manualAuthorized, reason }) {
  if (manualAuthorized && paymentIntentId) {
    try {
      const r = await cancelAuthorization(paymentIntentId, { sessionId, reason: reason || 'abandoned' });
      if (r.cancelled) {
        log('info', 'PAYMENT_AUTHORIZATION_CANCELLED', { session_id: sessionId, payment_intent_id: paymentIntentId, reason: reason || null });
        return { cancelled: true, refunded: false };
      }
      // cannotCancel → money was actually captured; fall through to refund.
    } catch (e) {
      log('error', 'authorization_cancel_failed', { session_id: sessionId, payment_intent_id: paymentIntentId, error: e.message });
      return { cancelled: false, refunded: false };
    }
  }
  // Legacy immediate-capture path: money is already taken, so refund it.
  let refunded = false;
  if (stripe && stripe.refunds && session && session.payment_intent) {
    try {
      log('info', 'REFUND_STARTED', { session_id: sessionId, payment_intent: session.payment_intent });
      await stripe.refunds.create({ payment_intent: session.payment_intent });
      refunded = true;
      log('info', 'REFUND_COMPLETED', { session_id: sessionId, payment_intent: session.payment_intent });
    } catch (e) {
      log('error', 'refund_failed', { session_id: sessionId, error: e.message });
    }
  }
  return { cancelled: false, refunded };
}

// ─── Helper: attach Duffel passenger ids ──────────────────
// Duffel's /air/orders requires every passenger to carry the `id` that came
// from the original offer. The frontend doesn't know these ids, so we fetch
// the offer and map them by passenger type (adult/child/infant), in order.
async function attachPassengerIds(offerId, passengers) {
  const offerRes = await duffel('GET', `/air/offers/${offerId}`);
  const offerPax = (offerRes.data && offerRes.data.passengers ? offerRes.data.passengers : []).slice();
  const mapped = (passengers || []).map((p) => {
    let idx = offerPax.findIndex((op) => op && op.type === p.type);
    if (idx === -1) idx = offerPax.findIndex((op) => !!op); // fallback: any remaining
    let id = null;
    if (idx !== -1) { id = offerPax[idx].id; offerPax[idx] = null; }
    return id ? Object.assign({}, p, { id }) : Object.assign({}, p);
  });
  // Duffel rule: every infant (infant_without_seat) must be assigned to a UNIQUE
  // responsible adult via infant_passenger_id, otherwise the order is rejected.
  const adults = mapped.filter((p) => p.type === 'adult');
  const infants = mapped.filter((p) => p.type === 'infant_without_seat');
  for (let i = 0; i < infants.length && i < adults.length; i++) {
    if (infants[i].id) adults[i].infant_passenger_id = infants[i].id;
  }
  return mapped;
}

// [FREE-CHAIR-FIX] Passenger order used to tie a seat's per-passenger service
// to a passenger index, mirroring /offer and /seatmaps: adults, then children,
// then infants, in Duffel's own listed order. passengerOrder[i] is the Duffel
// passenger id for "passenger index i" — the exact index the frontend stores a
// chosen seat under.
function offerPassengerOrder(offerData) {
  const pax = (offerData && offerData.passengers) || [];
  const byType = (t) => pax.filter((p) => p && p.type === t).map((p) => p.id);
  return [...byType('adult'), ...byType('child'), ...byType('infant_without_seat')];
}

// [FREE-CHAIR-FIX] Find the CURRENT Duffel seat service id for a chosen seat in
// a freshly-fetched seat map, matching by the seat's STABLE identity (segment +
// designator + passenger) rather than by service id. Seat-map service ids are
// only meaningful within the seat_maps response that produced them, so an id
// the customer's browser captured from its own earlier /seatmaps call is not
// guaranteed to be present in a later, independent seat_maps fetch — matching by
// id alone silently dropped the seat (it vanished from the total and was never
// charged or booked). Segment id + designator ARE stable for the life of the
// offer, so re-resolving through them yields the id that IS valid in this fetch.
// Returns null when the seat can't be found (caller then falls back to the
// original id — no worse than the old behaviour). Mirrors normalizeSeatMap()'s
// per-passenger service selection (passenger_ids when present, else positional).
function findCurrentSeatServiceId(seatMapsData, passengerOrder, segmentId, designator, passengerIndex) {
  if (!Array.isArray(seatMapsData) || !designator) return null;
  const pos = (typeof passengerIndex === 'number' && passengerIndex >= 0) ? passengerIndex : 0;
  for (const sm of seatMapsData) {
    if (segmentId && sm && sm.segment_id && sm.segment_id !== segmentId) continue;
    for (const cabin of (sm.cabins || [])) {
      for (const row of (cabin.rows || [])) {
        for (const section of (row.sections || [])) {
          for (const el of (section.elements || [])) {
            if (el.type !== 'seat' || el.designator !== designator) continue;
            const svcs = el.available_services || [];
            if (!svcs.length) return null;
            const pid = (passengerOrder || [])[pos] || null;
            const anyRealPassengerId = svcs.some((svc) => svc.passenger_ids && svc.passenger_ids[0]);
            if (pid && anyRealPassengerId) {
              const match = svcs.find((svc) => svc.passenger_ids && svc.passenger_ids.indexOf(pid) !== -1);
              if (match) return match.id;
            }
            const positional = svcs[pos] || svcs[0];
            return positional ? positional.id : null;
          }
        }
      }
    }
  }
  return null;
}

// [FREE-CHAIR-FIX] Re-point each requested SEAT to its current service id in the
// fresh seat map (see findCurrentSeatServiceId). Only seat requests carry a
// `designator`; baggage (whose ids come from the offer's own available_services
// and are stable) is passed through untouched. The stable identity fields are
// preserved on the returned entries so the same re-resolution can run again at
// booking time against the seat map fetched then.
function resolveSeatServiceIds(services, seatMapsData, passengerOrder) {
  if (!Array.isArray(services) || !services.length) return services || [];
  if (!services.some((s) => s && s.designator)) return services;
  return services.map((s) => {
    if (!s || !s.designator) return s;
    const current = findCurrentSeatServiceId(seatMapsData, passengerOrder, s.segment_id, s.designator, s.passenger);
    if (current && current !== s.id) {
      log('info', 'seat_service_id_reresolved', { designator: s.designator, segment_id: s.segment_id || null, from: s.id || null, to: current });
    }
    return current ? { ...s, id: current } : s;
  });
}

// ─── Helper: validate baggage/seat services against the live offer ────────
// Duffel rejects an order if a service id isn't actually available for it
// (e.g. expired offer, wrong segment). To avoid "paid but booking failed",
// we drop any service the current offer no longer offers, and clamp quantity.
async function validateServices(offerId, services, preFetchedAvailable) {
  if (!Array.isArray(services) || !services.length) return [];
  let available = preFetchedAvailable;
  if (!available) {
    try {
      const r = await duffel('GET', `/air/offers/${offerId}?return_available_services=true`);
      available = (r.data && r.data.available_services) || [];
    } catch (e) {
      log('warn', 'validateServices_fetch_failed', { error: e.message });
      return services; // fall through; Duffel will be the final judge
    }
  }
  const byId = new Map(available.map((s) => [s.id, s]));
  const clean = [];
  for (const svc of services) {
    const av = byId.get(svc.id);
    if (!av) { log('warn', 'service_dropped_unavailable', { id: svc.id }); continue; }
    const maxQ = (av.maximum_quantity != null) ? Number(av.maximum_quantity) : 1;
    // [FREE-CHAIR-FIX] Carry a seat's stable identity (designator/segment/
    // passenger) through validation so it survives into safeServices — the
    // booking-time pricing recompute re-resolves the seat id from the seat
    // map fetched then, exactly as this pricing pass does. Stripped back to
    // { id, quantity } right before the Duffel order call (Duffel rejects
    // unknown service fields).
    const entry = { id: svc.id, quantity: Math.max(1, Math.min(Number(svc.quantity) || 1, maxQ)) };
    if (svc.designator) {
      entry.designator = svc.designator;
      if (svc.segment_id) entry.segment_id = svc.segment_id;
      if (svc.passenger != null) entry.passenger = svc.passenger;
    }
    clean.push(entry);
  }
  return clean;
}

// ─── [ADMIN-MARGIN] Promo code lookup + validation (server-authoritative) ──
// Replaces the old hardcoded PROMO_CODES object that used to live in the
// frontend (visible to anyone via devtools, no real usage cap). The server
// is now the only place a code is checked or applied.
async function lookupPromoCode(code) {
  if (!code || !supa) return null;
  const normalized = String(code).trim().toUpperCase();
  if (!normalized) return null;
  try {
    const { data, error } = await supa.from('promo_codes').select('*').eq('code', normalized).maybeSingle();
    if (error || !data) return null;
    if (!data.active) return { valid: false, reason: 'inactive' };
    if (data.expires_at && new Date(data.expires_at) < new Date()) return { valid: false, reason: 'expired' };
    if (data.max_uses != null && data.used_count >= data.max_uses) return { valid: false, reason: 'max_uses_reached' };
    return { valid: true, row: data };
  } catch (e) {
    log('warn', 'promo_lookup_failed', { code: normalized, error: e.message });
    return null;
  }
}

function computePromoDiscount(promoRow, subtotal) {
  if (!promoRow) return 0;
  const raw = promoRow.type === 'percent' ? subtotal * (Number(promoRow.value) || 0) / 100 : Number(promoRow.value) || 0;
  // Never discount more than the subtotal itself (no negative totals).
  return Math.round(Math.min(Math.max(raw, 0), subtotal) * 100) / 100;
}

// [F8 · PROMO-RACE] Atomic check-and-increment via the increment_promo_usage
// RPC (sql/promo_atomic_increment.sql) — a single guarded UPDATE instead of
// the old read-then-write, so two concurrent checkouts can never push
// used_count past max_uses. Returns true if the counter was incremented,
// false if the cap was already reached (or the id wasn't found / no DB).
async function incrementPromoUsage(promoId) {
  if (!supa || !promoId) return false;
  try {
    const { data, error } = await supa.rpc('increment_promo_usage', { p_promo_id: promoId });
    if (error) {
      log('warn', 'promo_increment_rpc_failed', { promoId, error: error.message });
      return false;
    }
    if (data === false) log('warn', 'promo_usage_cap_reached', { promoId });
    return data !== false;
  } catch (e) {
    log('warn', 'promo_increment_failed', { promoId, error: e.message });
    return false;
  }
}

// ─── [ADMIN-MARGIN] Server-authoritative full price computation ───────────
// THE single source of truth for what Duffel gets paid vs. what the
// customer is charged. Never trusts amounts the browser sends — re-derives
// everything from Duffel's live offer + the server's own margin tiers +
// the server's own promo_codes table. Used by BOTH /create-checkout-session
// (before payment) and bookFromSession (right before booking), so the two
// can never disagree.
async function computeAuthoritativePricing(offerId, requestedServices, promoCode, deviceId, userId, applyLoyalty, perfLabel, opts) {
  // [P0.8 · DEADLINE] Optional overall wall-clock cap for the upstream Duffel
  // work (the only unbounded part of this function; the DB stages below are
  // cached/single indexed lookups of ~tens of ms). Passed ONLY by the
  // interactive /price-preview path — checkout/booking pass nothing, so their
  // behaviour is completely unchanged. When the deadline fires, a shared
  // AbortController cancels the in-flight offer/seat-map fetches AND stops any
  // pending retry (see src/services/duffel.js), and this function throws a
  // classified UPSTREAM_TIMEOUT (mapped to HTTP 504 by the route) instead of
  // hanging up to the ~40s double-timeout. It NEVER returns a partial or stale
  // price on timeout — it throws. Pricing math and booking logic are untouched.
  const _deadlineMs = opts && Number(opts.deadlineMs) > 0 ? Number(opts.deadlineMs) : 0;
  let _deadlineCtrl = null, _deadlineTimer = null;
  if (_deadlineMs) {
    _deadlineCtrl = new AbortController();
    _deadlineTimer = setTimeout(() => _deadlineCtrl.abort(), _deadlineMs);
    if (_deadlineTimer.unref) _deadlineTimer.unref();
  }
  const _duffelOpts = _deadlineCtrl ? { signal: _deadlineCtrl.signal } : null;
  // [PERF-INSTRUMENT · P0.1] Pure timing instrumentation — measures how long
  // each stage of this function takes and emits ONE structured log line at
  // the end. It changes NOTHING about the pricing result, the order of
  // operations, or the values returned; every _perf* variable is write-only
  // for logging. Deliberately logs NO card data, tokens, secrets, PII, or
  // full payment details — only stage durations in ms plus non-sensitive
  // shape counts (offer_id is already logged elsewhere in this same flow).
  // Lets P0.2 prove, with real production numbers, whether the ~40s p95 on
  // /price-preview is Duffel offers, Duffel seat_maps, DB, or the retry ×
  // timeout combination — instead of guessing.
  const _perfStart = Date.now();
  let _perfOffersMs = 0, _perfSeatMapsMs = 0;
  // [SEAT-PRICING-FIX] Per Duffel's own seat-maps docs: "A seat is a
  // special kind of service in that they're NOT shown when getting an
  // individual offer with return_available_services set to true. They're
  // only available through [the seat maps] endpoint." available_services
  // on the offer endpoint only ever contains baggage. Before this fix,
  // validateServices() checked every requested service (seats AND bags)
  // against available_services alone — so a chosen seat could never be
  // found there, got silently dropped ("service_dropped_unavailable"),
  // and contributed exactly 0 to both the net Duffel cost and the margin.
  // That's precisely how a customer could pick a seat, see its real price
  // appear for a moment (computed client-side from /seatmaps data), and
  // then watch it vanish moments later once syncPriceWithServer() replaced
  // the total with the server's recomputed (seat-less) figure — the seat
  // was never actually being charged for or reliably booked. Fetching
  // seat maps here too and merging their priced seat services into the
  // same lookup table available_services uses fixes both the live total
  // AND what's actually validated/charged at checkout.
  // [PERF · P0.4] Fetch the offer first (ALWAYS needed: ticket price +
  // baggage services), then fetch /air/seat_maps ONLY when a requested
  // service could actually be a seat. Seats appear EXCLUSIVELY via
  // /air/seat_maps (never in the offer's available_services — see the
  // [SEAT-PRICING-FIX] note above), so the (heavy) seat map is needed only
  // to validate/price a chosen seat. /price-preview is called after every
  // bag/seat toggle, but the vast majority of those calls have no seat
  // selected — yet the previous code fetched the full seat map on EVERY
  // call. That heavy call is the prime suspect for the ~40s p95 (it is the
  // one wrapped in .catch(), so a 40s upstream timeout was silently
  // absorbed while still costing the full 40s). Skipping it whenever no
  // seat is requested removes that upstream call from the hot path
  // entirely, WITHOUT changing any price: a request with no seat has no
  // seat to validate or charge for, so seatServices would have been empty
  // anyway. When a seat IS requested, behaviour is identical to before
  // (seat_maps fetched, seat validated/priced) — the two calls just run
  // sequentially on that minority path, which is already dominated by the
  // seat_maps cost.
  //
  // [PERF-INSTRUMENT · P0.1] Each Duffel call is still timed individually
  // (in a finally, so a caught seat_maps failure still records its real
  // duration); seat_maps_ms stays 0 and seat_maps_skipped=true when the
  // call is skipped.
  //
  // NOTE (P0.2 GATE): this optimization must not ship until production
  // pricing_timing evidence confirms seat_maps is the dominant cost.
  let _perfSeatMapsSkipped = false;
  let offerCheck, seatMapsResult = { data: [] };
  try {
    offerCheck = await (async () => { const _s = Date.now(); try { return await duffel('GET', `/air/offers/${offerId}?return_available_services=true`, null, null, _duffelOpts); } finally { _perfOffersMs = Date.now() - _s; } })();
    const baggageServices0 = (offerCheck.data && offerCheck.data.available_services) || [];
    const _baggageIdSet0 = new Set(baggageServices0.map((s) => s && s.id));
    // A requested service id that isn't a known baggage service can only be a
    // seat (the sole other service type this flow handles) — so nothing needs
    // the seat map unless at least one such id is present.
    // [FREE-CHAIR-FIX] A request that carries a `designator` is unambiguously a
    // seat, so fetch the seat map for it too — even if its (possibly stale)
    // service id happens to collide with the baggage set — so it can be
    // re-resolved and priced instead of silently dropped.
    const _needsSeatMaps = (requestedServices || []).some((s) => s && ((s.id && !_baggageIdSet0.has(s.id)) || s.designator));
    if (_needsSeatMaps) {
      // [P0.8] The .catch() still swallows a benign "no seat map" (Duffel 422)
      // into an empty map, but a deadline abort must NOT be swallowed — it has
      // to propagate so the caller fails in a controlled way instead of
      // silently pricing without the seat the customer selected.
      seatMapsResult = await (async () => { const _s = Date.now(); try { return await duffel('GET', `/air/seat_maps?offer_id=${encodeURIComponent(offerId)}`, null, null, _duffelOpts).catch((e) => { if (e && e.code === 'UPSTREAM_DEADLINE') throw e; return { data: [] }; }); } finally { _perfSeatMapsMs = Date.now() - _s; } })();
    } else {
      _perfSeatMapsSkipped = true;
    }
  } catch (e) {
    if (_deadlineTimer) clearTimeout(_deadlineTimer);
    if (e && e.code === 'UPSTREAM_DEADLINE') {
      log('warn', 'pricing_deadline_exceeded', { offer_id: offerId, label: perfLabel || null, deadline_ms: _deadlineMs, offers_ms: _perfOffersMs, seat_maps_ms: _perfSeatMapsMs });
      const err = new Error('Die Preisberechnung hat zu lange gedauert. Bitte erneut versuchen.');
      err.code = 'UPSTREAM_TIMEOUT';
      err.status = 504;
      throw err;
    }
    throw e;
  }
  if (_deadlineTimer) clearTimeout(_deadlineTimer);
  const baggageServices = (offerCheck.data && offerCheck.data.available_services) || [];
  const seatServices = [];
  for (const sm of (seatMapsResult.data || [])) {
    for (const cabin of (sm.cabins || [])) {
      for (const row of (cabin.rows || [])) {
        for (const section of (row.sections || [])) {
          for (const el of (section.elements || [])) {
            if (el.type === 'seat' && Array.isArray(el.available_services)) {
              for (const svc of el.available_services) seatServices.push(svc);
            }
          }
        }
      }
    }
  }
  const avail = baggageServices.concat(seatServices);
  // [FREE-CHAIR-FIX] Re-resolve each chosen seat to its current service id in
  // THIS fresh seat map (by segment + designator + passenger) before validating
  // — otherwise a paid seat the customer selected can be dropped just because
  // its browser-captured id isn't in this fetch, leaving it shown but never
  // charged. A genuinely free seat (net 0) still stays free downstream.
  const resolvedServices = resolveSeatServiceIds(requestedServices || [], seatMapsResult.data || [], offerPassengerOrder(offerCheck.data));
  const safeServices = await validateServices(offerId, resolvedServices, avail);

  const netTicketPrice = parseFloat(offerCheck.data && offerCheck.data.total_amount || 0);
  const currency = (offerCheck.data && offerCheck.data.total_currency) || 'EUR';

  const _perfTiersStart = Date.now();
  const ticketTiers = await getTicketProfitTiers();
  const ancillaryTiers = await getAncillaryProfitTiers();
  const _perfTiersMs = Date.now() - _perfTiersStart; // DB margin tiers (cache hit ≈ 0)
  // [PRICING-FIX] Same per-passenger margin logic as normalizeOffer() —
  // the fixed-amount part of a tier (e.g. "+500€") is meant to apply once
  // PER PASSENGER, not once for the whole multi-passenger booking. Duffel
  // only gives us one combined total_amount, never a per-passenger
  // breakdown, so we split it evenly across passengers as the best
  // available approximation, apply the tier to that per-passenger share,
  // then sum back up. This is the number actually charged at checkout, so
  // it must match normalizeOffer()'s math exactly or the price a customer
  // sees while searching will drift from what they're charged.
  const ticketPassengerCount = Math.max(1, (offerCheck.data && offerCheck.data.passengers || []).length);
  const netPerPassenger = netTicketPrice / ticketPassengerCount;
  const marginPerPassenger = computeTieredMargin(netPerPassenger, ticketTiers);
  const ticketMargin = Math.round(marginPerPassenger * ticketPassengerCount * 100) / 100;

  const byId = new Map(avail.map((s) => [s.id, s]));
  // [SEAT-MARGIN-REENABLED] Seat services now carry the same ancillary profit
  // tier as baggage — the customer-facing seat price = Duffel net + margin, and
  // that margin is charged at checkout. A net-0 (free) seat/bag stays free.
  let netServicesTotal = 0, servicesMargin = 0;
  for (const svc of safeServices) {
    const av = byId.get(svc.id);
    if (!av || !av.total_amount) continue;
    const qty = svc.quantity || 1;
    const netUnit = parseFloat(av.total_amount);
    netServicesTotal += netUnit * qty;
    // Seats and baggage alike: net 0 stays free, otherwise the ancillary tier applies.
    const unitMargin = netUnit > 0 ? computeTieredMargin(netUnit, ancillaryTiers) : 0;
    servicesMargin += unitMargin * qty;
  }
  netServicesTotal = Math.round(netServicesTotal * 100) / 100;
  servicesMargin = Math.round(servicesMargin * 100) / 100;

  // What Duffel must be paid: its exact net price, margin NEVER included.
  const duffelAmount = Math.round((netTicketPrice + netServicesTotal) * 100) / 100;
  // What the customer would pay before any promo/loyalty discount.
  const preDiscountTotal = Math.round((netTicketPrice + ticketMargin + netServicesTotal + servicesMargin) * 100) / 100;

  const _perfPromoStart = Date.now();
  let promoRow = null, promoDiscount = 0, promoStatus = null;
  if (promoCode) {
    const lookup = await lookupPromoCode(promoCode);
    if (lookup && lookup.valid) {
      promoRow = lookup.row;
      promoDiscount = computePromoDiscount(promoRow, preDiscountTotal);
      promoStatus = 'applied';
    } else {
      promoStatus = (lookup && lookup.reason) || 'invalid';
    }
  }
  const _perfPromoMs = Date.now() - _perfPromoStart; // DB promo lookup (0 if no code)

  // [LOYALTY-TIMING-FIX] The loyalty discount must only ever be COMPUTED
  // (and therefore shown as a price reduction) at the actual checkout
  // step — not while the customer is still browsing baggage/seat options.
  // Before this, /price-preview (called after every bag/seat toggle, to
  // keep the running total in sync with the server) used this exact same
  // function with no way to say "don't apply loyalty yet", so a logged-in
  // user with credit saw the discount kick in the moment they picked a
  // bag — long before they'd reached payment. We still look up the
  // account (loyaltyAccount) so its balance/tier can be shown for
  // informational purposes, but loyaltyDiscount itself stays 0 unless the
  // caller explicitly passes applyLoyalty=true.
  const _perfLoyaltyStart = Date.now();
  let loyaltyDiscount = 0, loyaltyAccount = null;
  if (userId) {
    const result = await computeLoyaltyDiscount('user', userId, preDiscountTotal);
    loyaltyAccount = result.account;
    if (applyLoyalty) loyaltyDiscount = result.discount;
  }
  const _perfLoyaltyMs = Date.now() - _perfLoyaltyStart; // DB loyalty account (0 if guest)

  // [PERF-INSTRUMENT · P0.1] One structured line per pricing computation.
  // duffel_ms is the wall-clock of the parallel pair (the slower of the
  // two, ≈ what the customer waits), while offers_ms/seat_maps_ms break it
  // apart. `other_ms` is everything not otherwise attributed (pricing math,
  // validateServices' own work, serialization) — normally single-digit ms.
  // Emitted at info level: prints to the Render/Sentry console stream, and
  // is intentionally NOT persisted to error_logs (that path is warn/error
  // only), so this adds no per-request DB write.
  try {
    const _perfTotalMs = Date.now() - _perfStart;
    const _perfDuffelMs = Math.max(_perfOffersMs, _perfSeatMapsMs);
    log('info', 'pricing_timing', {
      label: perfLabel || null,
      offer_id: offerId,
      total_ms: _perfTotalMs,
      duffel_ms: _perfDuffelMs,
      offers_ms: _perfOffersMs,
      seat_maps_ms: _perfSeatMapsMs,
      seat_maps_skipped: _perfSeatMapsSkipped,
      tiers_ms: _perfTiersMs,
      promo_ms: _perfPromoMs,
      loyalty_ms: _perfLoyaltyMs,
      other_ms: Math.max(0, _perfTotalMs - _perfDuffelMs - _perfTiersMs - _perfPromoMs - _perfLoyaltyMs),
      services_count: (requestedServices || []).length,
      authed: !!userId,
      applied_loyalty: !!applyLoyalty,
    });
  } catch (_e) { /* timing log must never affect pricing */ }

  const totalDiscount = Math.min(promoDiscount + loyaltyDiscount, preDiscountTotal);
  const customerAmount = Math.round((preDiscountTotal - totalDiscount) * 100) / 100;

  return {
    currency, safeServices,
    netTicketPrice, ticketMargin, netServicesTotal, servicesMargin,
    duffelAmount, preDiscountTotal, discount: totalDiscount, customerAmount,
    promo: promoRow ? { id: promoRow.id, code: promoRow.code, type: promoRow.type, value: promoRow.value } : null,
    promoStatus, promoDiscount,
    loyaltyKind: userId ? 'user' : null, loyaltyId: userId || null,
    loyaltyDiscount, loyaltyAccount: loyaltyAccount ? { credit: loyaltyAccount.credit, points: loyaltyAccount.points, tier: loyaltyAccount.tier } : null,
  };
}
// session from both booking (double-click / double-tab race). ───────────
const inFlight = new Set();

// ─── POST /confirm-payment ────────────────────────────────

async function bookFromSession(session_id, session) {
  // 2) Recover the booking payload stored at session creation
  const entry = await getPendingBooking(session_id);
  if (!entry) { const e = new Error('Buchungsdaten nicht gefunden oder abgelaufen'); e.code = 'NO_ENTRY'; throw e; }

  // [PAYMENT-LIFECYCLE] Resolve the Stripe PaymentIntent and the capture
  // mode ONCE up front (brief §5/§17). `manualAuthorized` means the money is
  // only HELD (capture_method 'manual', PI in requires_capture) and must be
  // captured after — never before — a confirmed Duffel booking (§7). When
  // there is no PI (no Stripe in tests) or an immediate-capture method
  // already took the money, manualAuthorized is false and the flow falls back
  // to the legacy immediate-capture / refund-on-failure behaviour unchanged.
  const paymentIntentId = getPaymentIntentId(session);
  let pi = null;
  if (paymentIntentId && stripe && stripe.paymentIntents && typeof stripe.paymentIntents.retrieve === 'function') {
    try { pi = await stripe.paymentIntents.retrieve(paymentIntentId); }
    catch (e) { log('warn', 'confirm_pi_retrieve_failed', { session_id, error: e.message }); }
  }
  const manualAuthorized = piIsAuthorized(pi);

  // 3) Idempotency — already booked for this session
  if (entry.duffel_order_id) {
    // [CAPTURE-RECOVERY · §13/§34] A prior run created the Duffel order but
    // may have crashed / been interrupted BEFORE capturing. If the money is
    // still only authorized (requires_capture), capture it now against the
    // SAME PaymentIntent — never a second Duffel booking. Idempotent: a
    // genuinely-already-captured PI short-circuits inside
    // captureAuthorizedPayment().
    if (manualAuthorized && paymentIntentId) {
      try {
        await captureAuthorizedPayment(paymentIntentId, { sessionId: session_id });
        setPaymentStatus(session_id, PAYMENT_STATUS.CAPTURED);
      } catch (capErr) {
        alertCritical('capture_failed_recovery', capErr, { session_id, payment_intent_id: paymentIntentId, order_id: entry.duffel_order_id });
        setBookingStatus(session_id, 'manual_review', { order_id: entry.duffel_order_id, booking_reference: entry.duffel_ref || null, error: capErr.message });
      }
    }
    // [ADS-CONVERSION] Return the real customer-paid amount + currency on the
    // idempotent path too, so a page refresh / double confirm-payment / poll
    // re-entry still carries an authoritative value (never 0). The customer
    // charge is persisted on the pending payload at checkout-session time;
    // it is the same source of truth used on the fresh-booking path below.
    const p = entry.payload || {};
    const alreadyCustomerPaid = p.customer_amount != null ? Number(p.customer_amount) : null;
    return {
      already: true,
      order_id: entry.duffel_order_id,
      booking_reference: entry.duffel_ref || null,
      total_amount: alreadyCustomerPaid,
      currency: p.currency || null,
    };
  }

  setBookingStatus(session_id, manualAuthorized ? 'authorized' : 'paid');
  if (manualAuthorized) setPaymentStatus(session_id, PAYMENT_STATUS.AUTHORIZED, { payment_intent_id: paymentIntentId });
  const booking = entry.payload;

  // 4) Book with Duffel (attach passenger ids + drop unavailable services)
  const paxWithIds = await attachPassengerIds(booking.offer_id, booking.passengers);

  // [ADMIN-MARGIN] Re-derive pricing from scratch, exactly as
  // /create-checkout-session did — never trust the stored payload's
  // amounts blindly, since the offer/services could theoretically have
  // changed between checkout-session creation and the customer actually
  // paying. payAmount (sent to Duffel) is ALWAYS the net price with no
  // margin; customerAmount is for our own bookings record only (Stripe
  // already charged this at checkout-session time).
  let payAmount = booking.duffel_amount;
  let payCurrency = booking.currency || 'EUR';
  let safeServices = booking.services || [];
  let pricing = null;
  try {
    // [LOYALTY-TIMING-FIX] true — this runs right after Duffel actually
    // confirms the order, recomputing the same authoritative pricing used
    // at checkout-session creation. The loyalty discount the customer saw
    // (and was charged via Stripe) at the payment step must be re-applied
    // identically here so applyLoyaltyForBooking() below deducts the
    // correct amount from their real balance.
    pricing = await computeAuthoritativePricing(booking.offer_id, booking.services || [], booking.promo_code || null, booking.device_id || null, booking.user_id || null, true, 'book-from-session');
    payAmount = String(pricing.duffelAmount);
    payCurrency = pricing.currency;
    safeServices = pricing.safeServices;
  } catch (e) {
    log('warn', 'offer_revalidate_failed', { error: e.message });
    // [SEAT-PRICING-FIX] Same fix as computeAuthoritativePricing() — this
    // rare fallback path (only reached if that function itself threw) must
    // also check requested seat services against /seat_maps, not just
    // available_services (baggage-only), or a chosen seat would silently
    // get dropped here too and never actually get booked with Duffel.
    let fallbackAvail = [];
    let fallbackSeatMaps = [];
    let fallbackPaxOrder = [];
    try {
      const [offerRes, seatMapsRes] = await Promise.all([
        duffel('GET', `/air/offers/${booking.offer_id}?return_available_services=true`),
        duffel('GET', `/air/seat_maps?offer_id=${encodeURIComponent(booking.offer_id)}`).catch(() => ({ data: [] })),
      ]);
      fallbackAvail = (offerRes.data && offerRes.data.available_services) || [];
      fallbackSeatMaps = seatMapsRes.data || [];
      fallbackPaxOrder = offerPassengerOrder(offerRes.data);
      for (const sm of fallbackSeatMaps) {
        for (const cabin of (sm.cabins || [])) {
          for (const row of (cabin.rows || [])) {
            for (const section of (row.sections || [])) {
              for (const el of (section.elements || [])) {
                if (el.type === 'seat' && Array.isArray(el.available_services)) {
                  for (const svc of el.available_services) fallbackAvail.push(svc);
                }
              }
            }
          }
        }
      }
    } catch (e2) { log('warn', 'fallback_avail_fetch_failed', { error: e2.message }); }
    // [FREE-CHAIR-FIX] Re-resolve chosen seats to their current ids here too, so
    // this rare fallback books the seat the customer paid for instead of dropping it.
    const fallbackResolved = resolveSeatServiceIds(booking.services || [], fallbackSeatMaps, fallbackPaxOrder);
    safeServices = await validateServices(booking.offer_id, fallbackResolved, fallbackAvail.length ? fallbackAvail : undefined);
    // fall through with the stored payload's amount; Duffel will be the final judge
  }

  // [PRICE-DRIFT-PROTECTION] The fare can genuinely change between the
  // customer reaching Stripe's hosted payment page and actually entering
  // their card details — Duffel's own docs note the price "can change
  // between booking and payment" when an offer has no price guarantee.
  // Stripe already charged the customer a FIXED amount (booking.customer_amount,
  // set at checkout-session creation — a Stripe Checkout Session's price
  // cannot be changed after creation). The pricing recomputed just above
  // is the CURRENT real fare, used to pay Duffel.
  //
  // Business rule (explicit, by design): only an INCREASE matters. If the
  // fare dropped, the customer simply paid a bit more than the new lower
  // price — that's accepted as-is, no refund, no interruption. If the
  // fare rose by more than 5 (currency units, e.g. €5), the booking is
  // stopped BEFORE any money moves to Duffel, the customer's card is
  // refunded in full, and the failure is logged clearly — instead of
  // paying Duffel the new higher amount while Stripe already collected
  // the old, lower one (a direct, silent loss to the company). No
  // percentage threshold is applied on top of the flat €5 — a €6 jump on
  // a €1000 booking (0.6%) is just as much a real fare increase as a €6
  // jump on a €50 booking, and both must be caught.
  const expectedCustomerAmount = Number(booking.customer_amount) || 0;
  const recomputedCustomerAmount = pricing ? pricing.customerAmount : expectedCustomerAmount;
  const priceDrift = Math.round((recomputedCustomerAmount - expectedCustomerAmount) * 100) / 100;
  if (expectedCustomerAmount > 0 && priceDrift > 5) {
    log('error', 'price_drift_blocked_booking', {
      session_id, offer_id: booking.offer_id,
      expected: expectedCustomerAmount, recomputed: recomputedCustomerAmount, drift: priceDrift,
    });
    // [PAYMENT-LIFECYCLE §9] No Duffel booking has happened yet, so the money
    // must be released BEFORE any capture. For a manual authorization that
    // means CANCEL (no refund, no lost fees); only an immediate-capture method
    // is actually refunded.
    const release = await releaseAuthorizationOrRefund({ sessionId: session_id, session, paymentIntentId, manualAuthorized, reason: 'requested_by_customer' });
    setBookingStatus(session_id, manualAuthorized ? 'authorization_cancelled' : 'failed_price_drift', {
      drift: priceDrift, expected: expectedCustomerAmount, recomputed: recomputedCustomerAmount,
      refunded: release.refunded, cancelled: release.cancelled,
    });
    setPaymentStatus(session_id, manualAuthorized ? PAYMENT_STATUS.AUTHORIZATION_CANCELLED : PAYMENT_STATUS.REFUNDED);
    const e = new Error(release.cancelled
      ? 'Der Flugpreis hat sich vor der Bezahlung erheblich geändert. Es wurde nichts berechnet.'
      : 'Der Flugpreis hat sich vor der Bezahlung erheblich geändert. Deine Zahlung wurde vollständig zurückerstattet.');
    e.code = 'PRICE_DRIFT';
    e.priceDrift = priceDrift;
    e.refunded = release.refunded;
    e.cancelled = release.cancelled;
    throw e;
  }

  let result;
  try {
    result = await duffel('POST', '/air/orders', {
      data: {
        type: 'instant',
        selected_offers: [booking.offer_id],
        passengers: paxWithIds,
        payments: [{ type: 'balance', amount: String(payAmount), currency: payCurrency }],
        // [FREE-CHAIR-FIX] Duffel rejects unknown fields on a service, so strip
        // each entry back to { id, quantity } — the seat-identity fields we carry
        // through pricing/validation are for our own re-resolution only.
        ...(safeServices.length > 0 ? { services: safeServices.map((s) => ({ id: s.id, quantity: s.quantity })) } : {}),
      },
    }, { 'Idempotency-Key': 'order_' + session_id });
  } catch (orderErr) {
    // [PAYMENT-LIFECYCLE §8] Duffel booking failed BEFORE any capture
    // (offer expired, airline rejection, transient API error, timeout,
    // missing supplier data — anything). The customer's money must be
    // released, but the SAFE way:
    //   - manual authorization (requires_capture) → CANCEL it. No money
    //     ever moved, so there is no refund and no lost processing fees —
    //     this is exactly the financial risk the new architecture removes.
    //   - immediate-capture method (money already taken) → refund, as the
    //     legacy flow did (still the only correct option there).
    // DUFFEL_BOOKING_FAILED is logged with safe identifiers only (§30).
    log('warn', 'DUFFEL_BOOKING_FAILED', { session_id, offer_id: booking.offer_id, status: orderErr.status || null });
    const release = await releaseAuthorizationOrRefund({ sessionId: session_id, session, paymentIntentId, manualAuthorized, reason: 'abandoned' });
    setBookingStatus(session_id, manualAuthorized ? 'authorization_cancelled' : 'failed', {
      error: orderErr.message, refunded: release.refunded, cancelled: release.cancelled,
    });
    setPaymentStatus(session_id, manualAuthorized ? PAYMENT_STATUS.AUTHORIZATION_CANCELLED : (release.refunded ? PAYMENT_STATUS.REFUNDED : PAYMENT_STATUS.CAPTURED));
    const e = new Error(release.cancelled
      ? 'Die Buchung konnte nicht abgeschlossen werden. Es wurde nichts berechnet — die Autorisierung wurde freigegeben.'
      : (release.refunded
        ? 'Die Buchung konnte nicht abgeschlossen werden. Deine Zahlung wurde vollständig zurückerstattet.'
        : orderErr.message));
    e.code = orderErr.code || 'ORDER_CREATE_FAILED';
    e.status = orderErr.status;
    e.details = orderErr.details;
    e.refunded = release.refunded;
    e.cancelled = release.cancelled;
    throw e;
  }

  const orderId = result.data?.id;
  const bookingRef = result.data?.booking_reference;

  // [DUFFEL-BOOKING-SUCCESS §10] Validate the supplier response before
  // treating it as bookable — a 200 alone is not proof (§10). A missing
  // order id means we must NOT capture blindly: enter manual review.
  const orderValidationFailed = !orderId;
  log('info', 'DUFFEL_BOOKING_SUCCESS', { session_id, order_id: orderId || null, ref: bookingRef || null });

  // 5) Mark booked so retries/refresh can't double-book
  await markPendingBooked(session_id, orderId || '', bookingRef || '');

  // ─── CAPTURE — only AFTER a confirmed Duffel booking (brief §7/§13) ───
  // GOLDEN RULE: NO CAPTURE WITHOUT SUPPLIER CONFIRMATION. For a manual
  // authorization we capture the SAME PaymentIntent now; the booking is only
  // "financially completed" once Stripe capture actually succeeds. For an
  // immediate-capture method the money is already taken — nothing to capture.
  let captureFailed = false;
  let capErr = null;
  let paymentStatusFinal = manualAuthorized ? PAYMENT_STATUS.CAPTURE_PENDING : PAYMENT_STATUS.CAPTURED;
  let capturedAmountMinor = null;
  if (manualAuthorized && !orderValidationFailed) {
    setPaymentStatus(session_id, PAYMENT_STATUS.CAPTURE_PENDING, { payment_intent_id: paymentIntentId });
    try {
      const cap = await captureAuthorizedPayment(paymentIntentId, { sessionId: session_id });
      paymentStatusFinal = PAYMENT_STATUS.CAPTURED;
      capturedAmountMinor = cap.pi && (cap.pi.amount_received != null ? cap.pi.amount_received : cap.pi.amount);
      setPaymentStatus(session_id, PAYMENT_STATUS.CAPTURED);
    } catch (e) {
      // [CRITICAL §13] Duffel SUCCESS + Stripe CAPTURE FAILURE. The flight IS
      // booked, so we do NOT cancel and do NOT refund. Enter manual review,
      // alert operations, keep the Duffel order, and surface a NON-confirmed
      // outcome so the customer is never told "confirmed" and no purchase
      // conversion fires. Recovery can re-capture the SAME PaymentIntent later.
      captureFailed = true;
      capErr = e;
      paymentStatusFinal = PAYMENT_STATUS.CAPTURE_FAILED;
    }
  } else if (orderValidationFailed) {
    // Order id missing despite a 2xx → manual review, do not capture (§10).
    captureFailed = true;
    capErr = errorWithCode('Duffel-Bestellung ohne gültige Order-ID', 'DUFFEL_ORDER_INVALID');
    paymentStatusFinal = manualAuthorized ? PAYMENT_STATUS.MANUAL_REVIEW : PAYMENT_STATUS.CAPTURED;
  }

  const bookingStatusFinal = captureFailed ? BOOKING_STATUS.MANUAL_REVIEW : BOOKING_STATUS.BOOKING_CONFIRMED;
  if (captureFailed) {
    setBookingStatus(session_id, 'manual_review', { order_id: orderId, booking_reference: bookingRef, error: capErr && capErr.message });
    setPaymentStatus(session_id, paymentStatusFinal);
  } else {
    setBookingStatus(session_id, 'booked', { order_id: orderId, booking_reference: bookingRef });
  }
  log('info', 'booking_confirmed', { order_id: orderId, ref: bookingRef, payment_status: paymentStatusFinal, capture_failed: captureFailed });

  // 6) Persist financial records (best-effort). Compute the authoritative
  // figures ONCE and reuse them for both the payments ledger and the
  // bookings row so they can never disagree.
  // [ADMIN-DASHBOARD-FIX] Every figure prefers the freshly-recomputed
  // `pricing` object from computeAuthoritativePricing() above (which
  // re-derives from the live offer at booking time) and only falls back to
  // the pre-payment checkout payload — so a fare/service drift between
  // checkout-session creation and actual payment can't leave these figures
  // disagreeing with each other.
  if (supa) {
    const ticketMargin = (pricing && pricing.ticketMargin) != null ? pricing.ticketMargin : (booking.ticket_margin || 0);
    const ancillaryMargin = (pricing && pricing.servicesMargin) != null ? pricing.servicesMargin : (booking.ancillary_margin || 0);
    const discountAmount = (pricing && pricing.discount) != null ? pricing.discount : (booking.discount_amount || 0);
    const loyaltyUsed = (pricing && pricing.loyaltyDiscount) || booking.loyalty_discount || 0;
    const customerPaid = booking.customer_amount != null ? Number(booking.customer_amount) : (pricing ? pricing.customerAmount : null);
    const supplierAmount = Number(payAmount);   // Duffel net cost (what the supplier was paid)
    const marginAmount = roundMoney((Number(ticketMargin) || 0) + (Number(ancillaryMargin) || 0), payCurrency);

    // [F6 · PAYMENT-LEDGER] `amount` is what the CUSTOMER actually paid via
    // Stripe — NOT the Duffel net cost that used to sit here and made the
    // ledger read the supplier price (€100) for a customer charge (€115).
    // Supplier cost and margin are stored in their own columns so the
    // ledger reconciles against Stripe (customer) AND Duffel (supplier)
    // independently (brief §8.1/§8.2). supplier_amount/margin_amount are
    // additive nullable columns (sql/payment_ledger.sql) — harmless if the
    // migration hasn't run yet.
    // [PAYMENT-LIFECYCLE] Legacy `status` stays 'paid' on capture and
    // 'failed' on capture failure (its CHECK only allows paid|refunded|
    // failed); the richer lifecycle state goes in payment_status. Additive
    // columns — harmless if sql/payment_lifecycle.sql hasn't run yet.
    supa.from('payments').insert({
      stripe_session_id: session_id,
      stripe_payment_id: paymentIntentId || (session && session.payment_intent) || null,
      payment_intent_id: paymentIntentId || (session && session.payment_intent) || null,
      amount: customerPaid,
      supplier_amount: supplierAmount,
      margin_amount: marginAmount,
      currency: payCurrency,
      status: captureFailed ? 'failed' : 'paid',
      payment_status: paymentStatusFinal,
      captured_at: paymentStatusFinal === PAYMENT_STATUS.CAPTURED ? new Date().toISOString() : null,
      captured_amount: paymentStatusFinal === PAYMENT_STATUS.CAPTURED ? customerPaid : null,
    }).then(function(){}, function(e){ log('error', 'supa_payment_insert_failed', { error: e.message }); });

    // [RACE-CONDITION-FIX] This was previously fire-and-forget
    // (.then(noop, logError), no await) — bookFromSession() returned to
    // the caller (and from there, the HTTP response went back to the
    // browser) WITHOUT waiting for this insert to actually land in
    // Supabase. The browser then immediately calls GET
    // /booking-confirmation?session_id=... to render the confirmation
    // screen — and that endpoint looks up this exact row by
    // stripe_session_id. With real network latency to Supabase, the
    // confirmation request could easily arrive before this insert had
    // finished, finding nothing and returning 404 — even though the
    // booking had genuinely succeeded seconds earlier (Duffel confirmed
    // it, the email had already sent) and the row would show up correctly
    // a moment later on a manual refresh. Awaiting this insert guarantees
    // the row exists by the time the customer's "payment succeeded"
    // response — and the confirmation-screen fetch that follows it — ever
    // reach the browser.
    try {
      const primaryPax = (booking.passengers && booking.passengers[0]) || {};
      // [F4 · CROSS-INSTANCE IDEMPOTENCY] Upsert on stripe_session_id with
      // ignoreDuplicates (INSERT ... ON CONFLICT DO NOTHING) so that if the
      // Stripe webhook and /confirm-payment both reach here on separate
      // instances for the same paid session, only one bookings row is ever
      // written — the DB UNIQUE index (sql/booking_idempotency.sql) is the
      // hard backstop the in-process `inFlight` Set can't provide across
      // instances. Requires the unique index to exist; harmless otherwise.
      const { error: bookingInsertError } = await supa.from('bookings').upsert({
        stripe_session_id: session_id,
        duffel_order_id: orderId || null,
        // [M1-OFFER-ID] Persist the Duffel offer id the order was created
        // from — previously only stored on the transient pending_bookings
        // payload, so an admin/audit could not tie a confirmed booking back
        // to its originating offer without the session lookup. Additive,
        // nullable column (see sql migration add_bookings_duffel_offer_id).
        duffel_offer_id: booking.offer_id || null,
        booking_reference: bookingRef || null,
        route_label: booking.route_label || null,
        status: 'confirmed',
        passenger_count: (booking.passengers || []).length || 1,
        customer_email: primaryPax.email || null,
        // [ADMIN-CUSTOMER-INFO] Primary passenger's contact/identity
        // details — already present on every booking payload (Duffel and
        // Stripe both require them), just not previously saved anywhere
        // queryable. Lets the admin dashboard show who actually booked,
        // not just their email.
        customer_name: `${primaryPax.given_name || ''} ${primaryPax.family_name || ''}`.trim() || null,
        customer_phone: primaryPax.phone_number || null,
        customer_dob: primaryPax.born_on || null,
        // [GUEST-LINK] If this customer was already logged in at checkout,
        // record it now — no need to wait for the retroactive-linking flow
        // at all. Stays null for a true guest checkout, exactly as before.
        user_id: booking.user_id || null,
        currency: payCurrency,
        duffel_amount: Number(payAmount),
        ticket_margin: ticketMargin,
        ancillary_margin: ancillaryMargin,
        discount_amount: discountAmount,
        promo_code: booking.promo_code || null,
        loyalty_discount: loyaltyUsed,
        customer_paid: customerPaid,
        stripe_payment_id: paymentIntentId || (session && session.payment_intent) || null,
        // [PAYMENT-LIFECYCLE] Separate booking / payment / supplier state
        // (brief §5/§6/§20). Legacy `status` above is unchanged; these
        // additive columns carry the authorize→capture lifecycle so a
        // capture failure is a distinct, admin-visible manual-review state
        // rather than a silently "confirmed" booking.
        payment_intent_id: paymentIntentId || (session && session.payment_intent) || null,
        payment_status: paymentStatusFinal,
        booking_status: bookingStatusFinal,
        supplier_status: SUPPLIER_STATUS.BOOKED,
        authorized_amount: manualAuthorized ? customerPaid : null,
        authorized_at: manualAuthorized ? new Date().toISOString() : null,
        authorization_expires_at: (manualAuthorized && pi) ? authorizationExpiresAt(pi) : null,
        captured_amount: paymentStatusFinal === PAYMENT_STATUS.CAPTURED ? customerPaid : null,
        captured_at: paymentStatusFinal === PAYMENT_STATUS.CAPTURED ? new Date().toISOString() : null,
        capture_id: paymentStatusFinal === PAYMENT_STATUS.CAPTURED ? (paymentIntentId || null) : null,
        capture_attempts: manualAuthorized ? 1 : 0,
        last_payment_error: captureFailed && capErr ? String(capErr.message || '').slice(0, 500) : null,
      }, { onConflict: 'stripe_session_id', ignoreDuplicates: true });
      if (bookingInsertError) log('error', 'supa_booking_insert_failed', { error: bookingInsertError.message });
    } catch (e) {
      log('error', 'supa_booking_insert_failed', { error: e.message });
    }

    // [PAYMENT-LIFECYCLE §38] Rewards/promo usage are granted ONLY when the
    // booking is financially complete (Duffel booked AND Stripe captured) —
    // never for a capture-failed / manual-review booking, which is not yet a
    // completed sale.
    // [ADMIN-MARGIN] Bump the promo code's usage counter now that the
    // booking is actually confirmed (not at checkout-session creation,
    // when the customer might still abandon payment).
    if (!captureFailed && booking.promo_id) incrementPromoUsage(booking.promo_id).then(function(){}, function(){});

    // [LOYALTY-FIX] Only a real logged-in user has a loyalty account to
    // credit/debit at all now — computeAuthoritativePricing() never
    // computes a device-scoped discount or creates a device account
    // anymore, so loyaltyUsed is always 0 here for an anonymous booking.
    // The old device_id fallback is removed rather than left as dead code
    // that could silently start working again if loyaltyUsed were ever
    // populated some other way.
    // [LOYALTY-CANCEL-REVERSAL-FIX] Now awaited (was fire-and-forget) so
    // the exact points earned can be captured and persisted on this
    // booking row — needed for a later cancellation to reverse this
    // EXACT figure, not a value recomputed against whatever tier the
    // account is at by then.
    if (!captureFailed && booking.user_id) {
      try {
        const earnedPoints = await applyLoyaltyForBooking('user', booking.user_id, loyaltyUsed, customerPaid);
        if (earnedPoints > 0 && orderId) {
          supa.from('bookings').update({ loyalty_points_earned: earnedPoints }).eq('duffel_order_id', orderId)
            .then(function(){}, function(e){ log('warn', 'loyalty_points_persist_failed', { order_id: orderId, error: e.message }); });
        }
      } catch (e) { log('warn', 'loyalty_apply_call_failed', { error: e.message }); }

      // [REFERRAL-REBUILD] If this customer was themselves referred by
      // someone, and this is their first confirmed booking, attach it —
      // using result.data (the just-confirmed Duffel order) for the real
      // departure date. Never blocks the booking response; a failure here
      // only means a referral reward is delayed, never that the booking
      // itself is affected.
      if (orderId) {
        attachBookingIfReferred(booking.user_id, orderId, result.data).catch((e) => log('warn', 'referral_attach_call_failed', { error: e.message }));
      }
    }
  }

  // [CRITICAL §13/§31] Duffel SUCCESS + Stripe CAPTURE FAILURE (or an invalid
  // supplier response). The Duffel order and the manual-review record are now
  // persisted above; alert operations and surface a NON-confirmed outcome. We
  // deliberately throw AFTER persistence and BEFORE the confirmation email /
  // rewards so the customer is never told "confirmed" and no purchase
  // conversion fires. The authorization is NOT cancelled (the flight is
  // booked) — recovery re-captures the SAME PaymentIntent later.
  if (captureFailed) {
    alertCritical('capture_failed_after_booking', capErr || new Error('capture_failed'), {
      session_id,
      payment_intent_id: paymentIntentId,
      duffel_order_id: orderId,
      booking_reference: bookingRef,
      stripe_error_code: capErr && capErr.stripeCode,
      capture_attempts: capErr && capErr.attempts,
      payment_status: paymentStatusFinal,
      supplier_status: SUPPLIER_STATUS.BOOKED,
    });
    const e = errorWithCode(
      'Deine Buchung wird gerade finalisiert. Unser Team prüft die Zahlung und meldet sich in Kürze.',
      'CAPTURE_FAILED_AFTER_BOOKING',
      { manualReview: true, order_id: orderId, booking_reference: bookingRef, status: 202 }
    );
    e.refunded = false;
    e.cancelled = false;
    throw e;
  }

  // [EMAIL-SEAT-FIX] The order data we just got back from POST
  // /air/orders may not yet include full passenger/seat detail — Duffel's
  // own docs note "there may be cases when the reservation is confirmed
  // but order information is not immediately available" for the create
  // response. Fetch the order fresh via GET before building anything the
  // email needs seat data for; retry briefly if the first fetch still
  // comes back without seats, since this whole block runs after the
  // customer's HTTP response has already gone out (the email send is
  // fire-and-forget) so a short delay here is invisible to them.
  let freshOrderData = result.data;
  if (orderId) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const fresh = await duffel('GET', `/air/orders/${orderId}`);
        if (fresh && fresh.data) {
          freshOrderData = fresh.data;
          const hasAnySeat = (fresh.data.slices || []).some((sl) =>
            (sl.segments || []).some((sg) => (sg.passengers || []).some((p) => p.seat && p.seat.designator))
          );
          // Only the FIRST attempt is unconditional — if any services were
          // requested at all (seats or bags) but no seat shows up yet,
          // retrying twice more (with a short pause) gives Duffel's sync a
          // little more time without noticeably delaying the email. If
          // nothing was requested, there's nothing to wait for.
          const anyServicesRequested = (safeServices || []).length > 0;
          if (hasAnySeat || !anyServicesRequested) break;
        }
      } catch (e) {
        log('warn', 'order_refetch_for_email_failed', { attempt, error: e.message });
      }
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1500));
    }
  }

  // 7) Send a real booking confirmation email (best-effort, never blocks the response)
  // [TICKET-EMAIL-FIX] The ticket/confirmation goes to whatever email the
  // customer entered on STRIPE'S OWN checkout page (session.customer_
  // details.email) — not the personal-data email from page 5. This is
  // the agreed split: the page-5 email determines which ACCOUNT the
  // booking belongs to (and therefore shows up under "Meine Buchungen"),
  // while the Stripe-entered email is purely where the actual ticket
  // gets sent, since the customer may want a different person to
  // receive it. Falls back to the passenger's own email only if Stripe
  // genuinely has none on file (rare — some payment methods can skip
  // email collection) rather than silently sending no email at all.
  const recipientEmail = (session && session.customer_details && session.customer_details.email)
    || (booking.passengers && booking.passengers[0] && booking.passengers[0].email)
    || null;
  if (recipientEmail && bookingRef) {
    // [EMAIL-FIX] Build the same structured summary the in-app confirmation
    // screen uses (flight segments, seats, bags, real ticket/bags/seats/
    // discount breakdown) — freshOrderData is the just-refetched live
    // Duffel order (see [EMAIL-SEAT-FIX] above), and the margin/discount
    // figures were already computed moments ago by
    // computeAuthoritativePricing() above. Wrapped in try/catch since this
    // is purely cosmetic for the email — a failure here must never stop
    // the email from sending with at least the basic reference + total it
    // had before.
    let orderSummary = null;
    try {
      orderSummary = buildOrderSummaryForEmail(freshOrderData, {
        ticketMargin: (pricing && pricing.ticketMargin) != null ? pricing.ticketMargin : (booking.ticket_margin || 0),
        ancillaryMargin: (pricing && pricing.servicesMargin) != null ? pricing.servicesMargin : (booking.ancillary_margin || 0),
        discountAmount: booking.discount_amount || 0,
        loyaltyDiscount: (pricing && pricing.loyaltyDiscount) || booking.loyalty_discount || 0,
        promoCode: booking.promo_code || null,
        customerPaid: booking.customer_amount != null ? Number(booking.customer_amount) : (pricing ? pricing.customerAmount : null),
      });
    } catch (e) {
      log('warn', 'order_summary_for_email_failed', { error: e.message });
    }
    sendBookingConfirmationEmail(recipientEmail, {
      bookingRef,
      orderId,
      // [TICKET-PDF-I18N] The user's UI language, captured at checkout and
      // persisted with the booking payload, so the attached ticket PDF is
      // rendered in that language (falls back to German if absent).
      lang: booking.lang || 'de',
      route: booking.route_label || '',
      passengers: booking.passengers || [],
      // [CONTACT-EMAIL-DISPLAY] The page-5 contact email — distinct from
      // recipientEmail above (which is Stripe's checkout email, where the
      // email actually gets sent) — shown under each passenger's name in
      // the email body, same as the confirmation screen/"Meine
      // Buchungen".
      contactEmail: (booking.passengers && booking.passengers[0] && booking.passengers[0].email) || null,
      totalAmount: result.data?.total_amount,
      currency: result.data?.total_currency,
      orderSummary,
    }).then(function(){}, function(){});
  }

  // [ADS-CONVERSION] total_amount must represent what the CUSTOMER actually
  // paid Airpiv (Stripe charge incl. margin, minus promo/loyalty), NOT the
  // Duffel net/supplier amount (result.data.total_amount). The customer
  // charge was fixed at checkout-session time and persisted on the pending
  // booking payload as customer_amount — the single source of truth here
  // (pricing.customerAmount is an identical recompute and only a fallback).
  // The conversion/analytics value downstream is derived from this field.
  const customerPaidFinal = booking.customer_amount != null
    ? Number(booking.customer_amount)
    : (pricing ? pricing.customerAmount : null);
  return {
    already: false,
    order_id: orderId,
    booking_reference: bookingRef,
    // customer-facing amount (source of the Google Ads / GA4 purchase value)
    total_amount: customerPaidFinal,
    currency: payCurrency,
    // [PAYMENT-LIFECYCLE] Authoritative state — reaching here means Duffel
    // booked AND (for a manual authorization) Stripe capture succeeded, so
    // the booking is financially complete. The frontend gates its purchase
    // conversion on payment_status === 'captured' (§25/§29).
    payment_status: paymentStatusFinal,        // 'captured'
    booking_status: bookingStatusFinal,        // 'booking_confirmed'
    captured: paymentStatusFinal === PAYMENT_STATUS.CAPTURED,
    // kept for reference/debugging — Duffel net/supplier figures, never the
    // conversion value.
    duffel_net_amount: result.data?.total_amount,
    duffel_net_currency: result.data?.total_currency,
  };
}

// [IDOR-FIX] Shared ownership check for every order/booking-scoped
// endpoint (cancel, booking-confirmation, GET /order/:id, add-services).
// This deliberately does NOT require a logged-in caller — guest
// checkout has no account to check against, and knowledge of the
// order_id/session_id is the accepted "manage my booking" capability
// for guests, same as every airline's own guest-booking-lookup flow.
// What it DOES close: a *different logged-in* user can no longer act
// on an account-linked booking that isn't theirs just by guessing/
// leaking its order_id — if the booking has a user_id and the caller
// is authenticated, the two must match.
// Returns { allowed: true, bookingRow } or { allowed: false, bookingRow }.
async function checkOrderOwnership(duffelOrderId, callerUserId) {
  if (!supa || !duffelOrderId) return { allowed: true, bookingRow: null };
  const { data: bookingRow } = await supa.from('bookings')
    .select('user_id').eq('duffel_order_id', duffelOrderId).maybeSingle();
  if (bookingRow && bookingRow.user_id && callerUserId && bookingRow.user_id !== callerUserId) {
    return { allowed: false, bookingRow };
  }
  return { allowed: true, bookingRow };
}

module.exports = {
  attachPassengerIds,
  validateServices,
  lookupPromoCode,
  computePromoDiscount,
  incrementPromoUsage,
  computeAuthoritativePricing,
  bookFromSession,
  inFlight,
  checkOrderOwnership,
};
