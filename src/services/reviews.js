// ═══════════════════════════════════════════════════════════════
// src/services/reviews.js
// [REVIEWS-P0] Server-authoritative reviews for the Airpiv experience.
//
// The old feedback card in app.js wrote reviews straight from the
// browser into Supabase (user_id + stars + comment), with no
// verification, moderation, route linkage or aggregate. This service
// makes reviews real and trustworthy: every write happens here with the
// service-role key, and every field the client must NOT be able to forge
// (verified, route_id, booking_id, status) is decided by the server from
// data it verified itself — the request body is never trusted for them
// (§6/§23/§35). Same IDOR-safe posture as referrals.js.
//
// Reads only ever expose `status = 'published'` rows, and the aggregate
// (average / count / distribution) is computed live from published rows
// only (§21) — never stored as a hand-maintained number.
// ═══════════════════════════════════════════════════════════════

const supa = require('../clients/supabase');
const log = require('../utils/log');

// The fixed "What did you like?" checkboxes (§7). Anything else the client
// sends is dropped, so this can never become a free-text keyword-stuffing
// vector (§38).
const LIKED_TAGS = ['easy_search', 'clear_prices', 'fast_results', 'good_information', 'easy_booking'];

const STATUSES = ['pending', 'published', 'rejected', 'deleted'];

function clampRating(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 5) return null;
  return n;
}

// Optional 1–5 sub-rating — returns null for anything not a valid 1–5
// integer (so a garbage value is simply omitted, never rejected).
function optRating(v) {
  if (v === undefined || v === null || v === '') return null;
  return clampRating(v);
}

function cleanLikedTags(arr) {
  if (!Array.isArray(arr)) return null;
  const seen = new Set();
  for (const t of arr) {
    if (typeof t === 'string' && LIKED_TAGS.includes(t)) seen.add(t);
  }
  return seen.size ? Array.from(seen) : null;
}

// Resolve a route SLUG (untrusted, from the browser) to a real published
// route_pages id (§23/§24 — never trust a client-supplied route_id, and
// never attach a review to a non-published route). Returns null when the
// slug is unknown or the route isn't published.
async function resolveRouteIdBySlug(slug) {
  if (!supa || !slug || typeof slug !== 'string') return null;
  const { data, error } = await supa
    .from('route_pages')
    .select('id')
    .eq('slug', slug.trim().toLowerCase())
    .eq('status', 'published')
    .maybeSingle();
  if (error) { log('warn', 'reviews_route_resolve_failed', { slug, error: error.message }); return null; }
  return data ? data.id : null;
}

// Verify a booking really belongs to this user, and derive its published
// route_id from the booking's own origin/destination. Returns
// { ok, routeId } — ok=false means the booking isn't the caller's (so the
// review is still allowed, but never gets verified=true / booking linkage).
async function verifyBookingAndResolveRoute(userId, bookingId) {
  if (!supa || !userId || !bookingId) return { ok: false, routeId: null };
  const { data: booking, error } = await supa
    .from('bookings')
    .select('id, user_id, origin, destination')
    .eq('id', bookingId)
    .maybeSingle();
  if (error) { log('warn', 'reviews_booking_lookup_failed', { error: error.message }); return { ok: false, routeId: null }; }
  if (!booking || booking.user_id !== userId) return { ok: false, routeId: null };

  let routeId = null;
  if (booking.origin && booking.destination) {
    const { data: route } = await supa
      .from('route_pages')
      .select('id')
      .eq('origin_iata', String(booking.origin).toUpperCase())
      .eq('destination_iata', String(booking.destination).toUpperCase())
      .eq('status', 'published')
      .maybeSingle();
    routeId = route ? route.id : null;
  }
  return { ok: true, routeId };
}

