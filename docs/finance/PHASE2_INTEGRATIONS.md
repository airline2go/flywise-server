# PHASE 2 — Financial Integrations, Reconciliation & Refund/Chargeback Infrastructure

> Builds on Phase 1's accounting/tax core. Additive migration + a dependency-
> injected service layer. **No tax rule is invented** — the Tax Engine is fully
> configurable and every unapproved classification stays `REVIEW_REQUIRED`. The
> Tax Matrix is delivered as a DRAFT for the Steuerberater
> (`docs/finance/TAX_MATRIX_DRAFT.md`).

## Migration — `sql/finance/07_integrations.sql`

11 additive, idempotent tables (minor units; provider ids / idempotency keys are
UNIQUE so re-delivered webhooks never duplicate a financial record):

`stripe_transactions` · `stripe_fees` · `stripe_payouts` · `stripe_refunds` ·
`stripe_disputes` · `duffel_invoices` · `duffel_invoice_lines` · `refunds` ·
`chargebacks` · `credit_notes` · `bank_transactions`

Tested on Postgres 16: migration applies cleanly, is idempotent, and every
UNIQUE idempotency constraint rejects duplicates (stripe_id, refund/chargeback/
duffel-line idempotency keys).

## Service layer — `src/services/finance/`

Dependency-injected (`{ supa, log, stripe }`), unit-tested, and **not yet mounted**
into routes/cron (that is the API/Jobs phase — spec 33/34) so the existing
booking hot path is untouched.

| Module | Responsibility |
|---|---|
| `moneyEngine.js` | integer minor units + EUR FX abstraction; foreign currency without a rate is **not convertible** (never guessed) |
| `taxEngine.js` | configurable, versioned classification; most-specific `ACTIVE` rule wins; no match → `REVIEW_REQUIRED` + `tax_exception`; invents nothing |
| `financialEvents.js` | idempotent source-fact recorder (unique idempotency key) |
| `reconciliation.js` | booking↔stripe↔duffel matcher — never matches on amount alone; writes matches + exceptions |
| `refunds.js` | refund as its own financial event; `tax_adjustment_status = REVIEW_REQUIRED` |
| `chargebacks.js` | dispute/chargeback as its own record; `tax_treatment_status = REVIEW_REQUIRED` |
| `stripeSync.js` | balance transactions / fees / payouts / refunds / disputes import; **fees are fees, never VAT** |
| `duffelSync.js` | ingests OFFICIAL Duffel invoices (authoritative over API net); unmatched lines → `DUFFEL_UNMATCHED` exception |

## Tests

- `test/finance.moneyEngine.test.js` — minor units, FX provenance, non-convertible guard
- `test/finance.taxEngine.test.js` — matching, specificity, ACTIVE/date validity, REVIEW_REQUIRED, no invented numbers
- `test/finance.reconciliation.test.js` — MATCHED / PARTIAL / UNMATCHED (amount-alone rejected) / MANUAL_REVIEW
- `test/finance.sync.mappers.test.js` — Stripe/Duffel object mapping to minor units

Full suite: **54 suites / 635 tests pass** (54→54, +19 finance). `node --check server.js` OK.

## Non-negotiable rules honoured

- VAT never from profit; fees never auto-treated as VAT (rule 11).
- Official Duffel invoice preferred over API estimate (rule 12).
- Every amount has currency + source; original currency preserved (rules 13–14, Decision 1).
- Refunds and chargebacks are independent financial events (Phases 12–13).
- Uncertain → `REVIEW_REQUIRED`, never guessed (rule 20).

## Not in this phase (by design)

Wiring into HTTP routes and cron jobs, the accountant dashboard/export, and any
**activation** of tax rules — these wait on the Steuerberater-approved Tax Matrix,
AirPiv contractual role, and FX/VAT method (the Phase 1 stop condition still holds
for anything that would compute a production VAT figure).
