-- ============================================================
-- Airpiv — Durable webhook event store (run once in Supabase SQL
-- Editor). Safe to re-run: every statement is idempotent.
--
-- [F3/F5 · WEBHOOK-DURABILITY] Stripe and Duffel webhooks previously
-- ACK'd 200 and then processed in-memory: if processing failed after the
-- ACK (crash, restart, transient Duffel/DB error) the event was only sent
-- to Sentry — never persisted, never retryable, and a re-delivery could be
-- re-processed from scratch. These tables make every received event
-- durable and de-duplicated:
--   * a UNIQUE event id means the same event is never processed twice,
--   * a status column (received | processed | processing_failed) lets a
--     reconciliation/worker job retry only what actually failed,
--   * retry_count / last_error give that job what it needs to back off.
-- ============================================================

create extension if not exists pgcrypto;

-- ─── Stripe webhook events ──────────────────────────────────────
create table if not exists stripe_webhook_events (
  stripe_event_id text primary key,          -- Stripe's own event id (evt_...) — the idempotency key
  type            text,
  session_id      text,                       -- checkout session id (cs_...) when present
  payment_intent  text,
  status          text not null default 'received',  -- received | processed | processing_failed
  retry_count     int  not null default 0,
  last_error      text,
  received_at     timestamptz not null default now(),
  processed_at    timestamptz
);
create index if not exists stripe_webhook_events_status_idx on stripe_webhook_events (status);
create index if not exists stripe_webhook_events_session_idx on stripe_webhook_events (session_id);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'stripe_webhook_events_status_check') then
    alter table stripe_webhook_events
      add constraint stripe_webhook_events_status_check
      check (status in ('received', 'processed', 'processing_failed'));
  end if;
end $$;

-- ─── Duffel webhook events ──────────────────────────────────────
create table if not exists duffel_webhook_events (
  duffel_event_id text primary key,          -- Duffel's own event id — the idempotency key
  type            text,
  status          text not null default 'received',
  retry_count     int  not null default 0,
  last_error      text,
  received_at     timestamptz not null default now(),
  processed_at    timestamptz
);
create index if not exists duffel_webhook_events_status_idx on duffel_webhook_events (status);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'duffel_webhook_events_status_check') then
    alter table duffel_webhook_events
      add constraint duffel_webhook_events_status_check
      check (status in ('received', 'processed', 'processing_failed'));
  end if;
end $$;
