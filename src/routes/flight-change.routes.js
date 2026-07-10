// ═══════════════════════════════════════════════════════════════
// src/routes/flight-change.routes.js
// [CORE-حساس مالياً] تغيير تاريخ رحلة لحجز مدفوع مسبقاً عبر Duffel
// Order Change API — /change-quote (عرض السعر الجديد والفرق)،
// /change-confirm (تأكيد مباشر للحالة المجانية/المسترجعة)،
// /change-pay + /confirm-change-payment (دفع الفرق عبر Stripe لو
// السعر زاد). بدون أي هامش ربح — نفس سعر Duffel بالضبط بالاتجاهين.
// ═══════════════════════════════════════════════════════════════

const crypto = require('crypto');
const log = require('../utils/log');
const Sentry = require('../clients/sentry');
const stripe = require('../clients/stripe');
const supa = require('../clients/supabase');
const rateLimit = require('../middleware/rateLimit');
const duffel = require('../services/duffel');
const { attachUserIfPresent } = require('../middleware/auth');
const { checkOrderOwnership } = require('../services/booking');
const { rememberBooking, getPendingBooking } = require('../services/pendingBookings');
const { recordSyncFailureEvent } = require('../services/adminConfig');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidFutureDate(dateStr) {
  if (typeof dateStr !== 'string' || !DATE_RE.test(dateStr)) return false;
  const d = new Date(dateStr + 'T00:00:00Z');
  if (isNaN(d.getTime())) return false;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return d.getTime() > today.getTime();
}

// Applies the fire-and-forget-with-one-retry bookings-row update pattern
// used by cancel.routes.js's cancellation sync — escalates to Sentry +
// the admin sync-failure feed if both attempts fail, never blocks the
// customer-facing response.
function syncBookingRow(orderId, updates, context) {
  if (!supa || !orderId) return;
  (async () => {
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const { error } = await supa.from('bookings').update(updates).eq('duffel_order_id', orderId);
      if (!error) return;
      lastError = error;
      if (attempt === 1) await new Promise((r) => setTimeout(r, 1500));
    }
    log('error', 'flight_change_sync_failed_after_retry', { order_id: orderId, error: lastError.message, context });
    Sentry.captureException(new Error('Flight change confirmed with Duffel but database sync failed after retry'), {
      tags: { critical: 'flight_change_sync_failed', order_id: orderId },
      extra: { order_id: orderId, db_error: lastError.message, context },
    });
    recordSyncFailureEvent({
      type: 'flight_change_sync_failed',
      order_id: orderId,
      message: 'Flugdatum-Änderung bei Duffel bestätigt, aber die Buchung konnte in der Datenbank nicht aktualisiert werden — manuelle Prüfung erforderlich.',
      db_error: lastError.message,
    });
  })();
}

function insertPaymentLedgerRow(entry) {
  if (!supa) return;
  supa.from('payments').insert(entry).then(function () {}, function (e) {
    log('error', 'supa_flight_change_payment_insert_failed', { error: e.message });
  });
}

