const env = require('../config/env');
const log = require('../utils/log');
const Sentry = require('../clients/sentry');
const { recordApiLog } = require('./apiLogs');
const { logSearchAccess } = require('../middleware/searchGuard');
const { createAttempt, finishAttempt } = require('./duffelApiAudit');
const { recordDuffelAttemptAlert } = require('./duffelUsageAlert');
const { randomUUID } = require('crypto');

const DUFFEL_TIMEOUT_MS = 20000;
const OFFER_REQUEST_RE = /\/air\/offer_requests/;
const PLACE_SUGGESTION_RE = /\/places\/suggestions/;
const SEARCH_PATH_RE = /\/air\/offer_requests|\/places\/suggestions/;
const SEARCH_SOURCES = new Set(['user_search', 'airport_search']);
const PRIVILEGED_SOURCES = new Set(['booking', 'cancellation', 'flight_change', 'admin']);

function isOfferRequestPath(path) { return OFFER_REQUEST_RE.test(String(path || '')); }
function isPlaceSuggestionPath(path) { return PLACE_SUGGESTION_RE.test(String(path || '')); }
function isSearchPath(path) { return SEARCH_PATH_RE.test(String(path || '')); }
function denySearchCall(reason) { const err = new Error('Suche nicht verfügbar.'); err.status = 403; err.code = 'SEARCH_GUARD_DENIED'; err.denyReason = reason; return err; }
function assertDuffelSearchContext(method, path, options) {
  const source = (options && options.source) || 'unspecified';

  // HARD COST GUARD: Duffel offer requests are allowed ONLY for a genuine,
  // signed user search session. No admin route probe, route-page refresh,
  // alert, warmup, backfill, SEO job, or other privileged/background caller
  // may create a priced offer request.
  if (isOfferRequestPath(path)) {
    if (source !== 'user_search') throw denySearchCall('offer_request_requires_real_user_search');
    const ctx = options && options.searchContext;
    if (!ctx || !ctx.valid || !ctx.sid) throw denySearchCall('missing_search_session');
    return source;
  }

  // Airport autocomplete is not a fare/price request. It still requires a
  // valid signed search session so bots cannot burn provider calls by typing.
  if (isPlaceSuggestionPath(path)) {
    if (SEARCH_SOURCES.has(source)) {
      const ctx = options && options.searchContext;
      if (!ctx || !ctx.valid || !ctx.sid) throw denySearchCall('missing_search_session');
      return source;
    }
    // Privileged tooling may still resolve airport/place metadata; this path
    // does not return fares and is not a priced offer request.
    if (PRIVILEGED_SOURCES.has(source)) return source;
    throw denySearchCall('missing_source');
  }

  if (!isSearchPath(path)) return source;
  if (PRIVILEGED_SOURCES.has(source)) return source;
  throw denySearchCall('missing_source');
}
const UPSTREAM_ERROR_CODES = Object.freeze({ UPSTREAM_422: 'UPSTREAM_422', UPSTREAM_429: 'UPSTREAM_429', UPSTREAM_4XX: 'UPSTREAM_4XX', UPSTREAM_5XX: 'UPSTREAM_5XX', UPSTREAM_TIMEOUT: 'UPSTREAM_TIMEOUT', UPSTREAM_NETWORK: 'UPSTREAM_NETWORK', UPSTREAM_DEADLINE: 'UPSTREAM_DEADLINE', UPSTREAM_CIRCUIT_OPEN: 'UPSTREAM_CIRCUIT_OPEN' });
function classifyUpstreamStatus(status) { const s = Number(status) || 0; if (s === 422) return 'UPSTREAM_422'; if (s === 429) return 'UPSTREAM_429'; if (s >= 500) return 'UPSTREAM_5XX'; if (s >= 400) return 'UPSTREAM_4XX'; return 'UPSTREAM_5XX'; }

