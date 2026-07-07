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

As of this writing, all six have been run against the live database.
