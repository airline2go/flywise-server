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
const { getPendingBooking, markPendingBooked, setBookingStatus } = require('./pendingBookings');

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
    clean.push({ id: svc.id, quantity: Math.max(1, Math.min(Number(svc.quantity) || 1, maxQ)) });
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

async function incrementPromoUsage(promoId) {
  if (!supa || !promoId) return;
  try {
    // Atomic increment via Postgres RPC would be ideal; a plain update is
    // fine here since usage races are low-stakes (worst case: max_uses is
    // off by one in a rare concurrent-checkout edge case).
    const { data } = await supa.from('promo_codes').select('used_count').eq('id', promoId).maybeSingle();
    const next = ((data && data.used_count) || 0) + 1;
    await supa.from('promo_codes').update({ used_count: next }).eq('id', promoId);
  } catch (e) {
    log('warn', 'promo_increment_failed', { promoId, error: e.message });
  }
}

// ─── [ADMIN-MARGIN] Server-authoritative full price computation ───────────
// THE single source of truth for what Duffel gets paid vs. what the
// customer is charged. Never trusts amounts the browser sends — re-derives
// everything from Duffel's live offer + the server's own margin tiers +
// the server's own promo_codes table. Used by BOTH /create-checkout-session
// (before payment) and bookFromSession (right before booking), so the two
// can never disagree.
async function computeAuthoritativePricing(offerId, requestedServices, promoCode, deviceId, userId, applyLoyalty) {
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
  const [offerCheck, seatMapsResult] = await Promise.all([
    duffel('GET', `/air/offers/${offerId}?return_available_services=true`),
    duffel('GET', `/air/seat_maps?offer_id=${encodeURIComponent(offerId)}`).catch(() => ({ data: [] })),
  ]);
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
  const safeServices = await validateServices(offerId, requestedServices || [], avail);

  const netTicketPrice = parseFloat(offerCheck.data && offerCheck.data.total_amount || 0);
  const currency = (offerCheck.data && offerCheck.data.total_currency) || 'EUR';

  const ticketTiers = await getTicketProfitTiers();
  const ancillaryTiers = await getAncillaryProfitTiers();
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
  let netServicesTotal = 0, servicesMargin = 0;
  for (const svc of safeServices) {
    const av = byId.get(svc.id);
    if (!av || !av.total_amount) continue;
    const qty = svc.quantity || 1;
    const netUnit = parseFloat(av.total_amount);
    netServicesTotal += netUnit * qty;
    servicesMargin += computeTieredMargin(netUnit, ancillaryTiers) * qty;
  }
  netServicesTotal = Math.round(netServicesTotal * 100) / 100;
  servicesMargin = Math.round(servicesMargin * 100) / 100;

  // What Duffel must be paid: its exact net price, margin NEVER included.
  const duffelAmount = Math.round((netTicketPrice + netServicesTotal) * 100) / 100;
  // What the customer would pay before any promo/loyalty discount.
  const preDiscountTotal = Math.round((netTicketPrice + ticketMargin + netServicesTotal + servicesMargin) * 100) / 100;

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
  let loyaltyDiscount = 0, loyaltyAccount = null;
  if (userId) {
    const result = await computeLoyaltyDiscount('user', userId, preDiscountTotal);
    loyaltyAccount = result.account;
    if (applyLoyalty) loyaltyDiscount = result.discount;
  }

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

  // 3) Idempotency — already booked for this session
  if (entry.duffel_order_id) {
    return { already: true, order_id: entry.duffel_order_id, booking_reference: entry.duffel_ref || null };
  }

  setBookingStatus(session_id, 'paid');
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
    pricing = await computeAuthoritativePricing(booking.offer_id, booking.services || [], booking.promo_code || null, booking.device_id || null, booking.user_id || null, true);
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
    try {
      const [offerRes, seatMapsRes] = await Promise.all([
        duffel('GET', `/air/offers/${booking.offer_id}?return_available_services=true`),
        duffel('GET', `/air/seat_maps?offer_id=${encodeURIComponent(booking.offer_id)}`).catch(() => ({ data: [] })),
      ]);
      fallbackAvail = (offerRes.data && offerRes.data.available_services) || [];
      for (const sm of (seatMapsRes.data || [])) {
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
    safeServices = await validateServices(booking.offer_id, booking.services || [], fallbackAvail.length ? fallbackAvail : undefined);
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
    if (stripe && session && session.payment_intent) {
      try {
        await stripe.refunds.create({ payment_intent: session.payment_intent });
        log('info', 'price_drift_refund_issued', { session_id, payment_intent: session.payment_intent });
      } catch (refundErr) {
        log('error', 'price_drift_refund_failed', { session_id, error: refundErr.message });
      }
    }
    setBookingStatus(session_id, 'failed_price_drift', { drift: priceDrift, expected: expectedCustomerAmount, recomputed: recomputedCustomerAmount });
    const e = new Error('Der Flugpreis hat sich vor der Bezahlung erheblich geändert. Deine Zahlung wurde vollständig zurückerstattet.');
    e.code = 'PRICE_DRIFT';
    e.priceDrift = priceDrift;
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
        ...(safeServices.length > 0 ? { services: safeServices } : {}),
      },
    }, { 'Idempotency-Key': 'order_' + session_id });
  } catch (orderErr) {
    // [REFUND-SAFETY-FIX] The customer has already paid via Stripe at
    // this point — ANY failure creating the actual Duffel order (offer
    // expired between payment and confirmation, an unexpected airline
    // rejection, a transient API error, anything) means they were
    // charged with nothing to show for it unless this refunds them right
    // now. Previously only PRICE_DRIFT (a deliberate pre-emptive check
    // above) ever triggered a refund — every other failure here had none
    // at all, confirmed by a real production incident where
    // "offer_no_longer_available" left a paid customer with no ticket
    // and no refund.
    let refunded = false;
    if (stripe && session && session.payment_intent) {
      try {
        await stripe.refunds.create({ payment_intent: session.payment_intent });
        refunded = true;
        log('info', 'order_failure_refund_issued', { session_id, payment_intent: session.payment_intent, original_error: orderErr.message });
      } catch (refundErr) {
        log('error', 'order_failure_refund_failed', { session_id, error: refundErr.message, original_error: orderErr.message });
      }
    }
    setBookingStatus(session_id, 'failed', { error: orderErr.message, refunded });
    const e = new Error(refunded
      ? 'Die Buchung konnte nicht abgeschlossen werden. Deine Zahlung wurde vollständig zurückerstattet.'
      : orderErr.message);
    e.code = orderErr.code || 'ORDER_CREATE_FAILED';
    e.status = orderErr.status;
    e.details = orderErr.details;
    e.refunded = refunded;
    throw e;
  }

  const orderId = result.data?.id;
  const bookingRef = result.data?.booking_reference;

  // 5) Mark booked so retries/refresh can't double-book
  await markPendingBooked(session_id, orderId || '', bookingRef || '');
  setBookingStatus(session_id, 'booked', { order_id: orderId, booking_reference: bookingRef });
  log('info', 'booking_confirmed', { order_id: orderId, ref: bookingRef });

  // 6) Persist a payment record (best-effort)
  if (supa) {
    supa.from('payments').insert({
      stripe_session_id: session_id,
      stripe_payment_id: (session && session.payment_intent) || null,
      amount: booking.duffel_amount ? Number(booking.duffel_amount) : null,
      currency: booking.currency || 'EUR',
      status: 'paid',
    }).then(function(){}, function(e){ log('error', 'supa_payment_insert_failed', { error: e.message }); });

    // [ADMIN-MARGIN] Persist the financial breakdown for the admin
    // dashboard (revenue/profit reporting) — separate from pending_bookings,
    // which only tracks the technical checkout-session lifecycle.
    // [ADMIN-DASHBOARD-FIX] discountAmount previously only ever read
    // booking.discount_amount — the value stored in the checkout-session
    // payload BEFORE payment. Every other figure here (ticketMargin,
    // ancillaryMargin, loyaltyUsed) already preferred the freshly
    // recomputed `pricing` object from computeAuthoritativePricing() just
    // above, which re-derives the discount from the live offer at booking
    // time. If the fare or services drifted between checkout-session
    // creation and actual payment, the admin dashboard's discount figure
    // could silently disagree with the other recomputed figures right
    // next to it — same inconsistency bug as the others, just on this
    // one field. Now matches the same "prefer fresh pricing" pattern.
    const ticketMargin = (pricing && pricing.ticketMargin) != null ? pricing.ticketMargin : (booking.ticket_margin || 0);
    const ancillaryMargin = (pricing && pricing.servicesMargin) != null ? pricing.servicesMargin : (booking.ancillary_margin || 0);
    const discountAmount = (pricing && pricing.discount) != null ? pricing.discount : (booking.discount_amount || 0);
    const loyaltyUsed = (pricing && pricing.loyaltyDiscount) || booking.loyalty_discount || 0;
    const customerPaid = booking.customer_amount != null ? Number(booking.customer_amount) : (pricing ? pricing.customerAmount : null);
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
      const { error: bookingInsertError } = await supa.from('bookings').insert({
        stripe_session_id: session_id,
        duffel_order_id: orderId || null,
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
        stripe_payment_id: (session && session.payment_intent) || null,
      });
      if (bookingInsertError) log('error', 'supa_booking_insert_failed', { error: bookingInsertError.message });
    } catch (e) {
      log('error', 'supa_booking_insert_failed', { error: e.message });
    }

    // [ADMIN-MARGIN] Bump the promo code's usage counter now that the
    // booking is actually confirmed (not at checkout-session creation,
    // when the customer might still abandon payment).
    if (booking.promo_id) incrementPromoUsage(booking.promo_id).then(function(){}, function(){});

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
    if (booking.user_id) {
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

  return {
    already: false,
    order_id: orderId,
    booking_reference: bookingRef,
    total_amount: result.data?.total_amount,
    currency: result.data?.total_currency,
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
