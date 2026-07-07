jest.mock('../src/clients/supabase', () => {
  const mockGetUser = jest.fn();
  return {
    auth: { getUser: mockGetUser },
    __mockGetUser: mockGetUser,
  };
});

const mockGetOrCreateReferralCode = jest.fn();
const mockLinkNewUser = jest.fn();
const mockCheckAndPayout = jest.fn();
const mockGetMyReferralList = jest.fn();
jest.mock('../src/services/referrals', () => ({
  getOrCreateReferralCode: (...args) => mockGetOrCreateReferralCode(...args),
  linkNewUser: (...args) => mockLinkNewUser(...args),
  checkAndPayout: (...args) => mockCheckAndPayout(...args),
  getMyReferralList: (...args) => mockGetMyReferralList(...args),
}));

jest.mock('../src/utils/log', () => jest.fn());

const express = require('express');
const request = require('supertest');
const supa = require('../src/clients/supabase');

function buildApp() {
  const app = express();
  app.use(express.json());
  require('../src/routes/referral.routes')(app);
  return app;
}

const app = buildApp();

function authAs(userId, email) {
  supa.__mockGetUser.mockResolvedValue({ data: { user: { id: userId, email: email || null } }, error: null });
  return { Authorization: 'Bearer valid-token' };
}

let ipCounter = 0;
function nextIp() { ipCounter += 1; return '10.2.0.' + ipCounter; }

beforeEach(() => {
  supa.__mockGetUser.mockReset().mockResolvedValue({ data: null, error: { message: 'invalid token' } });
  mockGetOrCreateReferralCode.mockReset();
  mockLinkNewUser.mockReset();
  mockCheckAndPayout.mockReset();
  mockGetMyReferralList.mockReset();
});

describe('GET /referrals/my-code', () => {
  test('401s when not authenticated', async () => {
    const res = await request(app).get('/referrals/my-code').set('X-Forwarded-For', nextIp());
    expect(res.status).toBe(401);
  });

  test('returns the code for an authenticated user', async () => {
    mockGetOrCreateReferralCode.mockResolvedValue('AP-ABC123');
    const res = await request(app).get('/referrals/my-code').set(authAs('u1')).set('X-Forwarded-For', nextIp());
    expect(res.status).toBe(200);
    expect(res.body.code).toBe('AP-ABC123');
    expect(mockGetOrCreateReferralCode).toHaveBeenCalledWith('u1');
  });
});

describe('POST /referrals/link', () => {
  test('401s when not authenticated', async () => {
    const res = await request(app).post('/referrals/link').set('X-Forwarded-For', nextIp()).send({ referrer_code: 'AP-X' });
    expect(res.status).toBe(401);
  });

  test('400s without a referrer_code', async () => {
    const res = await request(app).post('/referrals/link').set(authAs('u1')).set('X-Forwarded-For', nextIp()).send({});
    expect(res.status).toBe(400);
  });

  test('uses the verified user id/email, never anything from the body', async () => {
    mockLinkNewUser.mockResolvedValue({ linked: true });
    const res = await request(app).post('/referrals/link').set(authAs('real-user', 'real@x.com')).set('X-Forwarded-For', nextIp())
      .send({ referrer_code: 'AP-X', referred_id: 'attacker-supplied', referred_email: 'attacker@x.com' });
    expect(res.status).toBe(200);
    expect(res.body.linked).toBe(true);
    expect(mockLinkNewUser).toHaveBeenCalledWith('real-user', 'real@x.com', 'AP-X');
  });
});

describe('POST /referrals/check-payout', () => {
  test('401s when not authenticated', async () => {
    const res = await request(app).post('/referrals/check-payout').set('X-Forwarded-For', nextIp());
    expect(res.status).toBe(401);
  });

  test('returns how much was credited for the verified user', async () => {
    mockCheckAndPayout.mockResolvedValue({ creditedNow: 10 });
    const res = await request(app).post('/referrals/check-payout').set(authAs('u1')).set('X-Forwarded-For', nextIp());
    expect(res.status).toBe(200);
    expect(res.body.credited_now).toBe(10);
    expect(mockCheckAndPayout).toHaveBeenCalledWith('u1');
  });
});

describe('GET /referrals/my-list', () => {
  test('401s when not authenticated', async () => {
    const res = await request(app).get('/referrals/my-list').set('X-Forwarded-For', nextIp());
    expect(res.status).toBe(401);
  });

  test('returns the verified user\'s own referral list', async () => {
    mockGetMyReferralList.mockResolvedValue([{ referred_email: 'a@x.com', status: 'pending' }]);
    const res = await request(app).get('/referrals/my-list').set(authAs('u1')).set('X-Forwarded-For', nextIp());
    expect(res.status).toBe(200);
    expect(res.body.referrals).toHaveLength(1);
    expect(mockGetMyReferralList).toHaveBeenCalledWith('u1');
  });
});
