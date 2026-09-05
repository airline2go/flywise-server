process.env.DUFFEL_TOKEN = 'test-token';

const mockRecordApiLog = jest.fn();
jest.mock('../src/services/apiLogs', () => ({
  recordApiLog: (...args) => mockRecordApiLog(...args),
}));
jest.mock('../src/utils/log', () => jest.fn());
jest.mock('../src/clients/sentry', () => ({ captureMessage: jest.fn() }));

// [ISOLATION] The circuit breaker is module-level state — each test gets
// a fully fresh require so one test's failures never bleed into the next.
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

describe('duffel() — success path', () => {
  test('resolves with the parsed body and logs exactly one success entry', async () => {
    const duffel = freshDuffel();
    global.fetch.mockResolvedValue(fetchResponse(200, { data: { id: 'orq_1' } }));
    const result = await duffel('POST', '/air/offer_requests', { data: {} });
    expect(result).toEqual({ data: { id: 'orq_1' } });
    expect(mockRecordApiLog).toHaveBeenCalledTimes(1);
    expect(mockRecordApiLog).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST', path: '/air/offer_requests', statusCode: 200, success: true,
    }));
    expect(mockRecordApiLog.mock.calls[0][0].durationMs).toEqual(expect.any(Number));
  });

  test('passes logContext through to the log entry untouched', async () => {
    const duffel = freshDuffel();
    global.fetch.mockResolvedValue(fetchResponse(200, { data: {} }));
    await duffel('POST', '/air/offer_requests', {}, null, { logContext: { route_origin: 'BER', route_destination: 'CDG' } });
    expect(mockRecordApiLog).toHaveBeenCalledWith(expect.objectContaining({
      logContext: { route_origin: 'BER', route_destination: 'CDG' },
    }));
  });
});

describe('duffel() — non-transient (4xx) failure', () => {
  test('throws immediately (no retry) and logs exactly one failure entry', async () => {
    const duffel = freshDuffel();
    global.fetch.mockResolvedValue(fetchResponse(422, { errors: [{ message: 'invalid slice' }] }));
    await expect(duffel('POST', '/air/offer_requests', {})).rejects.toThrow('invalid slice');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mockRecordApiLog).toHaveBeenCalledTimes(1);
    expect(mockRecordApiLog).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 422, success: false }));
  });
});

describe('duffel() — transient (5xx) failure with retry', () => {
  test('retries once on 5xx and logs exactly ONE entry for the whole call, not one per attempt', async () => {
    const duffel = freshDuffel();
    global.fetch
      .mockResolvedValueOnce(fetchResponse(502, { errors: [{ message: 'bad gateway' }] }))
      .mockResolvedValueOnce(fetchResponse(200, { data: { id: 'orq_2' } }));
    const result = await duffel('POST', '/air/offer_requests', {});
    expect(result).toEqual({ data: { id: 'orq_2' } });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(mockRecordApiLog).toHaveBeenCalledTimes(1);
    expect(mockRecordApiLog).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 200, success: true }));
  });

  test('a transient failure that never recovers logs exactly one failure entry after both attempts', async () => {
    const duffel = freshDuffel();
    global.fetch.mockResolvedValue(fetchResponse(503, { errors: [{ message: 'unavailable' }] }));
    await expect(duffel('POST', '/air/offer_requests', {})).rejects.toThrow('unavailable');
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(mockRecordApiLog).toHaveBeenCalledTimes(1);
    expect(mockRecordApiLog).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 503, success: false }));
  });
});

describe('duffel() — circuit breaker open', () => {
  test('rejects immediately with 503 and logs a 503 entry once the circuit has tripped', async () => {
    const duffel = freshDuffel();
    global.fetch.mockResolvedValue(fetchResponse(503, { errors: [{ message: 'unavailable' }] }));
    // 5 consecutive failing calls trips the breaker (DUFFEL_FAILURE_THRESHOLD = 5).
    for (let i = 0; i < 5; i++) {
      await expect(duffel('POST', '/air/offer_requests', {})).rejects.toThrow();
    }
    mockRecordApiLog.mockClear();
    global.fetch.mockClear();

    await expect(duffel('POST', '/air/offer_requests', {})).rejects.toThrow('vorübergehend nicht erreichbar');
    expect(global.fetch).not.toHaveBeenCalled(); // circuit rejected before any network call
    expect(mockRecordApiLog).toHaveBeenCalledTimes(1);
    expect(mockRecordApiLog).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 503, success: false }));
  });
});

