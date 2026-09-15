const supa = require('../clients/supabase');
const log = require('../utils/log');
const { randomUUID } = require('crypto');

/**
 * Durable, one-row-per-outbound-attempt audit trail for every Duffel HTTP call.
 * createAttempt() is awaited before fetch() starts. In production, an audit
 * write failure therefore blocks the outbound Duffel request (fail closed).
 */
async function createAttempt({
  operationId,
  method,
  endpoint,
  source,
  trigger,
  actorUserId,
  actorIp,
  actorUserAgent,
  searchSessionId,
  routeOrigin,
  routeDestination,
  attemptNo,
  metadata,
}) {
  const requestId = randomUUID();
  if (!supa) {
    if (process.env.NODE_ENV === 'test') return requestId;
    throw new Error('Duffel audit database unavailable; outbound request blocked');
  }

  const row = {
    operation_id: operationId || null,
    request_id: requestId,
    attempt_no: attemptNo,
    method,
    endpoint,
    source: source || 'unspecified',
    trigger: trigger || source || 'unspecified',
    actor_user_id: actorUserId || null,
    actor_ip: actorIp || null,
    actor_user_agent: actorUserAgent || null,
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
  if (!supa || !requestId || process.env.NODE_ENV === 'test') return;
  const { error } = await supa.from('duffel_api_call_audit').update({
    ...patch,
    completed_at: new Date().toISOString(),
  }).eq('request_id', requestId);
  if (error) log('error', 'duffel_api_audit_finish_failed', { error: error.message, requestId });
}

module.exports = { createAttempt, finishAttempt };
