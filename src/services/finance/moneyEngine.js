// ═══════════════════════════════════════════════════════════════
// src/services/finance/moneyEngine.js
// [F-PHASE2 · MONEY] Central money + FX layer for the accounting engine.
// Wraps the existing integer-minor-unit utility (src/utils/money.js) and adds
// the EUR-conversion abstraction the ledger needs. Two hard rules baked in:
//   1. Every amount is an INTEGER in the currency's minor unit — never a float.
//   2. The ORIGINAL currency is always preserved; EUR is derived, never
//      substituted (Phase 1 Decision 1).
// The VAT conversion method is deliberately NOT decided here — vat_fx_source
// stays REVIEW_REQUIRED until a Steuerberater approves it, so toEur() records
// the source used and callers must not treat an unreviewed EUR figure as a
// VAT base.
// ═══════════════════════════════════════════════════════════════

const { toMinor, fromMinor, decimalsFor } = require('../../utils/money');

// FX source vocabulary — mirrors the DB CHECK on financial_events.exchange_rate_source.
const FX_SOURCE = Object.freeze({
  ECB: 'ECB', STRIPE: 'STRIPE', DUFFEL: 'DUFFEL',
  MANUAL: 'MANUAL', SYSTEM: 'SYSTEM', PROVIDER: 'PROVIDER',
});

// Convert a decimal major amount (e.g. 115.00) to integer minor units (11500).
function amountToMinor(amount, currency) {
  return toMinor(amount, currency);
}
function minorToAmount(minor, currency) {
  return fromMinor(minor, currency);
}

// Build a fully-provenanced money object for a financial event / ledger line.
// `rate` converts ONE unit of `currency` into EUR. When currency is already
// EUR the rate is 1 and no external source is needed. When a rate is required
// but not supplied, accounting_amount_eur_minor is left null and the caller is
// expected to raise a REVIEW_REQUIRED exception rather than guess.
function buildMoney({ amountMinor, currency, rate = null, rateSource = null, rateTimestamp = null, method = null }) {
  const cur = String(currency || 'EUR').toUpperCase();
  const out = {
    original_amount_minor: Math.round(Number(amountMinor) || 0),
    original_currency: cur,
    accounting_amount_eur_minor: null,
    exchange_rate: null,
    exchange_rate_source: null,
    exchange_rate_timestamp: rateTimestamp || null,
    conversion_method: method || null,
  };
  if (cur === 'EUR') {
    out.accounting_amount_eur_minor = out.original_amount_minor;
    out.exchange_rate = 1;
    out.exchange_rate_source = FX_SOURCE.SYSTEM;
    out.conversion_method = method || 'identity';
    return out;
  }
  if (rate != null && Number.isFinite(Number(rate)) && Number(rate) > 0) {
    // Convert via major units so currencies with different minor-unit scales
    // (e.g. JPY↔EUR) round correctly, then back to EUR minor units.
    const major = minorToAmount(out.original_amount_minor, cur);
    const eurMajor = major * Number(rate);
    out.accounting_amount_eur_minor = toMinor(eurMajor, 'EUR');
    out.exchange_rate = Number(rate);
    out.exchange_rate_source = rateSource || FX_SOURCE.SYSTEM;
  }
  return out;
}

// Is this money object safe to post to the EUR ledger? (Foreign currency with
// no rate → not convertible → must go to REVIEW_REQUIRED, never guessed.)
function isConvertible(money) {
  return money && money.accounting_amount_eur_minor != null;
}

module.exports = { FX_SOURCE, amountToMinor, minorToAmount, buildMoney, isConvertible, decimalsFor };