async function duffelAttempt(method, path, body, extraHeaders, timeoutMs, externalSignal, auditContext) {
  if (!env.DUFFEL_TOKEN) throw new Error('DUFFEL_TOKEN غير موجود في Environment Variables');

  // Defense in depth for callers that invoke duffelAttempt() directly and
  // bypass duffel(). A priced offer request must still originate from a real
  // user search. This check happens BEFORE audit creation and BEFORE fetch(),
  // so blocked background/admin calls create zero upstream Duffel traffic.
  const lowLevelSource = (auditContext && auditContext.source) || 'unspecified';
  if (isOfferRequestPath(path) && lowLevelSource !== 'user_search') {
    const err = denySearchCall('offer_request_requires_real_user_search');
    log('warn', 'duffel_offer_request_blocked_non_user_search', { source: lowLevelSource, path });
    throw err;
  }
  const opts = { method, headers: Object.assign({ Authorization: `Bearer ${env.DUFFEL_TOKEN}`, 'Content-Type': 'application/json', 'Duffel-Version': env.DUFFEL_VERSION, Accept: 'application/json' }, extraHeaders || {}) };
  if (body) opts.body = JSON.stringify(body);
  const requestId = await createAttempt({ ...auditContext, method, endpoint: path, attemptNo: auditContext.attemptNo });
  recordDuffelAttemptAlert({ source: auditContext.source, trigger: auditContext.trigger, endpoint: path }).catch((e) => log('error', 'duffel_usage_alert_error', { error: e.message }));
  opts.headers['x-client-correlation-id'] = requestId;
  const startedAt = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || DUFFEL_TIMEOUT_MS);
  let onExternalAbort = null;
  if (externalSignal) { if (externalSignal.aborted) ctrl.abort(); else { onExternalAbort = () => ctrl.abort(); externalSignal.addEventListener('abort', onExternalAbort, { once: true }); } }
  opts.signal = ctrl.signal;
  let res;
  try { res = await fetch(`${env.DUFFEL_BASE}${path}`, opts); }
  catch (e) {
    const deadlineHit = !!(externalSignal && externalSignal.aborted);
    const err = e.name === 'AbortError' ? Object.assign(new Error(deadlineHit ? 'Zeitlimit für die Preisberechnung überschritten' : 'Duffel antwortet nicht — bitte erneut versuchen'), { status: 504, code: deadlineHit ? 'UPSTREAM_DEADLINE' : 'UPSTREAM_TIMEOUT' }) : e;
    if (e.name !== 'AbortError' && !e.code) e.code = 'UPSTREAM_NETWORK';
    await finishAttempt(requestId, { status: e.name === 'AbortError' ? 'timeout' : 'network_error', http_status: err.status || null, success: false, duration_ms: Date.now() - startedAt, duffel_client_correlation_id: requestId, error_code: err.code || 'UPSTREAM_NETWORK', error_message: err.message });
    throw err;
  } finally { clearTimeout(timer); if (externalSignal && onExternalAbort) externalSignal.removeEventListener('abort', onExternalAbort); }
  const header = (name) => res.headers && typeof res.headers.get === 'function' ? res.headers.get(name) : null;
  const duffelRequestId = header('x-request-id');
  const clientCorrelationId = header('x-client-correlation-id') || requestId;
  let json;
  try { json = await res.json(); }
  catch (e) { const err = new Error('Invalid JSON response from Duffel'); err.status = res.status; err.code = 'UPSTREAM_NETWORK'; await finishAttempt(requestId, { status: 'failed', http_status: res.status, success: false, duration_ms: Date.now() - startedAt, duffel_request_id: duffelRequestId, duffel_client_correlation_id: clientCorrelationId, error_code: err.code, error_message: err.message }); throw err; }
  if (!res.ok) { const msg = json?.errors?.[0]?.message || 'Duffel API Error'; const err = new Error(msg); err.status = res.status; err.code = classifyUpstreamStatus(res.status); err.details = json?.errors; await finishAttempt(requestId, { status: 'failed', http_status: res.status, success: false, duration_ms: Date.now() - startedAt, duffel_request_id: duffelRequestId, duffel_client_correlation_id: clientCorrelationId, error_code: err.code, error_message: msg }); throw err; }
  await finishAttempt(requestId, { status: 'completed', http_status: res.status, success: true, duration_ms: Date.now() - startedAt, duffel_request_id: duffelRequestId, duffel_client_correlation_id: clientCorrelationId });
  return json;
}

let duffelCircuitState = 'closed';
let duffelFailureCount = 0;
let duffelCircuitOpenedAt = 0;
const DUFFEL_FAILURE_THRESHOLD = 5;
const DUFFEL_CIRCUIT_COOLDOWN_MS = 30000;
function duffelCircuitAllow() { if (duffelCircuitState !== 'open') return true; if (Date.now() - duffelCircuitOpenedAt > DUFFEL_CIRCUIT_COOLDOWN_MS) { duffelCircuitState = 'half-open'; return true; } return false; }
function duffelCircuitRecordSuccess() { if (duffelCircuitState !== 'closed') log('info', 'duffel_circuit_closed', {}); duffelFailureCount = 0; duffelCircuitState = 'closed'; }
function duffelCircuitRecordFailure() { duffelFailureCount++; if (duffelCircuitState === 'half-open') { duffelCircuitState = 'open'; duffelCircuitOpenedAt = Date.now(); log('warn', 'duffel_circuit_reopened', {}); return; } if (duffelFailureCount >= DUFFEL_FAILURE_THRESHOLD && duffelCircuitState === 'closed') { duffelCircuitState = 'open'; duffelCircuitOpenedAt = Date.now(); log('error', 'duffel_circuit_opened', { failures: duffelFailureCount }); if (env.SENTRY_DSN) Sentry.captureMessage('Duffel circuit breaker opened — API considered down', 'error'); } }

