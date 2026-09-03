// ═══════════════════════════════════════════════════════════════
// test/fareIntelligence.test.js
// [FARE-INTEL] Covers spec §33 TEST 1-10 plus the matching ladder, effective-
// date handling, admin validation and the baggage consistency invariants.
// Everything here is pure (no DB / network), exercising the engine directly.
// ═══════════════════════════════════════════════════════════════

const { resolveBaggage } = require('../src/services/baggageEngine');
const { matchLevel, isRuleEffective, matchBaggageRule } = require('../src/services/fareRules');
const { SOURCE, CONFIDENCE, BAGGAGE_TYPE } = require('../src/config/fareIntelligence');
const { checkBaggageEntry, checkOfferBaggage } = require('../src/services/consistencyValidation');
const { validateRule } = require('../src/routes/admin-fare-rules.routes');

// ── helpers ───────────────────────────────────────────────────
function rule(over = {}) {
  return Object.assign({
    id: 'r-' + Math.random().toString(36).slice(2),
    airline_iata: 'LH', cabin_class: 'economy', fare_family: null, booking_class: null,
    baggage_type: BAGGAGE_TYPE.CHECKED, included: true, pieces: 1, weight_kg: 23,
    source_type: 'AIRLINE_OFFICIAL', confidence: 'HIGH', active: true,
    effective_from: '2020-01-01', effective_until: null,
  }, over);
}
function duffelChecked(qty, weight) {
  return [{ type: 'checked', quantity: qty, weight }];
}

// ── TEST 1: Duffel confirms 1×23kg → HIGH, source Duffel ───────
test('TEST 1: Duffel offer-specific checked bag wins with HIGH/Duffel', () => {
  const b = resolveBaggage({
    duffelBags: duffelChecked(1, 23),
    ctx: { airline: 'LH', cabin: 'economy' },
    rules: [],
  });
  expect(b.checked.included).toBe(true);
  expect(b.checked.pieces).toBe(1);
  expect(b.checked.weight_kg).toBe(23);
  expect(b.checked.source).toBe(SOURCE.DUFFEL);
  expect(b.checked.confidence).toBe(CONFIDENCE.HIGH);
  expect(b.checked.confirmed).toBe(true);
});

// ── TEST 2: no Duffel baggage, fare-specific rule fills it ─────
test('TEST 2: fare-specific rule used when Duffel gives no baggage', () => {
  const b = resolveBaggage({
    duffelBags: [],
    ctx: { airline: 'LH', cabin: 'economy', fareFamily: 'Economy Classic' },
    rules: [rule({ fare_family: 'Economy Classic', weight_kg: 23 })],
  });
  expect(b.checked.weight_kg).toBe(23);
  expect(b.checked.source).toBe(SOURCE.AIRLINE_OFFICIAL);
  expect(b.checked.confidence).toBe(CONFIDENCE.HIGH);
  expect(b.checked.confirmed).toBe(true);
});

// ── TEST 3: only general policy, no fare id → NOT confirmed ────
test('TEST 3: general airline policy alone is never confirmed', () => {
  const b = resolveBaggage({
    duffelBags: [],
    ctx: { airline: 'LH', cabin: 'economy' }, // no fare family
    rules: [rule({ fare_family: null, confidence: 'LOW', source_type: 'VERIFIED_PROVIDER' })],
  });
  expect(b.checked.weight_kg).toBe(23);
  expect(b.checked.source).toBe(SOURCE.GENERAL_AIRLINE_POLICY);
  expect(b.checked.confidence).toBe(CONFIDENCE.LOW);
  expect(b.checked.confirmed).toBe(false); // must NOT be shown as a fact
});

// ── TEST 4: per-fare correctness (Light 0 vs Classic 23) ──────
test('TEST 4: Economy Light resolves to 0 checked, Classic to 23', () => {
  const rules = [
    rule({ fare_family: 'Economy Light', included: false, pieces: 0, weight_kg: null }),
    rule({ fare_family: 'Economy Classic', included: true, pieces: 1, weight_kg: 23 }),
  ];
  const light = resolveBaggage({ duffelBags: [], ctx: { airline: 'LH', cabin: 'economy', fareFamily: 'Economy Light' }, rules });
  expect(light.checked.included).toBe(false);
  expect(light.checked.pieces).toBe(0);

  const classic = resolveBaggage({ duffelBags: [], ctx: { airline: 'LH', cabin: 'economy', fareFamily: 'Economy Classic' }, rules });
  expect(classic.checked.included).toBe(true);
  expect(classic.checked.weight_kg).toBe(23);
});

