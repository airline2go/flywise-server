// ═════════════════════════════════════════════════════════════
// src/middleware/rateLimit.js
// Redis-backed distributed rate limiter with safe local fallback.
// ═════════════════════════════════════════════════════════════

const redis = require('../clients/redis');
const log = require('../utils/log');
const { clientIp } = require('../utils/clientIp');

const rlStore = new Map();

function rateLimitMemory(bucket, key, max, windowMs) {
  const storeKey = bucket + ':' + key;
  const now = Date.now();
  let e = rlStore.get(storeKey);
  if (!e || now > e.reset) { e = { count: 0, reset: now + windowMs }; rlStore.set(storeKey, e); }
  e.count++;
  return { limited: e.count > max, retryAfterSec: Math.ceil((e.reset - now) / 1000) };
}

async function rateLimitRedis(bucket, key, max, windowMs) {
  const redisKey = 'rl:' + bucket + ':' + key;
  const count = await redis.incr(redisKey);
  if (count === 1) await redis.pexpire(redisKey, windowMs);
  if (count > max) {
    const ttl = await redis.pttl(redisKey);
    return { limited: true, retryAfterSec: Math.ceil(Math.max(ttl, 0) / 1000) };
  }
  return { limited: false, retryAfterSec: 0 };
}

async function consumeRateLimit(bucket, key, max, windowMs) {
  if (redis && redis.status === 'ready') {
    try {
      return await rateLimitRedis(bucket, key, max, windowMs);
    } catch (e) {
      log('warn', 'redis_rl_fallback', { bucket, msg: e.message });
      return rateLimitMemory(bucket, key, max, windowMs);
    }
  }
  return rateLimitMemory(bucket, key, max, windowMs);
}

function getClientKey(req) {
  return clientIp(req).slice(0, 64);
}

function rateLimit(bucket, max, windowMs) {
  return async function (req, res, next) {
    const key = getClientKey(req);
    const result = await consumeRateLimit(bucket, key, max, windowMs);
    if (result.limited) {
      res.set('Retry-After', String(result.retryAfterSec));
      log('warn', 'rate_limited', { bucket, ip: key });
      return res.status(429).json({ ok: false, error: 'Zu viele Anfragen, bitte später erneut versuchen.' });
    }
    next();
  };
}

var _rlCleanup = setInterval(function () {
  const now = Date.now();
  for (const [k, v] of rlStore) { if (now > v.reset) rlStore.delete(k); }
}, 60000);
if (_rlCleanup.unref) _rlCleanup.unref();

module.exports = rateLimit;
module.exports.consumeRateLimit = consumeRateLimit;
module.exports.getClientKey = getClientKey;

