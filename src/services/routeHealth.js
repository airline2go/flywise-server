// ═══════════════════════════════════════════════════════════════════════
// src/services/routeHealth.js  (P0-3)
// ─────────────────────────────────────────────────────────────────────────
// Pure decision logic for route health-checking, extracted so it can be unit
// tested without Duffel or the DB. The rule, in one place:
//
//   • A route is checked across SEVERAL representative dates. If ANY date has
//     offers → 'alive'.
//   • A run counts as a confirmed empty ('empty') ONLY when every probed date
//     returned a clean, error-free empty. If ANY date errored (429/5xx/
//     timeout/network) the run is 'unknown' — API failure is NEVER evidence a
//     route is dead.
//   • An 'empty' run increments the empty streak; 'alive' resets it; 'unknown'
//     leaves it untouched. A route becomes `dead` only when the streak reaches
//     the threshold (repeated empties across runs), never on a single date or a
//     single run.
// ═══════════════════════════════════════════════════════════════════════

// Collapse the per-date probe outcomes of one run into a run result.
// dateOutcomes: array of 'alive' | 'empty' | 'unknown'.
function classifyRun(dateOutcomes) {
  if (!dateOutcomes || !dateOutcomes.length) return 'unknown';
  if (dateOutcomes.includes('alive')) return 'alive';
  if (dateOutcomes.includes('unknown')) return 'unknown'; // any error → cannot confirm empty
  return 'empty'; // every date was a clean empty
}

// Given the previous empty streak and this run's result, compute the next
// persisted state. threshold = consecutive confirmed-empty runs before dead.
function nextHealthState(prevStreak, runResult, threshold = 2) {
  const t = Math.max(2, threshold | 0 || 2);
  const prev = Math.max(0, prevStreak | 0);
  switch (runResult) {
    case 'alive':
      return { streak: 0, lastResult: 'alive', markDead: false, candidate: false, touch: true };
    case 'empty': {
      const streak = prev + 1;
      const markDead = streak >= t;
      return { streak, lastResult: 'empty', markDead, candidate: !markDead, touch: true };
    }
    case 'unknown':
    default:
      // Never dead on an API failure; do not touch the row so it retries later.
      return { streak: prev, lastResult: 'unknown', markDead: false, candidate: prev > 0, touch: false };
  }
}

module.exports = { classifyRun, nextHealthState };
