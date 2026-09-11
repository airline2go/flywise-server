// ═══════════════════════════════════════════════════════════════
// src/routes/reviews.routes.js
// [REVIEWS-P0] Public reviews API. Writes require a verified Supabase
// auth token and always act on req.userId — verified/route/status/
// booking linkage are decided server-side (see services/reviews.js),
// never trusted from the body (§35). Same IDOR-safe pattern as
// referral.routes.js. Reads only ever return published reviews.
// ═══════════════════════════════════════════════════════════════

const rateLimit = require('../middleware/rateLimit');
const { attachUserIfPresent } = require('../middleware/auth');
const { validate } = require('../utils/validate');
const reviews = require('../services/reviews');

// Shape validation only — the service still re-derives every trust-
// sensitive field itself. `comment` is encouraged but optional (§8);
// when present it must be substantive (>= 3 chars) and bounded.
const SUBMIT_SCHEMA = {
  rating: { type: 'number', required: true, min: 1, max: 5 },
  comment: { type: 'string', required: false, min: 3, max: 2000 },
  author_name: { type: 'string', required: false, min: 1, max: 80 },
  country: { type: 'string', required: false, max: 80 },
  language: { type: 'string', required: false, max: 12 },
  liked_tags: { type: 'array', required: false, max: 5, of: { type: 'string', max: 40 } },
  booking_id: { type: 'string', required: false, max: 64 },
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

module.exports = (app) => {

  // Submit a review. Auth required (author-only, per the table's RLS and
  // the plan's "logged-in + general" policy). Tight rate-limit on top of
  // the DB's one-per-booking unique index, to bound general/spam
  // submissions (§5/§9).
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
      // Always 'pending' — tell the client so it can show "under review"
      // instead of pretending the review is already live.
      return res.status(201).json({ ok: true, id: result.id, status: result.status, verified: result.verified });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Public list of published reviews + live aggregate. `?route=<slug>`
  // scopes to one published route (resolved server-side); omit it for the
  // central /reviews page. Pagination via limit/offset (§15).
  app.get('/reviews', rateLimit('reviews_read', 120, 60000), async (req, res) => {
    try {
      let routeId = null;
      if (req.query.route) {
        routeId = await reviews.resolveRouteIdBySlug(String(req.query.route));
        // Unknown/non-published route → empty, never an error (§24).
        if (!routeId) return res.json({ ok: true, reviews: [], total: 0, aggregate: { average: null, count: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } } });
      }
      const limit = req.query.limit ? Number(req.query.limit) : 10;
      const offset = req.query.offset ? Number(req.query.offset) : 0;
      const [{ reviews: list, total }, aggregate] = await Promise.all([
        reviews.listPublishedReviews({ routeId, limit, offset }),
        reviews.computeAggregate({ routeId }),
      ]);
      res.json({ ok: true, reviews: list, total, aggregate });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // A single published review.
  app.get('/reviews/:id', rateLimit('reviews_read', 120, 60000), async (req, res) => {
    try {
      const review = await reviews.getPublishedReviewById(req.params.id);
      if (!review) return res.status(404).json({ ok: false, error: 'Bewertung nicht gefunden' });
      res.json({ ok: true, review });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
};