// ── TEST 5: all three types independent ───────────────────────
test('TEST 5: personal item, cabin and checked resolved independently', () => {
  const rules = [
    rule({ baggage_type: BAGGAGE_TYPE.PERSONAL_ITEM, fare_family: 'Economy Classic', pieces: 1, weight_kg: 3 }),
    rule({ baggage_type: BAGGAGE_TYPE.CABIN, fare_family: 'Economy Classic', pieces: 1, weight_kg: 8 }),
    rule({ baggage_type: BAGGAGE_TYPE.CHECKED, fare_family: 'Economy Classic', pieces: 1, weight_kg: 23 }),
  ];
  const b = resolveBaggage({ duffelBags: [], ctx: { airline: 'LH', cabin: 'economy', fareFamily: 'Economy Classic' }, rules });
  expect(b.personal_item.weight_kg).toBe(3);
  expect(b.cabin.weight_kg).toBe(8);
  expect(b.checked.weight_kg).toBe(23);
  // never merged
  expect(b.personal_item.weight_kg).not.toBe(b.cabin.weight_kg);
});

// ── TEST 6: personal + cabin shown, checked not included ──────
test('TEST 6: checked=0 shows as not included, others intact', () => {
  const rules = [
    rule({ baggage_type: BAGGAGE_TYPE.PERSONAL_ITEM, fare_family: 'Economy Light', pieces: 1, weight_kg: 3 }),
    rule({ baggage_type: BAGGAGE_TYPE.CABIN, fare_family: 'Economy Light', pieces: 1, weight_kg: 8 }),
    rule({ baggage_type: BAGGAGE_TYPE.CHECKED, fare_family: 'Economy Light', included: false, pieces: 0, weight_kg: null }),
  ];
  const b = resolveBaggage({ duffelBags: [], ctx: { airline: 'LH', cabin: 'economy', fareFamily: 'Economy Light' }, rules });
  expect(b.personal_item.included).toBe(true);
  expect(b.cabin.included).toBe(true);
  expect(b.checked.included).toBe(false);
});

// ── TEST 7: real 10kg cabin, not a default 8kg ────────────────
test('TEST 7: cabin weight is whatever the source says (10kg), no default', () => {
  const b = resolveBaggage({
    duffelBags: [{ type: 'carry_on', quantity: 1, weight: 10 }],
    ctx: { airline: 'LH', cabin: 'economy' },
    rules: [rule({ baggage_type: BAGGAGE_TYPE.CABIN, weight_kg: 8, fare_family: null })],
  });
  expect(b.cabin.weight_kg).toBe(10); // Duffel wins, no 8kg default
  expect(b.cabin.source).toBe(SOURCE.DUFFEL);
});

// ── TEST 8: unknown fare family → no unsupported assumption ────
test('TEST 8: unknown fare family does not borrow another fare\'s allowance', () => {
  const b = resolveBaggage({
    duffelBags: [],
    ctx: { airline: 'LH', cabin: 'economy' }, // fare family unknown
    rules: [rule({ fare_family: 'Economy Classic', weight_kg: 23 })], // only a family-specific rule exists
  });
  // The family-specific rule must NOT apply to an unknown fare.
  expect(b.checked.source).toBe(SOURCE.UNKNOWN);
  expect(b.checked.confidence).toBe(CONFIDENCE.UNKNOWN);
  expect(b.checked.weight_kg).toBeNull();
});

// ── TEST 9: expired rule cannot be used ───────────────────────
test('TEST 9: an expired rule is not used as current confirmed data', () => {
  const expired = rule({ fare_family: 'Economy Classic', effective_from: '2020-01-01', effective_until: '2021-01-01' });
  expect(isRuleEffective(expired, new Date('2026-01-01'))).toBe(false);
  const b = resolveBaggage({
    duffelBags: [],
    ctx: { airline: 'LH', cabin: 'economy', fareFamily: 'Economy Classic' },
    rules: [expired],
    asOf: new Date('2026-01-01'),
  });
  expect(b.checked.source).toBe(SOURCE.UNKNOWN);
});

// ── TEST 10: Duffel-specific 0 beats a general 23kg policy ────
test('TEST 10: Duffel 0-checked wins over general airline policy', () => {
  const b = resolveBaggage({
    duffelBags: duffelChecked(0, null),
    ctx: { airline: 'LH', cabin: 'economy' },
    rules: [rule({ fare_family: null, weight_kg: 23, confidence: 'LOW' })],
  });
  expect(b.checked.included).toBe(false);
  expect(b.checked.pieces).toBe(0);
  expect(b.checked.source).toBe(SOURCE.DUFFEL);
});

