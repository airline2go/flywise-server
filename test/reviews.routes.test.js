// [REVIEWS-P0] Route-level tests for auth gating, shape validation, and service delegation.
jest.mock('../src/clients/supabase', () => {
  const mockGetUser = jest.fn();
  return { auth: { getUser: mockGetUser }, __mockGetUser: mockGetUser };
});
const mockSubmitReview = jest.fn(); const mockListPublished = jest.fn(); const mockGetById = jest.fn(); const mockAggregate = jest.fn(); const mockResolveRoute = jest.fn();
jest.mock('../src/services/reviews', () => ({ submitReview: (...a) => mockSubmitReview(...a), listPublishedReviews: (...a) => mockListPublished(...a), getPublishedReviewById: (...a) => mockGetById(...a), computeAggregate: (...a) => mockAggregate(...a), resolveRouteIdBySlug: (...a) => mockResolveRoute(...a) }));
jest.mock('../src/utils/log', () => jest.fn());
const express = require('express'); const request = require('supertest'); const supa = require('../src/clients/supabase');
function buildApp() {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { if (!req.headers['user-agent']) req.headers['user-agent'] = 'Mozilla/5.0'; next(); });
  require('../src/routes/reviews.routes')(app); return app;
}
const app = buildApp();
function authAs(userId, email) { supa.__mockGetUser.mockResolvedValue({ data: { user: { id: userId, email: email || null } }, error: null }); return { Authorization: 'Bearer valid-token' }; }
let ipCounter = 0; function nextIp() { ipCounter += 1; return '10.9.0.' + ipCounter; }
beforeEach(() => { supa.__mockGetUser.mockReset().mockResolvedValue({ data: null, error: { message: 'invalid token' } }); mockSubmitReview.mockReset(); mockListPublished.mockReset(); mockGetById.mockReset(); mockAggregate.mockReset(); mockResolveRoute.mockReset(); });

describe('POST /reviews', () => {
  test('401s when not authenticated', async () => { const res = await request(app).post('/reviews').set('X-Forwarded-For', nextIp()).send({ rating: 5 }); expect(res.status).toBe(401); expect(mockSubmitReview).not.toHaveBeenCalled(); });
  test('400s on an out-of-range rating', async () => { const res = await request(app).post('/reviews').set(authAs('u1')).set('X-Forwarded-For', nextIp()).send({ rating: 9 }); expect(res.status).toBe(400); expect(mockSubmitReview).not.toHaveBeenCalled(); });
  test('400s when rating is missing', async () => { const res = await request(app).post('/reviews').set(authAs('u1')).set('X-Forwarded-For', nextIp()).send({ comment: 'nice' }); expect(res.status).toBe(400); });
  test('201 on success and passes verified user id + body to service', async () => { mockSubmitReview.mockResolvedValue({ ok: true, id: 'r1', status: 'pending', verified: true }); const res = await request(app).post('/reviews').set(authAs('real-user')).set('X-Forwarded-For', nextIp()).send({ rating: 5, comment: 'Easy to compare flights', booking_id: 'b1' }); expect(res.status).toBe(201); expect(res.body).toMatchObject({ ok: true, id: 'r1', status: 'pending', verified: true }); expect(mockSubmitReview).toHaveBeenCalledWith('real-user', expect.objectContaining({ rating: 5, booking_id: 'b1' })); });
  test('409 when service reports duplicate booking review', async () => { mockSubmitReview.mockResolvedValue({ ok: false, reason: 'duplicate' }); const res = await request(app).post('/reviews').set(authAs('u1')).set('X-Forwarded-For', nextIp()).send({ rating: 4, booking_id: 'b1' }); expect(res.status).toBe(409); });
  test('short comment is rejected before reaching service', async () => { const res = await request(app).post('/reviews').set(authAs('u1')).set('X-Forwarded-For', nextIp()).send({ rating: 4, comment: 'x' }); expect(res.status).toBe(400); expect(mockSubmitReview).not.toHaveBeenCalled(); });
});

describe('GET /reviews', () => {
  test('returns published reviews + aggregate', async () => { mockListPublished.mockResolvedValue({ reviews: [{ id: 'r1', rating: 5 }], total: 1 }); mockAggregate.mockResolvedValue({ average: 4.7, count: 183, distribution: { 5: 150, 4: 20, 3: 8, 2: 3, 1: 2 } }); const res = await request(app).get('/reviews').set('X-Forwarded-For', nextIp()); expect(res.status).toBe(200); expect(res.body.aggregate.average).toBe(4.7); expect(res.body.total).toBe(1); expect(mockAggregate).toHaveBeenCalledWith({ routeId: null }); });
  test('resolves ?route=slug to a route id server-side', async () => { mockResolveRoute.mockResolvedValue('route-123'); mockListPublished.mockResolvedValue({ reviews: [], total: 0 }); mockAggregate.mockResolvedValue({ average: null, count: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } }); const res = await request(app).get('/reviews?route=berlin-barcelona').set('X-Forwarded-For', nextIp()); expect(res.status).toBe(200); expect(mockResolveRoute).toHaveBeenCalledWith('berlin-barcelona'); expect(mockListPublished).toHaveBeenCalledWith(expect.objectContaining({ routeId: 'route-123' })); });
  test('unknown/non-published route returns empty', async () => { mockResolveRoute.mockResolvedValue(null); const res = await request(app).get('/reviews?route=nope').set('X-Forwarded-For', nextIp()); expect(res.status).toBe(200); expect(res.body.total).toBe(0); expect(res.body.aggregate.count).toBe(0); expect(mockListPublished).not.toHaveBeenCalled(); });
});

describe('GET /reviews/:id', () => {
  test('404 when not found / not published', async () => { mockGetById.mockResolvedValue(null); const res = await request(app).get('/reviews/r-missing').set('X-Forwarded-For', nextIp()); expect(res.status).toBe(404); });
  test('returns a published review', async () => { mockGetById.mockResolvedValue({ id: 'r1', rating: 5, comment: 'great' }); const res = await request(app).get('/reviews/r1').set('X-Forwarded-For', nextIp()); expect(res.status).toBe(200); expect(res.body.review.id).toBe('r1'); });
});
