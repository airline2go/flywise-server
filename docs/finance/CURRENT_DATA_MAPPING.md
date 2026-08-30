# CURRENT_DATA_MAPPING.md

> **AirPiv — Phase 0 Audit (2/3)**
> Explicit mapping from **existing** storage to the **planned** Finance/Accounting/VAT
> data model (Spec Phases 2–4, 8–18). Purpose: reuse what already exists, never
> duplicate a table when the data is already captured.
> Status: mapping only. No migration is performed in Phase 0.

Legend:
`✅ exists` = usable as-is · `🟡 partial` = exists but must be extended ·
`❌ missing` = must be created new.

---

## 1. Money fields (Spec Phase 2 — integer minor units + FX)

| Planned field | Current source | Status |
|---|---|---|
| `amount_minor` | derived at runtime via `money.toMinor()`; DB stores `numeric(10,2)` | 🟡 add minor-unit columns / mirror table |
| `currency` | `bookings.currency`, `payments.currency` | ✅ |
| `original_amount_minor` / `original_currency` | Duffel offer `total_amount`/`total_currency` (not persisted as minor) | 🟡 |
| `accounting_amount_minor` / `accounting_currency` (EUR) | — | ❌ |
| `exchange_rate` / `_source` / `_timestamp` | — (single-currency assumption) | ❌ |

**Decision:** keep `money.js` as the calculation engine; introduce minor-unit +
FX columns on new financial tables rather than rewriting the legacy `numeric`
columns (additive, non-breaking).

---

## 2. Booking financial breakdown (Spec Phase 8)

| Planned | Current `bookings` column | Status |
|---|---|---|
| `customer_total` | `customer_paid` | ✅ |
| `supplier_fare` | `duffel_amount` | ✅ (Duffel NET) |
| `airpiv_markup` | `ticket_margin` (+ `ancillary_margin`) | ✅ |
| `ancillary_revenue` / `supplier_ancillary_cost` | folded into `ancillary_margin` / `duffel_amount` | 🟡 not split out |
| `airpiv_remuneration` | — (role/commission model undefined) | ❌ |
| `stripe_fee` | — (not captured anywhere) | ❌ |
| `duffel_fee` | — (only order NET stored) | ❌ |
| `refund_amount` | — (status flip only) | ❌ |
| `chargeback_amount` | — | ❌ |
| `taxable_base` / `output_vat` / `input_vat` / `reverse_charge_vat` | — | ❌ |
| `net_margin` | `profit_margin` (generated) | 🟡 pre-fee only |
| `revenue_recognition_method` (PRINCIPAL/AGENT/…) | — | ❌ |

**Decision:** `bookings` stays the operational record. A new
`booking_accounting` / `financial_events` layer holds fees, refunds, VAT and role.

---

## 3. Payments / Stripe (Spec Phase 10)

| Planned `stripe_transactions` | Current | Status |
|---|---|---|
| `stripe_id`, `type` | `payments.stripe_payment_id` (PI only) | 🟡 |
| `gross` / `fee` / `net` | `payments.amount`; fee/net absent | 🟡 fee ❌ |
| `payout_id` | — | ❌ |
| `booking_id` | link via `stripe_session_id`/`stripe_payment_id` | ✅ join key exists |
| Balance txns / payouts / disputes / refunds tables | — | ❌ |

**Reusable join keys already present:** `stripe_session_id`, `stripe_payment_id`
on both `bookings` and `payments`.

---

## 4. Duffel (Spec Phase 9)

| Planned | Current | Status |
|---|---|---|
| `duffel_order_id` | `bookings.duffel_order_id`, `pending_bookings` | ✅ |
| `duffel_offer_id` | `bookings.duffel_offer_id` | ✅ |
| supplier NET cost | `bookings.duffel_amount` / `payments.supplier_amount` | ✅ |
| `duffel_invoices` / `duffel_invoice_lines` | — | ❌ |
| Duffel fees | — | ❌ |
| `document_reference`, supplier_country/tax_id | — | ❌ |

---

## 5. Refunds / Chargebacks (Spec Phases 12–13)

| Planned | Current | Status |
|---|---|---|
| `refunds` table | Stripe refund call + `recordCancellationEvent` event; `payments.status='refunded'` | ❌ table |
| refund fee breakdown | computed live in `/cancel-quote` (airline fee + AirPiv service fee), **not persisted** | 🟡 |
| `chargebacks` / `stripe_disputes` | — | ❌ |
| tax adjustment on refund | — | ❌ |

---

## 6. Invoices / Credit notes (Spec Phases 16–17)

| Planned | Current `invoices` | Status |
|---|---|---|
| `invoice_number` (gap-free) | `invoice_number` + `invoice_seq` sequence | ✅ excellent base |
| `customer_name/address`, `booking_id`, `amount`, `currency` | present | ✅ |
| `net_amount` / `vat_rate` / `vat_amount` / `gross_amount` | — (single `amount`) | ❌ |
| `customer_country` / `customer_type` | — | ❌ |
| `tax_exemption_text` / `legal_reference` | — | ❌ |
| line items (`customer_invoice_lines`) | `fields` jsonb snapshot only | 🟡 |
| `credit_notes` | — | ❌ |
| tax mode | `invoice_config.taxMode` (`kleinunternehmer`/`regular`) | 🟡 not rule-driven |

---

## 7. Accounting core (Spec Phases 3–5)

| Planned | Current | Status |
|---|---|---|
| `accounting_accounts`, `journal_entries`, `journal_lines`, `accounting_periods` | — | ❌ all |
| double-entry / debit=credit enforcement | — | ❌ |
| immutable ledger + reversal chain | — | ❌ |

---

## 8. Tax engine (Spec Phases 6–7, 14–15)

| Planned | Current | Status |
|---|---|---|
| `tax_rules` / `tax_rule_versions` / `tax_configuration*` | — | ❌ |
| `tax_transactions`, `input_vat`, `output_vat`, `reverse_charge_transactions` | — | ❌ |
| classification (role, B2C/B2B, countries, route) | — | ❌ |
| customer/supplier country & tax id | not captured on bookings/suppliers | ❌ |

---

## 9. Audit / periods / retention (Spec Phases 20–21, 44)

| Planned | Current | Status |
|---|---|---|
| immutable `audit_logs` | `admin_activity_log` (mutable, app-level) | 🟡 reuse pattern, not immutability |
| ledger of value movements | `loyalty_transactions`, `admin_credit_log` | 🟡 loyalty/credit only |
| `accounting_periods` + closing checkpoints | — | ❌ |
| retention policy engine | — | ❌ |

---

## 10. Roles (Spec Phase 31)

| Planned role | Current equivalent | Status |
|---|---|---|
| OWNER | `admin` (full) | 🟡 |
| STAFF | `staff` | ✅ |
| FINANCE_ADMIN / ACCOUNTANT / TAX_REVIEWER / AUDITOR | — | ❌ |

Role check enum lives in `admin_users.role CHECK (role in ('admin','staff'))` and
`adminAuth.js` — extending it is a contained change.

---

## 11. Reusable assets (do NOT rebuild)

- `src/utils/money.js` — minor units + rounding → central rounding service (Phase 43).
- `stripe_webhook_events` / `duffel_webhook_events` — idempotency substrate (Phase 35).
- `invoice_seq` sequence — gap-free numbering (Phase 16).
- `admin_config` k/v store — tax configuration versions can build on it (Phase 6/32).
- `api_logs` + Sentry — observability substrate (Phase 47).
- `bookings.stripe_session_id / stripe_payment_id / duffel_order_id / duffel_offer_id`
  — the reconciliation join keys already exist (Phase 11).
