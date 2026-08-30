// ═══════════════════════════════════════════════════════════════
// src/services/finance/financeJobs.js
// [F-PHASE4 · JOBS] The concrete finance sync/reconciliation/integrity jobs,
// each idempotent and callable from BOTH the cron scheduler and the manual
// admin API. Every job returns { records_processed, records_failed, summary }.
// None of them activates a tax rule or computes a production VAT figure —
// unclassified items stay REVIEW_REQUIRED (spec stop condition).
// ═══════════════════════════════════════════════════════════════

const { syncStripe } = require('./stripeSync');
const { reconcileBooking } = require('./reconciliation');

// 1–5) Stripe sync: balance transactions, fees, refunds, disputes, payouts.
async function jobStripeSync(deps, opts = {}) {
  const { stripe, supa } = deps;
  if (!stripe || !supa) return { skipped: true, summary: { reason: 'stripe_or_db_unavailable' } };
  const out = await syncStripe(deps, { created_gte: opts.created_gte, limit: opts.limit || 100 });
  const s = out.summary || {};
  return {
    records_processed: (s.balance_transactions || 0) + (s.payouts || 0) + (s.refunds || 0) + (s.disputes || 0),
    records_failed: 0,
    summary: s,
  };
}

// 6–7) Duffel invoice sync. Duffel exposes no generic invoices-list API here;
// invoices are ingested via duffelSync.ingestInvoice() from an upload/export.
// This job drains a `duffel_invoice_inbox` staging table if present, else
// no-ops honestly (never fabricates supplier invoices).
async function jobDuffelSync(deps) {
  const { supa, log } = deps;
  if (!supa) return { skipped: true, summary: { reason: 'no_db' } };
  const { data: inbox, error } = await supa
    .from('duffel_invoice_inbox').select('*').eq('status', 'PENDING').limit(50);
  if (error) return { skipped: true, summary: { reason: 'no_inbox_table' } };  // table optional
  if (!inbox || !inbox.length) return { records_processed: 0, records_failed: 0, summary: { ingested: 0 } };
  const { ingestInvoice } = require('./duffelSync');
  let ingested = 0, failed = 0;
  for (const row of inbox) {
    try {
      await ingestInvoice(row.payload || row, deps);
      await supa.from('duffel_invoice_inbox').update({ status: 'INGESTED' }).eq('id', row.id);
      ingested++;
    } catch (e) { failed++; if (log) log('warn', 'duffel_inbox_ingest_failed', { id: row.id, error: e.message }); }
  }
  return { records_processed: ingested, records_failed: failed, summary: { ingested, failed } };
}

// 8–10) Reconciliation over recent bookings (booking↔stripe↔duffel).
async function jobReconcileBookings(deps, opts = {}) {
  const { supa } = deps;
  if (!supa) return { skipped: true, summary: { reason: 'no_db' } };
  const limit = opts.limit || 200;
  const { data: bookings } = await supa
    .from('bookings').select('id').order('created_at', { ascending: false }).limit(limit);
  let matches = 0, exceptions = 0, processed = 0;
  for (const b of (bookings || [])) {
    const r = await reconcileBooking(b.id, deps);
    matches += r.matches; exceptions += r.exceptions; processed++;
  }
  return { records_processed: processed, records_failed: 0, summary: { bookings: processed, matches, exceptions } };
}

// 11) Tax exception detection: any recorded event still REVIEW_REQUIRED with no
// tax_transaction and no open exception gets a TAX_REVIEW exception. Never
// classifies — only flags for the accountant queue.
async function jobTaxExceptionDetection(deps, opts = {}) {
  const { supa } = deps;
  if (!supa) return { skipped: true, summary: { reason: 'no_db' } };
  const limit = opts.limit || 500;
  const { data: events } = await supa
    .from('financial_events').select('id, booking_id, review_status')
    .eq('review_status', 'REVIEW_REQUIRED').limit(limit);
  let created = 0;
  for (const ev of (events || [])) {
    const { data: existing } = await supa.from('tax_exceptions')
      .select('id').eq('financial_event_id', ev.id).eq('status', 'OPEN').maybeSingle();
    if (existing) continue;
    const { error } = await supa.from('tax_exceptions').insert({
      exception_type: 'TAX_REVIEW_REQUIRED',
      entity_type: 'financial_event', entity_id: ev.id,
      financial_event_id: ev.id, booking_id: ev.booking_id,
      severity: 'REVIEW', details: { reason: 'unclassified_event' },
    });
    if (!error) created++;
  }
  return { records_processed: events ? events.length : 0, records_failed: 0, summary: { exceptions_created: created } };
}

// 12) Ledger integrity check: every POSTED entry must balance in EUR. The DB
// triggers already enforce this at post time; this job is the daily audit that
// proves it and surfaces any anomaly (spec Phase 36 #1/#8).
async function jobLedgerIntegrityCheck(deps) {
  const { supa, log } = deps;
  if (!supa) return { skipped: true, summary: { reason: 'no_db' } };
  const { data: entries } = await supa
    .from('journal_entries').select('id, status').eq('status', 'POSTED');
  let checked = 0, imbalanced = 0;
  for (const e of (entries || [])) {
    const { data: lines } = await supa
      .from('journal_lines').select('debit_eur_minor, credit_eur_minor').eq('journal_entry_id', e.id);
    const debit = (lines || []).reduce((s, l) => s + Number(l.debit_eur_minor || 0), 0);
    const credit = (lines || []).reduce((s, l) => s + Number(l.credit_eur_minor || 0), 0);
    checked++;
    if (debit !== credit) {
      imbalanced++;
      if (log) log('error', 'ledger_integrity_imbalance', { entry: e.id, debit, credit });
      await supa.from('reconciliation_exceptions').insert({
        exception_type: 'LEDGER_IMBALANCE', source: 'ledger', source_id: e.id,
        difference_minor: debit - credit, severity: 'CRITICAL', status: 'OPEN',
        details: { debit, credit },
      }).then(() => {}, () => {});
    }
  }
  return { records_processed: checked, records_failed: imbalanced, summary: { checked, imbalanced } };
}

// Registry — name → fn(deps, opts). Used by both cron and the manual API.
const JOBS = {
  stripe_sync: jobStripeSync,
  duffel_sync: jobDuffelSync,
  reconcile_bookings: jobReconcileBookings,
  tax_exception_detection: jobTaxExceptionDetection,
  ledger_integrity_check: jobLedgerIntegrityCheck,
};

module.exports = {
  JOBS,
  jobStripeSync, jobDuffelSync, jobReconcileBookings,
  jobTaxExceptionDetection, jobLedgerIntegrityCheck,
};
