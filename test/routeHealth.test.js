// P0-3 — route health-check safety. A route must never be declared dead from
// a single empty date, and API failures (429/5xx/timeout) must NEVER count as
// evidence a route is dead. These pin the pure decision logic.
const { classifyRun, nextHealthState } = require('../src/services/routeHealth');

describe('classifyRun (multi-date probe → run result)', () => {
  test('any alive date → alive', () => {
    expect(classifyRun(['empty', 'alive', 'empty'])).toBe('alive');
    expect(classifyRun(['alive'])).toBe('alive');
  });
  test('empty on one date but others alive → alive (not dead)', () => {
    expect(classifyRun(['empty', 'alive'])).toBe('alive');
  });
  test('all clean empty → empty', () => {
    expect(classifyRun(['empty', 'empty', 'empty'])).toBe('empty');
  });
  test('ANY error makes the whole run unknown, never empty', () => {
    expect(classifyRun(['empty', 'unknown'])).toBe('unknown'); // timeout on one date
    expect(classifyRun(['unknown', 'unknown'])).toBe('unknown');
  });
  test('no outcomes → unknown', () => {
    expect(classifyRun([])).toBe('unknown');
    expect(classifyRun(null)).toBe('unknown');
  });
});

describe('nextHealthState (streak → dead only on repeated empties)', () => {
  test('single empty run → candidate, NOT dead', () => {
    const s = nextHealthState(0, 'empty', 2);
    expect(s.markDead).toBe(false);
    expect(s.candidate).toBe(true);
    expect(s.streak).toBe(1);
  });
  test('repeated empty reaching threshold → dead', () => {
    const s = nextHealthState(1, 'empty', 2);
    expect(s.markDead).toBe(true);
    expect(s.streak).toBe(2);
  });
  test('threshold floor is 2 — never dead on one observation even if misconfigured', () => {
    const s = nextHealthState(0, 'empty', 1);
    expect(s.markDead).toBe(false);
  });
  test('alive resets the streak and never marks dead', () => {
    const s = nextHealthState(5, 'alive', 2);
    expect(s.streak).toBe(0);
    expect(s.markDead).toBe(false);
    expect(s.lastResult).toBe('alive');
  });
  test('unknown (API failure/timeout/429/5xx) NEVER marks dead and does not touch the row', () => {
    const s = nextHealthState(1, 'unknown', 2);
    expect(s.markDead).toBe(false);
    expect(s.touch).toBe(false);
    expect(s.streak).toBe(1); // preserved for retry, not incremented
  });
  test('seasonal route: empty once then alive → stays alive, streak cleared', () => {
    let s = nextHealthState(0, 'empty', 2);
    expect(s.markDead).toBe(false);
    s = nextHealthState(s.streak, 'alive', 2);
    expect(s.streak).toBe(0);
    expect(s.markDead).toBe(false);
  });
});
