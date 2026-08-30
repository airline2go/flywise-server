-- ============================================================
-- AirPiv Finance — Phase 1 · 06 · INTEGRITY (constraints, triggers, posting)
-- Run once AFTER 00–05. Idempotent (functions replaced, triggers re-created).
--
-- These enforce DATABASE INTEGRITY only — never business/tax logic
-- (Decision 4 design rule). Namely:
--   * double-entry: a journal entry can only reach POSTED when
--     Σ debit_eur = Σ credit_eur (and it has ≥1 line);
--   * posted entries are immutable in value; DELETE blocked unless DRAFT;
--   * posted lines are frozen;
--   * corrections happen via REVERSED/VOIDED status + a new entry, never edits;
--   * no posting into a CLOSED period;
--   * audit_logs and tax_rule_versions content are write-once.
-- Legitimate corrections are NOT blocked — they use reversal/adjustment.
-- ============================================================

-- ── Double-entry balance guard on transition into POSTED ────
create or replace function finance_assert_entry_balanced() returns trigger as $$
declare
  v_debit  bigint;
  v_credit bigint;
  v_lines  int;
begin
  if new.status = 'POSTED' and (tg_op = 'INSERT' or old.status is distinct from 'POSTED') then
    select coalesce(sum(debit_eur_minor),0), coalesce(sum(credit_eur_minor),0), count(*)
      into v_debit, v_credit, v_lines
      from journal_lines where journal_entry_id = new.id;
    if v_lines = 0 then
      raise exception 'Cannot POST journal entry % : it has no lines', new.id;
    end if;
    if v_debit <> v_credit then
      raise exception 'Double-entry violation on entry % : debit(% ) <> credit(% ) EUR minor',
        new.id, v_debit, v_credit;
    end if;
    if new.posting_date is null then
      new.posting_date := current_date;
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_journal_entries_balance on journal_entries;
create trigger trg_journal_entries_balance
  before insert or update on journal_entries
  for each row execute function finance_assert_entry_balanced();

-- ── Immutability of journal entries once they leave DRAFT ────
create or replace function finance_journal_entry_immutable() returns trigger as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'DRAFT' then
      raise exception 'Cannot DELETE journal entry % in status % — use a reversal', old.id, old.status;
    end if;
    return old;
  end if;

  -- UPDATE path
  if old.status = 'POSTED' then
    -- Only allow the lifecycle transition POSTED → REVERSED/VOIDED and the
    -- bookkeeping of the reversal link. Every monetary/source field frozen.
    if new.status not in ('POSTED','REVERSED','VOIDED') then
      raise exception 'Invalid status transition % → % on posted entry %', old.status, new.status, old.id;
    end if;
    if  new.entry_number   is distinct from old.entry_number
     or new.entry_date     is distinct from old.entry_date
     or new.posting_date   is distinct from old.posting_date
     or new.accounting_period_id is distinct from old.accounting_period_id
     or new.source_type    is distinct from old.source_type
     or new.source_id      is distinct from old.source_id
     or new.financial_event_id is distinct from old.financial_event_id
     or new.booking_id     is distinct from old.booking_id
     or new.currency       is distinct from old.currency
     or new.exchange_rate  is distinct from old.exchange_rate
     or new.reversal_of    is distinct from old.reversal_of
    then
      raise exception 'Posted journal entry % is immutable — only status/reversed_by may change', old.id;
    end if;
  elsif old.status in ('REVERSED','VOIDED') then
    raise exception 'Journal entry % is % and fully immutable', old.id, old.status;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_journal_entries_immutable on journal_entries;
create trigger trg_journal_entries_immutable
  before update or delete on journal_entries
  for each row execute function finance_journal_entry_immutable();

-- ── Freeze lines of a non-DRAFT entry ───────────────────────
create or replace function finance_journal_line_frozen() returns trigger as $$
declare v_status text; v_entry uuid;
begin
  v_entry := coalesce(new.journal_entry_id, old.journal_entry_id);
  select status into v_status from journal_entries where id = v_entry;
  -- v_status is null only while the parent is being cascade-deleted (DRAFT only,
  -- already guarded above) — allow that.
  if v_status is not null and v_status <> 'DRAFT' then
    raise exception 'Cannot % line of entry % in status % — entry is not DRAFT', tg_op, v_entry, v_status;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_journal_lines_frozen on journal_lines;
