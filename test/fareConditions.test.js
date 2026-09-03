// ═══════════════════════════════════════════════════════════════
// test/fareConditions.test.js
// [FARE-INTEL §24/§25] Change/refund/seat/meal/priority resolution: Duffel
// wins, verified rules fill gaps, unproven stays UNKNOWN and never "confirmed".
// ═══════════════════════════════════════════════════════════════

const { resolveFareConditions } = require('../src/services/fareConditionsEngine');
const { SOURCE, CONFIDENCE } = require('../src/config/fareIntelligence');

const ctx = { airline: 'LH', cabin: 'economy', fareFamily: 'Economy Flex' };

test('Duffel change_before_departure wins with HIGH/Duffel', () => {
  const r = resolveFareConditions({
    duffelConditions: { change_before_departure: { allowed: true, penalty_amount: '30.00', penalty_currency: 'EUR' } },
    ctx, rules: [],
  });
  expect(r.change.allowed).toBe(true);
  expect(r.change.fee).toBe(30);
  expect(r.change.source).toBe(SOURCE.DUFFEL);
  expect(r.change.confirmed).toBe(true);
});

test('refund falls back to a verified fare rule when Duffel is silent', () => {
  const r = resolveFareConditions({
    duffelConditions: null, ctx,
    rules: [{
      id: 'r1', airline_iata: 'LH', cabin_class: 'economy', fare_family: 'Economy Flex',
      refund_allowed: true, refund_fee: 50, refund_fee_currency: 'EUR',
      source_type: 'AIRLINE_OFFICIAL', confidence: 'HIGH', active: true, effective_from: '2020-01-01',
    }],
  });
  expect(r.refund.refundable).toBe(true);
  expect(r.refund.fee).toBe(50);
  expect(r.refund.source).toBe(SOURCE.AIRLINE_OFFICIAL);
  expect(r.refund.confirmed).toBe(true);
});

test('a general (airline+cabin) rule stays LOW / not confirmed', () => {
  const r = resolveFareConditions({
    duffelConditions: null, ctx: { airline: 'LH', cabin: 'economy' },
    rules: [{
      id: 'r2', airline_iata: 'LH', cabin_class: 'economy', fare_family: null,
      change_allowed: true, source_type: 'VERIFIED_PROVIDER', confidence: 'LOW', active: true, effective_from: '2020-01-01',
    }],
  });
  expect(r.change.allowed).toBe(true);
  expect(r.change.source).toBe(SOURCE.GENERAL_AIRLINE_POLICY);
  expect(r.change.confidence).toBe(CONFIDENCE.LOW);
  expect(r.change.confirmed).toBe(false);
});

test('nothing known → UNKNOWN, never a positive claim', () => {
  const r = resolveFareConditions({ duffelConditions: null, ctx, rules: [] });
  expect(r.change.source).toBe(SOURCE.UNKNOWN);
  expect(r.change.confirmed).toBe(false);
  expect(r.refund.refundable).toBeNull();
  expect(r.seat.seat_selection).toBeNull();
  expect(r.meal.included).toBeNull();
  expect(r.priority.included).toBeNull();
});

test('seat/meal/priority resolve from rules', () => {
  const r = resolveFareConditions({
    duffelConditions: null, ctx,
    rules: [{
      id: 'r3', airline_iata: 'LH', cabin_class: 'economy', fare_family: 'Economy Flex',
      seat_selection: 'included', meal_included: true, priority_included: false,
      source_type: 'AIRLINE_OFFICIAL', confidence: 'HIGH', active: true, effective_from: '2020-01-01',
    }],
  });
  expect(r.seat.seat_selection).toBe('included');
  expect(r.seat.confirmed).toBe(true);
  expect(r.meal.included).toBe(true);
  expect(r.priority.included).toBe(false);
});
