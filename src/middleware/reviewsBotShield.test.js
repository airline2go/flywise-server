const reviewsBotShield = require('./reviewsBotShield');

describe('reviewsBotShield', () => {
  test('blocks empty user-agent before route work', async () => {
    const req = { headers: {}, id: 'test' };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    await reviewsBotShield()(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('blocks obvious scripted clients', async () => {
    const req = { headers: { 'user-agent': 'python-requests/2.x' }, id: 'test' };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    await reviewsBotShield()(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
