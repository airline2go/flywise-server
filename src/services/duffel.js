const env = require('../config/env');
const log = require('../utils/log');
const Sentry = require('../clients/sentry');
const { recordApiLog } = require('./apiLogs');
const { logSearchAccess } = require('../middleware/searchGuard');

const DUFFEL_TIMEOUT_MS = 20000;
const SEARCH_PATH_RE = /\/air\/offer_requests|\/places\/suggestions/;
const SEARCH_SOURCES = new Set(['user_search', 'airport_search']);
const PRIVILEGED_SOURCES = new Set(['booking', 'cancellation', 'flight_change', 'admin']);

function isSearchPath(path) {
  return SEARCH_PATH_RE.test(String(path || ''));
}

function denySearchCall(reason) {
  const err = new Error('Suche nicht verfügbar.');
  err.status = 403;
  err.code = 'SEARCH_GUARD_DENIED';
  err.denyReason = reason;
  return err;
}

function assertDuffelSearchContext(method, path, options) {
  const source = (options && options.source) || 'unspecified';
  if (!isSearchPath(path)) return source;
  if (SEARCH_SOURCES.has(source)) {
    const ctx = options && options.searchContext;
    if (!ctx || !ctx.valid || !ctx.sid) throw denySearchCall('missing_search_session');
    return source;
  }
  if (PRIVILEGED_SOURCES.has(source)) return source;
  throw denySearchCall('missing_source');
}

const UPSTREAM_ERROR_CODES = Object.freeze({
  UPSTREAM_422: 'UPSTREAM_422',
  UPSTREAM_429: 'UPSTREAM_429',
  UPSTREAM_4XX: 'UPSTREAM_4XX',
  UPSTREAM_5XX: 'UPSTREAM_5XX',
  UPSTREAM_TIMEOUT: 'UPSTREAM_TIMEOUT',
  UPSTREAM_NETWORK: 'UPSTREAM_NETWORK',
  UPSTREAM_DEADLINE: 'UPSTREAM_DEADLINE',
  UPSTREAM_CIRCUIT_OPEN: 'UPSTREAM_CIRCUIT_OPEN',
});

function classifyUpstreamStatus(status) {
  const s = Number(status) || 0;
  if (s === 422) return 'UPSTREAM_422';
  if (s === 429) return 'UPSTREAM_429';
  if (s >= 500) return 'UPSTREAM_5XX';
  if (s >= 400) return 'UPSTREAM_4XX';
  return 'UPSTREAM_5XX';
}

async function duffelAttempt(method, path, body, extraHeaders, timeoutMs, externalSignal) {
  if (!env.DUFFEL_TOKEN) throw new Error('DUFFEL_TOKEN غير موجود في Environment Variables');
  const opts = {
    method,
    headers: Object.assign({
      Authorization: `Bearer ${env.DUFFEL_TOKEN}`,
      'Content-Type': 'application/json',
      'Duffel-Version': env.DUFFEL_VERSION,
      Accept: 'application/json',
    }, extraHeaders || {}),
  };
  if (body) opts.body = JSON.stringify(body);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || DUFFEL_TIMEOUT_MS);
  let onExternalAbort = null;
  if (externalSignal) {
    if (externalSignal.aborted) ctrl.abort();
    else { onExternalAbort = () => ctrl.abort(); externalSignal.addEventListener('abort', onExternalAbort, { once: true }); }
  }
  opts.signal = ctrl.signal;
  let res;
  try {
    res = await fetch(`${env.DUFFEL_BASE}${path}`, opts);
  } catch (e) {
    if (e.name === 'AbortError') {
      const deadlineHit = !!(externalSignal && externalSignal.aborted);
      const err = new Error(deadlineHit
        ? 'Zeitlimit für die Preisberechnung überschritten'
        : 'Duffel antwortet nicht — bitte erneut versuchen');
      err.status = 504;
      err.code = deadlineHit ? 'UPSTREAM_DEADLINE' : 'UPSTREAM_TIMEOUT';
      throw err;
    }
    if (e && !e.code) e.code = 'UPSTREAM_NETWORK';
    throw e;
  } finally {
    clearTimeout(timer);
    if (externalSignal && onExternalAbort) externalSignal.removeEventListener('abort', onExternalAbort);
  }
  const json = await res.json();
  if (!res.ok) {
    const msg = json?.errors?.[0]?.message || 'Duffel API Error';
    const err = new Error(msg);
    err.status = res.status;
    err.code = classifyUpstreamStatus(res.status);
    err.details = json?.errors;
    throw err;
  }
  return json;
}

let duffelCircuitState = 'closed';
let duffelFailureCount = 0;
let duffelCircuitOpenedAt = 0;
const DUFFEL_FAILURE_THRESHOLD = 5;
const DUFFEL_CIRCUIT_COOLDOWN_MS = 30000;

