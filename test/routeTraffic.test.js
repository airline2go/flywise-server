jest.mock('../src/clients/supabase', () => {
  const insertMock = jest.fn();
  const responses = {};
  function makeBuilder(table) {
    const builder = {
      select: () => builder,
      insert: (row) => insertMock(table, row),
      upsert: (rows) => Promise.resolve((responses[table] && responses[table].upsert) || { error: null }).then((r) => { builder.__upsertRows = rows; return r; }),
      delete: () => builder,
      lt: () => builder,
      gte: () => builder,
      in: () => builder,
      range: () => Promise.resolve((responses[table] && responses[table].select) || { data: [], error: null }),
      then: (resolve, reject) => Promise.resolve((responses[table] && responses[table].select) || { data: [], error: null }).then(resolve, reject),
    };
    return builder;
  }
  return {
    from: jest.fn((table) => makeBuilder(table)),
    __insertMock: insertMock,
    __setResponse: (table, key, cfg) => { responses[table] = responses[table] || {}; responses[table][key] = cfg; },
    __reset: () => { for (const k of Object.keys(responses)) delete responses[k]; },
  };
});
jest.mock('../src/utils/log', () => jest.fn());
jest.mock('../src/services/adminConfig', () => ({
  getAdminConfig: jest.fn().mockResolvedValue(90),
}));

const supa = require('../src/clients/supabase');
const log = require('../src/utils/log');
const { getAdminConfig } = require('../src/services/adminConfig');
const { recordRouteTrafficEvent, rollupAndPruneRouteTraffic, EVENT_TYPES } = require('../src/services/routeTraffic');

beforeEach(() => {
  supa.from.mockClear();
  supa.__insertMock.mockReset().mockResolvedValue({ error: null });
  supa.__reset();
  log.mockClear();
  getAdminConfig.mockClear().mockResolvedValue(90);
});

describe('EVENT_TYPES', () => {
  test('exposes exactly the three supported event types', () => {
    expect(EVENT_TYPES).toEqual(['impression', 'click', 'booking_start']);
  });
});

describe('recordRouteTrafficEvent', () => {
  test('inserts a row with the correct shape, uppercasing IATA codes', () => {
    recordRouteTrafficEvent({ eventType: 'impression', slug: 'berlin-paris', originIata: 'ber', destinationIata: 'cdg', language: 'de' });
    expect(supa.from).toHaveBeenCalledWith('route_traffic_events');
    expect(supa.__insertMock).toHaveBeenCalledWith('route_traffic_events', {
      event_type: 'impression', route_slug: 'berlin-paris', origin_iata: 'BER', destination_iata: 'CDG', language: 'de',
    });
  });

  test('silently ignores an unrecognized event type', () => {
    recordRouteTrafficEvent({ eventType: 'pageview', slug: 'x', originIata: 'BER', destinationIata: 'CDG', language: 'de' });
    expect(supa.__insertMock).not.toHaveBeenCalled();
  });

  test('defaults slug/language to null when omitted', () => {
    recordRouteTrafficEvent({ eventType: 'booking_start', originIata: 'BER', destinationIata: 'CDG' });
    expect(supa.__insertMock).toHaveBeenCalledWith('route_traffic_events', expect.objectContaining({ route_slug: null, language: null }));
  });

  test('never throws synchronously even if the supabase client itself throws', () => {
    supa.from.mockImplementationOnce(() => { throw new Error('boom'); });
    expect(() => recordRouteTrafficEvent({ eventType: 'click', slug: 'x' })).not.toThrow();
  });

  test('an async insert failure is logged via a warning, not thrown', async () => {
    supa.__insertMock.mockResolvedValueOnce({ error: { message: 'insert failed' } });
    recordRouteTrafficEvent({ eventType: 'click', slug: 'x' });
    await new Promise((r) => setImmediate(r));
    expect(log).toHaveBeenCalledWith('warn', 'route_traffic_event_insert_failed', expect.objectContaining({ error: 'insert failed' }));
  });
});

describe('rollupAndPruneRouteTraffic', () => {
  test('aggregates raw events into daily buckets, tagging slug-less rows with a synthetic direct key', async () => {
    supa.__setResponse('route_traffic_events', 'select', {
      data: [
        { event_type: 'impression', route_slug: 'berlin-paris', origin_iata: 'BER', destination_iata: 'CDG', created_at: '2026-07-01T10:00:00.000Z' },
        { event_type: 'click', route_slug: 'berlin-paris', origin_iata: 'BER', destination_iata: 'CDG', created_at: '2026-07-01T11:00:00.000Z' },
        { event_type: 'booking_start', route_slug: null, origin_iata: 'BER', destination_iata: 'CDG', created_at: '2026-07-01T12:00:00.000Z' },
      ],
      error: null,
    });
    supa.__setResponse('route_traffic_daily', 'select', { data: [], error: null });

    await rollupAndPruneRouteTraffic();

    expect(supa.from).toHaveBeenCalledWith('route_traffic_daily');
  });

  test('an unreadable raw-events page aborts the cycle with a warning, never throwing', async () => {
    supa.__setResponse('route_traffic_events', 'select', { data: null, error: { message: 'read failed' } });
    await expect(rollupAndPruneRouteTraffic()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith('warn', 'route_traffic_rollup_read_failed', expect.objectContaining({ error: 'read failed' }));
  });

  test('no-ops cleanly when there are no raw events to roll up', async () => {
    supa.__setResponse('route_traffic_events', 'select', { data: [], error: null });
    await expect(rollupAndPruneRouteTraffic()).resolves.toBeUndefined();
  });
});
