// Search Session + Search Guard — independent of user login.
const crypto = require('crypto');
const env = require('../config/env');
const log = require('../utils/log');
const { consumeRateLimit } = require('./rateLimit');
const { clientIp } = require('../utils/clientIp');
const SESSION_TTL_SEC = 30 * 60;
const HEADER = 'x-search-session';
function hashId(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}
function sessionSecret() {
  if (env.SEARCH_SESSION_SECRET) return env.SEARCH_SESSION_SECRET;
  if (env.DUFFEL_TOKEN) {
    return crypto.createHmac('sha256', 'airpiv-search-session-v1').update(env.DUFFEL_TOKEN).digest('hex');
  }
  return 'dev-search-session-secret';
}
function createSearchSession() {
  const sid = crypto.randomBytes(16).toString('hex');
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC;
  const payload = `v1.${sid}.${exp}`;
  const sig = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('hex');
  return { token: `${payload}.${sig}`, sid, exp };
}
function verifySearchSession(token) {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'missing' };
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return { ok: false, reason: 'invalid' };
  const [, sid, expStr, sig] = parts;
  if (!/^[a-f0-9]{32}$/.test(sid) || !/^[1-9][0-9]{8,11}$/.test(expStr) || !/^[a-f0-9]{64}$/.test(sig)) {
    return { ok: false, reason: 'invalid' };
  }
  const payload = `v1.${sid}.${expStr}`;
  const expected = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('hex');
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'invalid' };
  const exp = parseInt(expStr, 10);
  if (exp <= Math.floor(Date.now() / 1000)) return { ok: false, reason: 'expired' };
  return { ok: true, sid, exp };
}
function logSearchAccess(fields) {
  log(fields.allowed ? 'info' : 'warn', 'search_guard', {
    endpoint: fields.endpoint || null,
    source: fields.source || null,
    session_id_hash: fields.sid ? hashId(fields.sid) : null,
    user_id: fields.userId || null,
    ip_hash: fields.ip ? hashId(fields.ip) : null,
    route: fields.route || null,
    timestamp: new Date().toISOString(),
    allowed: !!fields.allowed,
    deny_reason: fields.reason || null,
    duffel_request_id: fields.duffelRequestId || null,
  });
}
function deny(res, status) {
  if (status === 429) {
    return res.status(429).json({ ok: false, error: 'Zu viele Anfragen, bitte später erneut versuchen.' });
  }
  return res.status(403).json({ ok: false, error: 'Suche nicht verfügbar. Bitte Seite neu laden.' });
}
async function isAuthorizedAdmin(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return false;
  if (env.ADMIN_TOKEN) {
    const a = Buffer.from(token);
    const b = Buffer.from(env.ADMIN_TOKEN);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  try {
    const { resolveSession } = require('../services/adminAuth');
    const session = await resolveSession(token);
    return !!session;
  } catch (e) {
    return false;
  }
}
async function verifyTurnstile(token, ip) {
  if (!env.TURNSTILE_SECRET_KEY) return { ok: true, skipped: true };
  if (!token) return { ok: false, reason: 'missing_turnstile' };
  try {
    const body = new URLSearchParams({
      secret: env.TURNSTILE_SECRET_KEY,
      response: String(token),
      remoteip: ip || '',
    });
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json = await res.json();
    if (json && json.success) return { ok: true };
    return { ok: false, reason: 'turnstile_failed' };
  } catch (e) {
    log('warn', 'turnstile_verify_error', { error: e.message });
    return { ok: false, reason: 'turnstile_failed' };
  }
}
function searchGuard(opts) {
  const bucket = opts.bucket;
  const ipMax = opts.ipMax;
  const ipWindowMs = opts.ipWindowMs;
  const sessionMax = opts.sessionMax;
  const sessionWindowMs = opts.sessionWindowMs;
  const source = opts.source || bucket;
  return async function searchGuardMiddleware(req, res, next) {
    const ip = clientIp(req);
    const admin = await isAuthorizedAdmin(req);
    let sid = null;
    if (admin) {
      sid = 'admin';
      req.searchSession = { valid: true, sid, exp: 0, admin: true };
    } else {
      const token = req.headers[HEADER];
      const verified = verifySearchSession(token);
      if (!verified.ok) {
        logSearchAccess({
          endpoint: req.path, source, sid: null, userId: req.userId, ip,
          allowed: false, reason: verified.reason === 'missing' ? 'missing_session' : verified.reason,
        });
        return deny(res, 403);
      }
      sid = verified.sid;
      req.searchSession = { valid: true, sid, exp: verified.exp };
    }
    const ipRl = await consumeRateLimit(bucket, ip, ipMax, ipWindowMs);
    if (ipRl.limited) {
      res.set('Retry-After', String(ipRl.retryAfterSec));
      logSearchAccess({
        endpoint: req.path, source, sid, userId: req.userId, ip,
        allowed: false, reason: 'ip_rate_limit',
      });
      return deny(res, 429);
    }
    const sessRl = await consumeRateLimit(bucket + ':ss', sid, sessionMax, sessionWindowMs);
    if (sessRl.limited) {
      res.set('Retry-After', String(sessRl.retryAfterSec));
      logSearchAccess({
        endpoint: req.path, source, sid, userId: req.userId, ip,
        allowed: false, reason: 'session_rate_limit',
      });
      return deny(res, 429);
    }
    logSearchAccess({
      endpoint: req.path, source, sid, userId: req.userId, ip, allowed: true,
    });
    next();
  };
}
module.exports = {
  searchGuard,
  createSearchSession,
  verifySearchSession,
  verifyTurnstile,
  clientIp,
  hashId,
  logSearchAccess,
  SESSION_TTL_SEC,
};