async function duffel(method, path, body = null, extraHeaders = null, options = null) {
  const startedAt = Date.now();
  const logContext = (options && options.logContext) || null;
  let source;
  try { source = assertDuffelSearchContext(method, path, options); }
  catch (guardErr) { const ctx = options && options.searchContext; logSearchAccess({ endpoint: path, source: (options && options.source) || 'unspecified', sid: ctx && ctx.sid, userId: ctx && ctx.userId, ip: ctx && ctx.ip, allowed: false, reason: guardErr.denyReason || 'missing_source' }); recordApiLog({ method, path, statusCode: 403, success: false, durationMs: Date.now() - startedAt, logContext }); throw guardErr; }
  if (isSearchPath(path)) { const ctx = options && options.searchContext; logSearchAccess({ endpoint: path, source, sid: ctx && ctx.sid, userId: ctx && ctx.userId, ip: ctx && ctx.ip, allowed: true }); }
  if (!duffelCircuitAllow()) { const err = new Error('Duffel ist vorübergehend nicht erreichbar — bitte in Kürze erneut versuchen'); err.status = 503; err.code = 'UPSTREAM_CIRCUIT_OPEN'; recordApiLog({ method, path, statusCode: 503, success: false, durationMs: Date.now() - startedAt, logContext }); throw err; }
  const timeoutMs = (options && options.timeoutMs) || DUFFEL_TIMEOUT_MS;
  const externalSignal = (options && options.signal) || null;
  const deadlineError = () => { const err = new Error('Zeitlimit für die Preisberechnung überschritten'); err.status = 504; err.code = 'UPSTREAM_DEADLINE'; return err; };
  // Search/airport lookups are expensive upstream calls. Avoid an automatic retry on transient failures here; the client can retry, while a second server-side attempt duplicates Duffel consumption. Keep two attempts for transactional/privileged calls.
  const maxAttempts = isSearchPath(path) ? 1 : 2;
  const ctx = (options && options.searchContext) || {};
  const operationId = randomUUID();
  const auditContext = { operationId, source, trigger: (options && options.trigger) || (logContext && logContext.trigger) || source, actorUserId: (options && options.actorUserId) || ctx.userId || null, actorIp: (options && options.actorIp) || ctx.ip || null, actorUserAgent: (options && options.actorUserAgent) || ctx.userAgent || null, searchSessionId: ctx.sid || null, routeOrigin: (logContext && logContext.route_origin) || null, routeDestination: (logContext && logContext.route_destination) || null, metadata: (options && options.auditMetadata) || null };
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (externalSignal && externalSignal.aborted) { const err = deadlineError(); recordApiLog({ method, path, statusCode: 504, success: false, durationMs: Date.now() - startedAt, logContext }); throw err; }
    try { const result = await duffelAttempt(method, path, body, extraHeaders, timeoutMs, externalSignal, { ...auditContext, attemptNo: attempt }); duffelCircuitRecordSuccess(); recordApiLog({ method, path, statusCode: 200, success: true, durationMs: Date.now() - startedAt, logContext }); return result; }
    catch (e) { lastErr = e; if (e.code === 'UPSTREAM_DEADLINE') { recordApiLog({ method, path, statusCode: 504, success: false, durationMs: Date.now() - startedAt, logContext }); throw e; } const transient = !e.status || e.status >= 500; if (!transient || attempt === maxAttempts) { duffelCircuitRecordFailure(); if (e && !e.code) e.code = e.status ? classifyUpstreamStatus(e.status) : 'UPSTREAM_NETWORK'; recordApiLog({ method, path, statusCode: e.status || null, success: false, durationMs: Date.now() - startedAt, logContext }); log('warn', 'duffel_upstream_error', { method, path, code: e.code, status: e.status || null, attempts: attempt, duration_ms: Date.now() - startedAt }); throw e; } await new Promise((r) => setTimeout(r, 300 * attempt)); }
  }
  throw lastErr;
}
function getDuffelCircuitStatus() { return { state: duffelCircuitState, consecutiveFailures: duffelFailureCount }; }
module.exports = duffel;
module.exports.getDuffelCircuitStatus = getDuffelCircuitStatus;
module.exports.duffelAttempt = duffelAttempt;
module.exports.UPSTREAM_ERROR_CODES = UPSTREAM_ERROR_CODES;
module.exports.classifyUpstreamStatus = classifyUpstreamStatus;
