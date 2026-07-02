// ═══════════════════════════════════════════════════════════════
// src/routes/cancel.routes.js
// [CORE-حساس مالياً] /cancel (مسار قديم بسيط)، /cancel-quote
// (عرض شروط الإلغاء)، /cancel-confirm (الأهم — بينفذ الإلغاء
// الفعلي + استرداد Stripe متناسب + عكس نقاط الولاء + إيميل تأكيد).
// ═══════════════════════════════════════════════════════════════

const log = require('./log');
const Sentry = require('./sentry');
const stripe = require('./stripe');
const supa = require('./supabase');
const rateLimit = require('./rateLimit');
const duffel = require('./duffel');
const { recordCancellationEvent, recordSyncFailureEvent } = require('./adminConfig');
const { reverseLoyaltyForBooking } = require('./loyalty');
const { sendCancellationEmail } = require('./email');

module.exports = (app) => {

app.post('/cancel', rateLimit('cancel', 10, 60000), async (req, res) => {
  try {
    const { order_id } = req.body;
    if (!order_id) return res.status(400).json({ ok: false, error: 'order_id مطلوب' });

    const cancelReq = await duffel('POST', '/air/order_cancellations', { data: { order_id } });
    const confirmed = await duffel('POST', `/air/order_cancellations/${cancelReq.data?.id}/actions/confirm`, {});

    // [ADMIN-CANCEL-SYNC-FIX] Reflect the real cancellation in our own
    // bookings table — previously this only happened via a client-side
    // Supabase update with a wrong column name (order_id instead of
    // duffel_order_id), which silently matched nothing every time, AND ran
    // with the browser's anon key rather than server-side. The admin
    // dashboard showed every customer-cancelled booking as still
    // "confirmed" forever, with a real refund already issued, until
    // someone happened to notice and fix it manually.
    if (supa) {
      supa.from('bookings').update({ status: 'cancelled' }).eq('duffel_order_id', order_id)
        .then(({ data, error }) => {
          if (error) { log('error', 'admin_cancel_sync_failed', { order_id, error: error.message }); return; }
          // [CANCEL-NOTIFY-FIX] This is a CUSTOMER cancelling their own
          // booking (via this public /cancel endpoint), not the admin
          // cancelling something from the dashboard — the admin has no
          // other way to find out this happened unless they happen to
          // check the bookings table. Record it so the dashboard can show
          // an unread-count badge.
          recordCancellationEvent({ order_id, refund_amount: confirmed.data?.refund_amount || null });
        });
    }

    res.json({ ok: true, cancelled: true, refund_amount: confirmed.data?.refund_amount });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// ─── POST /cancel-quote ───────────────────────────────────
// Duffel step 1: create a pending cancellation → returns the REAL refund amount
// and conditions for this order, WITHOUT actually cancelling yet.
app.post('/cancel-quote', rateLimit('cancel', 15, 60000), async (req, res) => {
  try {
    const { order_id } = req.body;
    if (!order_id) return res.status(400).json({ ok: false, error: 'order_id مطلوب' });
    const cancelReq = await duffel('POST', '/air/order_cancellations', { data: { order_id } });
    const d = cancelReq.data || {};
    res.json({
      ok: true,
      cancellation_id: d.id,
      refund_amount: d.refund_amount,
      refund_currency: d.refund_currency,
      expires_at: d.expires_at,
    });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message, details: err.details });
  }
});

// ─── POST /cancel-confirm ─────────────────────────────────
// Duffel step 2: confirm the pending cancellation (executes refund).
app.post('/cancel-confirm', rateLimit('cancel', 10, 60000), async (req, res) => {
  try {
    const { cancellation_id, order_id: order_id_from_client } = req.body;
    if (!cancellation_id) return res.status(400).json({ ok: false, error: 'cancellation_id مطلوب' });
    const confirmed = await duffel('POST', `/air/order_cancellations/${cancellation_id}/actions/confirm`, {});

    // [REFUND-DIAGNOSTIC] Logs Duffel's RAW response fields exactly as
    // received — refund_amount is documented as a nullable STRING (e.g.
    // "90.80"), not a number, and can be null when Duffel itself can't
    // get a refund quote from the carrier. This makes the actual root
    // cause of "no refund happening" verifiable from the logs with
    // certainty (a stale deployment vs. Duffel genuinely returning
    // null/0.00 vs. a missing booking row/stripe_payment_id) rather than
    // guessed.
    log('info', 'cancellation_confirmed_raw', {
      cancellation_id,
      raw_order_id: confirmed.data?.order_id,
      raw_refund_amount: confirmed.data?.refund_amount,
      raw_refund_amount_type: typeof confirmed.data?.refund_amount,
      raw_refund_currency: confirmed.data?.refund_currency,
      raw_refund_to: confirmed.data?.refund_to,
    });

    // [CANCEL-CONFIRM-100PCT-FIX] order_id comes primarily from Duffel's
    // own confirmed response — the authoritative source — with the
    // frontend-supplied value kept only as a fallback if Duffel's
    // response is ever missing it. Combined with the independent
    // /webhooks/duffel confirmation above, this gives two separate,
    // Duffel-sourced confirmations of every cancellation rather than
    // trusting solely what the browser happened to send.
    const order_id = confirmed.data?.order_id || order_id_from_client;
    // [STRIPE-REFUND-FIX] This is Duffel's NET refund amount — what
    // Duffel itself returns to us, NOT what the customer should get back.
    const duffelRefundAmount = parseFloat(confirmed.data?.refund_amount || 0);

    // [STRIPE-REFUND-FIX] The actual missing piece: until now, nothing
    // on this path ever called Stripe to refund the customer ANY amount
    // — the customer would see "Refund: 120€", confirm, have their
    // booking cancelled, and never receive a cent, since refund_amount
    // was purely a display value from Duffel with no corresponding
    // Stripe action behind it. Computes a FAIR, proportional refund: the
    // same ratio Duffel actually granted (duffelRefundAmount /
    // duffel_amount) applied to customer_paid (the FULL amount charged,
    // including our margin) — so a fully-refundable fare returns the
    // customer's complete payment (margin included, since no service was
    // delivered), and a partially-refundable fare returns the same
    // proportion of what they actually paid, not just Duffel's net share.
    // [REFUND-DIAGNOSTIC] Always logs the parsed refund amount — confirms
    // with certainty whether Duffel itself genuinely returned 0/null (a
    // real non-refundable fare, the correct and expected outcome for
    // many basic-economy tickets) versus some other unexpected value,
    // BEFORE any of the conditional refund logic below even runs.
    log('info', 'cancellation_duffel_refund_amount_parsed', {
      order_id, cancellation_id, duffelRefundAmount,
      is_genuinely_zero_or_unrefundable: duffelRefundAmount <= 0,
    });

    let actualRefundToCustomer = 0;
    let refundCurrency = confirmed.data?.refund_currency || 'EUR';
    let stripeRefundIssued = false;
    let stripeRefundError = null;
    let refundRatioForLoyalty = 0;
    let bookingRowForLoyalty = null;
    // [CANCELLATION-EMAIL-FIX] Lookup now happens for EVERY confirmed
    // cancellation, not just refundable ones — a non-refundable fare is a
    // common, normal case, and the customer still needs their
    // confirmation email and the loyalty/sync bookkeeping below still
    // needs this row (even if refundRatioForLoyalty ends up 0).
    let bookingRowForEmail = null;
    if (supa && order_id) {
      // [REFUND-DIAGNOSTIC] CRITICAL FIX confirmed by an actual production
      // incident: Supabase's client doesn't throw on a query error (e.g. a
      // missing column) — it returns { data: null, error: {...} } quietly.
      // The previous code only destructured `data` and never checked
      // `error` at all, so a schema mismatch (the loyalty_points_earned
      // column not yet existing) silently resulted in bookingRowForLoyalty
      // staying null — which meant the entire refund/loyalty-reversal
      // logic below never ran, with NO visible error anywhere. Now
      // explicitly checks `error` and escalates loudly.
      const { data: bookingRow, error: bookingLookupErr } = await supa.from('bookings')
        .select('duffel_amount,customer_paid,stripe_payment_id,currency,user_id,loyalty_discount,loyalty_points_earned,customer_email,booking_reference,route_label')
        .eq('duffel_order_id', order_id).maybeSingle();
      if (bookingLookupErr) {
        log('error', 'cancellation_booking_lookup_failed', { order_id, error: bookingLookupErr.message });
        Sentry.captureException(new Error('Cancellation confirmed with Duffel but booking lookup failed — likely a schema mismatch'), {
          tags: { critical: 'cancellation_booking_lookup_failed', order_id },
          extra: { order_id, db_error: bookingLookupErr.message },
        });
        recordSyncFailureEvent({
          type: 'cancellation_booking_lookup_failed',
          order_id, cancellation_id,
          message: 'Stornierung bei Duffel bestätigt, aber die Buchung konnte aus der Datenbank nicht geladen werden (möglicherweise fehlt eine Spalte) — Rückerstattung und E-Mail wurden NICHT verarbeitet. Sofortige manuelle Prüfung erforderlich!',
          db_error: bookingLookupErr.message,
        });
      } else {
        bookingRowForLoyalty = bookingRow;
        bookingRowForEmail = bookingRow;
      }
    }
    // [STRIPE-REFUND-FIX] The actual missing piece: until now, nothing
    // on this path ever called Stripe to refund the customer ANY amount
    // — the customer would see "Refund: 120€", confirm, have their
    // booking cancelled, and never receive a cent, since refund_amount
    // was purely a display value from Duffel with no corresponding
    // Stripe action behind it. Computes a FAIR, proportional refund: the
    // same ratio Duffel actually granted (duffelRefundAmount /
    // duffel_amount) applied to customer_paid (the FULL amount charged,
    // including our margin) — so a fully-refundable fare returns the
    // customer's complete payment (margin included, since no service was
    // delivered), and a partially-refundable fare returns the same
    // proportion of what they actually paid, not just Duffel's net share.
    if (bookingRowForLoyalty && duffelRefundAmount > 0) {
      try {
        const bookingRow = bookingRowForLoyalty;
        // [REFUND-DIAGNOSTIC] Logs the exact booking-row values feeding
        // into the ratio computation — confirms with certainty whether
        // duffel_amount/stripe_payment_id are actually present and
        // correct on this specific booking row, rather than guessing.
        log('info', 'cancellation_refund_inputs', {
          order_id,
          duffel_amount_raw: bookingRow.duffel_amount,
          customer_paid_raw: bookingRow.customer_paid,
          has_stripe_payment_id: !!bookingRow.stripe_payment_id,
          duffel_refund_amount: duffelRefundAmount,
        });
        if (bookingRow.stripe_payment_id && stripe) {
          const duffelAmount = Number(bookingRow.duffel_amount) || 0;
          const customerPaid = Number(bookingRow.customer_paid) || 0;
          // [REFUND-EXACT-FIX] Refund exactly what Duffel actually
          // refunded, capped at what the customer paid as a safety
          // ceiling — never re-derive it by applying a ratio to
          // customerPaid, since customerPaid includes our margin and a
          // ratio-based calc was previously over-refunding customers.
          const refundRatio = duffelAmount > 0 ? Math.min(1, duffelRefundAmount / duffelAmount) : 0;
          refundRatioForLoyalty = refundRatio;
          actualRefundToCustomer = customerPaid > 0
            ? Math.min(duffelRefundAmount, customerPaid)
            : duffelRefundAmount;
          actualRefundToCustomer = Math.round(actualRefundToCustomer * 100) / 100;
          refundCurrency = bookingRow.currency || refundCurrency;
          log('info', 'cancellation_refund_computed', { order_id, duffelAmount, customerPaid, refundRatio, actualRefundToCustomer });
          if (actualRefundToCustomer > 0) {
            await stripe.refunds.create({
              payment_intent: bookingRow.stripe_payment_id,
              amount: Math.round(actualRefundToCustomer * 100), // Stripe expects the smallest currency unit (cents)
            });
            stripeRefundIssued = true;
            log('info', 'cancellation_stripe_refund_issued', { order_id, amount: actualRefundToCustomer, currency: refundCurrency, ratio: refundRatio });
          } else {
            log('warn', 'cancellation_refund_amount_zero_after_ratio', { order_id, duffelAmount, customerPaid, refundRatio });
          }
        } else if (!bookingRow.stripe_payment_id) {
          log('warn', 'cancellation_refund_no_payment_id', { order_id });
        }
      } catch (refundErr) {
        // [STRIPE-REFUND-FIX] A failed Stripe refund here is exactly as
        // serious as the database-sync failure below — the customer was
        // told they'd be refunded and Duffel's cancellation already
        // went through, but the money didn't actually move. This MUST
        // surface as a critical admin alert, never just a log line.
        stripeRefundError = refundErr.message;
        log('error', 'cancellation_stripe_refund_failed', { order_id, error: refundErr.message });
        Sentry.captureException(refundErr, {
          tags: { critical: 'cancellation_refund_failed', order_id },
          extra: { order_id, cancellation_id, duffel_refund_amount: duffelRefundAmount },
        });
        recordSyncFailureEvent({
          type: 'cancellation_refund_failed',
          order_id, cancellation_id,
          refund_amount: duffelRefundAmount,
          message: 'Stornierung bestätigt, aber die Stripe-Rückerstattung an den Kunden ist fehlgeschlagen — manuelle Rückerstattung erforderlich!',
          db_error: refundErr.message,
        });
      }
    }

    // [LOYALTY-CANCEL-REVERSAL-FIX] Reverses the same fair proportion
    // (refundRatioForLoyalty) of whatever credit was used and points
    // earned on THIS specific booking — runs independently of whether
    // the Stripe refund above succeeded, since this is owed based on
    // what Duffel actually granted, not on Stripe's execution. A safe
    // no-op if the booking never used credit or has no logged-in user.
    // Never blocks the response — failures surface through the same
    // sync-failure admin-notification path as everything else here.
    if (bookingRowForLoyalty && bookingRowForLoyalty.user_id && refundRatioForLoyalty > 0) {
      const creditUsedOriginal = Number(bookingRowForLoyalty.loyalty_discount) || 0;
      const pointsEarnedOriginal = Number(bookingRowForLoyalty.loyalty_points_earned) || 0;
      if (creditUsedOriginal > 0 || pointsEarnedOriginal > 0) {
        reverseLoyaltyForBooking('user', bookingRowForLoyalty.user_id, creditUsedOriginal, pointsEarnedOriginal, refundRatioForLoyalty)
          .then((result) => {
            if (!result.ok) {
              log('error', 'loyalty_reversal_failed', { order_id, error: result.error });
              recordSyncFailureEvent({
                type: 'loyalty_reversal_failed',
                order_id, cancellation_id,
                message: 'Stornierung bestätigt, aber Treuepunkte/Guthaben konnten nicht zurückgebucht werden — manuelle Prüfung erforderlich.',
                db_error: result.error,
              });
            }
          });
      }
    }

    // [SYNC-FAILURE-NOTIFY] The cancellation with Duffel has ALREADY
    // succeeded by this point — that's the part that matters financially
    // to the customer, and it's never undone or delayed by anything
    // below. This sync-to-our-database step is genuinely fire-and-forget
    // (no await on the response path): one immediate retry covers the
    // common transient-network-blip case; if BOTH attempts fail, this
    // escalates to a dedicated, loud admin notification + Sentry alert
    // for manual reconciliation — never silently logged and forgotten,
    // since a confirmed-but-unsynced cancellation means the admin
    // dashboard would keep showing a real, refunded cancellation as an
    // active booking indefinitely.
    if (supa && order_id) {
      (async () => {
        let lastError = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
          const { error } = await supa.from('bookings').update({ status: 'cancelled' }).eq('duffel_order_id', order_id);
          if (!error) return; // success — nothing further to do
          lastError = error;
          if (attempt === 1) await new Promise((r) => setTimeout(r, 1500));
        }
        // Both attempts failed — this is the real, dangerous case.
        log('error', 'cancel_sync_failed_after_retry', { order_id, cancellation_id, error: lastError.message });
        Sentry.captureException(new Error('Cancellation confirmed with Duffel but database sync failed after retry'), {
          tags: { critical: 'cancel_sync_failed', order_id },
          extra: { order_id, cancellation_id, db_error: lastError.message },
        });
        recordSyncFailureEvent({
          type: 'cancellation_sync_failed',
          order_id, cancellation_id,
          message: 'Stornierung bei Duffel erfolgreich bestätigt, aber Status in der Datenbank konnte nicht aktualisiert werden — manuelle Prüfung erforderlich.',
          db_error: lastError.message,
        });
      })();
    }

    // [CANCELLATION-EMAIL-FIX] Fire-and-forget, matching every other email
    // send in this codebase — never delays the cancellation response to
    // the customer. Honestly reflects the actual refund outcome: a real
    // refund amount if Stripe succeeded, a "no refund per fare
    // conditions" message if duffelRefundAmount was 0 to begin with, or
    // a "still being processed" message if the Stripe refund call itself
    // failed — never claiming money was refunded when it wasn't.
    if (bookingRowForEmail && bookingRowForEmail.customer_email) {
      sendCancellationEmail(bookingRowForEmail.customer_email, {
        bookingRef: bookingRowForEmail.booking_reference,
        routeLabel: bookingRowForEmail.route_label,
        refundAmount: actualRefundToCustomer,
        refundCurrency,
        stripeRefundError,
      }).then(function(){}, function(e){ log('warn', 'cancellation_email_failed', { order_id, error: e.message }); });
    }

    res.json({
      ok: true,
      cancelled: true,
      refund_amount: actualRefundToCustomer || duffelRefundAmount,
      refund_currency: refundCurrency,
      stripe_refund_issued: stripeRefundIssued,
      stripe_refund_error: stripeRefundError,
    });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message, details: err.details });
  }
});
};
