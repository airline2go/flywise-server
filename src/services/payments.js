// ═══════════════════════════════════════════════════════════════
// src/services/payments.js
// [PAYMENT-LIFECYCLE] Stripe PaymentIntent lifecycle for the
// AUTHORIZE → BOOK → CAPTURE flow (brief §5–§14, §21):
//   - authorize:  the Checkout Session is created with capture_method
//                 'manual', so a completed checkout leaves the
//                 PaymentIntent in `requires_capture` (money is HELD,
//                 not taken).
//   - capture:    called ONLY after Duffel confirms the supplier
//                 booking. Idempotent + state-checked (§12).
//   - cancel:     called when the supplier booking fails BEFORE
//                 capture — releases the authorization. This is NOT a
//                 refund (§8): no money ever moved, so nothing is
//                 refunded (which would cost Stripe processing fees).
//
// Every operation is recorded durably in `payment_operations`
// (sql/payment_lifecycle.sql) so correctness never depends only on the
// in-memory `inFlight` Set (§21). All state constants live here so the
// route/service/webhook layers agree on one vocabulary (§6). No card
// data, tokens or PII is ever logged (§30).
// ═══════════════════════════════════════════════════════════════

const stripe = require('../clients/stripe');
const supa = require('../clients/supabase');
const log = require('../utils/log');
const Sentry = require('../clients/sentry');
const env = require('../config/env');

