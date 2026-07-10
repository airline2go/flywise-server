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