module.exports = (app) => {

// ─── POST /change-quote ───────────────────────────────────
// Duffel step 1: quote a date change for one slice (outbound or return)
// of a one-way/round-trip booking — WITHOUT confirming it yet.
app.post('/change-quote', attachUserIfPresent, rateLimit('change', 15, 60000), async (req, res) => {
  try {
    const { order_id, slice_id, slice_index, new_date } = req.body;
    if (!order_id) return res.status(400).json({ ok: false, error: 'order_id مطلوب' });
    if (!slice_id) return res.status(400).json({ ok: false, error: 'slice_id مطلوب' });
    if (!isValidFutureDate(new_date)) return res.status(400).json({ ok: false, error: 'Ungültiges oder vergangenes Datum' });

    const ownership = await checkOrderOwnership(order_id, req.userId);
    if (!ownership.allowed) return res.status(403).json({ ok: false, error: 'Nicht autorisiert' });

    if (supa) {
      const { data: bookingRow } = await supa.from('bookings').select('status').eq('duffel_order_id', order_id).maybeSingle();
      if (bookingRow && bookingRow.status === 'cancelled') {
        return res.status(400).json({ ok: false, error: 'Diese Buchung wurde bereits storniert' });
      }
    }

    // Fetch the live order — the only authoritative source for slice ids,
    // routes, and cabin class (never cached locally, same as every other
    // slice-level lookup in this codebase).
    const orderRes = await duffel('GET', `/air/orders/${order_id}`);
    const order = orderRes.data;
    if (!order) return res.status(404).json({ ok: false, error: 'Buchung nicht gefunden' });

    // [MULTI-CITY-GUARD] Phase 1 only supports one-way (1 slice) and
    // round-trip (2 slices) bookings — a 3+ slice multi-city itinerary
    // has interdependencies (connecting dates, open-jaw routing) this
    // simple "swap one slice's date" flow isn't designed to handle safely.
    if (!Array.isArray(order.slices) || order.slices.length > 2) {
      return res.status(400).json({ ok: false, error: 'Diese Buchung kann online nicht per Datum geändert werden — bitte kontaktiere den Support.' });
    }

    // [SLICE-ID-VERIFY] The client-supplied slice_id is only ever a hint
    // — same server-authoritative principle as the referral system —
    // it's re-validated here against the live order before being used
    // for anything, never trusted blindly for a money-moving action.
    const targetSlice = order.slices.find((s) => s.id === slice_id);
    if (!targetSlice) return res.status(400).json({ ok: false, error: 'Ungültiger Streckenabschnitt' });

    const segments = targetSlice.segments || [];
    if (!segments.length) return res.status(400).json({ ok: false, error: 'Streckenabschnitt hat keine Segmente' });
    const origin = segments[0].origin && segments[0].origin.iata_code;
    const destination = segments[segments.length - 1].destination && segments[segments.length - 1].destination.iata_code;
    const cabinClass = (segments[0].passengers && segments[0].passengers[0] && segments[0].passengers[0].cabin_class) || targetSlice.fare_brand_name || 'economy';
    if (!origin || !destination) return res.status(400).json({ ok: false, error: 'Streckendaten unvollständig' });

    const oldDepartureAt = segments[0].departing_at || null;

    const changeReq = await duffel('POST', '/air/order_change_requests', {
      data: {
        order_id,
        slices: {
          remove: [slice_id],
          add: [{ origin, destination, departure_date: new_date, cabin_class: cabinClass }],
        },
      },
    });
    const changeData = changeReq.data || {};
    const offers = changeData.order_change_offers || [];
    if (!offers.length) {
      return res.status(400).json({ ok: false, error: 'Für dieses Datum sind keine Umbuchungsoptionen verfügbar.' });
    }
    // Cheapest offer — phase 1 doesn't expose fare/cabin selection.
    const offer = offers.reduce((best, o) => (
      parseFloat(o.new_total_amount || 0) < parseFloat(best.new_total_amount || 0) ? o : best
    ), offers[0]);

    // [SIGN-CONVENTION] positive change_total_amount = customer owes more,
    // zero = free, negative = refund owed. Verified against a real Duffel
    // test-mode response — see plan verification step 3.
    const changeTotalAmount = Math.round(parseFloat(offer.change_total_amount || 0) * 100) / 100;
    const penaltyTotalAmount = Math.round(parseFloat(offer.penalty_total_amount || 0) * 100) / 100;
    const newTotalAmount = Math.round(parseFloat(offer.new_total_amount || 0) * 100) / 100;
    const currency = offer.new_total_currency || targetSlice.fare_brand_currency || 'EUR';
    const newDepartureAt = (offer.slices && offer.slices[0] && offer.slices[0].segments && offer.slices[0].segments[0] && offer.slices[0].segments[0].departing_at) || null;

    const quoteToken = crypto.randomBytes(16).toString('hex');
    await rememberBooking('chg_' + quoteToken, {
      order_id,
      slice_id,
      slice_index: Number.isInteger(slice_index) ? slice_index : null,
      change_request_id: changeData.id,
      offer_id: offer.id,
      change_total_amount: changeTotalAmount,
      penalty_total_amount: penaltyTotalAmount,
      new_total_amount: newTotalAmount,
      currency,
      old_departure_at: oldDepartureAt,
      new_departure_at: newDepartureAt,
      expires_at: offer.expires_at || null,
      consumed: false,
    });

    log('info', 'flight_change_quoted', {
      order_id, user_id: req.userId || null, slice_id,
      change_request_id: changeData.id, offer_id: offer.id,
      old_departure_at: oldDepartureAt, new_departure_at: newDepartureAt,
      old_amount: null, new_amount: newTotalAmount, currency,
    });

    res.json({
      ok: true,
      quote_token: quoteToken,
      change_total_amount: changeTotalAmount,
      penalty_total_amount: penaltyTotalAmount,
      new_total_amount: newTotalAmount,
      currency,
      old_departure_at: oldDepartureAt,
      new_departure_at: newDepartureAt,
      expires_at: offer.expires_at || null,
    });
  } catch (err) {
    log('error', 'flight_change_quote_failed', { error: err.message });
    res.status(err.status || 500).json({ ok: false, error: err.message, details: err.details });
  }
});

// ─── POST /change-confirm ─────────────────────────────────
// Used only when the quote's change_total_amount <= 0 (free, or a refund
// is owed) — confirms directly with Duffel, then refunds via Stripe if
// something is owed back. A positive change_total_amount MUST go through
// /change-pay + /confirm-change-payment instead (payment before confirm).
app.post('/change-confirm', attachUserIfPresent, rateLimit('change', 10, 60000), async (req, res) => {
  try {
    const { quote_token, order_id } = req.body;
    if (!quote_token) return res.status(400).json({ ok: false, error: 'quote_token مطلوب' });
    if (!order_id) return res.status(400).json({ ok: false, error: 'order_id مطلوب' });

    const ownership = await checkOrderOwnership(order_id, req.userId);
    if (!ownership.allowed) return res.status(403).json({ ok: false, error: 'Nicht autorisiert' });

    const entry = await getPendingBooking('chg_' + quote_token);
    if (!entry || !entry.payload) return res.status(400).json({ ok: false, error: 'Angebot nicht gefunden oder abgelaufen' });
    const payload = entry.payload;
    if (payload.order_id !== order_id) return res.status(403).json({ ok: false, error: 'Nicht autorisiert' });

    // [IDEMPOTENCY] A double-click, a network retry, or the browser
    // replaying this call must never confirm the Duffel change or issue
    // the Stripe refund a second time.
    if (payload.consumed) {
      return res.json({ ok: true, order_id, already_processed: true, refund_amount: payload.refund_amount || 0 });
    }

    if (payload.change_total_amount > 0) {
      return res.status(400).json({ ok: false, error: 'Für diese Änderung ist eine Zahlung erforderlich — bitte /change-pay verwenden' });
    }

    await duffel('POST', `/air/order_change_requests/${payload.change_request_id}/actions/confirm`, {
      data: { payment: { type: 'balance', amount: '0', currency: payload.currency } },
    });

    let refundAmount = 0;
    let refundIssued = false;
    let refundError = null;
    let bookingRow = null;
    if (supa) {
      const { data } = await supa.from('bookings')
        .select('duffel_amount,customer_paid,stripe_payment_id,currency')
        .eq('duffel_order_id', order_id).maybeSingle();
      bookingRow = data || null;
    }

    if (payload.change_total_amount < 0 && bookingRow && bookingRow.stripe_payment_id && stripe) {
      const owed = Math.abs(payload.change_total_amount);
      const customerPaid = Number(bookingRow.customer_paid) || 0;
      refundAmount = Math.round(Math.min(owed, customerPaid) * 100) / 100;
      if (refundAmount > 0) {
        try {
          await stripe.refunds.create({
            payment_intent: bookingRow.stripe_payment_id,
            amount: Math.round(refundAmount * 100),
          });
          refundIssued = true;
        } catch (refundErr) {
          refundError = refundErr.message;
          log('error', 'flight_change_refund_failed', { order_id, error: refundErr.message });
          Sentry.captureException(refundErr, {
            tags: { critical: 'flight_change_refund_failed', order_id },
            extra: { order_id, change_request_id: payload.change_request_id, owed },
          });
          recordSyncFailureEvent({
            type: 'flight_change_refund_failed',
            order_id,
            message: 'Flugdatum-Änderung bestätigt, aber die Stripe-Rückerstattung an den Kunden ist fehlgeschlagen — manuelle Rückerstattung erforderlich!',
            db_error: refundErr.message,
          });
        }
      }
    }

    // Mark consumed only after the Duffel confirm (and any refund attempt)
    // above — this is what makes the idempotency check at the top effective.
    await rememberBooking('chg_' + quote_token, Object.assign({}, payload, { consumed: true, refund_amount: refundAmount }));

    const newDuffelAmount = bookingRow ? (Number(bookingRow.duffel_amount) || 0) + payload.change_total_amount : undefined;
    const newCustomerPaid = bookingRow ? Math.max(0, (Number(bookingRow.customer_paid) || 0) + payload.change_total_amount) : undefined;
    syncBookingRow(order_id, Object.assign(
      {},
      newDuffelAmount !== undefined ? { duffel_amount: newDuffelAmount } : {},
      newCustomerPaid !== undefined ? { customer_paid: newCustomerPaid } : {},
    ), 'change-confirm');

    if (refundIssued || payload.change_total_amount === 0) {
      insertPaymentLedgerRow({
        stripe_payment_id: bookingRow ? bookingRow.stripe_payment_id : null,
        amount: -Math.abs(refundAmount) || 0,
        currency: payload.currency,
        status: refundIssued ? 'refunded' : 'free_change',
        note: 'flight_change · order ' + order_id + ' · slice ' + payload.slice_id,
      });
    }

    log('info', 'flight_change_confirmed', {
      order_id, user_id: req.userId || null, slice_id: payload.slice_id,
      change_request_id: payload.change_request_id,
      old_amount: null, new_amount: payload.new_total_amount, currency: payload.currency,
      refunded: refundIssued, refund_amount: refundAmount,
    });

    res.json({ ok: true, order_id, refunded: refundIssued, refund_amount: refundAmount, refund_error: refundError });
  } catch (err) {
    log('error', 'flight_change_confirm_failed', { error: err.message });
    res.status(err.status || 500).json({ ok: false, error: err.message, details: err.details });
  }
});

// ─── POST /change-pay ─────────────────────────────────────
// Used when the quote's change_total_amount > 0 — creates a Stripe
// Checkout Session for exactly that amount (no margin), mirroring
// POST /add-services. The Duffel change itself is only confirmed after
// payment succeeds, in /confirm-change-payment.
app.post('/change-pay', attachUserIfPresent, rateLimit('pay', 10, 60000), async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ ok: false, error: 'Stripe ist nicht konfiguriert' });
    const { quote_token, order_id, success_url, cancel_url } = req.body;
    if (!quote_token) return res.status(400).json({ ok: false, error: 'quote_token مطلوب' });
    if (!order_id) return res.status(400).json({ ok: false, error: 'order_id مطلوب' });

    const ownership = await checkOrderOwnership(order_id, req.userId);
    if (!ownership.allowed) return res.status(403).json({ ok: false, error: 'Nicht autorisiert' });

    const entry = await getPendingBooking('chg_' + quote_token);
    if (!entry || !entry.payload) return res.status(400).json({ ok: false, error: 'Angebot nicht gefunden oder abgelaufen' });
    const payload = entry.payload;
    if (payload.order_id !== order_id) return res.status(403).json({ ok: false, error: 'Nicht autorisiert' });
    if (payload.consumed) return res.status(400).json({ ok: false, error: 'Dieses Angebot wurde bereits verwendet' });
    if (!(payload.change_total_amount > 0)) {
      return res.status(400).json({ ok: false, error: 'Für diese Änderung ist keine Zahlung erforderlich — bitte /change-confirm verwenden' });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        quantity: 1,
        price_data: {
          currency: payload.currency.toLowerCase(),
          unit_amount: Math.round(payload.change_total_amount * 100),
          product_data: { name: 'Flugdatum-Änderung · Buchung ' + order_id },
        },
      }],
      success_url: (success_url || 'https://example.com/success') + '?change_session_id={CHECKOUT_SESSION_ID}',
      cancel_url: cancel_url || 'https://example.com/cancel',
      metadata: { airpiv_flight_change: '1', order_id },
    });

    await rememberBooking('chgpay_' + session.id, Object.assign({}, payload, { consumed: false }));

    log('info', 'flight_change_checkout_created', { order_id, session: session.id, amount: payload.change_total_amount });
    res.json({ ok: true, session_id: session.id, url: session.url, amount: payload.change_total_amount, currency: payload.currency });
  } catch (err) {
    log('error', 'flight_change_pay_failed', { error: err.message });
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// ─── POST /confirm-change-payment ─────────────────────────
// Called after Stripe confirms payment for the "customer owes more" case.
// Confirms the Duffel change at the full owed amount only after payment
// is verified — mirrors /confirm-add-services exactly.
app.post('/confirm-change-payment', rateLimit('pay', 10, 60000), async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ ok: false, error: 'Stripe ist nicht konfiguriert' });
    const { session_id } = req.body;
    if (!session_id) return res.status(400).json({ ok: false, error: 'session_id مطلوب' });
    if (typeof session_id !== 'string' || !session_id.startsWith('cs_')) {
      return res.status(400).json({ ok: false, error: 'session_id hat ein ungültiges Format' });
    }

    const entry = await getPendingBooking('chgpay_' + session_id);
    if (!entry || !entry.payload) return res.status(400).json({ ok: false, error: 'Zahlungsdaten nicht gefunden' });
    const payload = entry.payload;

    // [IDEMPOTENCY] Checked before touching Duffel or the ledger — a page
    // refresh on the success URL, or checkChangeDateReturn() firing twice,
    // must not confirm the Duffel change or insert a payment row twice.
    if (payload.consumed) {
      return res.json({ ok: true, order_id: payload.order_id, already_processed: true });
    }

    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (!session || session.payment_status !== 'paid') {
      return res.status(402).json({ ok: false, error: 'Zahlung nicht bestätigt' });
    }

    await duffel('POST', `/air/order_change_requests/${payload.change_request_id}/actions/confirm`, {
      data: { payment: { type: 'balance', amount: String(payload.change_total_amount), currency: payload.currency } },
    });

    await rememberBooking('chgpay_' + session_id, Object.assign({}, payload, { consumed: true }));

    let bookingRow = null;
    if (supa) {
      const { data } = await supa.from('bookings').select('duffel_amount,customer_paid').eq('duffel_order_id', payload.order_id).maybeSingle();
      bookingRow = data || null;
    }
    const newDuffelAmount = bookingRow ? (Number(bookingRow.duffel_amount) || 0) + payload.change_total_amount : undefined;
    const newCustomerPaid = bookingRow ? (Number(bookingRow.customer_paid) || 0) + payload.change_total_amount : undefined;
    syncBookingRow(payload.order_id, Object.assign(
      {},
      newDuffelAmount !== undefined ? { duffel_amount: newDuffelAmount } : {},
      newCustomerPaid !== undefined ? { customer_paid: newCustomerPaid } : {},
    ), 'confirm-change-payment');

    insertPaymentLedgerRow({
      stripe_session_id: session_id,
      stripe_payment_id: session.payment_intent || null,
      amount: payload.change_total_amount,
      currency: payload.currency,
      status: 'paid',
      note: 'flight_change · order ' + payload.order_id + ' · slice ' + payload.slice_id,
    });

    log('info', 'flight_change_payment_confirmed', {
      order_id: payload.order_id, slice_id: payload.slice_id,
      change_request_id: payload.change_request_id,
      old_amount: null, new_amount: payload.new_total_amount, currency: payload.currency,
    });

    res.json({ ok: true, order_id: payload.order_id });
  } catch (err) {
    log('error', 'confirm_change_payment_failed', { error: err.message });
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

};
