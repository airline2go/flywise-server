// ═══════════════════════════════════════════════════════════════
// src/services/finance/jobRunner.js
// [F-PHASE4 · JOB RUNNER] Wraps every finance job so it is observable and
// audited (spec Phase 34): one finance_job_runs row per execution with timing,
// status and counts, plus an append-only audit_logs entry. It does NOT provide
// idempotency itself — that lives on the target tables' unique idempotency keys
// (running a sync twice can never create duplicate accounting entries). The job
// fn returns { records_processed, records_failed, summary }.
// ═══════════════════════════════════════════════════════════════

async function runJob(jobName, fn, deps = {}, opts = {}) {
  const { supa, log } = deps;
  const trigger = opts.trigger || 'cron';
  const triggeredBy = opts.triggeredBy || 'system';
  let runId = null;

  // Open a run row (best-effort — a job must still run if the audit insert fails).
  if (supa) {
    try {
      const { data } = await supa.from('finance_job_runs')
        .insert({ job_name: jobName, trigger, triggered_by: triggeredBy, status: 'RUNNING' })
        .select('id').maybeSingle();
      runId = data ? data.id : null;
    } catch (e) { if (log) log('warn', 'job_run_open_failed', { jobName, error: e.message }); }
  }

  const startedAt = Date.now();
  try {
    const result = (await fn(deps)) || {};
    const processed = Number(result.records_processed) || 0;
    const failed = Number(result.records_failed) || 0;
    if (supa && runId) {
      await supa.from('finance_job_runs').update({
        finished_at: new Date().toISOString(),
        status: result.skipped ? 'SKIPPED' : 'SUCCEEDED',
        records_processed: processed,
        records_failed: failed,
        summary: result.summary || result,
      }).eq('id', runId);
      await supa.from('audit_logs').insert({
        actor_id: triggeredBy, role: 'system', action: 'FINANCE_JOB_RUN',
        entity_type: 'finance_job_runs', entity_id: runId,
        new_value: { job: jobName, processed, failed, ms: Date.now() - startedAt },
      }).then(() => {}, () => {});
    }
    if (log) log('info', 'finance_job_done', { jobName, processed, failed, ms: Date.now() - startedAt });
    return { ok: true, runId, ...result };
  } catch (err) {
    if (supa && runId) {
      await supa.from('finance_job_runs').update({
        finished_at: new Date().toISOString(), status: 'FAILED', error_log: String(err && err.message || err),
      }).eq('id', runId).then(() => {}, () => {});
    }
    if (log) log('error', 'finance_job_failed', { jobName, error: err.message });
    return { ok: false, runId, error: err.message };
  }
}

module.exports = { runJob };