// ─── State machine vocabularies (brief §6) ──────────────────────
// Kept in exact sync with the CHECK constraints in
// sql/payment_lifecycle.sql — change both together.
const BOOKING_STATUS = {
  PENDING: 'pending',
  BOOKING_PENDING_SUPPLIER: 'booking_pending_supplier',
  BOOKING_CONFIRMED: 'booking_confirmed',
  BOOKING_FAILED: 'booking_failed',
  TICKETED: 'ticketed',
  CANCEL_REQUESTED: 'cancel_requested',
  CANCELLED: 'cancelled',
  MANUAL_REVIEW: 'manual_review_required',
};
const PAYMENT_STATUS = {
  PENDING: 'pending',
  AUTHORIZED: 'authorized',
  CAPTURE_PENDING: 'capture_pending',
  CAPTURED: 'captured',
  AUTHORIZATION_CANCELLED: 'authorization_cancelled',
  CAPTURE_FAILED: 'capture_failed',
  AUTHORIZATION_EXPIRED: 'authorization_expired',
  REFUND_PENDING: 'refund_pending',
  REFUNDED: 'refunded',
  MANUAL_REVIEW: 'manual_review_required',
};
const SUPPLIER_STATUS = {
  PENDING: 'pending',
  REVALIDATED: 'revalidated',
  BOOKING_REQUESTED: 'booking_requested',
  BOOKED: 'booked',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

// Stripe-accepted PaymentIntent.cancel() reasons.
const CANCELLATION_REASONS = ['duplicate', 'fraudulent', 'requested_by_customer', 'abandoned'];

// A manual-capture card authorization is typically valid ~7 days before
// Stripe auto-expires it (transitions the PI to `canceled`). We store an
// approximate expiry for operational visibility (§14) — the live PI status
// remains the source of truth for whether it is actually still capturable.
const AUTHORIZATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function errorWithCode(message, code, extra) {
  const e = new Error(message);
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

// ─── PaymentIntent helpers ──────────────────────────────────────
function getPaymentIntentId(session) {
  if (!session) return null;
  const pi = session.payment_intent;
  if (!pi) return null;
  return typeof pi === 'string' ? pi : (pi.id || null);
}
function piIsAuthorized(pi) { return !!pi && pi.status === 'requires_capture'; }
function piIsCaptured(pi) { return !!pi && pi.status === 'succeeded'; }
function piIsCancelled(pi) { return !!pi && pi.status === 'canceled'; }

async function retrievePaymentIntent(paymentIntentId) {
  if (!stripe || !paymentIntentId) return null;
  return stripe.paymentIntents.retrieve(paymentIntentId);
}

function authorizationExpiresAt(pi) {
  // Stripe doesn't expose an explicit auth-expiry field for card PIs, so
  // approximate from the PI creation time when available.
  const createdSec = pi && pi.created ? Number(pi.created) : null;
  const base = createdSec ? createdSec * 1000 : Date.now();
  return new Date(base + AUTHORIZATION_TTL_MS).toISOString();
}

// ─── Durable operation records (brief §21) ──────────────────────
async function recordOperation(sessionId, operation, fields) {
  if (!supa || !sessionId) return;
  try {
    await supa.from('payment_operations').upsert(Object.assign({
      session_id: sessionId,
      operation,
      updated_at: new Date().toISOString(),
    }, fields || {}), { onConflict: 'session_id,operation' });
  } catch (e) {
    log('warn', 'payment_operation_record_failed', { operation, error: e.message });
  }
}
async function getOperation(sessionId, operation) {
  if (!supa || !sessionId) return null;
  try {
    const { data } = await supa.from('payment_operations')
      .select('*').eq('session_id', sessionId).eq('operation', operation).maybeSingle();
    return data || null;
  } catch (e) {
    log('warn', 'payment_operation_get_failed', { operation, error: e.message });
    return null;
  }
}

// ─── Capture (idempotent, state-checked — brief §12/§13) ────────
// GOLDEN RULE (§7): only ever called AFTER a confirmed Duffel booking.
// Returns { captured, alreadyCaptured, pi }. Throws a classified error
// (code CAPTURE_FAILED / CAPTURE_ON_CANCELLED / CAPTURE_UNEXPECTED_STATE)
// otherwise — the caller must move to a manual-review/recovery state, NOT
// blindly retry or refund.
async function captureAuthorizedPayment(paymentIntentId, opts = {}) {
  const { sessionId } = opts;
  if (!stripe) throw errorWithCode('Stripe ist nicht konfiguriert', 'STRIPE_NOT_CONFIGURED');
  if (!paymentIntentId) throw errorWithCode('PaymentIntent fehlt', 'NO_PAYMENT_INTENT');

  const prior = await getOperation(sessionId, 'capture');
  let pi = await stripe.paymentIntents.retrieve(paymentIntentId);
  log('info', 'PAYMENT_CAPTURE_STARTED', { session_id: sessionId, payment_intent_id: paymentIntentId, pi_status: pi.status });

  // Already captured (idempotent) — a prior capture, OR an immediate-capture
  // payment method that never entered `requires_capture` at all.
  if (pi.status === 'succeeded') {
    await recordOperation(sessionId, 'capture', {
      payment_intent_id: paymentIntentId, status: 'success',
      attempts: prior && prior.status === 'success' ? prior.attempts : ((prior ? prior.attempts : 0) + 1),
      amount_minor: pi.amount_received != null ? pi.amount_received : pi.amount,
      currency: pi.currency ? pi.currency.toUpperCase() : null,
    });
    return { captured: true, alreadyCaptured: true, pi };
  }
  // Authorization was cancelled/expired — capturing is impossible.
  if (pi.status === 'canceled') {
    throw errorWithCode('Autorisierung wurde storniert — Erfassung nicht möglich', 'CAPTURE_ON_CANCELLED', { piStatus: 'canceled' });
  }
  // Anything other than requires_capture is unexpected — do not guess (§12).
  if (pi.status !== 'requires_capture') {
    throw errorWithCode('Unerwarteter Zahlungsstatus für Erfassung: ' + pi.status, 'CAPTURE_UNEXPECTED_STATE', { piStatus: pi.status });
  }

  const attempts = (prior ? prior.attempts : 0) + 1;
  await recordOperation(sessionId, 'capture', { payment_intent_id: paymentIntentId, status: 'pending', attempts });
  try {
    // Stable idempotency key: browser + webhook capturing the same session
    // concurrently collapse to one Stripe capture, never two.
    pi = await stripe.paymentIntents.capture(paymentIntentId, {}, { idempotencyKey: 'capture_' + (sessionId || paymentIntentId) });
  } catch (err) {
    await recordOperation(sessionId, 'capture', {
      payment_intent_id: paymentIntentId, status: 'failed', attempts,
      stripe_error_code: err.code || null, last_error: String(err.message || '').slice(0, 500),
    });
    log('error', 'PAYMENT_CAPTURE_FAILED', { session_id: sessionId, payment_intent_id: paymentIntentId, stripe_code: err.code || null });
    throw errorWithCode(err.message || 'Erfassung fehlgeschlagen', 'CAPTURE_FAILED', { stripeCode: err.code || null, attempts });
  }
  if (pi.status !== 'succeeded') {
    await recordOperation(sessionId, 'capture', { payment_intent_id: paymentIntentId, status: 'failed', attempts, last_error: 'post_capture_status_' + pi.status });
    log('error', 'PAYMENT_CAPTURE_FAILED', { session_id: sessionId, payment_intent_id: paymentIntentId, pi_status: pi.status });
    throw errorWithCode('Erfassung nicht erfolgreich: ' + pi.status, 'CAPTURE_NOT_SUCCEEDED', { piStatus: pi.status, attempts });
  }
  await recordOperation(sessionId, 'capture', {
    payment_intent_id: paymentIntentId, status: 'success', attempts,
    amount_minor: pi.amount_received != null ? pi.amount_received : pi.amount,
    currency: pi.currency ? pi.currency.toUpperCase() : null,
  });
  log('info', 'PAYMENT_CAPTURE_SUCCESS', { session_id: sessionId, payment_intent_id: paymentIntentId, amount_minor: pi.amount_received });
  return { captured: true, alreadyCaptured: false, pi };
}

// ─── Cancel authorization (idempotent — brief §8) ───────────────
// Releases a held authorization when the supplier booking fails BEFORE
// capture. NOT a refund. Returns:
//   { cancelled:true }               — released (or already released)
//   { cannotCancel:true, pi }        — money already captured; caller must
//                                      decide a real refund instead (§23)
//   { skipped:true }                 — no Stripe / no PI to act on
async function cancelAuthorization(paymentIntentId, opts = {}) {
  const { sessionId, reason } = opts;
  if (!stripe || !paymentIntentId) return { cancelled: false, skipped: true };

  const prior = await getOperation(sessionId, 'cancel');
  let pi;
  try {
    pi = await stripe.paymentIntents.retrieve(paymentIntentId);
  } catch (e) {
    log('warn', 'cancel_pi_retrieve_failed', { session_id: sessionId, error: e.message });
    throw errorWithCode(e.message || 'PaymentIntent retrieve failed', 'CANCEL_RETRIEVE_FAILED');
  }
  log('info', 'PAYMENT_AUTHORIZATION_CANCEL_STARTED', { session_id: sessionId, payment_intent_id: paymentIntentId, pi_status: pi.status, reason: reason || null });

  if (pi.status === 'canceled') {
    await recordOperation(sessionId, 'cancel', { payment_intent_id: paymentIntentId, status: 'success', attempts: prior ? prior.attempts : 0 });
    return { cancelled: true, alreadyCancelled: true, pi };
  }
  if (pi.status === 'succeeded') {
    // The money was actually captured — an authorization cancel is impossible.
    // Surface this so the caller can enter manual review / a real refund (§13/§23).
    return { cancelled: false, cannotCancel: true, pi };
  }

  const attempts = (prior ? prior.attempts : 0) + 1;
  await recordOperation(sessionId, 'cancel', { payment_intent_id: paymentIntentId, status: 'pending', attempts });
  try {
    const params = reason && CANCELLATION_REASONS.includes(reason) ? { cancellation_reason: reason } : { cancellation_reason: 'abandoned' };
    pi = await stripe.paymentIntents.cancel(paymentIntentId, params);
  } catch (err) {
    // A concurrent cancel may have already transitioned it — treat as success.
    try {
      const fresh = await stripe.paymentIntents.retrieve(paymentIntentId);
      if (fresh && fresh.status === 'canceled') {
        await recordOperation(sessionId, 'cancel', { payment_intent_id: paymentIntentId, status: 'success', attempts });
        return { cancelled: true, alreadyCancelled: true, pi: fresh };
      }
    } catch (_) { /* fall through to failure */ }
    await recordOperation(sessionId, 'cancel', {
      payment_intent_id: paymentIntentId, status: 'failed', attempts,
      stripe_error_code: err.code || null, last_error: String(err.message || '').slice(0, 500),
    });
    throw errorWithCode(err.message || 'Stornierung fehlgeschlagen', 'CANCEL_FAILED', { stripeCode: err.code || null });
  }
  await recordOperation(sessionId, 'cancel', { payment_intent_id: paymentIntentId, status: 'success', attempts });
  log('info', 'PAYMENT_AUTHORIZATION_CANCELLED', { session_id: sessionId, payment_intent_id: paymentIntentId });
  return { cancelled: true, alreadyCancelled: false, pi };
}

// ─── Operational alerting (brief §31) ───────────────────────────
// Routes a dangerous state to Sentry (already wired) AND emits a structured
// error log. The queryable manual_review_required booking_status (set by the
// caller) is the durable, admin-visible half of the alert.
// ─── Reconciliation: lifecycle-mismatch detector (brief §32) ────
// Pure, DB-free classifier for a single booking's cross-system state. Returns
// null when the booking is internally consistent, otherwise a finding
// { code, severity, manualReview, reason }. It NEVER books, captures, cancels
// or refunds anything and NEVER implies creating a second supplier booking —
// it only decides whether a human must look (§32: unsafe cases → manual
// review). The caller persists / alerts on the finding.
function detectLifecycleMismatch(b, nowMs) {
  b = b || {};
  const now = nowMs || Date.now();
  const hasOrder = !!b.duffel_order_id;
  const ps = b.payment_status || null;
  const captured = ps === PAYMENT_STATUS.CAPTURED;

  // CASE E: the same Airpiv booking mapped to more than one supplier order.
  if (b.duffel_order_count != null && Number(b.duffel_order_count) > 1) {
    return { code: 'DUPLICATE_SUPPLIER_ORDER', severity: 'CRITICAL', manualReview: true, reason: 'multiple_duffel_orders' };
  }
  // CASE A: supplier order exists but the money was never captured.
  if (hasOrder && !captured && ps !== PAYMENT_STATUS.REFUNDED) {
    return { code: 'ORDER_WITHOUT_CAPTURE', severity: 'CRITICAL', manualReview: true, reason: 'duffel_order_but_payment_' + (ps || 'unknown') };
  }
  // CASE B: money captured but the booking never reached a confirmed state.
  if (captured && b.booking_status && b.booking_status !== BOOKING_STATUS.BOOKING_CONFIRMED
      && b.booking_status !== BOOKING_STATUS.TICKETED && b.booking_status !== BOOKING_STATUS.CANCELLED) {
    return { code: 'CAPTURE_WITHOUT_CONFIRMED_BOOKING', severity: 'CRITICAL', manualReview: true, reason: 'captured_but_' + b.booking_status };
  }
  // CASE C: an authorization is still open and getting old with no booking.
  if (ps === PAYMENT_STATUS.AUTHORIZED && !hasOrder && b.authorization_expires_at
      && new Date(b.authorization_expires_at).getTime() < now) {
    return { code: 'AUTHORIZATION_EXPIRED_ABANDONED', severity: 'REVIEW', manualReview: true, reason: 'authorization_expired_no_order' };
  }
  // Already-flagged terminal review states (capture failure etc.).
  if (b.booking_status === BOOKING_STATUS.MANUAL_REVIEW || ps === PAYMENT_STATUS.CAPTURE_FAILED || ps === PAYMENT_STATUS.MANUAL_REVIEW) {
    return { code: 'MANUAL_REVIEW_FLAGGED', severity: 'REVIEW', manualReview: true, reason: 'already_flagged' };
  }
  return null;
}

function alertCritical(tag, err, extra) {
  const e = err instanceof Error ? err : new Error(String(err || tag));
  try {
    if (env.SENTRY_DSN) Sentry.captureException(e, { tags: { critical: tag }, extra: extra || {} });
  } catch (_) { /* alerting must never throw */ }
  log('error', tag, Object.assign({ message: e.message }, extra || {}));
}

module.exports = {
  BOOKING_STATUS, PAYMENT_STATUS, SUPPLIER_STATUS, CANCELLATION_REASONS,
  errorWithCode,
  getPaymentIntentId, retrievePaymentIntent,
  piIsAuthorized, piIsCaptured, piIsCancelled, authorizationExpiresAt,
  recordOperation, getOperation,
  captureAuthorizedPayment, cancelAuthorization,
  detectLifecycleMismatch,
  alertCritical,
};
