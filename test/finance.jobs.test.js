const { runJob } = require('../src/services/finance/jobRunner');
const { jobLedgerIntegrityCheck, jobTaxExceptionDetection } = require('../src/services/finance/financeJobs');

// Minimal chainable Supabase mock: per-table result queues + captured inserts.
function makeSupa(tableData = {}) {
  const inserts = [];
  const updates = [];
  function builder(table) {
    const state = { table, _result: tableData[table] };
    const chain = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'insert') return (row) => { inserts.push({ table, row }); return { select: () => ({ maybeSingle: () => Promise.resolve({ data: { id: `${table}-id` }, error: null }) }), then: (r) => Promise.resolve({ data: null, error: null }).then(r) }; };
        if (prop === 'update') return (row) => { updates.push({ table, row }); return chainReturning(); };
        if (prop === 'maybeSingle') return () => Promise.resolve({ data: Array.isArray(state._result) ? (state._result[0] || null) : (state._result || null), error: null });
        if (prop === 'then') return (resolve) => Promise.resolve({ data: state._result || [], error: null }).then(resolve);
        return () => chain; // select/eq/gte/lt/order/limit/or...
      },
    });
    function chainReturning() {
      return new Proxy({}, { get(_t, p) { if (p === 'eq') return () => Promise.resolve({ data: null, error: null }); if (p === 'then') return (r) => Promise.resolve({ data: null, error: null }).then(r); return () => chainReturning(); } });
    }
    return chain;
  }
  return { from: (t) => builder(t), __inserts: inserts, __updates: updates };
}

describe('finance/jobRunner', () => {
  test('records a SUCCEEDED run + audit entry on success', async () => {
    const supa = makeSupa();
    const out = await runJob('unit_job', async () => ({ records_processed: 3, records_failed: 0, summary: { x: 1 } }), { supa });
    expect(out.ok).toBe(true);
    expect(supa.__inserts.some((i) => i.table === 'finance_job_runs')).toBe(true);
    expect(supa.__inserts.some((i) => i.table === 'audit_logs' && i.row.action === 'FINANCE_JOB_RUN')).toBe(true);
    expect(supa.__updates.some((u) => u.table === 'finance_job_runs' && u.row.status === 'SUCCEEDED')).toBe(true);
  });

  test('records a FAILED run when the job throws (never swallows silently)', async () => {
    const supa = makeSupa();
    const out = await runJob('unit_job', async () => { throw new Error('boom'); }, { supa });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('boom');
    expect(supa.__updates.some((u) => u.table === 'finance_job_runs' && u.row.status === 'FAILED')).toBe(true);
  });
});

describe('finance/financeJobs integrity + exception detection', () => {
  test('ledger integrity check flags an imbalanced posted entry', async () => {
    const supa = makeSupa({
      journal_entries: [{ id: 'e1', status: 'POSTED' }],
      journal_lines: [{ debit_eur_minor: 100, credit_eur_minor: 0 }],  // imbalanced
    });
    const out = await jobLedgerIntegrityCheck({ supa, log: () => {} });
    expect(out.summary.checked).toBe(1);
    expect(out.summary.imbalanced).toBe(1);
    expect(supa.__inserts.some((i) => i.table === 'reconciliation_exceptions' && i.row.exception_type === 'LEDGER_IMBALANCE')).toBe(true);
  });

  test('tax exception detection raises TAX_REVIEW_REQUIRED for an unclassified event', async () => {
    const supa = makeSupa({
      financial_events: [{ id: 'fe1', booking_id: 'b1', review_status: 'REVIEW_REQUIRED' }],
      tax_exceptions: [],  // no existing exception → one is created
    });
    const out = await jobTaxExceptionDetection({ supa });
    expect(out.summary.exceptions_created).toBe(1);
    expect(supa.__inserts.some((i) => i.table === 'tax_exceptions' && i.row.exception_type === 'TAX_REVIEW_REQUIRED')).toBe(true);
  });
});