// Submit a review. `userId` comes from the caller's VERIFIED auth token.
// `input` is the (already sanitized/validated-shape) request body. Returns
// { ok, id, status, verified } or { ok:false, reason }.
async function submitReview(userId, input) {
  if (!supa) return { ok: false, reason: 'db_unavailable' };
  if (!userId) return { ok: false, reason: 'unauthenticated' };

  const rating = clampRating(input.rating);
  if (rating === null) return { ok: false, reason: 'invalid_rating' };

  // Server decides verified + linkage. A booking_id only counts if it's
  // really the caller's booking; otherwise it's silently dropped (never an
  // error, and never grants the verified badge).
  let verified = false;
  let bookingId = null;
  let routeId = null;

  if (input.booking_id) {
    const v = await verifyBookingAndResolveRoute(userId, input.booking_id);
    if (v.ok) { verified = true; bookingId = input.booking_id; routeId = v.routeId; }
  }

  // A general (non-booking) review may still name the route the traveler
  // used, resolved server-side from its slug against published routes only.
  if (!routeId && input.route_slug) {
    routeId = await resolveRouteIdBySlug(input.route_slug);
  }

  const row = {
    user_id: userId,
    rating,
    stars: rating, // keep the legacy column in sync so old readers stay correct
    comment: typeof input.comment === 'string' && input.comment.trim() ? input.comment.trim() : null,
    author_name: typeof input.author_name === 'string' && input.author_name.trim() ? input.author_name.trim().slice(0, 80) : null,
    country: typeof input.country === 'string' && input.country.trim() ? input.country.trim().slice(0, 80) : null,
    language: typeof input.language === 'string' && input.language.trim() ? input.language.trim().slice(0, 12) : null,
    liked_tags: cleanLikedTags(input.liked_tags),
    search_experience_rating: optRating(input.search_experience_rating),
    price_transparency_rating: optRating(input.price_transparency_rating),
    information_rating: optRating(input.information_rating),
    booking_experience_rating: optRating(input.booking_experience_rating),
    booking_id: bookingId,
    route_id: routeId,
    verified,
    status: 'pending', // every review starts pending — moderation decides (§10)
  };

  const { data, error } = await supa.from('reviews').insert(row).select('id, status, verified').maybeSingle();
  if (error) {
    // 23505 = unique_violation → one review per (user, booking) (§5).
    if (error.code === '23505') return { ok: false, reason: 'duplicate' };
    log('warn', 'reviews_insert_failed', { error: error.message, code: error.code });
    return { ok: false, reason: 'insert_failed' };
  }
  return { ok: true, id: data.id, status: data.status, verified: data.verified };
}

// Public list of published reviews, newest first. `routeId` filters to one
// route (the route page section); omit it for the central /reviews page.
async function listPublishedReviews({ routeId = null, limit = 10, offset = 0 } = {}) {
  if (!supa) return { reviews: [], total: 0 };
  const lim = Math.min(Math.max(Number(limit) || 10, 1), 50);
  const off = Math.max(Number(offset) || 0, 0);
  let q = supa
    .from('reviews')
    .select('id, rating, comment, author_name, country, language, liked_tags, verified, created_at, ' +
      'search_experience_rating, price_transparency_rating, information_rating, booking_experience_rating',
      { count: 'exact' })
    .eq('status', 'published')
    .order('created_at', { ascending: false })
    .range(off, off + lim - 1);
  if (routeId) q = q.eq('route_id', routeId);
  const { data, error, count } = await q;
  if (error) { log('warn', 'reviews_list_failed', { error: error.message }); return { reviews: [], total: 0 }; }
  return { reviews: data || [], total: count || 0 };
}

async function getPublishedReviewById(id) {
  if (!supa || !id) return null;
  const { data, error } = await supa
    .from('reviews')
    .select('id, rating, comment, author_name, country, language, liked_tags, verified, created_at')
    .eq('id', id)
    .eq('status', 'published')
    .maybeSingle();
  if (error) { log('warn', 'reviews_get_failed', { error: error.message }); return null; }
  return data || null;
}

// Live aggregate from PUBLISHED rows only (§21/§22). Uses head-count
// queries per rating bucket so it never loads every row into memory, and
// so it scales to a big central total. Returns
// { average, count, distribution: {1..5} } — average is null when count=0
// (so callers can decide not to render an empty rating, §14/§19).
async function computeAggregate({ routeId = null } = {}) {
  const empty = { average: null, count: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } };
  if (!supa) return empty;
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let total = 0;
  let sum = 0;
  for (let r = 1; r <= 5; r++) {
    let q = supa.from('reviews').select('*', { count: 'exact', head: true }).eq('status', 'published').eq('rating', r);
    if (routeId) q = q.eq('route_id', routeId);
    // eslint-disable-next-line no-await-in-loop -- 5 cheap head-count queries, intentionally sequential
    const { count, error } = await q;
    if (error) { log('warn', 'reviews_aggregate_failed', { error: error.message }); return empty; }
    const c = count || 0;
    distribution[r] = c;
    total += c;
    sum += c * r;
  }
  if (total === 0) return empty;
  return { average: Math.round((sum / total) * 10) / 10, count: total, distribution };
}

module.exports = {
  submitReview,
  listPublishedReviews,
  getPublishedReviewById,
  computeAggregate,
  resolveRouteIdBySlug,
  verifyBookingAndResolveRoute,
  LIKED_TAGS,
  STATUSES,
};
