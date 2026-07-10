# Database migrations

There is no migration tool/runner here — these are plain `.sql` files, run
manually, once each, in Supabase's SQL Editor. Every statement in every
file is idempotent (`if not exists` / `drop policy if exists` / etc.), so
re-running any file is always safe.

Run order (oldest first — a fresh database should run them in this order;
an existing one only needs whichever haven't been run yet):

1. `schema_admin.sql` — the full base schema (tables, indexes, the
   `link_guest_bookings_to_user` function).
2. `migration_status_constraints.sql` — `CHECK` constraints on the
   `status` columns (`bookings`, `payments`, `pending_bookings`) and on
   `promo_codes.value`.
3. `rls_security_fixes.sql` — enables Row Level Security on every table,
   with server-only tables getting zero public policies and
   customer-owned tables (`bookings`, `passengers`, `reviews`) getting
   `auth.uid() = user_id` policies; also hardens `search_path` on
   `SECURITY DEFINER` functions.
4. `route_pages_dead_status.sql` — adds the `'dead'` status value to
   `route_pages` (routes confirmed to have no real flights, distinct from
   `'draft'`) and its health-check tracking column.
5. `missing_indexes.sql` — indexes on hot lookup columns
   (`duffel_order_id`, `booking_reference`, `stripe_payment_id`,
   `loyalty_accounts.tier`) that predate this file's existence.
6. `referrals_system.sql` — the `referrals` table (real
   `referrer_id`/`referred_id`/`booking_id` foreign keys, RLS with
   server-only writes) and `loyalty_accounts.referral_code`. Needed by
   `src/services/referrals.js` / `src/routes/referral.routes.js`.
7. `admin_staff.sql` — real per-admin accounts (`admin_users`,
   `admin_sessions`) with two roles (`admin` full access, `staff`
   restricted from margins/credit/staff-management), a general
   `admin_activity_log`, and a full credit-movement ledger
   (`loyalty_transactions`, `admin_credit_log`). The legacy
   `ADMIN_TOKEN` env var keeps working unchanged as a permanent
   fallback — this migration is purely additive. Needed by
   `src/services/adminAuth.js` / `src/routes/admin-staff.routes.js` /
   `src/routes/admin-customers.routes.js`.

As of this writing, the first six have been run against the live database.
`admin_staff.sql` (#7) is new and still needs to be run once before the
admin panel's staff-accounts/credit-top-up features go live.
