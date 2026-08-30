-- ============================================================
-- AirPiv Finance — Phase 1 · 04 · ADJUSTMENTS & IMMUTABLE AUDIT LOG
-- Run once. Idempotent. Additive.
--
-- Corrections never mutate a posted entry — they are recorded here and
-- realised as a reversal + corrected entry in the ledger (spec Phase 5).
-- audit_logs is append-only: UPDATE/DELETE are blocked at the DB level
-- (06_integrity_triggers.sql), satisfying "user cannot delete audit logs"
-- (spec Phase 20).
-- ============================================================

create extension if not exists pgcrypto;

-- ── Accounting adjustments (the reason/paper-trail for a correction) ──
create table if not exists accounting_adjustments (
  id                 uuid primary key default gen_random_uuid(),
  adjustment_type    text not null default 'CORRECTION'
                       check (adjustment_type in ('CORRECTION','REVERSAL','RECLASS','WRITE_OFF','MANUAL')),
  source_entry_id    uuid references journal_entries(id) on delete restrict,
  reversal_entry_id  uuid references journal_entries(id) on delete restrict,
  corrected_entry_id uuid references journal_entries(id) on delete restrict,
  accounting_period_id uuid references accounting_periods(id) on delete restrict,
  reason             text not null,
  supporting_document uuid,          -- documents.id (documents table lands in a later phase)
  status             text not null default 'DRAFT'
                       check (status in ('DRAFT','POSTED','REVERSED','VOIDED')),
  created_at         timestamptz not null default now(),
  created_by         text not null
);
create index if not exists accounting_adjustments_source_idx on accounting_adjustments (source_entry_id);
create index if not exists accounting_adjustments_status_idx on accounting_adjustments (status);

-- ── Immutable audit log (spec Phase 20) ─────────────────────
-- Records CREATE/UPDATE/POST/REVERSE/VOID/APPROVE/REJECT/EXPORT/
-- TAX_RULE_CHANGE/MANUAL_ADJUSTMENT/DOCUMENT_*/PERIOD_CLOSE/PERIOD_REOPEN.
-- No CHECK on `action` (open vocabulary), but rows are write-once.
create table if not exists audit_logs (
  id          uuid primary key default gen_random_uuid(),
  actor_id    text,                 -- admin_users.id or system actor
  role        text,
  action      text not null,
  entity_type text,
  entity_id   text,
  old_value   jsonb,
  new_value   jsonb,
  reason      text,
  request_id  text,
  created_at  timestamptz not null default now()
);
create index if not exists audit_logs_entity_idx  on audit_logs (entity_type, entity_id);
create index if not exists audit_logs_action_idx  on audit_logs (action);
create index if not exists audit_logs_created_idx on audit_logs (created_at desc);
