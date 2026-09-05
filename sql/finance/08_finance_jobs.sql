-- ============================================================
-- AirPiv Finance — Phase 4 · 08 · JOB RUNS (observability for cron sync)
-- Run once AFTER 00–07. Idempotent. Additive.
--
-- Every finance cron job records exactly one run row here (spec Phase 34):
-- job_id, name, timing, status, counts, error log. This makes each job
-- observable and auditable without changing what the job itself writes — the
-- idempotency that prevents duplicate accounting entries lives on the target
-- tables (unique idempotency keys), not here.
-- ============================================================

create extension if not exists pgcrypto;

create table if not exists finance_job_runs (
  id                uuid primary key default gen_random_uuid(),
  job_name          text not null,
  trigger           text not null default 'cron'      -- cron | manual | api
                      check (trigger in ('cron','manual','api')),
  started_at        timestamptz not null default now(),
  finished_at       timestamptz,
  status            text not null default 'RUNNING'
                      check (status in ('RUNNING','SUCCEEDED','FAILED','SKIPPED')),
  records_processed int not null default 0,
  records_failed    int not null default 0,
  summary           jsonb,
  error_log         text,
  triggered_by      text
);
create index if not exists finance_job_runs_name_idx    on finance_job_runs (job_name, started_at desc);
create index if not exists finance_job_runs_status_idx  on finance_job_runs (status);
