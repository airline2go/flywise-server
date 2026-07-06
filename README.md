# Airpiv Server

Node.js/Express backend for the Airpiv flight-booking platform. It proxies flight search and booking to [Duffel](https://duffel.com), takes payment via [Stripe](https://stripe.com), stores data in [Supabase](https://supabase.com), and sends transactional email via [Brevo](https://www.brevo.com).

## Requirements

- Node.js >= 20
- A Duffel API token (required — the server fails fast on startup without one)
- Stripe, Supabase, Brevo and Sentry are all optional in development: each client degrades gracefully (returns `null`/no-ops) when unconfigured, so you can run and test most of the server with only a Duffel token set.

## Setup

```bash
npm install
cp .env.example .env   # fill in DUFFEL_TOKEN at minimum
npm start
```

The server listens on `PORT` (default `3000`). See `.env.example` for every recognized environment variable; `src/config/env.js` is the single source of truth for how each one is read and defaulted.

## Project structure

```
server.js               entry point — wires everything together (see its own header comment for the load order, which is intentional and load-bearing)
src/
  config/env.js          all environment variables, read once, in one place
  clients/               thin singletons for external services (supabase, stripe, redis, sentry) — each returns null/no-op when unconfigured
  middleware/             auth (admin bearer token + optional Supabase user auth), rate limiting, global request middleware
  services/               business logic: booking/pricing (booking.js), Duffel API wrapper, loyalty program, email, PDF tickets, etc.
  routes/                 one file per route group (search, booking, cancel, admin, webhooks, ...) — each exports `(app) => { ... }` and mounts its own paths
  utils/                  logging, input validation, request-body sanitization
test/                     Jest + Supertest test suite
```

`booking.js` is the most important file in the codebase — it's the single source of truth for pricing, price-drift protection, and refund-on-failure logic shared between `/confirm-payment` and the Stripe webhook. Read its header comment before changing it.

## Testing

```bash
npm test
```

The suite covers:
- Pure utilities: `validate.js`, `sanitize.js`, `normalizeOffer.js`, `routePages.js` (haversine/haul classification)
- The core booking/pricing logic in `booking.js`: authoritative price computation, price-drift protection, refund-on-order-failure, idempotency
- The proportional Stripe refund math in `cancel.routes.js`
- Critical `admin.routes.js` paths: profit-tier validation, promo code CRUD, invoice-config sanitization
- Route-level smoke tests for `health`, `promo`, `cancel`, and `booking` endpoints with no external credentials configured

Tests never call real Duffel/Stripe/Supabase APIs — external clients are mocked via Jest, and the app's own null-safe fallback behavior (every client degrades gracefully when unconfigured) is used to keep tests deterministic and offline.

## CI

`.github/workflows/ci.yml` runs on every push/PR to `main`:
- `node --check server.js` — fast syntax check
- `npm ci && npm test` — the full test suite
- `eslint` — non-blocking (`continue-on-error`), surfaces issues without failing the build

## Deployment

Deployed on Render, configured outside this repository. `server.js`'s own startup log reports which optional integrations (Stripe, Supabase, Sentry, Brevo) are active based on which environment variables are set.
