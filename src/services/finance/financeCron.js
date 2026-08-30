// ═══════════════════════════════════════════════════════════════
// src/services/finance/financeCron.js
// [F-PHASE4 · SCHEDULER] Self-starting, .unref()'d schedulers for the finance
// jobs — same pattern as routePriceHistoryRefresh.js. DISABLED by default:
// the whole scheduler only arms when FINANCE_CRON_ENABLED=true, so merging this
// never starts syncing production data on its own. Each tick runs through
// jobRunner (observable + audited); idempotency lives on the target tables, so
// a double tick can never create duplicate accounting entries.
// ═══════════════════════════════════════════════════════════════

const supa = require('../../clients/supabase');
const stripe = require('../../clients/stripe');
const log = require('../../utils/log');
const { runJob } = require('./jobRunner');
const { JOBS } = require('./financeJobs');

const deps = { supa, stripe, log, duffel: require('../duffel') };

const HOUR = 60 * 60 * 1000;

// Schedule table: job name → interval. Kept conservative; tune via env later.
const SCHEDULE = [
  { name: 'stripe_sync',             every: 1 * HOUR,  delay: 120000 },
  { name: 'reconcile_bookings',      every: 2 * HOUR,  delay: 180000 },
  { name: 'duffel_sync',             every: 2 * HOUR,  delay: 240000 },
  { name: 'tax_exception_detection', every: 6 * HOUR,  delay: 300000 },
  { name: 'ledger_integrity_check',  every: 24 * HOUR, delay: 360000 },
];

function tick(name) {
  const fn = JOBS[name];
  if (!fn) return;
  runJob(name, (d) => fn(d, {}), deps, { trigger: 'cron' })
    .catch((e) => log('warn', 'finance_cron_tick_failed', { name, error: e.message }));
}

function start() {
  if (String(process.env.FINANCE_CRON_ENABLED).toLowerCase() !== 'true') {
    log('info', 'finance_cron_disabled', { hint: 'set FINANCE_CRON_ENABLED=true to enable' });
    return false;
  }
  if (!supa) { log('warn', 'finance_cron_no_db'); return false; }
  for (const job of SCHEDULE) {
    setTimeout(() => tick(job.name), job.delay).unref();
    setInterval(() => tick(job.name), job.every).unref();
  }
  log('info', 'finance_cron_started', { jobs: SCHEDULE.map((j) => j.name) });
  return true;
}

module.exports = { start, tick, SCHEDULE };
