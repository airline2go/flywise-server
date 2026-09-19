process.env.DUFFEL_TOKEN = 'test-token';
process.env.SEARCH_SESSION_SECRET = 'test-search-session-secret';

const mockRecordApiLog = jest.fn();
jest.mock('../src/services/apiLogs', () => ({
  recordApiLog: (...args) => mockRecordApiLog(...args),
}));
jest.mock('../src/utils/log', () => jest.fn());
jest.mock('../src/clients/sentry', () => ({ captureMessage: jest.fn() }));

function freshDuffel() {
  jest.resetModules();
  return require('../src/services/duffel');
}

function fetchResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeEach(() => {
  mockRecordApiLog.mockReset();
  global.fetch = jest.fn();
});

const SEARCH_OPTS = { source: 'user_search', searchContext: { valid: true, sid: 'test-sid' } };

describe('duffel() — success path', () => {
  test('resolves with the parsed body and logs exactly one success entry', async () => {
    const duffel = freshDuffel();
    global.fetch.mockResolvedValue(fetchResponse(200, { data: { id: 'orq_1' } }));
    const result = await duffel('POST', '/air/offer_requests', { data: {} }, null, SEARCH_OPTS);
    expect(result).toEqual({ data: { id: 'orq_1' } });
    expect(mockRecordApiLog).toHaveBeenCalledTimes(1);
    expect(mockRecordApiLog).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST', path: '/air/offer_requests', statusCode: 200, success: true,
    }));
  });
});

describe('duffel() — non-transient (4xx) failure', () => {
  test('throws immediately (no retry) and logs exactly one failure entry', async () => {
    const duffel = freshDuffel();
    global.fetch.mockResolvedValue(fetchResponse(422, { errors: [{ message: 'invalid slice' }] }));
    await expect(duffel('POST', '/air/offer_requests', {}, null, SEARCH_OPTS)).rejects.toThrow('invalid slice');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('duffel() — transient search failure', () => {
  test('does not retry a search after a 5xx response', async () => {
    const duffel = freshDuffel();
    global.fetch
      .mockResolvedValueOnce(fetchResponse(502, { errors: [{ message: 'bad gateway' }] }))
      .mockResolvedValueOnce(fetchResponse(200, { data: { id: 'orq_2' } }));
    await expect(duffel('POST', '/air/offer_requests', {}, null, SEARCH_OPTS))
      .rejects.toThrow('bad gateway');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('duffel() — circuit breaker open', () => {
  test('rejects immediately with 503 once the circuit has tripped', async () => {
    const duffel = freshDuffel();
    global.fetch.mockResolvedValue(fetchResponse(503, { errors: [{ message: 'unavailable' }] }));
    for (let i = 0; i < 5; i++) {
      await expect(duffel('POST', '/air/offer_requests', {}, null, SEARCH_OPTS)).rejects.toThrow();
    }
    mockRecordApiLog.mockClear();
    global.fetch.mockClear();
    await expect(duffel('POST', '/air/offer_requests', {}, null, SEARCH_OPTS)).rejects.toThrow('vorübergehend nicht erreichbar');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('duffel() — P0.8 external deadline signal', () => {
  test('a pre-aborted signal ends the call terminally', async () => {
    const duffel = freshDuffel();
    const ac = new AbortController();
    ac.abort();
    await expect(duffel('GET', '/air/seat_maps?offer_id=x', null, null, { signal: ac.signal }))
      .rejects.toMatchObject({ code: 'UPSTREAM_DEADLINE', status: 504 });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('without a deadline signal, an AbortError is retried once', async () => {
    const duffel = freshDuffel();
    const err = new Error('The operation was aborted'); err.name = 'AbortError';
    global.fetch.mockRejectedValue(err);
    await expect(duffel('GET', '/air/offers/x')).rejects.toMatchObject({ status: 504 });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});

describe('duffel() — P0.9 error classification', () => {
  const cases = [
    [422, 'UPSTREAM_422'],
    [429, 'UPSTREAM_429'],
    [404, 'UPSTREAM_4XX'],
    [400, 'UPSTREAM_4XX'],
    [500, 'UPSTREAM_5XX'],
    [503, 'UPSTREAM_5XX'],
  ];
  test.each(cases)('HTTP %i is classified as %s', async (status, code) => {
    const duffel = freshDuffel();
    global.fetch.mockResolvedValue(fetchResponse(status, { errors: [{ message: 'x' }] }));
    await expect(duffel('GET', '/air/offers/x')).rejects.toMatchObject({ status, code });
  });

  test('classifyUpstreamStatus + exported taxonomy are consistent', () => {
    const duffel = freshDuffel();
    expect(duffel.classifyUpstreamStatus(422)).toBe('UPSTREAM_422');
    expect(duffel.UPSTREAM_ERROR_CODES.UPSTREAM_DEADLINE).toBe('UPSTREAM_DEADLINE');
  });
});

describe('duffel() — Search Service Guard', () => {
  test('refuses a Search path with no source and never hits the network', async () => {
    const duffel = freshDuffel();
    global.fetch.mockResolvedValue(fetchResponse(200, { data: {} }));
    await expect(duffel('POST', '/air/offer_requests', { data: {} }))
      .rejects.toMatchObject({ status: 403, code: 'SEARCH_GUARD_DENIED' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('refuses user_search without a valid Search Session context', async () => {
    const duffel = freshDuffel();
    global.fetch.mockResolvedValue(fetchResponse(200, { data: {} }));
    await expect(duffel('POST', '/air/offer_requests', {}, null, { source: 'user_search' }))
      .rejects.toMatchObject({ status: 403, code: 'SEARCH_GUARD_DENIED' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('allows user_search with a valid Search Session context', async () => {
    const duffel = freshDuffel();
    global.fetch.mockResolvedValue(fetchResponse(200, { data: { id: 'orq_ok' } }));
    const result = await duffel('POST', '/air/offer_requests', {}, null, SEARCH_OPTS);
    expect(result).toEqual({ data: { id: 'orq_ok' } });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('allows admin Search without a Search Session', async () => {
    const duffel = freshDuffel();
    global.fetch.mockResolvedValue(fetchResponse(200, { data: {} }));
    await duffel('GET', '/places/suggestions?query=BER', null, null, { source: 'admin' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('non-search paths still work without a Search Session', async () => {
    const duffel = freshDuffel();
    global.fetch.mockResolvedValue(fetchResponse(200, { data: { id: 'off_1' } }));
    const result = await duffel('GET', '/air/offers/off_1');
    expect(result).toEqual({ data: { id: 'off_1' } });
  });
});
