// ═══════════════════════════════════════════════════════════════
// src/services/finance/stripeSync.js
// [F-PHASE2 · STRIPE SYNC] Imports Stripe balance transactions, fees, payouts,
// refunds and disputes into the finance tables (spec Phase 10). Every record
// is idempotent on its Stripe id. A Stripe FEE is stored as a fee and emitted
// as a `stripe_fee` financial event — it is NEVER treated as VAT (non-
// negotiable rule 11); its tax treatment is left to the Tax Engine.
//
// Pure mappers (mapBalanceTxn/mapPayout) are unit-tested without network. The
// `syncStripe` driver pages the Balance Transactions API and persists. It
// no-ops cleanly when the Stripe client is absent (same guard as the rest of
// the codebase).
// ═══════════════════════════════════════════════════════════════

const { recordEvent } = require('./financialEvents');
const { recordRefund } = require('./refunds');
const { recordChargeback } = require('./chargebacks');

// Map a Stripe balance transaction to our stripe_transactions row shape.
// Amounts from Stripe are already in minor units.
function mapBalanceTxn(bt) {
  return {
    stripe_id: bt.id,
    type: bt.type,                         // charge|refund|payout|adjustment|stripe_fee|...
    source_id: typeof bt.source === 'string' ? bt.source : (bt.source && bt.source.id) || null,
    gross_minor: bt.amount != null ? Number(bt.amount) : null,
    fee_minor: bt.fee != null ? Number(bt.fee) : null,
    net_minor: bt.net != null ? Number(bt.net) : null,
    currency: bt.currency ? String(bt.currency).toUpperCase() : null,
    exchange_rate: bt.exchange_rate != null ? Number(bt.exchange_rate) : null,
    exchange_rate_source: 'STRIPE',
    payout_id: typeof bt.payout === 'string' ? bt.payout : (bt.payout && bt.payout.id) || null,
    available_on: bt.available_on ? new Date(bt.available_on * 1000).toISOString() : null,
    stripe_created_at: bt.created ? new Date(bt.created * 1000).toISOString() : null,
    payload: bt,
  };
}

function mapPayout(po) {
  return {
    stripe_id: po.id,
    amount_minor: po.amount != null ? Number(po.amount) : null,
    currency: po.currency ? String(po.currency).toUpperCase() : null,
    status: po.status,
    arrival_date: po.arrival_date ? new Date(po.arrival_date * 1000).toISOString() : null,
    stripe_created_at: po.created ? new Date(po.created * 1000).toISOString() : null,
    bank_reference: po.statement_descriptor || null,
    payload: po,
  };
}

// Upsert one balance transaction + its fee details + a financial event.
async function persistBalanceTxn(bt, deps) {
  const { supa, log } = deps;
  const row = mapBalanceTxn(bt);
  const { data: tx, error } = await supa.from('stripe_transactions')
    .upsert(row, { onConflict: 'stripe_id', ignoreDuplicates: true })
    .select().maybeSingle();
  if (error && error.code !== '23505') {
    if (log) log('error', 'stripe_txn_upsert_failed', { id: bt.id, error: error.message });
    return { persisted: false };
  }

  // Fee detail lines (bt.fee_details[]) → stripe_fees (idempotent per line).
  for (const fd of (bt.fee_details || [])) {
    const feeKey = `stripefee:${bt.id}:${fd.type}:${fd.amount}:${fd.description || ''}`;
    await supa.from('stripe_fees').insert({
      stripe_transaction_id: tx ? tx.id : null,
      stripe_balance_txn_id: bt.id,
      fee_type: fd.type,
      description: fd.description || null,
      amount_minor: Number(fd.amount) || 0,
      currency: fd.currency ? String(fd.currency).toUpperCase() : null,
      idempotency_key: feeKey,
    }).then(() => {}, (e) => { if (e.code !== '23505' && log) log('warn', 'stripe_fee_insert_failed', { error: e.message }); });
  }

  // Emit the Stripe fee as its OWN financial event (fee, not VAT).
  if (row.fee_minor && row.fee_minor > 0) {
    await recordEvent({
      idempotencyKey: `stripe_fee:${bt.id}`,
      eventType: 'stripe_fee',
      sourceType: 'stripe',
      sourceId: bt.id,
      amountMinor: row.fee_minor,
      currency: row.currency || 'EUR',
      payload: { balance_transaction: bt.id },
      createdBy: 'system:stripe_sync',
    }, deps).catch((e) => { if (log) log('warn', 'stripe_fee_event_failed', { error: e.message }); });
  }
  return { persisted: true, tx };
}

// Full sync driver. opts: { created_gte (unix secs), limit }. Requires
// deps.stripe (the Stripe client) and deps.supa.
async function syncStripe(deps = {}, opts = {}) {
  const { stripe, supa, log } = deps;
  if (!stripe || !supa) return { ran: false, reason: 'stripe_or_db_unavailable' };

  const summary = { balance_transactions: 0, payouts: 0, refunds: 0, disputes: 0 };
  const params = { limit: opts.limit || 100 };
  if (opts.created_gte) params.created = { gte: opts.created_gte };

  // Balance transactions (the money-movement backbone) with auto-pagination.
  for await (const bt of stripe.balanceTransactions.list(params)) {
    await persistBalanceTxn(bt, deps);
    summary.balance_transactions++;
    if (bt.type === 'refund') {
      const src = typeof bt.source === 'string' ? bt.source : (bt.source && bt.source.id);
      await recordRefund({
        stripeRefundId: src, amountMinor: Math.abs(Number(bt.amount) || 0),
        currency: (bt.currency || 'eur').toUpperCase(),
        refundDate: bt.created ? new Date(bt.created * 1000).toISOString() : null,
        createdBy: 'system:stripe_sync',
      }, deps).then((r) => { if (r.created) summary.refunds++; }, () => {});
    }
  }

  // Payouts.
  for await (const po of stripe.payouts.list({ limit: opts.limit || 100 })) {
    await supa.from('stripe_payouts')
      .upsert(mapPayout(po), { onConflict: 'stripe_id', ignoreDuplicates: true })
      .then(() => { summary.payouts++; }, () => {});
  }

  // Disputes / chargebacks.
  for await (const dp of stripe.disputes.list({ limit: opts.limit || 100 })) {
    await recordChargeback({
      stripeDisputeId: dp.id,
      amountMinor: Number(dp.amount) || 0,
      currency: (dp.currency || 'eur').toUpperCase(),
      status: dp.status, reason: dp.reason,
      finalResult: dp.status === 'won' ? 'won' : (dp.status === 'lost' ? 'lost' : null),
      createdBy: 'system:stripe_sync',
    }, deps).then((r) => { if (r.created) summary.disputes++; }, () => {});
  }

  if (log) log('info', 'stripe_sync_done', summary);
  return { ran: true, summary };
}

module.exports = { mapBalanceTxn, mapPayout, persistBalanceTxn, syncStripe };
