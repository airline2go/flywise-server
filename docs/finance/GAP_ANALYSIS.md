# GAP_ANALYSIS.md

> **AirPiv — Phase 0 Audit (3/3)**
> What the Finance/Accounting/VAT spec requires vs. what exists today, and the
> proposed build order. No tax rule is invented in this document — the Tax Matrix
> stays empty until a Steuerberater approves it (Spec Phases 49–50).

---

## 1. Gap summary by domain

| Domain | Have | Missing | Severity |
|---|---|---|---|
| Money model | integer-minor util (`money.js`), per-row currency | FX record, accounting currency, minor-unit persistence | High |
| Accounting core | — | accounts, double-entry journal, ledger, periods | **Critical** |
| Immutability | webhook dedup, invoice seq | immutable ledger, reversal chain, immutable audit log | **Critical** |
| Tax engine | invoice `taxMode` flag | rule engine, versions, classification, tax_transactions | **Critical** |
| Output VAT | — | output_vat, VAT on invoices, VAT returns | **Critical** |
| Input VAT / Vorsteuer | — | supplier expenses, deductibility | High |
| Reverse charge | — | RC module + rule-driven detection | High |
| Stripe finance | PI + refund calls | fees, balance txns, payouts, disputes import | High |
| Duffel finance | order NET | invoices, invoice lines, fees import | High |
| Refunds | status flip + event | refund financial events + tax adjustment | High |
| Chargebacks | — | dispute/chargeback records | High |
| Reconciliation | join keys exist | matching engine + exceptions | High |
| Invoices | gap-free seq | VAT breakdown, line items, country/type, credit notes | High |
| Documents | invoice `fields` jsonb | document vault + versioning + hashing + retention | Medium |
| Periods/closing | — | open/close/reopen + checkpoints | High |
| Accountant export | `/admin/stats` | ZIP package, DATEV, README, Verfahrensdok. | High |
| Roles | admin/staff | finance roles matrix | Medium |
| Cron jobs | route refreshers | finance sync/reconciliation/VAT jobs | Medium |
| Tests | some jest tests | 25 integrity + 50 tax + reconciliation suites | High |
| E-Rechnung | — | XRechnung/ZUGFeRD/EN16931 | Low (future-ready) |

---

## 2. Non-negotiable rules — current compliance check

