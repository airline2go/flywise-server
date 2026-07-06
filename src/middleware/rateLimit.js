// ═══════════════════════════════════════════════════════════════
// src/middleware/rateLimit.js
// [#9] العدادات بتتخزن في Redis عشان تعيش بعد أي إعادة تشغيل
// للسيرفر، بدل ما ترجع لصفر كل مرة Render يعيد تشغيل الخدمة. لو
// REDIS_URL مش موجود، أو Redis مش متاح لحظياً، كل طلب بيرجع
// تلقائي لنفس منطق الذاكرة المحلية القديم — الموقع أبداً معتمدش
// على شغل Redis عشان يفضل شغال.
//
// نفس التوقيع بالظبط زي القديم: rateLimit('bucket', max, windowMs)
// — عشان كل استخدام موجود في ملفات الراوتات يشتغل من غير أي تعديل.
// ═══════════════════════════════════════════════════════════════

const redis = require('../clients/redis');
const log = require('../utils/log');

const rlStore = new Map(); // مخزن احتياطي (وبرضو المستخدم لما Redis واقع)

function rateLimitMemory(bucket, ip, max, windowMs) {
  const key = bucket + ':' + ip;
  const now = Date.now();
  let e = rlStore.get(key);
  if (!e || now > e.reset) { e = { count: 0, reset: now + windowMs }; rlStore.set(key, e); }
  e.count++;
  return { limited: e.count > max, retryAfterSec: Math.ceil((e.reset - now) / 1000) };
}

// مسار Redis — INCR + PEXPIRE بيدّينا عداد نافذة-ثابتة atomic من غير
// ما نحتاج Lua script. بيرجع للذاكرة تلقائياً لو حصل أي خطأ.
async function rateLimitRedis(bucket, ip, max, windowMs) {
  const key = 'rl:' + bucket + ':' + ip;
  const count = await redis.incr(key);
  if (count === 1) await redis.pexpire(key, windowMs);
  if (count > max) {
    const ttl = await redis.pttl(key);
    return { limited: true, retryAfterSec: Math.ceil(Math.max(ttl, 0) / 1000) };
  }
  return { limited: false, retryAfterSec: 0 };
}

function rateLimit(bucket, max, windowMs) {
  return async function (req, res, next) {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
    let result;
    if (redis && redis.status === 'ready') {
      try {
        result = await rateLimitRedis(bucket, ip, max, windowMs);
      } catch (e) {
        log('warn', 'redis_rl_fallback', { bucket, msg: e.message });
        result = rateLimitMemory(bucket, ip, max, windowMs);
      }
    } else {
      result = rateLimitMemory(bucket, ip, max, windowMs);
    }
    if (result.limited) {
      res.set('Retry-After', String(result.retryAfterSec));
      log('warn', 'rate_limited', { bucket, ip });
      return res.status(429).json({ ok: false, error: 'Zu viele Anfragen, bitte später erneut versuchen.' });
    }
    next();
  };
}

// تنظيف دوري للـ buckets المنتهية (مخزن الذاكرة بس — مفاتيح Redis
// بتنتهي لوحدها بـ PEXPIRE)
var _rlCleanup = setInterval(function () {
  const now = Date.now();
  for (const [k, v] of rlStore) { if (now > v.reset) rlStore.delete(k); }
}, 60000);
if (_rlCleanup.unref) _rlCleanup.unref();

module.exports = rateLimit;
