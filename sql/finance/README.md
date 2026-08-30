# AirPiv Finance — Phase 1 Migration (`sql/finance/`)

Additive, backward-compatible accounting/tax **infrastructure**. Creates the
double-entry ledger, tax-engine tables, audit and reconciliation structure
required by the Finance/Accounting/VAT master spec. **No production tax rule is
invented** — every legally-unsettled value ships as `REVIEW_REQUIRED` pending
Steuerberater approval.

## Run order (idempotent — safe to re-run)

Run in Supabase SQL Editor **in this order**:

| # | File | Creates |
|---|------|---------|
| 00 | `00_finance_config.sql` | `finance_config`, `finance_config_versions` + governing decisions (regime, role, FX) |
| 01 | `01_accounting_core.sql` | `accounting_accounts`, `accounting_periods`, `journal_entries`, `journal_lines` |
| 02 | `02_financial_events.sql` | `financial_events` (immutable source layer, unique idempotency key) |
| 03 | `03_tax.sql` | `tax_rules`, `tax_rule_versions`, `tax_transactions`, `tax_exceptions` |
| 04 | `04_adjustments_audit.sql` | `accounting_adjustments`, `audit_logs` |
| 05 | `05_reconciliation.sql` | `reconciliation_matches`, `reconciliation_exceptions` |
| 06 | `06_integrity_triggers.sql` | double-entry / immutability / period-close / append-only enforcement + `finance_post_journal_entry()` |
| 07 | `07_integrations.sql` | **(Phase 2)** Stripe/Duffel mirrors, `refunds`, `chargebacks`, `credit_notes`, `bank_transactions` — provider-id/idempotency-key UNIQUE |
| 08 | `08_finance_jobs.sql` | **(Phase 4)** `finance_job_runs` — one row per cron/manual job run (timing, status, counts, error log) |

`_phase1_selftest.sql` is **not** a migration — run it only against a disposable
copy to verify the integrity guarantees (see below).

## Governing decisions (seeded in `finance_config`)

| key | value | status |
|---|---|---|
| `accounting_currency` | `EUR` | APPROVED |
| `vat_regime` | `REGELBESTEUERUNG` | APPROVED |
| `airpiv_business_role` | `REVIEW_REQUIRED` | REVIEW_REQUIRED |
| `vat_fx_source` | `REVIEW_REQUIRED` | REVIEW_REQUIRED |
| `accounting_fx_source` | `ECB` | APPROVED |
| `settlement_fx_source` | `PROVIDER` | APPROVED |

`REGELBESTEUERUNG` does **not** imply a default VAT rate — the Tax Engine decides
per transaction, and until rules are approved every classification is
`REVIEW_REQUIRED`. The system never guesses.

## Money model

Integer **minor units** (`bigint`) everywhere; no floating point. Every event
keeps its `original_amount_minor` + `original_currency` and, separately, an
`accounting_amount_eur_minor` with full FX provenance
(`exchange_rate`, `exchange_rate_source`, `exchange_rate_timestamp`,
`conversion_method`). Debit=credit is checked in EUR minor units.

## DB-enforced integrity (proven by `_phase1_selftest.sql`)

1. **Double-entry** — an entry can reach `POSTED` only when `Σ debit_eur = Σ credit_eur` and it has ≥1 line.
2. **Immutable posted entries** — no value UPDATE, no DELETE; only `POSTED → REVERSED/VOIDED` lifecycle transitions.
3. **Frozen lines** — lines of a non-`DRAFT` entry cannot be inserted/updated/deleted.
4. **Corrections via reversal** — not edits.
5. **Closed periods** — no posting into a `CLOSED` period.
6. **Append-only audit** — `audit_logs` and `finance_config_versions` reject UPDATE/DELETE.
7. **Immutable tax versions** — `tax_rule_versions` content is frozen; only lifecycle columns change; new rule = new version.
8. **Idempotency** — `financial_events.idempotency_key` is UNIQUE (cross-instance duplicate-entry guard).
9. **One-sided lines** — a line is a debit XOR a credit (own currency and EUR).

These are **database-integrity** guarantees only. Business/tax logic
(classification, revenue recognition, reconciliation matching, rule selection)
lives in the backend engine, per the design separation in Decision 4.

## Testing locally

```bash
# against a throwaway Postgres 16:
for f in 00 01 02 03 04 05 06; do psql -f sql/finance/${f}_*.sql; done
psql -f sql/finance/_phase1_selftest.sql   # disposable copy only — it commits test rows
```

## Backward compatibility

100% additive: new tables, sequences, functions and triggers only. **No** existing
table (`bookings`, `payments`, `invoices`, `promo_codes`, webhook tables, …) is
altered, renamed, or dropped. Links to existing entities are loose (nullable
`booking_id`/`source_id`, no hard FK into operational tables) so production
booking/payment/Stripe/Duffel/refund/invoice/webhook flows are untouched.

## STOP after Phase 1

Per the spec stop-condition, do **not** proceed to Phase 2 integrations or any
production VAT calculation until the Tax Matrix, AirPiv contractual role, and
FX/VAT conversion methodology are reviewed and approved by a Steuerberater.