create trigger trg_journal_lines_frozen
  before insert or update or delete on journal_lines
  for each row execute function finance_journal_line_frozen();

-- ── No posting into a CLOSED period ─────────────────────────
create or replace function finance_period_posting_guard() returns trigger as $$
declare v_pstatus text;
begin
  if new.status = 'POSTED' and new.accounting_period_id is not null then
    select status into v_pstatus from accounting_periods where id = new.accounting_period_id;
    if v_pstatus = 'CLOSED' then
      raise exception 'Accounting period % is CLOSED — cannot POST entry %', new.accounting_period_id, new.id;
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_journal_period_guard on journal_entries;
create trigger trg_journal_period_guard
  before insert or update on journal_entries
  for each row execute function finance_period_posting_guard();

-- ── audit_logs: append-only ─────────────────────────────────
create or replace function finance_append_only() returns trigger as $$
begin
  raise exception 'Table % is append-only — % is not permitted', tg_table_name, tg_op;
end;
$$ language plpgsql;

drop trigger if exists trg_audit_logs_append_only on audit_logs;
create trigger trg_audit_logs_append_only
  before update or delete on audit_logs
  for each row execute function finance_append_only();

drop trigger if exists trg_finance_config_versions_append_only on finance_config_versions;
create trigger trg_finance_config_versions_append_only
  before update or delete on finance_config_versions
  for each row execute function finance_append_only();

-- ── tax_rule_versions: content immutable, lifecycle mutable ─
create or replace function finance_tax_rule_version_immutable() returns trigger as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'tax_rule_versions are immutable — cannot DELETE version % of rule %', old.version, old.tax_rule_id;
  end if;
  -- Block edits to any content column; allow only lifecycle columns.
  if  new.tax_rule_id        is distinct from old.tax_rule_id
   or new.version            is distinct from old.version
   or new.tax_type           is distinct from old.tax_type
   or new.transaction_type   is distinct from old.transaction_type
   or new.service_type       is distinct from old.service_type
   or new.supplier_type      is distinct from old.supplier_type
   or new.customer_type      is distinct from old.customer_type
   or new.customer_country   is distinct from old.customer_country
   or new.supplier_country   is distinct from old.supplier_country
   or new.origin_country     is distinct from old.origin_country
   or new.destination_country is distinct from old.destination_country
   or new.route_type         is distinct from old.route_type
   or new.vat_rate           is distinct from old.vat_rate
   or new.taxable_percentage is distinct from old.taxable_percentage
   or new.output_vat_required is distinct from old.output_vat_required
   or new.input_vat_allowed  is distinct from old.input_vat_allowed
   or new.reverse_charge     is distinct from old.reverse_charge
   or new.exemption_code     is distinct from old.exemption_code
   or new.revenue_recognition is distinct from old.revenue_recognition
   or new.legal_basis        is distinct from old.legal_basis
   or new.source_reference   is distinct from old.source_reference
   or new.valid_from         is distinct from old.valid_from
  then
    raise exception 'tax_rule_versions content is immutable — create a new version instead (rule %, v%)',
      old.tax_rule_id, old.version;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_tax_rule_versions_immutable on tax_rule_versions;
create trigger trg_tax_rule_versions_immutable
  before update or delete on tax_rule_versions
  for each row execute function finance_tax_rule_version_immutable();

-- ── Helper: atomically post a balanced entry (backend convenience) ──
-- The balance/period guards above fire regardless of how status becomes
-- POSTED; this function is just the blessed one-call path.
create or replace function finance_post_journal_entry(p_entry_id uuid) returns void as $$
begin
  update journal_entries set status = 'POSTED' where id = p_entry_id and status = 'DRAFT';
  if not found then
    raise exception 'Entry % not found or not in DRAFT', p_entry_id;
  end if;
end;
$$ language plpgsql;
