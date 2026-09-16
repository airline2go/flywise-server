// ═══════════════════════════════════════════════════════════════
// src/config/price.js
// [PRICE-SNAPSHOT] Single source of truth for how a route "from" price is
// defined, how fresh it must be to count as *live*, and the fixed assumptions
// every displayed price is quoted under. Every price the frontend shows —
// hero, meta description, average, FAQ, JSON-LD Offer — must trace back to a
// snapshot built here. No component may compute, age, or re-label a price on
// its own. Changing the freshness window is a one-line, one-place edit (or an
// env override), and it governs BOTH "is this live?" and "serve fresh vs
// revalidate", so the two can never drift apart again.
// ═══════════════════════════════════════════════════════════════

const FRESHNESS_HOURS = Number(process.env.PRICE_FRESHNESS_HOURS) > 0
  ? Number(process.env.PRICE_FRESHNESS_HOURS)
  : 24;
const PRICE_FRESHNESS_MS = FRESHNESS_HOURS * 60 * 60 * 1000;

const PRICE_ASSUMPTIONS = Object.freeze({ tripType: 'one-way', passengers: 1, cabin: 'economy' });

function isPriceLive(checkedAt, now = Date.now()) {
  if (!checkedAt) return false;
  const t = new Date(checkedAt).getTime();
  if (!Number.isFinite(t)) return false;
  const age = now - t;
  return age >= 0 && age <= PRICE_FRESHNESS_MS;
}

// Unknown currency is deliberately NOT converted to EUR. A missing currency
// is missing price evidence and must stay null rather than becoming a
// fabricated EUR amount. Callers can therefore data-gate the display.
function normalizeCurrency(currency) {
  const value = String(currency || '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(value) ? value : null;
}

function buildPriceSnapshot(input = {}, now = Date.now()) {
  const { price = null, currency = null, checkedAt = null, source = 'none', offersCount = null } = input;
  const hasPrice = price != null && Number.isFinite(Number(price)) && Number(price) > 0;
  const normalizedCurrency = normalizeCurrency(currency);
  const usablePrice = hasPrice && normalizedCurrency ? Number(price) : null;
  return {
    price: usablePrice,
    currency: usablePrice != null ? normalizedCurrency : null,
    checkedAt: usablePrice != null ? (checkedAt || null) : null,
    source: usablePrice != null ? source : 'none',
    offersCount: offersCount == null ? null : Number(offersCount),
    tripType: PRICE_ASSUMPTIONS.tripType,
    passengers: PRICE_ASSUMPTIONS.passengers,
    cabin: PRICE_ASSUMPTIONS.cabin,
    isLive: usablePrice != null ? isPriceLive(checkedAt, now) : false,
    freshnessMs: PRICE_FRESHNESS_MS,
  };
}

module.exports = {
  PRICE_FRESHNESS_MS,
  PRICE_FRESHNESS_HOURS: FRESHNESS_HOURS,
  PRICE_ASSUMPTIONS,
  isPriceLive,
  buildPriceSnapshot,
  normalizeCurrency,
};