// [P0.8 · DEADLINE] External deadline signal support.
describe('duffel() — P0.8 external deadline signal', () => {
  test('a pre-aborted signal ends the call terminally (UPSTREAM_DEADLINE), never touches the network, never retries', async () => {
    const duffel = freshDuffel();
    const ac = new AbortController();
    ac.abort();
    await expect(duffel('GET', '/air/seat_maps?offer_id=x', null, null, { signal: ac.signal }))
      .rejects.toMatchObject({ code: 'UPSTREAM_DEADLINE', status: 504 });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockRecordApiLog).toHaveBeenCalledTimes(1);
    expect(mockRecordApiLog).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 504, success: false }));
  });

  test('a signal that aborts mid-flight yields a terminal UPSTREAM_DEADLINE and is NOT retried', async () => {
    const duffel = freshDuffel();
    const ac = new AbortController();
    // Simulate the deadline firing while the request is in flight: abort, then
    // reject with the AbortError fetch would raise.
    global.fetch.mockImplementation(() => {
      ac.abort();
      const err = new Error('The operation was aborted'); err.name = 'AbortError';
      return Promise.reject(err);
    });
    await expect(duffel('GET', '/air/offers/x', null, null, { signal: ac.signal }))
      .rejects.toMatchObject({ code: 'UPSTREAM_DEADLINE' });
    expect(global.fetch).toHaveBeenCalledTimes(1); // terminal — no second attempt
  });

  test('without a deadline signal, an AbortError is our own timeout (504, retried once) — unchanged behaviour', async () => {
    const duffel = freshDuffel();
    const err = new Error('The operation was aborted'); err.name = 'AbortError';
    global.fetch.mockRejectedValue(err);
    await expect(duffel('GET', '/air/offers/x')).rejects.toMatchObject({ status: 504 });
    expect(global.fetch).toHaveBeenCalledTimes(2); // transient timeout is retried once
  });
});

// [P0.9 · ERROR TAXONOMY] Every duffel() failure carries a stable err.code.
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

  test('our own per-request timeout is UPSTREAM_TIMEOUT (status 504)', async () => {
    const duffel = freshDuffel();
    const err = new Error('aborted'); err.name = 'AbortError';
    global.fetch.mockRejectedValue(err);
    await expect(duffel('GET', '/air/offers/x')).rejects.toMatchObject({ status: 504, code: 'UPSTREAM_TIMEOUT' });
  });

  test('a transport failure (no HTTP response) is UPSTREAM_NETWORK', async () => {
    const duffel = freshDuffel();
    global.fetch.mockRejectedValue(new Error('ECONNRESET'));
    await expect(duffel('GET', '/air/offers/x')).rejects.toMatchObject({ code: 'UPSTREAM_NETWORK' });
  });

  test('classifyUpstreamStatus + exported taxonomy are consistent', () => {
    const duffel = freshDuffel();
    expect(duffel.classifyUpstreamStatus(422)).toBe('UPSTREAM_422');
    expect(duffel.classifyUpstreamStatus(429)).toBe('UPSTREAM_429');
    expect(duffel.classifyUpstreamStatus(418)).toBe('UPSTREAM_4XX');
    expect(duffel.classifyUpstreamStatus(502)).toBe('UPSTREAM_5XX');
    expect(duffel.UPSTREAM_ERROR_CODES.UPSTREAM_DEADLINE).toBe('UPSTREAM_DEADLINE');
    expect(duffel.UPSTREAM_ERROR_CODES.UPSTREAM_CIRCUIT_OPEN).toBe('UPSTREAM_CIRCUIT_OPEN');
  });
});
