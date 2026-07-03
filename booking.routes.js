// ═══════════════════════════════════════════════════════════════
// src/routes/booking.routes.js
// [CORE] كل روتات الحجز والدفع: عرض العرض، خرائط المقاعد، جلسة
// الدفع، معاينة السعر، تأكيد الدفع، إضافة خدمات، وعرض الحجز.
// أي تعديل هنا محتاج مراجعة دقيقة زي src/services/booking.js
// بالظبط — نفس المنطق الماليّ الحساس.
// ═══════════════════════════════════════════════════════════════

const env = require('./env');
const log = require('./log');
const Sentry = require('./sentry');
const stripe = require('./stripe');
const supa = require('./supabase');
const rateLimit = require('./rateLimit');
const { attachUserIfPresent } = require('./auth');
const { validate, PASSENGER_SCHEMA } = require('./validate');
const duffel = require('./duffel');
const { getTicketProfitTiers, getAncillaryProfitTiers, computeTieredMargin, recordBookingFailureEvent } = require('./adminConfig');
const { normalizeOffer } = require('./normalizeOffer');
const { rememberBooking, getPendingBooking, setBookingStatus, getBookingStatus } = require('./pendingBookings');
const { computeAuthoritativePricing, bookFromSession, inFlight } = require('./booking');

