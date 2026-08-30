// ═══════════════════════════════════════════════════════════════
// src/services/finance/index.js
// [F-PHASE2] Barrel for the finance engine service layer. These modules are
// self-contained and dependency-injected (they take { supa, log, stripe }),
// so they can be unit-tested without network and wired into routes/cron in the
// API/Jobs phase (spec Phase 33/34) without touching the existing booking hot
// path. Nothing here is mounted yet — importing this file has no side effects.
// ═══════════════════════════════════════════════════════════════

module.exports = {
  moneyEngine: require('./moneyEngine'),
  taxEngine: require('./taxEngine'),
  financialEvents: require('./financialEvents'),
  reconciliation: require('./reconciliation'),
  refunds: require('./refunds'),
  chargebacks: require('./chargebacks'),
  stripeSync: require('./stripeSync'),
  duffelSync: require('./duffelSync'),
};
