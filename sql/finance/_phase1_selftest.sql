-- ============================================================
-- AirPiv Finance — Phase 1 SELF-TEST (not a migration; run against a
-- disposable copy). Proves the DB-level integrity guarantees hold.
-- Each block should either SUCCEED silently or raise the EXPECTED error.
-- Uses savepoints so a deliberately-failing case doesn't abort the run.
-- ============================================================
\set ON_ERROR_STOP 0
\echo '--- T1: config seeded with the mandated REVIEW_REQUIRED / regime values ---'
select key, value, review_status from finance_config
 where key in ('vat_regime','airpiv_business_role','vat_fx_source','accounting_currency') order by key;

\echo '--- T2: a BALANCED entry can be posted ---'
begin;
  insert into accounting_periods (year, month) values (2026, 8) on conflict do nothing;
  insert into accounting_accounts (code,name,account_type) values
    ('T_BANK','Test bank','ASSET'),('T_REV','Test revenue','REVENUE') on conflict do nothing;
  with e as (
    insert into journal_entries (source_type, description, accounting_period_id)
    select 'test','balanced', id from accounting_periods where year=2026 and month=8
    returning id)
  insert into journal_lines (journal_entry_id, account_id, debit_minor, debit_eur_minor, credit_minor, credit_eur_minor)
  select e.id, a1.id, 10000, 10000, 0, 0 from e, accounting_accounts a1 where a1.code='T_BANK'
  union all
  select e.id, a2.id, 0, 0, 10000, 10000 from e, accounting_accounts a2 where a2.code='T_REV';
  select finance_post_journal_entry((select id from journal_entries where description='balanced'));
  select status, posting_date is not null as has_posting_date from journal_entries where description='balanced';
commit;

\echo '--- T3: an UNBALANCED entry is REJECTED at POST (expect error) ---'
begin;
  with e as (
    insert into journal_entries (source_type, description) values ('test','unbalanced') returning id)
  insert into journal_lines (journal_entry_id, account_id, debit_minor, debit_eur_minor)
  select e.id, a.id, 9999, 9999 from e, accounting_accounts a where a.code='T_BANK';
  select finance_post_journal_entry((select id from journal_entries where description='unbalanced'));  -- EXPECT: double-entry violation
rollback;

\echo '--- T4: a POSTED entry cannot be UPDATEd in value (expect error) ---'
update journal_entries set description='hacked', currency='USD'
 where description='balanced';  -- EXPECT: immutable error

\echo '--- T5: a POSTED entry cannot be DELETEd (expect error) ---'
delete from journal_entries where description='balanced';  -- EXPECT: cannot DELETE

\echo '--- T6: a POSTED entry line cannot be changed (expect error) ---'
update journal_lines set debit_minor=1
 where journal_entry_id=(select id from journal_entries where description='balanced');  -- EXPECT: frozen

\echo '--- T7: POSTED → REVERSED transition IS allowed (correction path) ---'
update journal_entries set status='REVERSED' where description='balanced';
select status from journal_entries where description='balanced';

\echo '--- T8: audit_logs are append-only (insert ok, update/delete error) ---'
insert into audit_logs (action, entity_type, entity_id) values ('POST','journal_entry','x');
update audit_logs set action='TAMPER' where entity_id='x';  -- EXPECT: append-only error
delete from audit_logs where entity_id='x';                  -- EXPECT: append-only error

\echo '--- T9: financial_events idempotency_key is UNIQUE (2nd insert error) ---'
insert into financial_events (event_type,source_type,idempotency_key,original_amount_minor,original_currency)
  values ('booking_paid','stripe','idem-1',11500,'EUR');
insert into financial_events (event_type,source_type,idempotency_key,original_amount_minor,original_currency)
  values ('booking_paid','stripe','idem-1',11500,'EUR');  -- EXPECT: duplicate key

\echo '--- T10: no POSTING into a CLOSED period (expect error) ---'
-- NB: the entry must be BALANCED so the period guard is what rejects it
-- (an unbalanced entry would be caught earlier by the balance trigger).
begin;
  insert into accounting_periods (year, month, status) values (2025, 1, 'CLOSED') on conflict (year,month) do update set status='CLOSED';
  with e as (
    insert into journal_entries (source_type, description, accounting_period_id)
    select 'test','into-closed', id from accounting_periods where year=2025 and month=1 returning id)
  insert into journal_lines (journal_entry_id, account_id, debit_eur_minor, credit_eur_minor)
  select e.id, a.id, 100, 0 from e, accounting_accounts a where a.code='T_BANK'
  union all
  select e.id, a.id, 0, 100 from e, accounting_accounts a where a.code='T_REV';
  update journal_entries set status='POSTED' where description='into-closed';  -- EXPECT: period CLOSED
rollback;

\echo '--- T11: tax_rule_versions content is immutable; lifecycle mutable ---'
update tax_rule_versions set vat_rate=19 where version=1;  -- EXPECT: content immutable error
update tax_rule_versions set review_status='APPROVED', status='APPROVED' where version=1;  -- allowed
select r.rule_code, v.status as version_status, v.review_status
  from tax_rules r join tax_rule_versions v on v.tax_rule_id=r.id;

\echo '--- T12: one-sided line constraint (debit AND credit) rejected ---'
begin;
  insert into journal_entries (source_type, description) values ('test','bad-line');
  insert into journal_lines (journal_entry_id, account_id, debit_eur_minor, credit_eur_minor)
  select id, (select id from accounting_accounts where code='T_BANK'), 5, 5
   from journal_entries where description='bad-line';  -- EXPECT: one_sided_eur violation
rollback;

\echo '--- SELFTEST COMPLETE ---'