module.exports = (app) => {

app.get('/offer/:id', rateLimit('pay', 30, 60000), async (req, res) => {
  try {
    const result = await duffel('GET', `/air/offers/${req.params.id}?return_available_services=true`);
    const raw = result.data?.available_services || [];
    const ticketTiers = await getTicketProfitTiers();
    // [MULTI-PAX-FIX] Same passenger ordering as /seatmaps — adults, then
    // children, then infants, in Duffel's own listed order — so baggage
    // services can be tagged with a passengerIndex the frontend can match
    // against its passenger form fields (bf-fn0, bf-fn1, ...).
    const offerPaxRaw = (result.data && result.data.passengers) || [];
    const byType = (t) => offerPaxRaw.filter((p) => p && p.type === t).map((p) => p.id);
    const passengerOrder = [...byType('adult'), ...byType('child'), ...byType('infant_without_seat')];
    res.json({
      ok: true,
      offer: normalizeOffer(result.data, ticketTiers),
      services: raw,                          // raw passthrough (compat)
      baggageServices: await normalizeBaggageServices(raw, passengerOrder),  // clean baggage list, margin applied
      passengerOrder,
    });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// Turn Duffel available_services into a clean baggage list. [ADMIN-MARGIN]
// `price` is what the customer sees/pays (net Duffel price + ancillary
// margin); `netPrice` is the exact Duffel price with NOTHING added, kept
// alongside so the booking flow can send Duffel its real cost while
// charging the customer the marked-up amount via Stripe.
async function normalizeBaggageServices(services, passengerOrder) {
  if (!Array.isArray(services)) return [];
  passengerOrder = passengerOrder || [];
  const baggage = services.filter(s => s.type === 'baggage');
  const tiers = await getAncillaryProfitTiers();
  return baggage
    .map(s => {
      const md = s.metadata || {};
      const netPrice = parseFloat(s.total_amount || 0);
      const margin = computeTieredMargin(netPrice, tiers);
      const passengerIds = s.passenger_ids || [];
      // [MULTI-PAX-FIX] Resolve to a 0-based index matching the frontend's
      // passenger form fields — null if this service isn't tied to a
      // single specific passenger (some airlines return baggage services
      // without passenger_ids at all, meaning it applies regardless).
      const pid = passengerIds[0] || null;
      const passengerIndex = pid ? passengerOrder.indexOf(pid) : -1;
      return {
        id: s.id,
        price: Math.round((netPrice + margin) * 100) / 100, // customer-facing price (incl. margin)
        netPrice,                                            // exact Duffel price (no margin) — used at booking time
        margin,
        currency: s.total_currency || 'EUR',
        bagType: md.type || null,                 // e.g. "checked" | "carry_on"
        maxWeightKg: (md.maximum_weight_kg != null) ? Number(md.maximum_weight_kg) : null,
        maxQuantity: (s.maximum_quantity != null) ? Number(s.maximum_quantity) : null,
        segmentIds: s.segment_ids || [],
        passengerIds,
        passengerIndex: passengerIndex >= 0 ? passengerIndex : null,
      };
    })
    // cheapest first (by customer-facing price, matching what's displayed)
    .sort((a, b) => a.price - b.price);
}


// ─── POST /seatmaps ───────────────────────────────────────
// Body: { offer_id }. Returns one normalized seat map per segment.
app.post('/seatmaps', rateLimit('pay', 20, 60000), async (req, res) => {
  try {
    const { offer_id } = req.body;
    if (!offer_id) return res.status(400).json({ ok: false, error: 'offer_id required' });
    const [result, offerRes] = await Promise.all([
      duffel('GET', `/air/seat_maps?offer_id=${encodeURIComponent(offer_id)}`),
      duffel('GET', `/air/offers/${encodeURIComponent(offer_id)}`).catch(() => null),
    ]);
    const maps = Array.isArray(result.data) ? result.data : [];
    // [MULTI-PAX-FIX] passengerOrder mirrors attachPassengerIds()'s own
    // grouping (adults, then children, then infants, in Duffel's listed
    // order) — the frontend's passenger form fields (bf-fn0, bf-fn1, ...)
    // are built in that exact same order, so passengerOrder[i] is
    // guaranteed to be the correct Duffel passenger id for "passenger
    // index i" everywhere: seat selection, baggage selection, and the
    // final order sent to Duffel at booking time.
    const offerPaxRaw = (offerRes && offerRes.data && offerRes.data.passengers) || [];
    const byType = (t) => offerPaxRaw.filter((p) => p && p.type === t).map((p) => p.id);
    const passengerOrder = [...byType('adult'), ...byType('child'), ...byType('infant_without_seat')];
    // [SEATMAP-DEBUG] Logs exactly what Duffel actually returned — how
    // many cabins per segment, and the lowest/highest row number in each
    // cabin — so a "the seat map only starts at row 28" report can be
    // checked against the real upstream data rather than guessed at. This
    // is read-only logging; it changes nothing about the response sent to
    // the frontend.
    maps.forEach((sm, i) => {
      const cabins = sm.cabins || [];
      const cabinSummaries = cabins.map((c) => {
        const rowNums = (c.rows || [])
          .map((row) => {
            const seatEl = (row.sections || []).flatMap((s) => s.elements || []).find((el) => el.type === 'seat' && el.designator);
            return seatEl ? parseInt(seatEl.designator.replace(/\D/g, ''), 10) : null;
          })
          .filter((n) => n != null);
        return {
          cabinClass: c.cabin_class || null,
          rowCount: (c.rows || []).length,
          firstRow: rowNums.length ? Math.min(...rowNums) : null,
          lastRow: rowNums.length ? Math.max(...rowNums) : null,
        };
      });
      log('info', 'seatmap_debug', { segmentIndex: i, segmentId: sm.segment_id, cabinCount: cabins.length, cabins: cabinSummaries });
    });
    // [ADMIN-MARGIN] Fetch tiers ONCE here (async) rather than inside the
    // nested cabin/row/section/element .map() chain below, which must stay
    // synchronous — awaiting inside a nested nested .map() would silently
    // produce arrays of unresolved Promises instead of seat objects.
    const ancillaryTiers = await getAncillaryProfitTiers();
    res.json({ ok: true, seatMaps: maps.map(sm => normalizeSeatMap(sm, ancillaryTiers, passengerOrder)), passengerOrder });
  } catch (err) {
    // Seat maps not supported for this airline/flight -> return empty, not an error
    res.json({ ok: true, seatMaps: [], passengerOrder: [], note: err.message });
  }
});

// Normalize one Duffel seat map (per segment) into a compact render-ready
// shape. [ADMIN-MARGIN] `price` is the customer-facing price (net Duffel
// price + ancillary margin); `netPrice` is the untouched Duffel price,
// carried alongside for the booking flow to charge Duffel its real cost.
function normalizeSeatMap(sm, ancillaryTiers, offerPassengerOrder) {
  if (!sm) return null;
  offerPassengerOrder = offerPassengerOrder || [];
  const cabins = (sm.cabins || []).map(cabin => {
    const rows = (cabin.rows || []).map(row => {
      const sections = (row.sections || []).map(section => {
        const elements = (section.elements || []).map(el => {
          if (el.type === 'seat') {
            // [MULTI-PAX-FIX] A seat is bookable only if it has
            // available_services — but Duffel gives ONE service per
            // PASSENGER for the same physical seat (different id, same
            // designator/price), not one service total. Build a lookup by
            // passenger_id so the frontend can pick the right service id
            // for whichever passenger is currently selecting a seat.
            //
            // [SEAT-EMPTY-PAXIDS-FIX] Confirmed via live diagnostic
            // logging: some airlines return the correct number of
            // per-passenger services (one each) but leave passenger_ids
            // EMPTY on every single one — instead of the explicit
            // passenger_ids Duffel's docs describe. Relying on
            // passenger_ids alone in that case meant servicesByPassenger
            // stayed empty for this airline, so every passenger fell back
            // to the same svcs[0] — sending the IDENTICAL service id
            // twice, which Duffel correctly rejects as "expected one seat
            // service per passenger and segments". Fix: when NONE of a
            // seat's services carry a passenger_id, fall back to
            // POSITIONAL order — the Nth service in available_services
            // corresponds to the Nth passenger in offerPassengerOrder
            // (same adults-then-children-then-infants order used
            // everywhere else). This is a safe assumption specifically
            // because Duffel's own docs guarantee one service per
            // passenger per seat — the only thing missing was which one
            // belongs to whom, and array position is the only information
            // left to infer it from.
            const svcs = el.available_services || [];
            const servicesByPassenger = {};
            const anyRealPassengerId = svcs.some((svc) => svc.passenger_ids && svc.passenger_ids[0]);
            svcs.forEach((svc, svcIdx) => {
              const netPriceSvc = parseFloat(svc.total_amount || 0);
              const marginSvc = computeTieredMargin(netPriceSvc, ancillaryTiers);
              let pid = (svc.passenger_ids && svc.passenger_ids[0]) || null;
              if (!pid && !anyRealPassengerId) {
                pid = offerPassengerOrder[svcIdx] || null;
              }
              if (pid) {
                servicesByPassenger[pid] = {
                  serviceId: svc.id,
                  price: Math.round((netPriceSvc + marginSvc) * 100) / 100,
                  netPrice: netPriceSvc,
                  margin: marginSvc,
                  currency: svc.total_currency || 'EUR',
                };
              }
            });
            const svc = svcs[0] || null;
            const netPrice = svc ? parseFloat(svc.total_amount || 0) : null;
            const margin = netPrice != null ? computeTieredMargin(netPrice, ancillaryTiers) : 0;
            return {
              type: 'seat',
              designator: el.designator || null,
              available: svcs.length > 0,
              // Kept for backward compatibility — same values as before,
              // now explicitly documented as "first available passenger's
              // pricing", not "the only price". New code should use
              // servicesByPassenger instead.
              serviceId: svc ? svc.id : null,
              price: netPrice != null ? Math.round((netPrice + margin) * 100) / 100 : null,
              netPrice,
              margin,
              currency: svc ? (svc.total_currency || 'EUR') : null,
              servicesByPassenger,
              disclosures: el.disclosures || []
            };
          }
          // non-seat elements: empty, exit_row, bassinet, lavatory, galley, etc.
          return { type: el.type };
        });
        return { elements };
      });
      return { sections };
    });
    return {
      cabinClass: cabin.cabin_class || null,
      deck: cabin.deck != null ? cabin.deck : 0,
      wingsStart: cabin.wings ? cabin.wings.first_row_index : null,
      wingsEnd: cabin.wings ? cabin.wings.last_row_index : null,
      rows
    };
  });
  return {
    segmentId: sm.segment_id || null,
    sliceId: sm.slice_id || null,
    cabins
  };
}


// ─── POST /create-checkout-session ────────────────────────
// Creates a Stripe Checkout Session. The actual flight booking happens
// ONLY after Stripe confirms the payment (see /confirm-payment).
//
// [PRICE-CHECK + ADMIN-MARGIN] The server NEVER trusts amounts the browser
// sends. computeAuthoritativePricing() re-derives everything from Duffel's
// live offer + the admin's own margin tiers + the server's own promo_codes
// table: the exact net amount Duffel must be paid, the ticket/ancillary
// margins, any promo discount, and the final customer charge. The
// browser's duffel_amount is used ONLY to detect fare drift (so we can
// show the customer a "price changed" prompt) — it never affects what
// actually gets charged or booked.
app.post('/create-checkout-session', rateLimit('pay', 15, 60000), attachUserIfPresent, async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ ok: false, error: 'Stripe ist nicht konfiguriert' });

    const {
      offer_id, passengers, services = [],
      duffel_amount, customer_amount, currency = 'EUR', promo_code, device_id,
      route_label, success_url, cancel_url,
    } = req.body;

    // [SCHEMA-VALIDATION] Full structural check — catches a malformed
    // passenger (missing name, garbage date, invalid email format) before
    // it ever reaches Duffel's own API or computeAuthoritativePricing().
    // This is the highest-stakes endpoint in the system (it's what
    // actually moves money via Stripe), so it gets the most thorough
    // schema of any endpoint.
    const validationErr = validate(req.body, {
      offer_id: { type: 'string', required: true, min: 3, max: 200 },
      passengers: { type: 'array', required: true, min: 1, max: 9, of: PASSENGER_SCHEMA },
      currency: { type: 'string', required: false, min: 3, max: 3 },
    });
    if (validationErr) return res.status(400).json({ ok: false, error: validationErr });

    let pricing;
    try {
      // [LOYALTY-TIMING-FIX] true — this IS the actual checkout/payment
      // step, the only point where a loyalty discount should ever apply.
      pricing = await computeAuthoritativePricing(offer_id, services, promo_code, device_id, req.userId, true);
    } catch (e) {
      log('warn', 'pricing_compute_failed', { offer_id, error: e.message });
      return res.status(409).json({ ok: false, code: 'OFFER_UNAVAILABLE', error: 'Dieses Angebot ist nicht mehr verfügbar. Bitte erneut suchen.' });
    }

    // [PRICE-CHECK] Compare the server's fresh net Duffel cost against what
    // the browser last showed, to detect fare drift BEFORE any money moves.
    // [PRICE-DISPLAY-BUG-FIX] The trigger condition used to compare only
    // the raw NET Duffel amounts (duffel_amount old vs. pricing.duffelAmount
    // fresh) — a real screenshot showed "Vorheriger Preis: 1.208€" and
    // "Neuer Preis: 1.208€", the exact same customer-facing number, with
    // the "price changed" sheet still popping up. That's because a net
    // price move of just a few cents (enough to cross the old >= 0.5
    // threshold) can land on a margin tier boundary or simply round away
    // to nothing once margin is added and the result is rounded to the
    // nearest cent for display — the number actually shown to the
    // customer never moved at all, but the dialog interrupting their
    // checkout fired anyway based on an internal figure they never see.
    // The trigger now checks the REAL customer-facing difference
    // (customerAmount, including margin/discount) instead — if that
    // number is identical (or differs by less than half a cent, i.e.
    // would format to the same value), nothing is shown and checkout
    // proceeds normally, regardless of how much the underlying net cost
    // moved internally.
    if (duffel_amount != null && customer_amount != null) {
      const oldCustomerAmount = Math.round(Number(customer_amount) * 100) / 100;
      const customerDiff = Math.round((pricing.customerAmount - oldCustomerAmount) * 100) / 100;
      if (Math.abs(customerDiff) >= 0.01) {
        const oldAmount = Math.round(Number(duffel_amount) * 100) / 100;
        const diff = Math.round((pricing.duffelAmount - oldAmount) * 100) / 100;
        log('info', 'price_changed_before_checkout', { offer_id, old: oldAmount, fresh: pricing.duffelAmount, diff, old_customer: oldCustomerAmount, new_customer: pricing.customerAmount, customer_diff: customerDiff });
        return res.status(409).json({
          ok: false,
          code: 'PRICE_CHANGED',
          error: 'Der Preis hat sich geändert',
          old_amount: oldAmount,
          new_amount: pricing.duffelAmount,
          old_customer_amount: oldCustomerAmount,
          new_customer_amount: pricing.customerAmount,
          currency: pricing.currency,
          diff,
        });
      }
    }

    if (pricing.customerAmount <= 0) return res.status(400).json({ ok: false, error: 'Betrag ungültig' });
    if (promo_code && pricing.promoStatus && pricing.promoStatus !== 'applied') {
      // Customer typed a code but it isn't valid — fail loudly so the
      // frontend can tell them, instead of silently charging full price.
      return res.status(400).json({ ok: false, code: 'PROMO_INVALID', error: 'Aktionscode ungültig oder abgelaufen', promo_status: pricing.promoStatus });
    }

    // Stripe wants the amount in the smallest currency unit (cents)
    const amountCents = Math.round(pricing.customerAmount * 100);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        quantity: 1,
        price_data: {
          currency: pricing.currency.toLowerCase(),
          unit_amount: amountCents,
          product_data: { name: route_label ? ('Flug ' + route_label) : 'Flugbuchung (FlyWise)' },
        },
      }],
      success_url: (success_url || 'https://example.com/success') + '?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: cancel_url || 'https://example.com/cancel',
      metadata: { flywise: '1' },
    });

    // Store booking payload server-side, keyed by session id. Only a small
    // marker goes into Stripe metadata. Everything needed to both book with
    // Duffel (offer_id, services) and record accurate financials later
    // (margins, discount, promo, loyalty) is persisted here — never
    // recomputed from browser input again after this point.
    await rememberBooking(session.id, {
      offer_id,
      passengers,
      services: pricing.safeServices,
      duffel_amount: String(pricing.duffelAmount),
      currency: pricing.currency,
      route_label,
      ticket_margin: pricing.ticketMargin,
      ancillary_margin: pricing.servicesMargin,
      discount_amount: pricing.discount,
      promo_code: pricing.promo ? pricing.promo.code : null,
      promo_id: pricing.promo ? pricing.promo.id : null,
      loyalty_discount: pricing.loyaltyDiscount,
      device_id: device_id || null,
      user_id: req.userId || null,
      customer_amount: pricing.customerAmount,
    });
    setBookingStatus(session.id, 'pending');
    log('info', 'checkout_created', { session: session.id, duffel_amount: pricing.duffelAmount, customer_amount: pricing.customerAmount, promo: pricing.promo ? pricing.promo.code : null, loyalty_discount: pricing.loyaltyDiscount });


    res.json({ ok: true, session_id: session.id, url: session.url, customer_amount: pricing.customerAmount, currency: pricing.currency });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

