'use strict';

const logger              = require('./logger');
const { DUFFEL_TOKEN, DUFFEL_BASE, DUFFEL_VER, FETCH_TIMEOUT_MS, RETRY_MAX } = require('./config');

/** Status codes we should retry on (transient server-side errors) */
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

/**
 * Make a single fetch attempt to the Duffel API.
 * Throws on network error or non-OK HTTP status.
 *
 * @param {string}  method
 * @param {string}  path
 * @param {object|null} body
 * @param {string}  reqId
 * @returns {Promise<object>} parsed JSON
 */
async function attemptFetch(method, path, body, reqId) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(`${DUFFEL_BASE}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        Authorization:    `Bearer ${DUFFEL_TOKEN}`,
        'Content-Type':   'application/json',
        'Duffel-Version': DUFFEL_VER,
        Accept:           'application/json',
      },
      ...(body !== null ? { body: JSON.stringify(body) } : {}),
    });
  } catch (fetchErr) {
    if (fetchErr.name === 'AbortError') {
      const err  = new Error('Duffel API request timed out');
      err.status = 504;
      err.retryable = true;
      throw err;
    }
    const err  = new Error(`Network error reaching Duffel API: ${fetchErr.message}`);
    err.status = 502;
    err.retryable = true;
    throw err;
  } finally {
    clearTimeout(timer);
  }

  let json;
  try {
    json = await res.json();
  } catch {
    const err  = new Error('Invalid JSON response from Duffel API');
    err.status = 502;
    err.retryable = true;
    throw err;
  }

  if (!res.ok) {
    const msg   = json?.errors?.[0]?.message || 'Duffel API Error';
    const err   = new Error(msg);
    err.status  = res.status;
    err.details = Array.isArray(json?.errors) ? json.errors : undefined;
    err.retryable = RETRYABLE_STATUSES.has(res.status);
    throw err;
  }

  return json;
}

/**
 * Call the Duffel API with automatic exponential-backoff retry.
 *
 * Only retries on:
 *  - HTTP 502, 503, 504
 *  - Network timeouts / DNS failures
 *
 * Never retries on:
 *  - 4xx client errors (400, 401, 403, 404, 422 …)
 *  - Business-logic errors
 *
 * @param {string}      method  - HTTP method
 * @param {string}      path    - Duffel API path (e.g. '/air/offers')
 * @param {object|null} body    - Request body (null for GET)
 * @param {string}      [reqId] - Request ID for log correlation
 * @returns {Promise<object>}
 */
async function duffelRequest(method, path, body = null, reqId = '') {
  let attempt = 0;

  while (true) {                    // eslint-disable-line no-constant-condition
    attempt += 1;
    try {
      return await attemptFetch(method, path, body, reqId);
    } catch (err) {
      const isLastAttempt = attempt > RETRY_MAX;

      if (!err.retryable || isLastAttempt) {
        // Log at warn for retryable errors that finally failed
        if (err.retryable) {
          logger.warn({ reqId, path, attempts: attempt, status: err.status },
            'Duffel request failed after all retries');
        }
        throw err;
      }

      // Exponential backoff: 200ms, 400ms, 800ms …
      const delayMs = 200 * Math.pow(2, attempt - 1);
      logger.warn(
        { reqId, path, attempt, status: err.status, retryInMs: delayMs },
        `Duffel transient error — retrying (attempt ${attempt}/${RETRY_MAX})`
      );
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

module.exports = { duffelRequest };