function duffelCircuitAllow() {
  if (duffelCircuitState !== 'open') return true;
  if (Date.now() - duffelCircuitOpenedAt > DUFFEL_CIRCUIT_COOLDOWN_MS) {
    duffelCircuitState = 'half-open';
    return true;
  }
  return false;
}
function duffelCircuitRecordSuccess() {
  if (duffelCircuitState !== 'closed') log('info', 'duffel_circuit_closed', {});
  duffelFailureCount = 0;
  duffelCircuitState = 'closed';
}
function duffelCircuitRecordFailure() {
  duffelFailureCount++;
  if (duffelCircuitState === 'half-open') {
    duffelCircuitState = 'open';
    duffelCircuitOpenedAt = Date.now();
    log('warn', 'duffel_circuit_reopened', {});
    return;
  }
  if (duffelFailureCount >= DUFFEL_FAILURE_THRESHOLD && duffelCircuitState === 'closed') {
    duffelCircuitState = 'open';
    duffelCircuitOpenedAt = Date.now();
    log('error', 'duffel_circuit_opened', { failures: duffelFailureCount });
    if (env.SENTRY_DSN) Sentry.captureMessage('Duffel circuit breaker opened — API considered down', 'error');
  }
}

async function duffel(method, path, body = null, extraHeaders = null, options = null) {
  const startedAt = Date.now();
  const logContext = (options && options.logContext) || null;
  let source;
  try {
    source = assertDuffelSearchContext(method, path, options);
  } catch (guardErr) {
    const ctx = options && options.searchContext;
    logSearchAccess({
      endpoint: path,
      source: (options && options.source) || 'unspecified',
      sid: ctx && ctx.sid,
      userId: ctx && ctx.userId,
      ip: ctx && ctx.ip,
      allowed: false,
      reason: guardErr.denyReason || 'missing_source',
    });
    recordApiLog({ method, path, statusCode: 403, success: false, durationMs: Date.now() - startedAt, logContext });
    throw guardErr;
  }
  if (isSearchPath(path)) {
    const ctx = options && options.searchContext;
    logSearchAccess({
      endpoint: path,
      source,
      sid: ctx && ctx.sid,
      userId: ctx && ctx.userId,
      ip: ctx && ctx.ip,
      allowed: true,
    });
  }
  if (!duffelCircuitAllow()) {
    const err = new Error('Duffel ist vorübergehend nicht erreichbar — bitte in Kürze erneut versuchen');
    err.status = 503;
    err.code = 'UPSTREAM_CIRCUIT_OPEN';
    recordApiLog({ method, path, statusCode: 503, success: false, durationMs: Date.now() - startedAt, logContext });
    throw err;
  }
  const timeoutMs = (options && options.timeoutMs) || DUFFEL_TIMEOUT_MS;
  const externalSignal = (options && options.signal) || null;
  const deadlineError = () => { const err = new Error('Zeitlimit für die Preisberechnung überschritten'); err.status = 504; err.code = 'UPSTREAM_DEADLINE'; return err; };
  const maxAttempts = 2;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (externalSignal && externalSignal.aborted) {
      const err = deadlineError();
      recordApiLog({ method, path, statusCode: 504, success: false, durationMs: Date.now() - startedAt, logContext });
      throw err;
    }
    try {
      const result = await duffelAttempt(method, path, body, extraHeaders, timeoutMs, externalSignal);
      duffelCircuitRecordSuccess();
      recordApiLog({ method, path, statusCode: 200, success: true, durationMs: Date.now() - startedAt, logContext });
      return result;
    } catch (e) {
      lastErr = e;
      if (e.code === 'UPSTREAM_DEADLINE') {
        recordApiLog({ method, path, statusCode: 504, success: false, durationMs: Date.now() - startedAt, logContext });
        throw e;
      }
      const transient = !e.status || e.status >= 500;
      if (!transient || attempt === maxAttempts) {
        duffelCircuitRecordFailure();
        if (e && !e.code) e.code = e.status ? classifyUpstreamStatus(e.status) : 'UPSTREAM_NETWORK';
        recordApiLog({ method, path, statusCode: e.status || null, success: false, durationMs: Date.now() - startedAt, logContext });
        log('warn', 'duffel_upstream_error', { method, path, code: e.code, status: e.status || null, attempts: attempt, duration_ms: Date.now() - startedAt });
        throw e;
      }
      await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }
  throw lastErr;
}

function getDuffelCircuitStatus() {
  return { state: duffelCircuitState, consecutiveFailures: duffelFailureCount };
}

module.exports = duffel;
module.exports.getDuffelCircuitStatus = getDuffelCircuitStatus;
module.exports.duffelAttempt = duffelAttempt;
module.exports.UPSTREAM_ERROR_CODES = UPSTREAM_ERROR_CODES;
module.exports.classifyUpstreamStatus = classifyUpstreamStatus;