// ─── POST /price-preview ───────────────────────────────────
// [PRICE-SYNC-FIX] Read-only preview of the EXACT amount the customer would
// be charged right now, using the same computeAuthoritativePricing() used
// by /create-checkout-session — never a separately-maintained calculation.
// Why this exists: the booking flow shows prices pulled from three
// independent calls (/offer, /seatmaps, then checkout), each hitting
// Duffel separately. Duffel's net price can drift between those calls
// (normal for live fares), so the margin computed on slightly different
// net prices can round into a different tier and produce a few extra
// euros the customer never agreed to. Calling this endpoint right before
// showing any "final" number (seat step running total, summary, payment
// screen) collapses that drift window to effectively zero — the frontend
// always displays what the server would actually charge, instead of
// recomputing locally from possibly-stale per-step prices.
// Does NOT create a Stripe session or touch Duffel order state — purely a
// price quote, safe to call as often as the UI needs.
app.post('/price-preview', rateLimit('pay', 30, 60000), attachUserIfPresent, async (req, res) => {
  try {
    const { offer_id, services = [], promo_code, device_id, duffel_amount, apply_loyalty } = req.body;
    if (!offer_id) return res.status(400).json({ ok: false, error: 'offer_id مطلوب' });

    let pricing;
    try {
      // [LOYALTY-TIMING-FIX] false by default — /price-preview is normally
      // called from the baggage/seat steps (syncPriceWithServer in the
      // frontend) to keep the running total in sync with the server while
      // the customer is still browsing extras; a loyalty discount must not
      // appear there.
      // [LOYALTY-PREVIEW-FIX] The payment step (step 5) now explicitly
      // passes apply_loyalty:true to get the REAL server-side discount
      // before showing any price to the customer — never the frontend's
      // own loyaltyData.credit, which lives in localStorage and can go
      // stale (e.g. a previous device sync failed silently, or the credit
      // was already spent/changed server-side since the last successful
      // sync). Without this, the payment screen showed a discount the
      // server didn't actually have, and /create-checkout-session's own
      // (correct) recomputation kept disagreeing with it — surfacing as
      // the same "Der Preis hat sich geändert" dialog on every booking.
      pricing = await computeAuthoritativePricing(offer_id, services, promo_code, device_id, req.userId, !!apply_loyalty);
    } catch (e) {
      log('warn', 'price_preview_failed', { offer_id, error: e.message });
      return res.status(409).json({ ok: false, code: 'OFFER_UNAVAILABLE', error: 'Dieses Angebot ist nicht mehr verfügbar. Bitte erneut suchen.' });
    }

    // Optional drift flag: if the caller passed the price it last showed,
    // tell it whether that figure is still accurate (>= 0.5 unit diff —
    // same threshold as /create-checkout-session — counts as "changed").
    let changed = false, diff = 0;
    if (duffel_amount != null) {
      const oldAmount = Math.round(Number(duffel_amount) * 100) / 100;
      diff = Math.round((pricing.duffelAmount - oldAmount) * 100) / 100;
      changed = Math.abs(diff) >= 0.5;
    }

    res.json({
      ok: true,
      currency: pricing.currency,
      duffel_amount: pricing.duffelAmount,
      customer_amount: pricing.customerAmount,
      ticket_margin: pricing.ticketMargin,
      services_margin: pricing.servicesMargin,
      discount: pricing.discount,
      loyalty_discount: pricing.loyaltyDiscount,
      loyalty_account: pricing.loyaltyAccount,
      promo_status: pricing.promoStatus,
      changed, diff,
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

// ─── [#4] GET /booking-status/:sessionId ──────────────────
// Lets the frontend recover state after a refresh / reopened browser.
// [SLOW-CONFIRM-POLL-FIX] Also now the endpoint the frontend polls while
// /confirm-payment is still in flight for this session (see app.js
// checkStripeReturn/pollBookingStatus) — this lookup is a plain in-memory
// Map read, zero calls to Stripe or Duffel, so it's safe to poll
// frequently without adding load anywhere the original slow_request
// warnings were coming from. error/refunded are forwarded so a failed
// outcome can be explained accurately without a second heavy round trip.
app.get('/booking-status/:sessionId', (req, res) => {
  const s = getBookingStatus(req.params.sessionId);
  if (!s) return res.json({ ok: true, status: 'unknown' });
  res.json({
    ok: true,
    status: s.status,
    order_id: s.order_id || null,
    booking_reference: s.booking_reference || null,
    error: s.error || null,
    refunded: !!s.refunded,
  });
});

// ─── GET /booking-confirmation ──────────────────────────────
// [CONFIRMATION-FIX] The single source of truth for any "booking
// confirmation" screen — used identically right after checkout AND from
// "Meine Buchungen". Accepts either ?session_id= (right after Stripe
// redirects back) or ?order_id= (viewing a past booking).
//
// Two previously-separate, inconsistent paths fed the confirmation screen:
//   - checkStripeReturn() rebuilt a sparse offer object from sessionStorage
//     (no flight times/airline/seats/bags — set before the customer even
//     paid) and showed order.total_amount (Duffel's NET price) as the total.
//   - openBookingDetail() fetched live from Duffel only, also showing the
//     net amount, with no margin/discount/loyalty breakdown at all.
// Neither one showed what the customer actually paid (with margin, minus
// any promo/loyalty discount) — only Duffel's net cost. This endpoint
// fixes that by joining our own `bookings` record (the real money: 
// customer_paid, discount_amount, loyalty_discount, margins) with Duffel's
// live order (the real flight: segments, baggage, seat selections),
// so every confirmation screen — immediate or revisited later — shows
// the exact same numbers and details.
app.get('/booking-confirmation', rateLimit('order-status', 30, 60000), async (req, res) => {
  try {
    const { session_id, order_id } = req.query;
    if (!session_id && !order_id) return res.status(400).json({ ok: false, error: 'session_id oder order_id erforderlich' });

    // 1) Our own financial record — the real customer_paid/discount/margin.
    let bookingRow = null;
    if (supa) {
      let q = supa.from('bookings').select('*');
      q = session_id ? q.eq('stripe_session_id', session_id) : q.eq('duffel_order_id', order_id);
      const { data } = await q.maybeSingle();
      bookingRow = data || null;
    }

    // 2) Resolve the Duffel order id (from our record, or directly if the
    // caller already has it) and fetch the live order for flight/seat/bag
    // details — Duffel is the only source for those.
    const resolvedOrderId = (bookingRow && bookingRow.duffel_order_id) || order_id || null;
    let order = null;
    if (resolvedOrderId) {
      try {
        const result = await duffel('GET', `/air/orders/${resolvedOrderId}`);
        order = result.data;
      } catch (e) {
        log('warn', 'booking_confirmation_duffel_fetch_failed', { resolvedOrderId, error: e.message });
      }
    }

    if (!bookingRow && !order) {
      return res.status(404).json({ ok: false, error: 'Buchung nicht gefunden' });
    }

    res.json({
      ok: true,
      order,
      booking: bookingRow ? {
        reference: bookingRow.booking_reference,
        orderId: bookingRow.duffel_order_id,
        status: bookingRow.status,
        currency: bookingRow.currency,
        duffelAmount: Number(bookingRow.duffel_amount) || 0,
        ticketMargin: Number(bookingRow.ticket_margin) || 0,
        ancillaryMargin: Number(bookingRow.ancillary_margin) || 0,
        discountAmount: Number(bookingRow.discount_amount) || 0,
        promoCode: bookingRow.promo_code || null,
        loyaltyDiscount: Number(bookingRow.loyalty_discount) || 0,
        customerPaid: Number(bookingRow.customer_paid) || 0,
        createdAt: bookingRow.created_at,
        // [CONTACT-EMAIL-DISPLAY] Already selected from the database
        // (select('*') above) but never forwarded here — this is the
        // authoritative page-5 contact email (the same field that
        // determines account linking), more reliable than reading it
        // back from Duffel's order.passengers[0].email.
        customerEmail: bookingRow.customer_email || null,
      } : null,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/confirm-payment', rateLimit('pay', 20, 60000), async (req, res) => {
  const _sid = req.body && req.body.session_id;
  try {
    if (!stripe) return res.status(500).json({ ok: false, error: 'Stripe ist nicht konfiguriert' });
    const { session_id } = req.body;
    if (!session_id) return res.status(400).json({ ok: false, error: 'session_id مطلوب' });

    // [#14] Reject a second concurrent attempt while the first is still booking
    if (inFlight.has(session_id)) {
      return res.status(409).json({ ok: false, error: 'Buchung wird bereits verarbeitet', processing: true });
    }
    inFlight.add(session_id);

    // 1) Retrieve the session and verify payment really succeeded
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (!session || session.payment_status !== 'paid') {
      inFlight.delete(session_id);
      return res.status(402).json({ ok: false, error: 'Zahlung nicht bestätigt', payment_status: session ? session.payment_status : 'unknown' });
    }

    const out = await bookFromSession(session_id, session);
    inFlight.delete(session_id);
    if (out.already) return res.json({ ok: true, already: true, order_id: out.order_id, booking_reference: out.booking_reference });
    res.json({ ok: true, order_id: out.order_id, booking_reference: out.booking_reference, total_amount: out.total_amount, currency: out.currency });
  } catch (err) {
    inFlight.delete(_sid);
    if (err.code === 'NO_ENTRY') return res.status(400).json({ ok: false, error: err.message });
    // [PRICE-DRIFT-PROTECTION] This case already refunded the customer in
    // full inside bookFromSession() before throwing — it's a handled,
    // safe outcome (no money is stuck anywhere), not the "customer was
    // charged with no ticket and no refund" emergency the Sentry alert
    // below exists for. Logged normally, but skips the critical-alert path.
    if (err.code === 'PRICE_DRIFT') {
      log('warn', 'booking_blocked_price_drift', { message: err.message, drift: err.priceDrift });
      return res.status(409).json({
        ok: false, error: err.message, code: 'PRICE_DRIFT',
        booking_failed_after_payment: true, refunded: true,
      });
    }
    // Payment succeeded but booking failed → surface clearly so support can refund/retry
    setBookingStatus(req.body && req.body.session_id, 'failed', { error: err.message });
    log('error', 'booking_failed_after_payment', { message: err.message, status: err.status, duffel_errors: err.details, refunded: err.refunded });
    console.error('[BOOKING FAILED AFTER PAYMENT] message=' + (err.message || '') +
      ' | status=' + (err.status || '') +
      ' | refunded=' + (err.refunded ? 'yes' : 'no') +
      ' | duffel_errors=' + JSON.stringify(err.details || {}));
    recordBookingFailureEvent({
      source: 'confirm-payment',
      session_id: req.body && req.body.session_id,
      message: err.message,
      refunded: !!err.refunded,
      duffel_errors: err.details || null,
    });
    // [#8] This is the single most important error in the whole app — a
    // customer was charged but has no ticket (unless err.refunded is now
    // true — see [REFUND-SAFETY-FIX] above — in which case it's a
    // handled, safe outcome, same as PRICE_DRIFT). Still sent to Sentry
    // either way so a refund failure (refunded: false) is impossible to
    // miss.
    if (env.SENTRY_DSN) {
      Sentry.captureException(err, {
        tags: { critical: 'booking_failed_after_payment', refunded: err.refunded ? 'true' : 'false' },
        extra: { session_id: req.body && req.body.session_id, duffel_errors: err.details },
      });
    }
    res.status(err.status || 500).json({
      ok: false,
      error: err.message,
      details: err.details,
      duffel_errors: err.details,
      booking_failed_after_payment: true,
      refunded: !!err.refunded,
    });
  }
});

app.post('/add-services', rateLimit('pay', 10, 60000), async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ ok: false, error: 'Stripe ist nicht konfiguriert' });
    const { order_id, services, success_url, cancel_url, route_label } = req.body;
    if (!order_id) return res.status(400).json({ ok: false, error: 'order_id مطلوب' });
    if (!Array.isArray(services) || !services.length) return res.status(400).json({ ok: false, error: 'services مطلوب' });

    // 1) Fetch the order to get offer_id and available services
    const orderRes = await duffel('GET', `/air/orders/${order_id}`);
    const order = orderRes.data;
    if (!order) return res.status(404).json({ ok: false, error: 'الحجز غير موجود' });

    // 2) Fetch available services for this order's offer
    const offerRes = await duffel('GET', `/air/offers/${order.offer_id}?return_available_services=true`).catch(() => null);
    const available = (offerRes && offerRes.data && offerRes.data.available_services) || [];
    const byId = new Map(available.map(s => [s.id, s]));

    // 3) Compute the net Duffel cost + our ancillary margin for requested services
    const ancillaryTiers = await getAncillaryProfitTiers();
    let netTotal = 0, marginTotal = 0;
    const validServices = [];
    for (const svc of services) {
      const av = byId.get(svc.id);
      if (!av) { log('warn', 'add_service_not_available', { id: svc.id, order_id }); continue; }
      const qty = Math.max(1, Math.min(Number(svc.quantity) || 1, Number(av.maximum_quantity) || 1));
      const netUnit = parseFloat(av.total_amount || 0);
      const margin = computeTieredMargin(netUnit, ancillaryTiers);
      netTotal += netUnit * qty;
      marginTotal += margin * qty;
      validServices.push({ id: svc.id, quantity: qty, netUnit, margin });
    }
    netTotal = Math.round(netTotal * 100) / 100;
    marginTotal = Math.round(marginTotal * 100) / 100;
    const customerAmount = Math.round((netTotal + marginTotal) * 100) / 100;

    if (!validServices.length) return res.status(400).json({ ok: false, error: 'لا توجد خدمات صالحة' });
    if (customerAmount <= 0) return res.status(400).json({ ok: false, error: 'المبلغ غير صالح' });

    const currency = (available[0] && available[0].total_currency) || 'EUR';

    // 4) Create Stripe session for the customer-facing amount (net + margin)
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        quantity: 1,
        price_data: {
          currency: currency.toLowerCase(),
          unit_amount: Math.round(customerAmount * 100),
          product_data: { name: route_label ? ('Zusatzleistungen · ' + route_label) : 'Zusatzleistungen' },
        },
      }],
      success_url: (success_url || 'https://example.com/success') + '?add_session_id={CHECKOUT_SESSION_ID}',
      cancel_url: cancel_url || 'https://example.com/cancel',
      metadata: { airpiv_add_services: '1', order_id },
    });

    // 5) Store payload server-side so confirm can book with Duffel at net price
    await rememberBooking('add_' + session.id, {
      type: 'add_services',
      order_id,
      services: validServices.map(s => ({ id: s.id, quantity: s.quantity })),
      net_amount: netTotal,
      ancillary_margin: marginTotal,
      customer_amount: customerAmount,
      currency,
      route_label: route_label || null,
    });

    log('info', 'add_services_checkout_created', { order_id, session: session.id, net: netTotal, customer: customerAmount });
    res.json({ ok: true, session_id: session.id, url: session.url, customer_amount: customerAmount, currency });
  } catch (err) {
    log('error', 'add_services_failed', { error: err.message });
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// ─── POST /confirm-add-services ───────────────────────────
// Called after Stripe confirms payment for post-booking service addition.
// Submits the order change to Duffel at the NET price (no margin).
app.post('/confirm-add-services', rateLimit('pay', 10, 60000), async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ ok: false, error: 'Stripe ist nicht konfiguriert' });
    const { session_id } = req.body;
    if (!session_id) return res.status(400).json({ ok: false, error: 'session_id مطلوب' });
    // [SCHEMA-VALIDATION] Lightweight format check — Stripe checkout
    // session IDs always start with "cs_". This endpoint's real security
    // already comes from payload being read from getPendingBooking()
    // below (never trusted from the request body itself), so this is
    // just an early reject for obviously malformed input.
    if (typeof session_id !== 'string' || !session_id.startsWith('cs_')) {
      return res.status(400).json({ ok: false, error: 'session_id hat ein ungültiges Format' });
    }

    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (!session || session.payment_status !== 'paid') {
      return res.status(402).json({ ok: false, error: 'الدفع لم يتم تأكيده' });
    }

    const entry = await getPendingBooking('add_' + session_id);
    if (!entry) return res.status(400).json({ ok: false, error: 'بيانات الطلب غير موجودة' });
    const payload = entry.payload;

    // Submit order change to Duffel at NET price (our margin stays with us)
    const changeReq = await duffel('POST', '/air/order_change_requests', {
      data: {
        order_id: payload.order_id,
        services: payload.services,
      },
    });
    const changeId = changeReq.data && changeReq.data.id;
    if (!changeId) throw new Error('Duffel order_change_request fehlgeschlagen');

    // Confirm the change
    await duffel('POST', `/air/order_change_requests/${changeId}/actions/confirm`, {
      data: { payment: { type: 'balance', amount: String(payload.net_amount), currency: payload.currency } },
    });

    // Record ancillary margin in bookings table (best-effort)
    if (supa) {
      supa.from('bookings').update({
        ancillary_margin: supa.rpc ? undefined : null, // can't do += in REST easily; log separately
      }).eq('duffel_order_id', payload.order_id).then(function(){}, function(){});

      supa.from('payments').insert({
        stripe_session_id: session_id,
        stripe_payment_id: session.payment_intent || null,
        amount: payload.customer_amount,
        currency: payload.currency,
        status: 'paid',
        note: 'add_services · order ' + payload.order_id,
      }).then(function(){}, function(e){ log('error', 'supa_add_services_payment_failed', { error: e.message }); });
    }

    log('info', 'add_services_confirmed', { order_id: payload.order_id, change_id: changeId });
    res.json({ ok: true, change_id: changeId, order_id: payload.order_id });
  } catch (err) {
    log('error', 'confirm_add_services_failed', { error: err.message });
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

app.post('/order', rateLimit('order', 15, 60000), async (req, res) => {
  return res.status(410).json({ ok: false, error: 'Dieser Endpunkt ist nicht mehr verfügbar. Bitte verwende den regulären Buchungsablauf.' });
});

// ─── GET /order/:id ───────────────────────────────────────
app.get('/order/:id', rateLimit('order-status', 30, 60000), async (req, res) => {
  try {
    const result = await duffel('GET', `/air/orders/${req.params.id}`);
    res.json({ ok: true, order: result.data });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});
};
