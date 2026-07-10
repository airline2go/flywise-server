jest.mock('../src/clients/supabase', () => {
  const insertMock = jest.fn();
  return {
    from: jest.fn((table) => ({
      insert: (row) => insertMock(table, row),
    })),
    __insertMock: insertMock,
  };
});
jest.mock('../src/utils/log', () => jest.fn());

const supa = require('../src/clients/supabase');
const log = require('../src/utils/log');
const { categorizeEndpoint, recordApiLog } = require('../src/services/apiLogs');

beforeEach(() => {
  supa.from.mockClear();
  supa.__insertMock.mockReset().mockResolvedValue({ error: null });
  log.mockClear();
});

describe('categorizeEndpoint', () => {
  test('classifies offer-request paths as search', () => {
    expect(categorizeEndpoint('/air/offer_requests?return_offers=true')).toBe('search');
  });
  test('classifies order paths as booking', () => {
    expect(categorizeEndpoint('/air/orders')).toBe('booking');
    expect(categorizeEndpoint('/air/orders/ord_123')).toBe('booking');
  });
  test('classifies anything else as other', () => {
    expect(categorizeEndpoint('/places/suggestions')).toBe('other');
    expect(categorizeEndpoint('')).toBe('other');
    expect(categorizeEndpoint(undefined)).toBe('other');
  });
});

describe('recordApiLog', () => {
  test('inserts a row with the correct shape and derived category', () => {
    recordApiLog({ method: 'POST', path: '/air/offer_requests', statusCode: 200, success: true, durationMs: 150, logContext: { route_origin: 'BER', route_destination: 'CDG' } });
    expect(supa.from).toHaveBeenCalledWith('api_logs');
    expect(supa.__insertMock).toHaveBeenCalledWith('api_logs', {
      method: 'POST', endpoint: '/air/offer_requests', category: 'search',
      status_code: 200, success: true, duration_ms: 150,
      route_origin: 'BER', route_destination: 'CDG',
    });
  });

  test('defaults route_origin/destination to null when no logContext given', () => {
    recordApiLog({ method: 'GET', path: '/air/orders', statusCode: 200, success: true, durationMs: 50 });
    expect(supa.__insertMock).toHaveBeenCalledWith('api_logs', expect.objectContaining({ route_origin: null, route_destination: null }));
  });

  test('never throws synchronously even if the supabase client itself throws', () => {
    supa.from.mockImplementationOnce(() => { throw new Error('boom'); });
    expect(() => recordApiLog({ method: 'POST', path: '/air/orders', statusCode: 500, success: false, durationMs: 10 })).not.toThrow();
  });

  test('an async insert failure is logged via a warning, not thrown', async () => {
    supa.__insertMock.mockResolvedValueOnce({ error: { message: 'insert failed' } });
    recordApiLog({ method: 'POST', path: '/air/orders', statusCode: 500, success: false, durationMs: 10 });
    await new Promise((r) => setImmediate(r));
    expect(log).toHaveBeenCalledWith('warn', 'api_log_insert_failed', expect.objectContaining({ error: 'insert failed' }));
  });
});