| # | Rule | Today | Action |
|---|---|---|---|
| 1 | Never VAT from profit | N/A (no VAT yet) | Enforce in Tax Engine |
| 2 | Never assume customer_total = revenue | ⚠️ `/admin/stats` treats Σ customer_paid as "revenue" | Add revenue_recognition_method |
| 3 | Never assume foreign supplier = reverse charge | N/A | Rule-driven RC only |
| 4 | Never assume VAT deductible | N/A | Deductibility field |
| 5 | No hard-coded tax rules in booking/payment | ✅ none exist | Keep engine separate |
| 6 | Never delete accounting entries | ⚠️ `/admin/promos` DELETE etc. exist (non-accounting) | Immutable ledger, reversal only |
| 7 | No silent modify of posted entries | ⚠️ `bookings.status` mutated in place | Post immutable events |
| 8 | Never overwrite tax rules | N/A | Versioning from day 1 |
| 9 | No invoice with assumed VAT under uncertainty | ⚠️ invoices issued with no VAT logic | Gate on classification |
| 10 | Never hide reconciliation diffs | N/A | Exceptions queue |
| 11 | Stripe/Duffel fees ≠ VAT | ✅ fees not treated as VAT (they're just absent) | Capture fees, classify via engine |
| 12 | Prefer official supplier invoice over API | ⚠️ only API NET used | Import Duffel invoices |
| 13 | Every amount has currency | ✅ | Keep |
| 14 | Every transaction has a source | 🟡 partial (join keys) | financial_events.source_type/id |
| 15 | Every tax calc has rule id+version | N/A | Enforce |
| 16 | Manual change has user+time+reason | 🟡 admin_activity_log | Extend to immutable audit |
| 17 | Corrections via reversal chain | ❌ | Build |
| 18 | Closed VAT period reproducible | ❌ | Build |
| 19 | Export == dashboard numbers | ❌ | Build consistency check |
| 20 | Uncertain → REVIEW_REQUIRED, never guess | ❌ | Core engine behaviour |

⚠️ = an existing behaviour that must be superseded (not deleted) by the accounting layer.

---

## 3. Proposed build order (maps to Spec Phase 53)

Phase 0 (**this deliverable**) is complete once these three docs are reviewed.
Recommended increments, each shippable and testable on its own:

1. **DB migration foundation** — accounts, journal entries/lines, periods,
   financial_events, tax_rules(+versions), tax_transactions (Spec 3–7). Additive,
   `create table if not exists`, RLS service-role only.
2. **Money/FX + central rounding service** (Spec 2, 43) building on `money.js`.
3. **Financial events + double-entry ledger + immutability/reversal** (Spec 4–5).
4. **Tax Rule Engine + classification → REVIEW_REQUIRED default** (Spec 6–7).
   *Ships with an EMPTY rule set — no invented rules.*
5. **Stripe finance sync** (fees, balance txns, payouts, disputes) (Spec 10).
6. **Duffel invoice sync** (Spec 9).
7. **Reconciliation engine + exceptions** (Spec 11).
8. **Refunds + chargebacks as financial events** (Spec 12–13).
9. **Input VAT + reverse charge + supplier invoices** (Spec 14–15).
10. **Customer invoices (VAT-aware) + credit notes** (Spec 16–17).
11. **Periods/closing + VAT period + exceptions queue** (Spec 21–23).
12. **Accountant dashboard + package export + DATEV mapping** (Spec 24–27).
13. **Audit/GoBD controls + Verfahrensdokumentation + retention** (Spec 20, 29–30, 44).
14. **Finance roles + API + cron + observability** (Spec 31–34, 45–47).
15. **Test suites (integrity + tax matrix + reconciliation)** (Spec 36–38).
16. **Tax Matrix authored → Steuerberater review → activate in prod** (Spec 49–52).

---

## 4. Key risks / decisions to confirm before migration

1. **Minor-unit persistence** — new tables in integer minor units; legacy
   `numeric(10,2)` columns kept for back-compat. Confirm no dual-write drift by
   posting all new accounting off `financial_events`, not off `bookings`.
2. **FX source** — spec forbids arbitrary rates. Need an approved rate source
   (ECB daily? Stripe/Duffel's own reported rate per transaction?). **Open question.**
3. **AirPiv contractual role** (principal vs intermediary/agent) drives revenue
   recognition AND VAT. This is a **Steuerberater decision**, not a code default —
   engine must emit `REVIEW_REQUIRED` until configured.
4. **Kleinunternehmer vs Regelbesteuerung** — current `invoice_config.taxMode`
   suggests this is still undecided in production. Confirm the regime before the
   VAT engine is switched on.
5. **Supabase-only vs app-side** — accounting integrity (debit=credit, immutability)
   is best enforced with DB constraints + triggers; confirm we may add triggers.
6. **Where new server code lives** — proposed `src/services/finance/*` and
   `src/routes/admin-finance.routes.js`, `sql/finance/*.sql`.

---

## 5. Definition of done for Phase 0

- [x] Full project finance/payment/DB code audited.
- [x] Located where customer price, supplier fare, markup, refund, currency are stored.
- [x] Confirmed what is missing (fees, FX, VAT, ledger, reconciliation, audit).
- [x] Explicit reuse mapping (no duplicate tables planned).
- [x] Three deliverables produced (`CURRENT_FINANCE_ARCHITECTURE.md`,
      `CURRENT_DATA_MAPPING.md`, `GAP_ANALYSIS.md`).
- [ ] **Human sign-off + answers to §4 open questions before Phase 1 migration.**

> Per the spec: migration must NOT begin until Phase 0 is accepted, and no AirPiv
> tax rule is activated in production until the Steuerberater approves the Tax Matrix.
