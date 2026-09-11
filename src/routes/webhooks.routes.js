// ═══════════════════════════════════════════════════════════════
// src/routes/webhooks.routes.js
// [مهم جداً] لازم تتركب في server.js بـ express.raw() و **قبل**
// app.use(express.json()) العام — التحقق من التوقيع محتاج الجسم
// الخام (raw) للطلب، ولو json() اشتغل الأول هيبقى الجسم object
// متحلل بالفعل وأي تحقق توقيع هيفشل تلقائياً.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const env = require('../config/env');
const log = require('../utils/log');
const Sentry = require('../clients/sentry');
const stripe = require('../clients/stripe');
const supa = require('../clients/supabase');
const { bookFromSession, inFlight } = require('../services/booking');
const { recordBookingFailureEvent } = require('../services/adminConfig');
const {
  beginStripeEvent, completeStripeEvent, failStripeEvent,
  beginDuffelEvent, completeDuffelEvent, failDuffelEvent,
} = require('../services/webhookEvents');

// [F5 · REPLAY-PROTECTION] Reject a signed webhook whose timestamp is more
// than this many seconds away from now (past OR future, to allow modest
// clock drift). A valid signature stays replayable forever without this —
// freshness + per-event de-duplication together close the replay window.
const MAX_WEBHOOK_AGE_SEC = 300;