// ── matching ladder precision → confidence ────────────────────
describe('matching ladder', () => {
  const ctx = { airline: 'LH', cabin: 'economy', fareFamily: 'Economy Classic', bookingClass: 'K' };
  test('airline+family+booking+cabin → level 4 (HIGH)', () => {
    expect(matchLevel(rule({ fare_family: 'Economy Classic', booking_class: 'K' }), ctx)).toBe(4);
  });
  test('airline+family+cabin → level 3 (HIGH)', () => {
    expect(matchLevel(rule({ fare_family: 'Economy Classic' }), ctx)).toBe(3);
  });
  test('airline+booking+cabin → level 2 (MEDIUM)', () => {
    const m = matchBaggageRule(BAGGAGE_TYPE.CHECKED, { airline: 'LH', cabin: 'economy', bookingClass: 'K' },
      [rule({ fare_family: null, booking_class: 'K' })]);
    expect(m.confidence).toBe(CONFIDENCE.MEDIUM);
  });
  test('airline+cabin only → level 1 (LOW / general)', () => {
    expect(matchLevel(rule({ fare_family: null, booking_class: null }), { airline: 'LH', cabin: 'economy' })).toBe(1);
  });
  test('wrong cabin → no match', () => {
    expect(matchLevel(rule({ cabin_class: 'business' }), { airline: 'LH', cabin: 'economy' })).toBeNull();
  });
  test('wrong airline → no match', () => {
    expect(matchLevel(rule({ airline_iata: 'AF' }), ctx)).toBeNull();
  });
});

// ── admin validation (spec §28) ───────────────────────────────
describe('admin validateRule', () => {
  test('valid rule passes', () => {
    const { value, error } = validateRule({ airline_iata: 'lh', baggage_type: 'checked', pieces: 1, weight_kg: 23, source_type: 'AIRLINE_OFFICIAL' });
    expect(error).toBeUndefined();
    expect(value.airline_iata).toBe('LH');
    expect(value.weight_kg).toBe(23);
  });
  test('negative weight rejected', () => {
    expect(validateRule({ airline_iata: 'LH', baggage_type: 'checked', weight_kg: -5 }).error).toMatch(/weight_kg/);
  });
  test('negative pieces rejected', () => {
    expect(validateRule({ airline_iata: 'LH', baggage_type: 'checked', pieces: -1 }).error).toMatch(/pieces/);
  });
  test('missing airline rejected', () => {
    expect(validateRule({ baggage_type: 'checked' }).error).toMatch(/airline/);
  });
  test('bad baggage type rejected', () => {
    expect(validateRule({ airline_iata: 'LH', baggage_type: 'suitcase' }).error).toMatch(/baggage_type/);
  });
  test('effective_until before effective_from rejected', () => {
    expect(validateRule({ airline_iata: 'LH', baggage_type: 'checked', effective_from: '2026-01-01', effective_until: '2025-01-01' }).error).toMatch(/effective_until/);
  });
  test('0 pieces + included warns', () => {
    const { warnings } = validateRule({ airline_iata: 'LH', baggage_type: 'checked', included: true, pieces: 0 });
    expect(warnings.length).toBeGreaterThan(0);
  });
});

// ── consistency invariants (spec §26) ─────────────────────────
describe('baggage consistency checks', () => {
  test('clean confirmed entry has no issues', () => {
    const b = resolveBaggage({ duffelBags: duffelChecked(1, 23), ctx: { airline: 'LH', cabin: 'economy' }, rules: [] });
    expect(checkOfferBaggage(b)).toEqual([]);
  });
  test('flags a confirmed entry with UNKNOWN source', () => {
    const issues = checkBaggageEntry({ confirmed: true, source: SOURCE.UNKNOWN, confidence: CONFIDENCE.HIGH, weight_kg: 23 }, 'checked');
    expect(issues.some(i => i.code === 'baggage-confirmed-without-source')).toBe(true);
  });
  test('flags non-positive weight', () => {
    const issues = checkBaggageEntry({ weight_kg: 0, source: SOURCE.DUFFEL, confidence: CONFIDENCE.HIGH }, 'checked');
    expect(issues.some(i => i.code === 'baggage-nonpositive-weight')).toBe(true);
  });
});
