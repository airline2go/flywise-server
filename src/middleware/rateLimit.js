// ═════════════════════════════════════════════════════════════
// src/middleware/rateLimit.js
// [#9] العدادات بتتخزن في Redis عشان تعيش بعد أي إعادة تشغيل
// للسيرفر، بدل ما ترجع لصفر كل مرة Render يعيد تشغيل الخدمة. لو
// REDIS_URL مش موجود، أو Redis مش متاح لحظياً، كل طلب بيرجع
// تلقائي لنفس منطق الذاكرة المحلية القديم — الموقع أبدا معتمدش
// على شغل Redis عشان يفضل شغال.
//
// نفس التوقيع بالظبط زي القديم: rateLimit('bucket', max, windowMs)
// — عشان كل استخدام موجود في ملفات الراوتات يشتغل من غير أي تعديل.
// consumeRateLimit(bucket, key, max, windowMs) is the shared counter
// used by both IP middleware and Search Session rate limits.
// ═════════════════════════════════════════════════════════════

const redis = require('../clients/redis');
const log = require('../utils/log');

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

function rateLimit(bucket, max, windowMs) {
  return async function (req, res, next) {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
    const result = await consumeRateLimit(bucket, ip, max, windowMs);
    if (result.limited) {
      res.set('Retry-After', String(result.retryAfterSec));
      log('warn', 'rate_limited', { bucket, ip });
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
