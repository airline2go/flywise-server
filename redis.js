// ═══════════════════════════════════════════════════════════════
// src/clients/redis.js
// عميل Redis — لو REDIS_URL مش موجود أو الاتصال فشل، بيرجّع null
// وكل حاجة بتستخدمه (زي الـ rate limiter) بترجع تلقائي للذاكرة
// المحلية بدل ما توقف. الموقع أبداً معتمدش على Redis عشان يفضل شغال.
// ═══════════════════════════════════════════════════════════════

const env = require('./env');
const log = require('./log');

let redis = null;
if (env.REDIS_URL) {
  try {
    const Redis = require('ioredis');
    redis = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 1, // فشل سريع بدل ما يراكم طلبات في طابور
      retryStrategy: (times) => Math.min(times * 200, 2000),
      lazyConnect: false,
    });
    redis.on('error', (e) => log('warn', 'redis_error', { msg: e.message }));
    redis.on('connect', () => log('info', 'redis_connected', {}));
  } catch (e) {
    console.error('Redis init failed:', e.message);
    redis = null;
  }
}

module.exports = redis;
