// ═══════════════════════════════════════════════════════════════
// src/services/finance/refunds.js
// [F-PHASE2 · REFUNDS] A refund is its OWN financial event, never an edit of
// the original booking (spec Phase 12). Records a `refunds` row + a
// financial_event, both idempotent on the Stripe refund id. The tax effect of
// the refund is NOT computed here — tax_adjustment_status stays REVIEW_REQUIRED
// until an approved rule exists (non-negotiable rules 9, 20).
// ═══════════════════════════════════════════════════════════════

const { recordEvent } = require('./financialEvents');
const { amountToMinor } = require('./moneyEngine');

// Record a refund. `input` accepts either minor units directly or a decimal
// `amount`. Returns { created, refund, event }.
async function recordRefund(input, deps = {}) {
  const { supa, log } = deps;
  if (!supa) return { created: false, refund: null, event: null, skipped: 'no_database' };

  const {
    bookingId = null, originalPaymentId = null, stripeRefundId = null,
    reason = null, refundType = 'FULL',
    amount = null, amountMinor = null, currency = 'EUR',
    customerRefundMinor = null, supplierRefundMinor = null, feeMinor = null,
    rate = null, rateSource = null, refundDate = null, createdBy = 'system',
  } = input;

  const origMinor = amountMinor != null ? Math.round(amountMinor)
    : (amount != null ? amountToMinor(amount, currency) : null);
  if (origMinor == null) throw new Error('recordRefund: amount or amountMinor required');

  // Idempotency: prefer the Stripe refund id; fall back to a composite key.
  const idem = stripeRefundId
    ? `refund:${stripeRefundId}`
    : `refund:${bookingId || 'nobk'}:${origMinor}:${currency}:${refundDate || 'nd'}`;

  // 1) financial_event (immutable source fact)
  const { created, event } = await recordEvent({
    idempotencyKey: idem,
    eventType: 'refund',
    sourceType: 'stripe',
    sourceId: stripeRefundId,
    bookingId,
    paymentId: originalPaymentId,
    amountMinor: origMinor,
    currency,
    rate, rateSource,
    occurredAt: refundDate,
    payload: { reason, refundType },
    createdBy,
  }, deps);

  // 2) refunds row (skip if the event was a duplicate — already recorded)
  if (!created) {
    const { data: existing } = await supa.from('refunds').select('*').eq('idempotency_key', idem).maybeSingle();
    return { created: false, refund: existing || null, event };
  }

  const { data: refund, error } = await supa.from('refunds').insert({
    booking_id: bookingId,
    original_payment_id: originalPaymentId,
    stripe_refund_id: stripeRefundId,
    refund_reason: reason,
    refund_type: refundType,
    original_amount_minor: origMinor,
    original_currency: currency,
    customer_refund_minor: customerRefundMinor,
    supplier_refund_minor: supplierRefundMinor,
    fee_minor: feeMinor,
    accounting_amount_eur_minor: event ? event.accounting_amount_eur_minor : null,
    exchange_rate: event ? event.exchange_rate : null,
    exchange_rate_source: event ? event.exchange_rate_source : null,
    tax_adjustment_status: 'REVIEW_REQUIRED',   // never computed automatically
    financial_event_id: event ? event.id : null,
    refund_date: refundDate,
    idempotency_key: idem,
    status: 'RECORDED',
    created_by: createdBy,
  }).select().maybeSingle();

  if (error) {
    if (error.code === '23505') {
      const { data: existing } = await supa.from('refunds').select('*').eq('idempotency_key', idem).maybeSingle();
      return { created: false, refund: existing || null, event };
    }
    if (log) log('error', 'refund_insert_failed', { idem, error: error.message });
    throw new Error('refund insert failed: ' + error.message);
  }
  if (log) log('info', 'refund_recorded', { booking_id: bookingId, stripe_refund_id: stripeRefundId, amount_minor: origMinor });
  return { created: true, refund, event };
}

module.exports = { recordRefund };
