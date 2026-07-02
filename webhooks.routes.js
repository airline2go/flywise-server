// ═══════════════════════════════════════════════════════════════
// src/routes/webhooks.routes.js
// [مهم جداً] لازم تتركب في server.js بـ express.raw() و **قبل**
// app.use(express.json()) العام — التحقق من التوقيع محتاج الجسم
// الخام (raw) للطلب، ولو json() اشتغل الأول هيبقى الجسم object
// متحلل بالفعل وأي تحقق توقيع هيفشل تلقائياً.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const env = require('./env');
const log = require('./log');
const Sentry = require('./sentry');
const stripe = require('./stripe');
const supa = require('./supabase');
const { bookFromSession, inFlight } = require('./booking');
const { recordBookingFailureEvent } = require('./adminConfig');

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

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      if (session.payment_status === 'paid') {
        if (inFlight.has(session.id)) return; // /confirm-payment is already handling it
        inFlight.add(session.id);
        try {
          const out = await bookFromSession(session.id, session);
          log('info', 'webhook_booking_done', { session: session.id, order_id: out.order_id, already: out.already });
        } finally {
          inFlight.delete(session.id);
        }
      }
    } else if (event.type === 'payment_intent.payment_failed') {
      const pi = event.data.object;
      log('warn', 'webhook_payment_failed', { payment_intent: pi.id });
    }
  } catch (err) {
    // [PRICE-DRIFT-PROTECTION] Already refunded in full inside
    // bookFromSession() before throwing — a handled, safe outcome, not
    // the "customer charged with no ticket" emergency the Sentry alert
    // below exists for.
    if (err.code === 'PRICE_DRIFT') {
      log('warn', 'webhook_booking_blocked_price_drift', { type: event.type, message: err.message, drift: err.priceDrift });
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
  } catch (err) {
    log('error', 'duffel_webhook_processing_failed', { error: err.message, event_type: event.type });
    if (env.SENTRY_DSN) {
      Sentry.captureException(err, { tags: { critical: 'duffel_webhook_failed' }, extra: { event_type: event.type } });
    }
  }
});
};
