// ═══════════════════════════════════════════════════════════════
// src/routes/admin-finance.routes.js
// [F-PHASE3 · FINANCE API] Wires the Phase 2 finance services + Phase 1/2
// tables to admin HTTP routes. Reads are requireAdmin; money-moving / manual
// job / classification actions are requireFullAdmin. This file adds NO finance
// logic of its own and activates NO tax rule — unclassified data is surfaced as
// REVIEW_REQUIRED, never guessed (spec stop condition).
// ═══════════════════════════════════════════════════════════════

const log = require('../utils/log');
const supa = require('../clients/supabase');
const stripe = require('../clients/stripe');
const rateLimit = require('../middleware/rateLimit');
const { requireAdmin, requireFullAdmin } = require('../middleware/auth');
const { logAdminActivity } = require('../services/adminAuth');
const duffel = require('../services/duffel');
const { recordRefund } = require('../services/finance/refunds');
const { recordChargeback } = require('../services/finance/chargebacks');
const { reconcileBooking } = require('../services/finance/reconciliation');
const { runJob } = require('../services/finance/jobRunner');
const { JOBS } = require('../services/finance/financeJobs');

const deps = () => ({ supa, stripe, log, duffel });
const sumMinor = (rows, col) => (rows || []).reduce((s, r) => s + Number(r[col] || 0), 0);
const noDb = (res) => res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });

