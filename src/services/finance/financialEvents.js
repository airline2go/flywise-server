// ═══════════════════════════════════════════════════════════════
// src/services/finance/financialEvents.js
// [F-PHASE2 · EVENTS] Records the immutable source facts every accounting
// entry derives from. The idempotency_key UNIQUE constraint (07/02) makes a
// re-delivered Stripe/Duffel webhook a no-op instead of a duplicate financial
// record (spec Phase 35). Classification is attached but NEVER guessed —
// business_role and tax treatment default REVIEW_REQUIRED until approved.
// ═══════════════════════════════════════════════════════════════

const { buildMoney } = require('./moneyEngine');

// Insert-or-ignore a financial event by idempotency key. Returns
// { created, event } — created=false means the key already existed.
async function recordEvent(input, deps = {}) {
  const { supa, log } = deps;
  if (!supa) return { created: false, event: null, skipped: 'no_database' };
  const {
    idempotencyKey, eventType, sourceType, sourceId = null,
    bookingId = null, paymentId = null, customerId = null, supplierId = null,
    amountMinor, currency, rate = null, rateSource = null, rateTimestamp = null, method = null,
    businessRole = 'REVIEW_REQUIRED', occurredAt = null, payload = null, createdBy = 'system',
  } = input;

  if (!idempotencyKey) throw new Error('recordEvent: idempotencyKey is required');
  const money = buildMoney({ amountMinor, currency, rate, rateSource, rateTimestamp, method });

  const row = {
    event_type: eventType,
    source_type: sourceType,
    source_id: sourceId,
    idempotency_key: idempotencyKey,
    booking_id: bookingId,
    payment_id: paymentId,
    customer_id: customerId,
    supplier_id: supplierId,
    occurred_at: occurredAt || new Date().toISOString(),
    original_amount_minor: money.original_amount_minor,
    original_currency: money.original_currency,
    accounting_amount_eur_minor: money.accounting_amount_eur_minor,
    exchange_rate: money.exchange_rate,
    exchange_rate_source: money.exchange_rate_source,
    exchange_rate_timestamp: money.exchange_rate_timestamp,
    conversion_method: money.conversion_method,
    business_role: businessRole,
    review_status: 'REVIEW_REQUIRED',
    status: 'RECORDED',
    payload,
    created_by: createdBy,
  };

  // Insert; on unique conflict, fetch the existing row so callers always get one.
  const { data, error } = await supa
    .from('financial_events')
    .insert(row)
    .select()
    .maybeSingle();

  if (error) {
    if (error.code === '23505') {   // duplicate idempotency_key → already recorded
      const { data: existing } = await supa
        .from('financial_events').select('*').eq('idempotency_key', idempotencyKey).maybeSingle();
      return { created: false, event: existing || null };
    }
    if (log) log('error', 'financial_event_insert_failed', { key: idempotencyKey, error: error.message });
    throw new Error('financial_event insert failed: ' + error.message);
  }
  return { created: true, event: data };
}

module.exports = { recordEvent };
