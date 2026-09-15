const supa = require('../clients/supabase');
const log = require('../utils/log');
const { randomUUID } = require('crypto');

/**
 * Durable, one-row-per-outbound-attempt audit trail for every Duffel HTTP call.
 *
 * IMPORTANT: createAttempt() is awaited before fetch() starts. If the audit row
 * cannot be created, callers must not send the Duffel request. This is the
 * fail-closed boundary that makes the database count an authoritative
 * application-side ledger rather than best-effort logging.
 */
async function createAttempt({
  method,
  endpoint,
  source,
  trigger,
  actorUserId,
  searchSessionId,
  routeOrigin,
  routeDestination,
  attemptNo,
  metadata,
}) {
  if (!supa) throw new Error('Duffel audit database unavailable');

  const requestId = randomUUID();
  const row = {
    request_id: requestId,
    attempt_no: attemptNo,
    method,
    endpoint,
    source: source || 'unspecified',
    trigger: trigger || source || 'unspecified',
    actor_user_id: actorUserId || null,
    search_session_id: searchSessionId || null,
    route_origin: routeOrigin || null,
    route_destination: routeDestination || null,
    started_at: new Date().toISOString(),
    status: 'started',
    billable_attempt: true,
    metadata: metadata || null,
  };

  const { error } = await supa.from('duffel_api_call_audit').insert(row);
  if (error) {
    log('error', 'duffel_api_audit_create_failed', { error: error.message, endpoint, source, attemptNo });
    throw new Error('Duffel audit write failed; outbound request blocked');
  }
  return requestId;
}

async function finishAttempt(requestId, patch) {
  if (!supa || !requestId) return;
  const { error } = await supa.from('duffel_api_call_audit').update({
    ...patch,
    completed_at: new Date().toISOString(),
  }).eq('request_id', requestId);
  if (error) log('error', 'duffel_api_audit_finish_failed', { error: error.message, requestId });
}

module.exports = { createAttempt, finishAttempt };