module.exports = (app) => {

// ── 1) Finance dashboard — headline totals + status counts ──
app.get('/admin/finance/dashboard', rateLimit('admin', 120, 60000), requireAdmin, async (req, res) => {
  try {
    if (!supa) return noDb(res);
    const [cfg, events, stripeFees, duffelLines, refunds, chargebacks, taxExc, recExc, recMatch] = await Promise.all([
      supa.from('finance_config').select('key,value,review_status'),
      supa.from('financial_events').select('event_type,original_amount_minor,accounting_amount_eur_minor,review_status,original_currency').limit(5000),
      supa.from('stripe_transactions').select('fee_minor').limit(5000),
      supa.from('duffel_invoice_lines').select('gross_minor,match_status').limit(5000),
      supa.from('refunds').select('original_amount_minor,tax_adjustment_status').limit(5000),
      supa.from('chargebacks').select('amount_minor,tax_treatment_status').limit(5000),
      supa.from('tax_exceptions').select('status').limit(5000),
      supa.from('reconciliation_exceptions').select('status,severity').limit(5000),
      supa.from('reconciliation_matches').select('status').limit(5000),
    ]);
    const ev = events.data || [];
    const byType = (t) => ev.filter((e) => e.event_type === t);
    const config = {}; (cfg.data || []).forEach((c) => { config[c.key] = { value: c.value, review_status: c.review_status }; });

    const statusCounts = {
      MATCHED: (recMatch.data || []).filter((m) => m.status === 'MATCHED').length,
      UNMATCHED: (recExc.data || []).filter((e) => e.status === 'OPEN').length,
      REVIEW_REQUIRED: ev.filter((e) => e.review_status === 'REVIEW_REQUIRED').length,
      BLOCKED: (recExc.data || []).filter((e) => e.severity === 'CRITICAL' && e.status === 'OPEN').length,
    };

    res.json({
      ok: true,
      config,
      // Every VAT-ish figure is REVIEW_REQUIRED until rules are approved — the
      // dashboard reports source amounts, not an invented VAT.
      totals_minor: {
        supplier_costs: sumMinor(byType('duffel_invoice_line'), 'accounting_amount_eur_minor'),
        stripe_fees: sumMinor(stripeFees.data, 'fee_minor'),
        refunds: sumMinor(refunds.data, 'original_amount_minor'),
        chargebacks: sumMinor(chargebacks.data, 'amount_minor'),
      },
      vat: { output_vat: 'REVIEW_REQUIRED', input_vat: 'REVIEW_REQUIRED', reverse_charge: 'REVIEW_REQUIRED', vat_payable: 'REVIEW_REQUIRED' },
      status_counts: statusCounts,
      exceptions: { tax_open: (taxExc.data || []).filter((e) => e.status === 'OPEN').length, reconciliation_open: statusCounts.UNMATCHED },
      duffel_unmatched: (duffelLines.data || []).filter((l) => l.match_status === 'UNMATCHED').length,
    });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── 2) Financial transactions (financial_events) ──
app.get('/admin/finance/transactions', rateLimit('admin', 120, 60000), requireAdmin, async (req, res) => {
  try {
    if (!supa) return noDb(res);
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    let q = supa.from('financial_events').select('*').order('occurred_at', { ascending: false }).limit(limit);
    if (req.query.type) q = q.eq('event_type', req.query.type);
    if (req.query.review_status) q = q.eq('review_status', req.query.review_status);
    if (req.query.booking_id) q = q.eq('booking_id', req.query.booking_id);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    res.json({ ok: true, transactions: data || [] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── 3 & 6) Booking financial detail — every amount traceable to its source ──
app.get('/admin/finance/bookings/:id', rateLimit('admin', 120, 60000), requireAdmin, async (req, res) => {
  try {
    if (!supa) return noDb(res);
    const id = req.params.id;
    const { data: booking } = await supa.from('bookings').select('*').eq('id', id).maybeSingle();
    if (!booking) return res.status(404).json({ ok: false, error: 'Buchung nicht gefunden' });
    const [events, stripeTx, duffelLines, taxTx, journalEntries, refunds, chargebacks, recMatches] = await Promise.all([
      supa.from('financial_events').select('*').eq('booking_id', id),
      supa.from('stripe_transactions').select('*').eq('booking_id', id),
      supa.from('duffel_invoice_lines').select('*').eq('booking_id', id),
      supa.from('tax_transactions').select('*').eq('booking_id', id),
      supa.from('journal_entries').select('*').eq('booking_id', id),
      supa.from('refunds').select('*').eq('booking_id', id),
      supa.from('chargebacks').select('*').eq('booking_id', id),
      supa.from('reconciliation_matches').select('*').or(`left_id.eq.${id},right_id.eq.${id}`),
    ]);
    res.json({
      ok: true,
      booking,
      financial_events: events.data || [],
      stripe: stripeTx.data || [],
      duffel: duffelLines.data || [],
      tax_classification: taxTx.data || [],
      accounting_entries: journalEntries.data || [],
      refunds: refunds.data || [],
      chargebacks: chargebacks.data || [],
      reconciliation: recMatches.data || [],
    });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── 4 & 5) Reconciliation views + on-demand run ──
app.get('/admin/finance/reconciliation', rateLimit('admin', 120, 60000), requireAdmin, async (req, res) => {
  try {
    if (!supa) return noDb(res);
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const [matches, exceptions] = await Promise.all([
      supa.from('reconciliation_matches').select('*').order('created_at', { ascending: false }).limit(limit),
      supa.from('reconciliation_exceptions').select('*').eq('status', 'OPEN').order('created_at', { ascending: false }).limit(limit),
    ]);
    res.json({ ok: true, matches: matches.data || [], exceptions: exceptions.data || [] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/admin/finance/reconciliation/booking/:id', rateLimit('admin', 60, 60000), requireFullAdmin, async (req, res) => {
  try {
    if (!supa) return noDb(res);
    const result = await reconcileBooking(req.params.id, deps());
    logAdminActivity(req.adminUserId, 'finance_reconcile_booking', 'booking', req.params.id, result);
    res.json({ ok: true, result });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── 6b) Stripe / Duffel raw views ──
app.get('/admin/finance/stripe/transactions', rateLimit('admin', 120, 60000), requireAdmin, async (req, res) => {
  try {
    if (!supa) return noDb(res);
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const { data } = await supa.from('stripe_transactions').select('*').order('stripe_created_at', { ascending: false }).limit(limit);
    res.json({ ok: true, transactions: data || [] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/admin/finance/duffel/invoices', rateLimit('admin', 120, 60000), requireAdmin, async (req, res) => {
  try {
    if (!supa) return noDb(res);
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const { data: invoices } = await supa.from('duffel_invoices').select('*').order('created_at', { ascending: false }).limit(limit);
    res.json({ ok: true, invoices: invoices || [] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── 7) Refund + Chargeback API integration ──
app.get('/admin/finance/refunds', rateLimit('admin', 120, 60000), requireAdmin, async (req, res) => {
  try {
    if (!supa) return noDb(res);
    const { data } = await supa.from('refunds').select('*').order('created_at', { ascending: false }).limit(200);
    res.json({ ok: true, refunds: data || [] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/admin/finance/refunds', rateLimit('admin', 60, 60000), requireFullAdmin, async (req, res) => {
  try {
    if (!supa) return noDb(res);
    const b = req.body || {};
    const out = await recordRefund({
      bookingId: b.booking_id || null, originalPaymentId: b.original_payment_id || null,
      stripeRefundId: b.stripe_refund_id || null, reason: b.reason || null,
      refundType: b.refund_type || 'FULL', amount: b.amount, amountMinor: b.amount_minor,
      currency: b.currency || 'EUR', refundDate: b.refund_date || new Date().toISOString(),
      createdBy: `admin:${req.adminUserId || 'token'}`,
    }, deps());
    logAdminActivity(req.adminUserId, 'finance_refund_recorded', 'refund', out.refund && out.refund.id, { created: out.created });
    res.json({ ok: true, ...out });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/admin/finance/chargebacks', rateLimit('admin', 120, 60000), requireAdmin, async (req, res) => {
  try {
    if (!supa) return noDb(res);
    const { data } = await supa.from('chargebacks').select('*').order('created_at', { ascending: false }).limit(200);
    res.json({ ok: true, chargebacks: data || [] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/admin/finance/chargebacks', rateLimit('admin', 60, 60000), requireFullAdmin, async (req, res) => {
  try {
    if (!supa) return noDb(res);
    const b = req.body || {};
    const out = await recordChargeback({
      bookingId: b.booking_id || null, stripeDisputeId: b.stripe_dispute_id || null,
      amountMinor: b.amount_minor, currency: b.currency || 'EUR', feeMinor: b.fee_minor || null,
      status: b.status || null, reason: b.reason || null, finalResult: b.final_result || null,
      createdBy: `admin:${req.adminUserId || 'token'}`,
    }, deps());
    logAdminActivity(req.adminUserId, 'finance_chargeback_recorded', 'chargeback', out.chargeback && out.chargeback.id, { created: out.created });
    res.json({ ok: true, ...out });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── 8) Tax exceptions ──
app.get('/admin/finance/exceptions', rateLimit('admin', 120, 60000), requireAdmin, async (req, res) => {
  try {
    if (!supa) return noDb(res);
    const status = req.query.status || 'OPEN';
    const [tax, recon] = await Promise.all([
      supa.from('tax_exceptions').select('*').eq('status', status).order('created_at', { ascending: false }).limit(300),
      supa.from('reconciliation_exceptions').select('*').eq('status', status).order('created_at', { ascending: false }).limit(300),
    ]);
    res.json({ ok: true, tax_exceptions: tax.data || [], reconciliation_exceptions: recon.data || [] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── 9) Accountant export preparation (period summary; numbers only) ──
app.get('/admin/finance/accountant/summary', rateLimit('admin', 120, 60000), requireAdmin, async (req, res) => {
  try {
    if (!supa) return noDb(res);
    const year = parseInt(req.query.year, 10);
    const month = parseInt(req.query.month, 10);
    if (!year || !month) return res.status(400).json({ ok: false, error: 'year und month erforderlich' });
    const from = new Date(Date.UTC(year, month - 1, 1)).toISOString();
    const to = new Date(Date.UTC(year, month, 1)).toISOString();
    const [events, refunds, chargebacks, taxExc] = await Promise.all([
      supa.from('financial_events').select('event_type,accounting_amount_eur_minor,review_status').gte('occurred_at', from).lt('occurred_at', to).limit(10000),
      supa.from('refunds').select('original_amount_minor').gte('created_at', from).lt('created_at', to).limit(10000),
      supa.from('chargebacks').select('amount_minor').gte('created_at', from).lt('created_at', to).limit(10000),
      supa.from('tax_exceptions').select('status').eq('status', 'OPEN').limit(10000),
    ]);
    const ev = events.data || [];
    res.json({
      ok: true, period: { year, month },
      summary_minor: {
        supplier_costs: sumMinor(ev.filter((e) => e.event_type === 'duffel_invoice_line'), 'accounting_amount_eur_minor'),
        stripe_fees: sumMinor(ev.filter((e) => e.event_type === 'stripe_fee'), 'accounting_amount_eur_minor'),
        refunds: sumMinor(refunds.data, 'original_amount_minor'),
        chargebacks: sumMinor(chargebacks.data, 'amount_minor'),
      },
      vat: { output_vat: 'REVIEW_REQUIRED', input_vat: 'REVIEW_REQUIRED', reverse_charge: 'REVIEW_REQUIRED' },
      review_required: ev.filter((e) => e.review_status === 'REVIEW_REQUIRED').length,
      open_tax_exceptions: (taxExc.data || []).length,
      note: 'VAT figures are REVIEW_REQUIRED until the Tax Matrix is approved. This summary is preparation only.',
    });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── 10) Finance documents (Document Vault lands in a later phase — read if present) ──
app.get('/admin/finance/documents', rateLimit('admin', 120, 60000), requireAdmin, async (req, res) => {
  try {
    if (!supa) return noDb(res);
    const { data, error } = await supa.from('documents').select('*').order('created_at', { ascending: false }).limit(200);
    if (error) return res.json({ ok: true, documents: [], note: 'documents table not yet provisioned (Phase 19)' });
    res.json({ ok: true, documents: data || [] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── Manual job runner + job history (Phase 4 surface via API) ──
app.post('/admin/finance/jobs/:job/run', rateLimit('admin', 30, 60000), requireFullAdmin, async (req, res) => {
  try {
    if (!supa) return noDb(res);
    const jobName = req.params.job;
    if (!JOBS[jobName]) return res.status(400).json({ ok: false, error: `Unbekannter Job: ${jobName}` });
    const out = await runJob(jobName, (d) => JOBS[jobName](d, req.body || {}), deps(),
      { trigger: 'manual', triggeredBy: `admin:${req.adminUserId || 'token'}` });
    logAdminActivity(req.adminUserId, 'finance_job_manual_run', 'finance_job', jobName, { ok: out.ok });
    res.json({ ok: true, result: out });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/admin/finance/jobs', rateLimit('admin', 120, 60000), requireAdmin, async (req, res) => {
  try {
    if (!supa) return noDb(res);
    const { data } = await supa.from('finance_job_runs').select('*').order('started_at', { ascending: false }).limit(100);
    res.json({ ok: true, jobs: data || [] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

};
