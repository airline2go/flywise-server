const { normalizeOffer, isoToMin } = require('../src/services/normalizeOffer');
const { DEFAULT_TICKET_TIERS, computeTieredMargin } = require('../src/services/adminConfig');

describe('isoToMin', () => {
  test('parses hours and minutes', () => {
    expect(isoToMin('PT2H30M')).toBe(150);
  });

  test('parses hours only', () => {
    expect(isoToMin('PT5H')).toBe(300);
  });

  test('returns 0 for falsy input', () => {
    expect(isoToMin(null)).toBe(0);
  });
});

describe('normalizeOffer', () => {
  test('returns null for falsy offer', () => {
    expect(normalizeOffer(null, DEFAULT_TICKET_TIERS)).toBeNull();
  });

  test('applies the same tiered margin as computeTieredMargin per passenger', () => {
    const offer = {
      id: 'off_1',
      total_amount: '100.00',
      total_currency: 'EUR',
      passengers: [{ type: 'adult' }],
      slices: [
        {
          origin: { iata_code: 'BER' },
          destination: { iata_code: 'CDG' },
          duration: 'PT2H0M',
          segments: [
            {
              id: 'seg_1',
              origin: { iata_code: 'BER' },
              destination: { iata_code: 'CDG' },
              departing_at: '2026-06-01T10:00:00Z',
              arriving_at: '2026-06-01T12:00:00Z',
              duration: 'PT2H0M',
              marketing_carrier_flight_number: '123',
              marketing_carrier: { iata_code: 'LH', name: 'Lufthansa' },
              passengers: [{ baggages: [] }],
            },
          ],
        },
      ],
    };

    const result = normalizeOffer(offer, DEFAULT_TICKET_TIERS);
    const expectedMargin = computeTieredMargin(100, DEFAULT_TICKET_TIERS);

    expect(result.netPrice).toBe(100);
    expect(result.margin).toBe(expectedMargin);
    expect(result.price).toBe(Math.round((100 + expectedMargin) * 100) / 100);
    expect(result.outbound.orig).toBe('BER');
    expect(result.outbound.dest).toBe('CDG');
    expect(result.outbound.dur).toBe(120);
  });
});
