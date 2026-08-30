# AirPiv Tax Matrix — DRAFT for Steuerberater review

> **STATUS: DRAFT · NOT APPROVED · NOT ACTIVE.**
> This document is the *structure* of AirPiv's Tax Matrix. Every outcome cell is
> intentionally left **`REVIEW_REQUIRED`** — AirPiv has invented **no** VAT rate,
> exemption, reverse-charge, deductibility, or revenue-recognition decision
> (spec Phases 49–50, non-negotiable rules 1–9, 20). A German Steuerberater must
> fill in and approve each row before it becomes an `ACTIVE` `tax_rule_version`.
>
> Regime (confirmed by the operator, not the software): **Regelbesteuerung**.
> Accounting currency: **EUR**. AirPiv contractual role: **`REVIEW_REQUIRED`**.
> VAT FX conversion method: **`REVIEW_REQUIRED`**.

## How this maps to the engine

Each approved row becomes one `tax_rule_versions` row (see `sql/finance/03_tax.sql`):
matching **dimensions** (left columns) + **outcome** (right columns). The Tax
Engine (`src/services/finance/taxEngine.js`) selects the most specific `ACTIVE`,
date-valid rule whose constrained dimensions match a transaction; if none
matches, the transaction is `REVIEW_REQUIRED` and a `tax_exception` is raised —
the engine never guesses.

**Dimensions:** `transaction_type · service_type · supplier_type · customer_type ·
customer_country · supplier_country · origin_country · destination_country ·
route_type`
**Outcome (to be decided by Steuerberater):** `vat_rate · taxable_percentage ·
output_vat_required · input_vat_allowed · reverse_charge · exemption_code ·
revenue_recognition · legal_basis · source_reference · valid_from`

---

## Section A — Sales / Output side (AirPiv → customer)

| # | Scenario | txn_type | service | customer_type | cust_country | route_type | → VAT rate | reverse_charge | revenue_recognition | legal_basis |
|---|----------|----------|---------|---------------|--------------|-----------|-----------|----------------|---------------------|-------------|
| A1 | Flight mediation, German consumer, domestic flight | sale | flight | B2C | DE | domestic | REVIEW_REQUIRED | REVIEW_REQUIRED | REVIEW_REQUIRED | _tbd_ |
| A2 | Flight mediation, German consumer, intra-EU flight | sale | flight | B2C | DE | intra_eu | REVIEW_REQUIRED | REVIEW_REQUIRED | REVIEW_REQUIRED | _tbd_ |
| A3 | Flight mediation, German consumer, international flight | sale | flight | B2C | DE | international | REVIEW_REQUIRED | REVIEW_REQUIRED | REVIEW_REQUIRED | _tbd_ |
| A4 | Flight mediation, EU consumer (non-DE) | sale | flight | B2C | EU | any | REVIEW_REQUIRED | REVIEW_REQUIRED | REVIEW_REQUIRED | _tbd_ |
| A5 | Flight mediation, non-EU consumer | sale | flight | B2C | NON_EU | any | REVIEW_REQUIRED | REVIEW_REQUIRED | REVIEW_REQUIRED | _tbd_ |
| A6 | Flight mediation, EU business customer (VAT-ID) | sale | flight | B2B | EU | any | REVIEW_REQUIRED | REVIEW_REQUIRED | REVIEW_REQUIRED | _tbd_ |
| A7 | Flight mediation, German business customer | sale | flight | B2B | DE | any | REVIEW_REQUIRED | REVIEW_REQUIRED | REVIEW_REQUIRED | _tbd_ |
| A8 | AirPiv service/booking fee (markup component) | sale | service_fee | B2C | DE | n/a | REVIEW_REQUIRED | REVIEW_REQUIRED | REVIEW_REQUIRED | _tbd_ |
| A9 | Ancillary — baggage | sale | ancillary_baggage | B2C | DE | any | REVIEW_REQUIRED | REVIEW_REQUIRED | REVIEW_REQUIRED | _tbd_ |
| A10 | Ancillary — seat | sale | ancillary_seat | B2C | DE | any | REVIEW_REQUIRED | REVIEW_REQUIRED | REVIEW_REQUIRED | _tbd_ |
| A11 | Mixed / multi-leg route (partly domestic, partly intl) | sale | flight | B2C | DE | mixed | REVIEW_REQUIRED | REVIEW_REQUIRED | REVIEW_REQUIRED | _tbd_ |

## Section B — Purchases / Input side (supplier → AirPiv)

