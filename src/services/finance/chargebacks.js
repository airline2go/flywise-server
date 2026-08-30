// ═══════════════════════════════════════════════════════════════
// src/services/finance/chargebacks.js
// [F-PHASE2 · CHARGEBACKS] A chargeback/dispute is its own financial record,
// never merely a negative booking (spec Phase 13). Idempotent on the Stripe
// dispute id. Tax treatment stays REVIEW_REQUIRED.
// ═══════════════════════════════════════════════════════════════

const { recordEvent } = require('./financialEvents');

async function recordChargeback(input, deps = {}) {
  const { supa, log } = deps;
  if (!supa) return { created: false, chargeback: null, event: null, skipped: 'no_database' };

  const {
    bookingId = null, stripeDisputeId = null, amountMinor = null, currency = 'EUR',
    feeMinor = null, status = null, reason = null, finalResult = null,
    recoveredAmountMinor = null, rate = null, rateSource = null, createdBy = 'system',
  } = input;

  if (amountMinor == null) throw new Error('recordChargeback: amountMinor required');
  const idem = stripeDisputeId ? `chargeback:${stripeDisputeId}` : `chargeback:${bookingId}:${amountMinor}:${currency}`;

  const { created, event } = await recordEvent({
    idempotencyKey: idem,
    eventType: 'chargeback',
    sourceType: 'stripe',
    sourceId: stripeDisputeId,
    bookingId,
    amountMinor: Math.round(amountMinor),
    currency, rate, rateSource,
    payload: { status, reason, finalResult },
    createdBy,
  }, deps);

  if (!created) {
    const { data: existing } = await supa.from('chargebacks').select('*').eq('idempotency_key', idem).maybeSingle();
    return { created: false, chargeback: existing || null, event };
  }

  const { data: chargeback, error } = await supa.from('chargebacks').insert({
    booking_id: bookingId,
    stripe_dispute_id: stripeDisputeId,
    amount_minor: Math.round(amountMinor),
    currency,
    fee_minor: feeMinor,
    status,
    recovered_amount_minor: recoveredAmountMinor,
    final_result: finalResult,
    tax_treatment_status: 'REVIEW_REQUIRED',
    financial_event_id: event ? event.id : null,
    idempotency_key: idem,
  }).select().maybeSingle();

  if (error) {
    if (error.code === '23505') {
      const { data: existing } = await supa.from('chargebacks').select('*').eq('idempotency_key', idem).maybeSingle();
      return { created: false, chargeback: existing || null, event };
    }
    if (log) log('error', 'chargeback_insert_failed', { idem, error: error.message });
    throw new Error('chargeback insert failed: ' + error.message);
  }
  if (log) log('info', 'chargeback_recorded', { booking_id: bookingId, stripe_dispute_id: stripeDisputeId });
  return { created: true, chargeback, event };
}

module.exports = { recordChargeback };
