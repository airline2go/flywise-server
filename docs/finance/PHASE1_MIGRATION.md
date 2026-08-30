# PHASE 1 — Accounting Architecture Migration

> Additive DB migration establishing the AirPiv accounting/tax **infrastructure**.
> Design + files live in [`sql/finance/`](../../sql/finance/README.md).
> Scope is Phase 1 only — **no** Phase 2 integrations, **no** invented tax rules.

## What was built

13 core tables + config/versioning + DB-enforced integrity:

- **Config/governance:** `finance_config`, `finance_config_versions`
- **Accounting core:** `accounting_accounts`, `accounting_periods`,
  `journal_entries`, `journal_lines`
- **Source layer:** `financial_events`
- **Tax engine:** `tax_rules`, `tax_rule_versions`, `tax_transactions`, `tax_exceptions`
- **Governance:** `accounting_adjustments`, `audit_logs`
- **Reconciliation:** `reconciliation_matches`, `reconciliation_exceptions`
- **Integrity:** posting/immutability/period/append-only triggers + `finance_post_journal_entry()`

## Decisions applied (verbatim from the Phase 1 brief)

| Decision | Implementation |
|---|---|
| 1 — EUR accounting currency, original currency always preserved | minor-unit money model; `original_*` + `accounting_amount_eur_minor` + FX provenance on every event; `vat_fx_source = REVIEW_REQUIRED` |
| 2 — AirPiv role not decided in code | `business_role` enum defaults `REVIEW_REQUIRED`; `airpiv_business_role = REVIEW_REQUIRED` in config |
| 3 — Regelbesteuerung, no default rate | `vat_regime = REGELBESTEUERUNG`; no VAT rate seeded; classification defaults `REVIEW_REQUIRED` |
| 4 — DB integrity separate from business logic | constraints/triggers enforce integrity only; classification/reconciliation left to the backend engine |

## Acceptance criteria

- [x] Migration tested on a copy of the database (Postgres 16, fresh schema + self-test)
- [x] No breaking change (100% additive; no existing table altered/renamed/dropped)
- [x] No duplicate of existing functionality (reuse mapping in `CURRENT_DATA_MAPPING.md`)
- [x] Double-entry architecture ready
- [x] Debit/Credit integrity enforced at DB level (proven: T2/T3)
- [x] Posted entries immutable (proven: T4/T5/T6)
- [x] Reversal architecture present (`REVERSED`/`VOIDED` + `accounting_adjustments`; proven: T7)
- [x] Tax rules versioned + version content immutable (proven: T11)
- [x] No invented VAT rules (only a `REVIEW_REQUIRED` placeholder)
- [x] REGELBESTEUERUNG configured
- [x] AirPiv role = REVIEW_REQUIRED
- [x] FX VAT source = REVIEW_REQUIRED
- [x] EUR accounting currency implemented
- [x] Original currencies preserved
- [x] Idempotency constraints implemented (proven: T9)
- [x] Foreign keys correct (verified on fresh migration)
- [x] Unique constraints correct (proven: T9, plus one-sided line check T12)
- [x] Audit structure present + append-only (proven: T8)
- [x] Reconciliation structure present
- [x] Existing production flows unaffected (no ALTER on operational tables)
- [x] Migration tested successfully (self-test: all 12 guarantees behave as designed)

## Status model implemented

- **Tax:** `DRAFT / REVIEW_REQUIRED / APPROVED / ACTIVE / RETIRED`
- **Accounting entry:** `DRAFT / POSTED / REVERSED / VOIDED`
- **Period:** `OPEN / SOFT_CLOSED / CLOSED / REOPENED`
- **Reconciliation:** `MATCHED / PARTIALLY_MATCHED / UNMATCHED / MANUAL_REVIEW`

## STOP CONDITION (per brief)

Phase 1 ends here. Do not implement production tax rules or VAT calculations
until the Steuerberater has reviewed and approved: (1) the Tax Matrix, (2) AirPiv's
contractual role, and (3) the FX/VAT conversion methodology.