| # | Scenario | txn_type | service | supplier_type | supp_country | → input_vat_allowed | deductibility | reverse_charge | legal_basis |
|---|----------|----------|---------|---------------|--------------|---------------------|---------------|----------------|-------------|
| B1 | Duffel supplier cost (airline fare via Duffel) | purchase | flight_cost | ota_aggregator | REVIEW_REQUIRED | REVIEW_REQUIRED | REVIEW_REQUIRED | REVIEW_REQUIRED | _tbd_ |
| B2 | Duffel platform fee | purchase | platform_fee | ota_aggregator | REVIEW_REQUIRED | REVIEW_REQUIRED | REVIEW_REQUIRED | REVIEW_REQUIRED | _tbd_ |
| B3 | Stripe payment processing fee | purchase | payment_fee | psp | REVIEW_REQUIRED | REVIEW_REQUIRED | REVIEW_REQUIRED | REVIEW_REQUIRED | _tbd_ |
| B4 | Software subscription (foreign supplier) | purchase | software | saas | NON_DE | REVIEW_REQUIRED | REVIEW_REQUIRED | REVIEW_REQUIRED | _tbd_ |
| B5 | Advertising (e.g. non-DE platform) | purchase | advertising | media | NON_DE | REVIEW_REQUIRED | REVIEW_REQUIRED | REVIEW_REQUIRED | _tbd_ |
| B6 | Hosting / infrastructure (foreign supplier) | purchase | hosting | saas | NON_DE | REVIEW_REQUIRED | REVIEW_REQUIRED | REVIEW_REQUIRED | _tbd_ |
| B7 | German-supplier service with German VAT | purchase | service | domestic | DE | REVIEW_REQUIRED | REVIEW_REQUIRED | REVIEW_REQUIRED | _tbd_ |

## Section C — Adjustments (refunds, cancellations, chargebacks, credit notes)

| # | Scenario | txn_type | basis | → tax adjustment | legal_basis |
|---|----------|----------|-------|------------------|-------------|
| C1 | Full refund of a sale | refund | links to original sale row | REVIEW_REQUIRED | _tbd_ |
| C2 | Partial refund | refund | pro-rata of original | REVIEW_REQUIRED | _tbd_ |
| C3 | Cancellation with airline fee retained | refund | net of retained fee | REVIEW_REQUIRED | _tbd_ |
| C4 | Chargeback (dispute lost) | chargeback | reverses the sale | REVIEW_REQUIRED | _tbd_ |
| C5 | Chargeback recovered (dispute won) | chargeback | no net effect | REVIEW_REQUIRED | _tbd_ |
| C6 | Credit note against an issued invoice | credit_note | links to invoice | REVIEW_REQUIRED | _tbd_ |

## Section D — Edge / exception scenarios (must NOT auto-classify)

These deliberately have **no** rule and must always land in the exception queue:

| # | Scenario | Expected engine behaviour |
|---|----------|---------------------------|
| D1 | Supplier with missing VAT-ID | `TAX_RULE_NOT_FOUND` / `MISSING_SUPPLIER_VAT_ID` → REVIEW_REQUIRED |
| D2 | Unknown supplier country | REVIEW_REQUIRED |
| D3 | Unknown / missing customer country | REVIEW_REQUIRED |
| D4 | Foreign-currency transaction with no approved VAT FX method | REVIEW_REQUIRED (vat_fx_source unapproved) |
| D5 | AirPiv role still `REVIEW_REQUIRED` | Revenue recognition REVIEW_REQUIRED |
| D6 | Zero-value / test transaction | recorded, REVIEW_REQUIRED for tax |

---

## Approval workflow (per row)

1. Steuerberater fills the outcome columns + `legal_basis` + `valid_from`.
2. Row is entered as a new `tax_rule_versions` (status `REVIEW_REQUIRED`).
3. Steuerberater/TAX_REVIEWER sets `review_status = APPROVED`, then `status = ACTIVE`.
4. Only `ACTIVE`, date-valid versions are ever applied; version content is immutable
   thereafter (a change is a new version — enforced in `06_integrity_triggers.sql`).

**Until every needed row is `ACTIVE`, AirPiv produces `REVIEW_REQUIRED` classifications
and issues no tax invoice under an assumed rate. This is by design.**

## Open legal questions to resolve first

1. **AirPiv contractual role** — principal vs. intermediary/agent (§25 UStG
   Reiseleistungen / Margenbesteuerung vs. Vermittlung?). Drives A-rows and revenue recognition.
2. **Place of supply** for flight mediation to B2C vs B2B, DE/EU/non-EU.
3. **Reverse-charge** applicability for B3–B6 foreign suppliers (§13b UStG).
4. **Input-VAT deductibility** for each purchase category.
5. **VAT FX conversion method** (§16 UStG / BMF guidance) → sets `vat_fx_source`.
