-- Durable one-row-per-outbound-attempt Duffel usage ledger.
-- The application writes a row BEFORE the outbound HTTP request starts.
create table if not exists public.duffel_api_call_audit (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  attempt_no integer not null,
  method text not null,
  endpoint text not null,
  source text not null,
  trigger text,
  actor_user_id uuid,
  search_session_id text,
  route_origin text,
  route_destination text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null default 'started',
  http_status integer,
  success boolean,
  billable_attempt boolean not null default true,
  duration_ms integer,
  duffel_request_id text,
  duffel_client_correlation_id text,
  error_code text,
  error_message text,
  metadata jsonb,
  constraint duffel_api_call_audit_attempt_no_chk check (attempt_no > 0),
  constraint duffel_api_call_audit_status_chk check (status in ('started','completed','failed','timeout','network_error'))
);
create unique index if not exists duffel_api_call_audit_request_attempt_uq on public.duffel_api_call_audit(request_id, attempt_no);
create index if not exists duffel_api_call_audit_started_at_idx on public.duffel_api_call_audit(started_at desc);
create index if not exists duffel_api_call_audit_source_idx on public.duffel_api_call_audit(source, started_at desc);
create index if not exists duffel_api_call_audit_endpoint_idx on public.duffel_api_call_audit(endpoint, started_at desc);
create index if not exists duffel_api_call_audit_actor_idx on public.duffel_api_call_audit(actor_user_id, started_at desc);
create index if not exists duffel_api_call_audit_route_idx on public.duffel_api_call_audit(route_origin, route_destination, started_at desc);
create index if not exists duffel_api_call_audit_billable_idx on public.duffel_api_call_audit(billable_attempt, started_at desc);
