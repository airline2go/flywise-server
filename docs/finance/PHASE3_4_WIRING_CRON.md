# PHASE 3 & 4 — Production Service Wiring + Automatic Sync (Cron)

> Wires the Phase 2 finance services to admin HTTP routes and to safe,
> re-runnable cron jobs. **No finance/tax logic is rewritten** and **no tax rule
> is activated** — unclassified data stays `REVIEW_REQUIRED`. VAT figures are
> reported as `REVIEW_REQUIRED` everywhere until the Tax Matrix is approved.

## Phase 3 — Finance API (`src/routes/admin-finance.routes.js`)

Mounted in `server.js`. Reads require `requireAdmin`; money-moving / manual-job
actions require `requireFullAdmin`. All rate-limited; all admin actions audited.

| Method + path | Purpose |
|---|---|
| `GET /admin/finance/dashboard` | headline source totals + status counts (MATCHED/UNMATCHED/REVIEW_REQUIRED/BLOCKED); VAT = REVIEW_REQUIRED |
| `GET /admin/finance/transactions` | financial_events, filterable by type/review_status/booking |
| `GET /admin/finance/bookings/:id` | full booking financial detail — events, stripe, duffel, tax, journal entries, refunds, chargebacks, reconciliation (every amount traceable) |
| `GET /admin/finance/reconciliation` | matches + open exceptions |
| `POST /admin/finance/reconciliation/booking/:id` | run reconciliation for one booking |
| `GET /admin/finance/stripe/transactions` | Stripe balance-transaction mirror |
| `GET /admin/finance/duffel/invoices` | official Duffel invoice mirror |
| `GET/POST /admin/finance/refunds` | list / record a refund (independent event) |
| `GET/POST /admin/finance/chargebacks` | list / record a chargeback (independent event) |
| `GET /admin/finance/exceptions` | tax + reconciliation exceptions |
| `GET /admin/finance/accountant/summary?year&month` | period summary (preparation only; VAT REVIEW_REQUIRED) |
| `GET /admin/finance/documents` | document vault (reads if provisioned; Phase 19 stub otherwise) |
| `POST /admin/finance/jobs/:job/run` | run a named job manually |
| `GET /admin/finance/jobs` | recent `finance_job_runs` |

## Phase 4 — Cron (`src/services/finance/financeCron.js`)

Self-starting, `.unref()`'d schedulers — **disabled unless `FINANCE_CRON_ENABLED=true`**,
so merging this never starts syncing production data on its own. Each tick runs
through `jobRunner` (records a `finance_job_runs` row + an append-only audit
entry). Idempotency lives on the target tables' unique keys, so a double tick
can never create duplicate accounting entries.

Jobs (`src/services/finance/financeJobs.js`), each returning
`{ records_processed, records_failed, summary }`:

| Job | Covers | Notes |
|---|---|---|
| `stripe_sync` | balance txns, fees, refunds, disputes, payouts | fees stored as fees, never VAT |
| `duffel_sync` | official Duffel invoices | drains optional `duffel_invoice_inbox`; no-ops honestly if none |
| `reconcile_bookings` | booking↔stripe↔duffel | never matches on amount alone |
| `tax_exception_detection` | flags unclassified events | creates `TAX_REVIEW_REQUIRED`; never classifies |
| `ledger_integrity_check` | daily debit=credit audit | raises `LEDGER_IMBALANCE` on any anomaly |

Migration `sql/finance/08_finance_jobs.sql` adds `finance_job_runs`
(job_id, name, timing, status, counts, error log) for observability.

## Guarantees honoured

- Idempotent: every write keys off a unique idempotency key — double runs no-op.
- Observable + audited: every job run recorded with counts + status + audit entry.
- No production VAT: cron may create `financial_event` / `tax_transaction` with
  `classification_status = REVIEW_REQUIRED`, but never applies an unapproved rule.
- Additive & safe: existing booking/payment/webhook hot paths untouched; new
  route module + cron are the only wiring, and cron is off by default.

## Tests

- `test/finance.jobs.test.js` — jobRunner success/failure recording; ledger
  imbalance detection; tax-exception creation.
- `test/admin-finance.routes.test.js` — dashboard/transactions/summary + auth,
  asserting VAT stays REVIEW_REQUIRED.

Full suite: **56 suites / 643 tests pass**. `node --check server.js` OK; eslint clean.
