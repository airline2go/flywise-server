// ═══════════════════════════════════════════════════════════════
// src/routes/reviews.routes.js
// [REVIEWS-P0] Public reviews API. Writes require a verified Supabase
// auth token and always act on req.userId — verified/route/status/
// booking linkage are decided server-side (see services/reviews.js),
// never trusted from the body (§35). Same IDOR-safe pattern as
// referral.routes.js. Reads only ever return published reviews.
// ═══════════════════════════════════════════════════════════════

const rateLimit = require('../middleware/rateLimit');
const redis = require('../clients/redis');
const { attachUserIfPresent } = require('../middleware/auth');
const { validate } = require('../utils/validate');
const reviews = require('../services/reviews');

const SUBMIT_SCHEMA = {
  rating: { type: 'number', required: true, min: 1, max: 5 },
  comment: { type: 'string', required: false, min: 3, max: 2000 },
  author_name: { type: 'string', required: false, min: 1, max: 80 },
  country: { type: 'string', required: false, max: 80 },
  language: { type: 'string', required: false, max: 12 },
  liked_tags: { type: 'array', required: false, max: 5, of: { type: 'string', max: 40 } },
  booking_id: { type: 'string', required: false, max: 64 },
  booking_ref: { type: 'string', required: false, max: 40 },
  route_slug: { type: 'string', required: false, max: 120 },
  search_experience_rating: { type: 'number', required: false, min: 1, max: 5 },
  price_transparency_rating: { type: 'number', required: false, min: 1, max: 5 },
  information_rating: { type: 'number', required: false, min: 1, max: 5 },
  booking_experience_rating: { type: 'number', required: false, min: 1, max: 5 },
};

const SUBMIT_ERRORS = {
  db_unavailable: { status: 503, msg: 'Datenbank nicht verfügbar' },
  unauthenticated: { status: 401, msg: 'Nicht angemeldet' },
  invalid_rating: { status: 400, msg: 'Bewertung muss zwischen 1 und 5 liegen' },
  duplicate: { status: 409, msg: 'Du hast diese Buchung bereits bewertet' },
  insert_failed: { status: 500, msg: 'Bewertung konnte nicht gespeichert werden' },
};

// Public review lists are immutable between writes and can safely be cached
// for a short period. This protects Supabase from distributed bot floods:
// thousands of different IPs still converge on one Redis result per query.
const PUBLIC_CACHE_TTL_SEC = 30;
const localCache = new Map();

function normalizeReadQuery(req) {
  const route = req.query.route ? String(req.query.route).trim().slice(0, 120) : '';
  const rawLimit = req.query.limit == null ? 10 : Number(req.query.limit);
  const rawOffset = req.query.offset == null ? 0 : Number(req.query.offset);
  const limit = Number.isFinite(rawLimit) ? Math.min(20, Math.max(1, Math.floor(rawLimit))) : 10;
  const offset = Number.isFinite(rawOffset) ? Math.min(1000, Math.max(0, Math.floor(rawOffset))) : 0;
  return { route, limit, offset };
}

function cacheKey({ route, limit, offset }) {
  return `reviews:v2:${route || 'all'}:${limit}:${offset}`;
}

async function readCache(key) {
  if (redis && redis.status === 'ready') {
    try {
      const value = await redis.get(key);
      return value ? JSON.parse(value) : null;
    } catch (_) {}
  }
  const entry = localCache.get(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    if (entry) localCache.delete(key);
    return null;
  }
  return entry.value;
}

async function writeCache(key, value) {
  if (redis && redis.status === 'ready') {
    try { await redis.set(key, JSON.stringify(value), 'EX', PUBLIC_CACHE_TTL_SEC); } catch (_) {}
  }
  localCache.set(key, { value, expiresAt: Date.now() + PUBLIC_CACHE_TTL_SEC * 1000 });
}

module.exports = (app) => {
  app.post('/reviews', attachUserIfPresent, rateLimit('reviews_submit', 5, 3600000), async (req, res) => {
    try {
      if (!req.userId) return res.status(401).json({ ok: false, error: 'Nicht angemeldet' });
      const err = validate(req.body || {}, SUBMIT_SCHEMA);
      if (err) return res.status(400).json({ ok: false, error: err });

      const result = await reviews.submitReview(req.userId, req.body || {});
      if (!result.ok) {
        const e = SUBMIT_ERRORS[result.reason] || { status: 400, msg: 'Ungültige Bewertung' };
        return res.status(e.status).json({ ok: false, error: e.msg });
      }
      return res.status(201).json({ ok: true, id: result.id, status: result.status, verified: result.verified });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Public list: stricter per-IP limit + bounded pagination + short shared
  // cache. Cache is deliberately server-side so distributed bots cannot
  // multiply identical Supabase reads by rotating IP addresses.
  app.get('/reviews', rateLimit('reviews_read', 10, 60000), async (req, res) => {
    try {
      const { route, limit, offset } = normalizeReadQuery(req);
      const key = cacheKey({ route, limit, offset });
      const cached = await readCache(key);
      if (cached) {
        res.set('Cache-Control', `public, max-age=${PUBLIC_CACHE_TTL_SEC}, stale-while-revalidate=60`);
        return res.json(cached);
      }

      let routeId = null;
      if (route) {
        routeId = await reviews.resolveRouteIdBySlug(route);
        if (!routeId) {
          const empty = { ok: true, reviews: [], total: 0, aggregate: { average: null, count: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } } };
          await writeCache(key, empty);
          return res.json(empty);
        }
      }
      const [{ reviews: list, total }, aggregate] = await Promise.all([
        reviews.listPublishedReviews({ routeId, limit, offset }),
        reviews.computeAggregate({ routeId }),
      ]);
      const payload = { ok: true, reviews: list, total, aggregate };
      await writeCache(key, payload);
      res.set('Cache-Control', `public, max-age=${PUBLIC_CACHE_TTL_SEC}, stale-while-revalidate=60`);
      return res.json(payload);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/reviews/:id', rateLimit('reviews_read', 10, 60000), async (req, res) => {
    try {
      const id = String(req.params.id || '').trim().slice(0, 128);
      if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return res.status(404).json({ ok: false, error: 'Bewertung nicht gefunden' });
      const key = `reviews:v2:id:${id}`;
      const cached = await readCache(key);
      if (cached) {
        res.set('Cache-Control', `public, max-age=${PUBLIC_CACHE_TTL_SEC}, stale-while-revalidate=60`);
        return res.json(cached);
      }
      const review = await reviews.getPublishedReviewById(id);
      if (!review) return res.status(404).json({ ok: false, error: 'Bewertung nicht gefunden' });
      const payload = { ok: true, review };
      await writeCache(key, payload);
      res.set('Cache-Control', `public, max-age=${PUBLIC_CACHE_TTL_SEC}, stale-while-revalidate=60`);
      return res.json(payload);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
};
