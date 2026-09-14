'use strict';

/**
 * Durable persistence for a completed supplier booking + Stripe payment.
 *
 * Financial rule: after Duffel succeeds and Stripe capture succeeds, database
 * persistence is mandatory. Writes are awaited and idempotent. Callers should
 * put the transaction into manual review if this helper throws; do not blindly
 * refund a supplier booking that has already been created.
 */

async function persistCompletedBooking({ supa, sessionId, paymentIntentId, payment, booking }) {
  if (!supa) throw new Error('SUPABASE_UNAVAILABLE');
  if (!sessionId) throw new Error('SESSION_ID_REQUIRED');

  const paymentPayload = Object.assign({}, payment, {
    stripe_session_id: sessionId,
    stripe_payment_id: paymentIntentId || payment?.stripe_payment_id || null,
    payment_intent_id: paymentIntentId || payment?.payment_intent_id || null,
  });

  const { error: paymentError } = await supa
    .from('payments')
    .upsert(paymentPayload, { onConflict: 'stripe_payment_id' });

  if (paymentError) {
    const err = new Error(`PAYMENT_PERSISTENCE_FAILED: ${paymentError.message}`);
    err.cause = paymentError;
    throw err;
  }

  const bookingPayload = Object.assign({}, booking, {
    stripe_session_id: sessionId,
    stripe_payment_id: paymentIntentId || booking?.stripe_payment_id || null,
    payment_intent_id: paymentIntentId || booking?.payment_intent_id || null,
  });

  const { error: bookingError } = await supa
    .from('bookings')
    .upsert(bookingPayload, { onConflict: 'stripe_session_id' });

  if (bookingError) {
    const err = new Error(`BOOKING_PERSISTENCE_FAILED: ${bookingError.message}`);
    err.cause = bookingError;
    throw err;
  }

  return { persisted: true };
}

module.exports = { persistCompletedBooking };