module.exports = (app) => {

app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const secret = env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !secret) {
    log('error', 'webhook_not_configured', {});
    return res.status(500).send('webhook not configured');
  }

  let event;
  try {
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    log('warn', 'webhook_signature_invalid', { error: err.message });
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Acknowledge immediately so Stripe doesn't retry while we work
  res.json({ received: true });

  // [F3 · DURABILITY + DEDUP] Persist the event and skip it entirely if it
  // was already fully processed (a Stripe re-delivery of the same event id).
  // Falls back to best-effort (no store) when Supabase isn't configured.
  const evStore = await beginStripeEvent(event);
  if (evStore.alreadyProcessed) {
    log('info', 'stripe_webhook_duplicate_skipped', { event_id: event.id, type: event.type });
    return;
  }

  try {
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const session = event.data.object;
      // [PAYMENT-LIFECYCLE §16] With manual capture, checkout.session.completed
      // fires with the money only AUTHORIZED (session.payment_status is
      // typically 'unpaid', PaymentIntent in `requires_capture`) — NOT
      // captured. So we must not gate on payment_status === 'paid' here; a
      // completed session (status === 'complete') is the trigger to run the
      // booking. bookFromSession then revalidates, books Duffel and CAPTURES
      // the same PaymentIntent — this is the browser-independent recovery
      // path (§15): it completes the booking even if the customer closed the
      // tab. Idempotent + inFlight-guarded against the browser's
      // /confirm-payment running at the same time.
      const shouldBook = session.status === 'complete' || session.payment_status === 'paid';
      if (shouldBook) {
        if (inFlight.has(session.id)) return;
        inFlight.add(session.id);
        try {
          const out = await bookFromSession(session.id, session);
          log('info', 'webhook_booking_done', { session: session.id, order_id: out.order_id, already: out.already, payment_status: out.payment_status });
        } finally {
          inFlight.delete(session.id);
        }
        await completeStripeEvent(event.id);
      } else {
        // Session not complete (e.g. still awaiting an async method) — nothing
        // to book yet, but the event itself is handled.
        await completeStripeEvent(event.id);
      }
    } else if (event.type === 'payment_intent.canceled') {
      // Authorization was released (our cancel, or a Stripe auto-expiry).
      // Best-effort sync of the durable record; a booking may or may not exist.
      const pi = event.data.object;
      log('info', 'webhook_payment_intent_canceled', { payment_intent: pi.id, reason: pi.cancellation_reason || null });
      if (supa && pi.id) {
        try { await supa.from('bookings').update({ payment_status: 'authorization_cancelled', authorization_cancelled_at: new Date().toISOString() }).eq('payment_intent_id', pi.id).is('captured_at', null); } catch (_) { /* best-effort */ }
      }
      await completeStripeEvent(event.id);
    } else if (event.type === 'payment_intent.amount_capturable_updated') {
      // Authorization succeeded (money held, awaiting capture). Booking is
      // driven by checkout.session.completed; here we only acknowledge.
      const pi = event.data.object;
      log('info', 'PAYMENT_AUTHORIZED', { payment_intent: pi.id });
      await completeStripeEvent(event.id);
    } else if (event.type === 'payment_intent.payment_failed') {
      const pi = event.data.object;
      log('warn', 'webhook_payment_failed', { payment_intent: pi.id });
      await completeStripeEvent(event.id);
    } else {
      // Any other event type: acknowledged, nothing to do.
      await completeStripeEvent(event.id);
    }
  } catch (err) {
    // [F3] Mark durable so a reconciliation/worker job can retry only what
    // actually failed — instead of the failure being Sentry-only and lost.
    await failStripeEvent(event.id, err.message);
    // [PAYMENT-LIFECYCLE §13] Duffel booked but Stripe capture failed — a
    // handled manual-review outcome (bookFromSession already persisted the
    // record + alerted). NOT the "customer charged with no ticket" emergency,
    // and NOT a refund case (the money is still safely authorized).
    if (err.code === 'CAPTURE_FAILED_AFTER_BOOKING') {
      log('warn', 'webhook_capture_failed_manual_review', { type: event.type, order_id: err.order_id, booking_reference: err.booking_reference });
      return;
    }
    // [PRICE-DRIFT / AUTH-CANCEL] Pre-capture failure released the money the
    // safe way (cancelled authorization, or refunded for an immediate-capture
    // method) inside bookFromSession() before throwing — a handled, safe
    // outcome, not the "customer charged with no ticket" emergency below.
    if (err.code === 'PRICE_DRIFT') {
      log('warn', 'webhook_booking_blocked_price_drift', { type: event.type, message: err.message, drift: err.priceDrift, refunded: !!err.refunded, cancelled: !!err.cancelled });
      return;
    }
    // [PAYMENT-LIFECYCLE §8] Duffel failed pre-capture and the authorization
    // was cancelled — no money moved, a safe handled outcome, not the critical
    // emergency below.
    if (err.cancelled) {
      log('warn', 'webhook_booking_failed_authorization_released', { type: event.type, message: err.message, code: err.code });
      recordBookingFailureEvent({
        source: 'webhook', session_id: event.data && event.data.object && event.data.object.id,
        message: err.message, refunded: false, duffel_errors: err.details || null,
      });
      return;
    }
    // Booking failed after a paid webhook → log loudly for support follow-up
    log('error', 'webhook_booking_failed', { type: event.type, message: err.message, duffel_errors: err.details, refunded: err.refunded });
    console.error('[WEBHOOK BOOKING FAILED] ' + (err.message || '') + ' | refunded=' + (err.refunded ? 'yes' : 'no') + ' | ' + JSON.stringify(err.details || {}));
    recordBookingFailureEvent({
      source: 'webhook',
      session_id: event.data && event.data.object && event.data.object.id,
      message: err.message,
      refunded: !!err.refunded,
      duffel_errors: err.details || null,
    });
    if (env.SENTRY_DSN) {
      Sentry.captureException(err, {
        tags: { critical: 'booking_failed_after_payment', source: 'webhook', refunded: err.refunded ? 'true' : 'false' },
        extra: { event_type: event.type, duffel_errors: err.details },
      });
    }
  }
});

