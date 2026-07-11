const mockRecordRouteTrafficEvent = jest.fn();
jest.mock('../src/services/routeTraffic', () => ({
  recordRouteTrafficEvent: (...args) => mockRecordRouteTrafficEvent(...args),
  EVENT_TYPES: ['impression', 'click', 'booking_start'],
}));

const express = require('express');
const request = require('supertest');

function buildApp() {
  const app = express();
  app.use(express.json());
  require('../src/routes/tracking.routes')(app);
  return app;
}

beforeEach(() => {
  mockRecordRouteTrafficEvent.mockClear();
});

describe('POST /track/route-page', () => {
  test('always responds 202 immediately, even for a well-formed event', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/track/route-page')
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify({ event_type: 'impression', route_slug: 'berlin-paris', origin_iata: 'BER', destination_iata: 'CDG', language: 'de' }));
    expect(res.status).toBe(202);
  });

  test('records a valid impression event', async () => {
    const app = buildApp();
    await request(app)
      .post('/track/route-page')
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify({ event_type: 'impression', route_slug: 'berlin-paris', origin_iata: 'BER', destination_iata: 'CDG', language: 'de' }));
    expect(mockRecordRouteTrafficEvent).toHaveBeenCalledWith({
      eventType: 'impression', slug: 'berlin-paris', originIata: 'BER', destinationIata: 'CDG', language: 'de',
    });
  });

  test('records a valid click event', async () => {
    const app = buildApp();
    await request(app)
      .post('/track/route-page')
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify({ event_type: 'click', route_slug: 'berlin-paris', origin_iata: 'BER', destination_iata: 'CDG', language: 'de' }));
    expect(mockRecordRouteTrafficEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'click' }));
  });

  test('records a valid booking_start event, including when route_slug is absent (direct search-page landing)', async () => {
    const app = buildApp();
    await request(app)
      .post('/track/route-page')
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify({ event_type: 'booking_start', origin_iata: 'BER', destination_iata: 'CDG', language: 'de' }));
    expect(mockRecordRouteTrafficEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'booking_start', slug: null }));
  });

  test('rejects an unrecognized event_type by simply not recording anything', async () => {
    const app = buildApp();
    await request(app)
      .post('/track/route-page')
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify({ event_type: 'pageview', route_slug: 'x' }));
    expect(mockRecordRouteTrafficEvent).not.toHaveBeenCalled();
  });

  test('a curl-style user-agent is silently dropped by the bot filter', async () => {
    const app = buildApp();
    await request(app)
      .post('/track/route-page')
      .set('Content-Type', 'text/plain')
      .set('User-Agent', 'curl/8.5.0')
      .send(JSON.stringify({ event_type: 'impression', route_slug: 'x' }));
    expect(mockRecordRouteTrafficEvent).not.toHaveBeenCalled();
  });

  test('a normal browser user-agent passes the bot filter', async () => {
    const app = buildApp();
    await request(app)
      .post('/track/route-page')
      .set('Content-Type', 'text/plain')
      .set('User-Agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15')
      .send(JSON.stringify({ event_type: 'impression', route_slug: 'x' }));
    expect(mockRecordRouteTrafficEvent).toHaveBeenCalled();
  });

  test('malformed (non-JSON) body never crashes the request', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/track/route-page')
      .set('Content-Type', 'text/plain')
      .send('not json{{{');
    expect(res.status).toBe(202);
    expect(mockRecordRouteTrafficEvent).not.toHaveBeenCalled();
  });

  test('an empty body never crashes the request', async () => {
    const app = buildApp();
    const res = await request(app).post('/track/route-page').set('Content-Type', 'text/plain').send('');
    expect(res.status).toBe(202);
    expect(mockRecordRouteTrafficEvent).not.toHaveBeenCalled();
  });

  test('also accepts application/json content type (express.text catches it via type: () => true)', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/track/route-page')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ event_type: 'click', route_slug: 'x' }));
    expect(res.status).toBe(202);
    expect(mockRecordRouteTrafficEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'click' }));
  });

  test('truncates overlong fields rather than storing arbitrary-length input', async () => {
    const app = buildApp();
    const longSlug = 'x'.repeat(500);
    await request(app)
      .post('/track/route-page')
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify({ event_type: 'impression', route_slug: longSlug, origin_iata: 'BERLIN', destination_iata: 'PARIS' }));
    const call = mockRecordRouteTrafficEvent.mock.calls[0][0];
    expect(call.slug.length).toBe(200);
    expect(call.originIata.length).toBe(3);
    expect(call.destinationIata.length).toBe(3);
  });
});