// ─── POST /webhooks/duffel ──────────────────────────────────
// [CANCEL-CONFIRM-100PCT-FIX] Independent, server-verified confirmation
// that a cancellation actually completed — separate from (not solely
// dependent on) the direct /cancel-confirm API call succeeding. Per
// Duffel's docs, the X-Duffel-Signature header has the format
// "t=<timestamp>,v1=<hex-hmac-sha256>", computed over "<timestamp>.<raw
// body>" using the webhook's signing secret (same general scheme as
// Stripe/Mux). Must run BEFORE express.json() below — signature
// verification needs the raw, unparsed body; if json() ran first here
// the body would already be a parsed object and every signature check
// would fail.
app.post('/webhooks/duffel', express.raw({ type: 'application/json' }), async (req, res) => {
  const secret = env.DUFFEL_WEBHOOK_SECRET;
  if (!secret) {
    log('error', 'duffel_webhook_not_configured', {});
    return res.status(500).send('webhook not configured');
  }

  try {
    const sigHeader = req.headers['x-duffel-signature'] || '';
    const parts = Object.fromEntries(sigHeader.split(',').map((p) => p.split('=')));
    const timestamp = parts.t;
    const signature = parts.v1;
    if (!timestamp || !signature) {
      log('warn', 'duffel_webhook_signature_missing', {});
      return res.status(400).send('Missing signature');
    }
    const expected = require('crypto').createHmac('sha256', secret).update(`${timestamp}.${req.body}`).digest('hex');
    const sigBuf = Buffer.from(signature, 'hex');
    const expBuf = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expBuf.length || !require('crypto').timingSafeEqual(sigBuf, expBuf)) {
      log('warn', 'duffel_webhook_signature_invalid', {});
      return res.status(400).send('Invalid signature');
    }
    // [F5 · REPLAY-PROTECTION] A valid signature alone is replayable
    // forever — reject a payload whose signed timestamp is too old/new.
    const tsSec = parseInt(timestamp, 10);
    const nowSec = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(tsSec) || Math.abs(nowSec - tsSec) > MAX_WEBHOOK_AGE_SEC) {
      log('warn', 'duffel_webhook_stale_timestamp', { timestamp });
      return res.status(400).send('Stale timestamp');
    }
  } catch (e) {
    log('warn', 'duffel_webhook_verify_error', { error: e.message });
    return res.status(400).send('Signature verification failed');
  }

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch (e) {
    return res.status(400).send('Invalid payload');
  }

  // Acknowledge immediately — Duffel retries failed deliveries for 72h on
  // a backoff, so we must not let slow downstream work (our own DB call)
  // risk a timeout that triggers an unnecessary retry storm.
  res.json({ received: true });

  // [F5 · DEDUP] Skip an event we've already fully processed (a Duffel
  // re-delivery, or a replayed-within-the-window payload). Best-effort when
  // Supabase isn't configured or the event carries no id.
  const evStore = await beginDuffelEvent(event);
  if (evStore.alreadyProcessed) {
    log('info', 'duffel_webhook_duplicate_skipped', { event_id: event.id, type: event.type });
    return;
  }

  try {
    if (event.type === 'order_cancellation.confirmed') {
      const cancellation = event.data?.object || {};
      // [CANCEL-CONFIRM-100PCT-FIX] order_id comes from Duffel's own
      // confirmed payload — the authoritative source, never trusted from
      // a request the frontend sent us.
      const orderId = cancellation.order_id;
      if (supa && orderId) {
        const { error } = await supa.from('bookings').update({ status: 'cancelled' }).eq('duffel_order_id', orderId);
        if (error) {
          log('error', 'duffel_webhook_cancel_sync_failed', { order_id: orderId, error: error.message });
        } else {
          log('info', 'duffel_webhook_cancel_confirmed', { order_id: orderId, refund_amount: cancellation.refund_amount });
        }
      }
    }
    await completeDuffelEvent(event.id);
  } catch (err) {
    await failDuffelEvent(event.id, err.message);
    log('error', 'duffel_webhook_processing_failed', { error: err.message, event_type: event.type });
    if (env.SENTRY_DSN) {
      Sentry.captureException(err, { tags: { critical: 'duffel_webhook_failed' }, extra: { event_type: event.type } });
    }
  }
});
};
