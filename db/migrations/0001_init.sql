-- =============================================================================
-- Claude AI SRE Platform — initial PostgreSQL schema
--
-- Roles (see README.md "Database roles"):
--   * Migration owner (e.g. `sre_owner`): owns all objects. The EC2 scheduler
--     connects as this role (table owners bypass RLS).
--   * `sre_app` (NOLOGIN group role): the dashboard's login user is a member.
--     Can only SELECT tenant tables (filtered by RLS) and call `app.*` functions.
--
-- Tenant isolation: the dashboard runs every query inside a transaction that
-- sets `app.user_id` (see backend/db/index.ts withUser()). RLS policies use it.
-- =============================================================================

create schema if not exists private;   -- secrets, sessions, scheduler state: no app access
create schema if not exists app;       -- functions callable by the dashboard

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'sre_app') then
    create role sre_app nologin;
  end if;
end;
$$;

revoke all on schema private from public;
revoke all on schema app from public;
grant usage on schema public to sre_app;
grant usage on schema app to sre_app;

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------
create type public.org_role as enum ('owner', 'admin', 'member', 'viewer');
create type public.log_provider as enum ('cloudwatch', 'elasticsearch', 'cloudfront', 'datadog');
create type public.connector_status as enum ('pending', 'connected', 'degraded', 'disconnected', 'disabled');
create type public.ingest_mode as enum ('errors_only', 'all');
create type public.git_provider as enum ('github');
create type public.pr_policy as enum ('draft_only', 'approval_required');
create type public.severity as enum ('low', 'medium', 'high', 'critical');
create type public.incident_status as enum ('new', 'investigating', 'needs_review', 'resolved', 'ignored');
create type public.workflow_state as enum (
  'RECEIVED', 'NORMALIZED', 'GROUPED', 'TRIAGED', 'INVESTIGATING',
  'REPOSITORY_RESOLVED', 'PATCH_PROPOSED', 'VALIDATING', 'AWAITING_APPROVAL',
  'PR_CREATED',
  'NEEDS_HUMAN_REVIEW', 'DUPLICATE', 'IGNORED', 'FAILED', 'CANCELLED'
);
create type public.run_status as enum ('queued', 'running', 'succeeded', 'failed', 'cancelled');
create type public.pr_status as enum ('draft', 'open', 'merged', 'closed', 'failed');
create type public.approval_decision as enum ('approved', 'rejected');
create type public.alert_kind as enum (
  'pii_detected', 'secret_detected', 'new_incident', 'incident_regression',
  'incident_spike', 'connector_error', 'scheduler_error'
);
create type public.alert_status as enum ('open', 'acknowledged', 'resolved');
create type public.sensitive_category as enum ('pii', 'secret');

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------
create or replace function private.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- The user the dashboard is acting for (set per transaction by withUser()).
create or replace function app.current_user_id()
returns uuid language sql stable set search_path = '' as $$
  select nullif(current_setting('app.user_id', true), '')::uuid;
$$;

-- -----------------------------------------------------------------------------
-- Users, sessions, organizations
-- -----------------------------------------------------------------------------
create table public.users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null check (email = lower(email) and email like '%_@_%'),
  display_name  text,
  created_at    timestamptz not null default now()
);
create unique index users_email_key on public.users (email);

create table private.user_credentials (
  user_id        uuid primary key references public.users (id) on delete cascade,
  password_hash  text not null,
  updated_at     timestamptz not null default now()
);

create table private.sessions (
  token_hash    text primary key,           -- sha256(token); the raw token is only in the cookie
  user_id       uuid not null references public.users (id) on delete cascade,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  last_seen_at  timestamptz not null default now()
);
create index sessions_user_idx on private.sessions (user_id);
create index sessions_expires_idx on private.sessions (expires_at);

create table public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 2 and 100),
  slug        text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'),
  created_at  timestamptz not null default now()
);

create table public.organization_members (
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  user_id          uuid not null references public.users (id) on delete cascade,
  role             public.org_role not null default 'member',
  created_at       timestamptz not null default now(),
  primary key (organization_id, user_id)
);
create index organization_members_user_idx on public.organization_members (user_id);

create or replace function app.is_org_member(org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.organization_members m
    where m.organization_id = org and m.user_id = app.current_user_id()
  );
$$;

create or replace function app.has_org_role(org uuid, roles public.org_role[])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.organization_members m
    where m.organization_id = org and m.user_id = app.current_user_id() and m.role = any (roles)
  );
$$;

-- -----------------------------------------------------------------------------
-- AWS accounts, connectors, log sources
-- -----------------------------------------------------------------------------
create table public.aws_accounts (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  display_name     text not null,
  account_id       text not null check (account_id ~ '^[0-9]{12}$'),
  role_arn         text not null check (role_arn like 'arn:aws:iam::%:role/%'),
  created_at       timestamptz not null default now(),
  unique (organization_id, account_id)
);

create table private.aws_account_secrets (
  aws_account_id  uuid primary key references public.aws_accounts (id) on delete cascade,
  external_id     text not null             -- sts:ExternalId for cross-account AssumeRole
);

-- One connector per (provider, AWS account, region). aws_account_id NULL means
-- "use the EC2 instance profile of the scheduler".
create table public.log_connectors (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  aws_account_id    uuid references public.aws_accounts (id) on delete set null,
  provider          public.log_provider not null,
  name              text not null,
  region            text check (region ~ '^[a-z]{2}(-[a-z]+)+-[0-9]$'),
  status            public.connector_status not null default 'pending',
  settings          jsonb not null default '{}'::jsonb,   -- non-secret metadata only
  last_success_at   timestamptz,
  last_error        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (organization_id, name)
);
create trigger log_connectors_updated_at before update on public.log_connectors
  for each row execute function private.set_updated_at();

create table public.log_sources (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references public.organizations (id) on delete cascade,
  connector_id           uuid not null references public.log_connectors (id) on delete cascade,
  source_name            text not null,          -- CloudWatch log group name, index pattern, ...
  service_name           text,
  environment            text,
  ingest_mode            public.ingest_mode not null default 'errors_only',
  filter_pattern         text,                   -- CloudWatch filter pattern; NULL = default error pattern
  pii_scan               boolean not null default true,
  poll_interval_seconds  integer not null default 60 check (poll_interval_seconds between 15 and 3600),
  enabled                boolean not null default true,
  last_polled_at         timestamptz,
  last_event_at          timestamptz,
  last_error             text,
  created_at             timestamptz not null default now(),
  unique (connector_id, source_name)
);
create index log_sources_org_idx on public.log_sources (organization_id);
create index log_sources_due_idx on public.log_sources (enabled, last_polled_at);

-- Scheduler checkpoint per source. next_token is set when a run stopped mid-window.
create table private.cloudwatch_checkpoints (
  log_source_id  uuid primary key references public.log_sources (id) on delete cascade,
  window_start   timestamptz not null,
  window_end     timestamptz not null,
  next_token     text,
  updated_at     timestamptz not null default now()
);

-- Event IDs already processed (dedupe for the overlap window); pruned by the scheduler.
create table private.processed_log_events (
  log_source_id  uuid not null references public.log_sources (id) on delete cascade,
  event_id       text not null,
  seen_at        timestamptz not null default now(),
  primary key (log_source_id, event_id)
);
create index processed_log_events_seen_idx on private.processed_log_events (seen_at);

create table public.connector_health_checks (
  id               bigint generated always as identity primary key,
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  connector_id     uuid not null references public.log_connectors (id) on delete cascade,
  log_source_id    uuid references public.log_sources (id) on delete cascade,
  status           public.connector_status not null,
  error_code       text,
  message          text,
  checked_at       timestamptz not null default now()
);
create index connector_health_checks_connector_idx on public.connector_health_checks (connector_id, checked_at desc);

-- -----------------------------------------------------------------------------
-- Repository registry
-- -----------------------------------------------------------------------------
create table public.repositories (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  provider         public.git_provider not null default 'github',
  owner            text not null,
  name             text not null,
  installation_id  bigint,
  default_branch   text not null default 'main',
  technology       text[] not null default '{}',
  services         text[] not null default '{}',
  test_commands    text[] not null default '{}',
  pr_policy        public.pr_policy not null default 'approval_required',
  enabled          boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, provider, owner, name)
);
create trigger repositories_updated_at before update on public.repositories
  for each row execute function private.set_updated_at();

create table public.repository_mappings (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  repository_id    uuid not null references public.repositories (id) on delete cascade,
  log_source_id    uuid references public.log_sources (id) on delete cascade,
  service_name     text,
  created_at       timestamptz not null default now(),
  check (log_source_id is not null or service_name is not null)
);
create index repository_mappings_repo_idx on public.repository_mappings (repository_id);

-- -----------------------------------------------------------------------------
-- Incidents and investigations
-- -----------------------------------------------------------------------------
create table public.incidents (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  fingerprint      text not null,
  title            text not null,
  severity         public.severity not null default 'medium',
  status           public.incident_status not null default 'new',
  workflow_state   public.workflow_state not null default 'GROUPED',
  environment      text,
  service_name     text,
  log_source_id    uuid references public.log_sources (id) on delete set null,
  repository_id    uuid references public.repositories (id) on delete set null,
  first_seen       timestamptz not null default now(),
  last_seen        timestamptz not null default now(),
  occurrences      integer not null default 1 check (occurrences >= 1),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, fingerprint)
);
create index incidents_org_last_seen_idx on public.incidents (organization_id, last_seen desc);
create index incidents_org_status_idx on public.incidents (organization_id, status);
create trigger incidents_updated_at before update on public.incidents
  for each row execute function private.set_updated_at();

-- Sampled, redacted events per incident (not every log line).
create table public.incident_events (
  id               bigint generated always as identity primary key,
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  incident_id      uuid not null references public.incidents (id) on delete cascade,
  log_source_id    uuid references public.log_sources (id) on delete set null,
  event_time       timestamptz not null,
  log_stream       text,
  provider_event_id text,
  message_excerpt  text,                  -- REDACTED and truncated
  request_id       text,
  trace_id         text
);
create index incident_events_incident_idx on public.incident_events (incident_id, event_time desc);

create table public.investigations (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  incident_id      uuid not null references public.incidents (id) on delete cascade,
  status           public.workflow_state not null default 'RECEIVED',
  summary          text,
  root_cause       text,
  confidence       numeric(4, 3) check (confidence between 0 and 1),
  analysis         jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index investigations_incident_idx on public.investigations (incident_id);
create trigger investigations_updated_at before update on public.investigations
  for each row execute function private.set_updated_at();

create table public.agent_runs (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  investigation_id  uuid not null references public.investigations (id) on delete cascade,
  agent_name        text not null,
  model             text,
  status            public.run_status not null default 'queued',
  input_tokens      integer,
  output_tokens     integer,
  latency_ms        integer,
  error             text,
  started_at        timestamptz,
  finished_at       timestamptz,
  created_at        timestamptz not null default now()
);

create table public.code_changes (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  investigation_id  uuid not null references public.investigations (id) on delete cascade,
  repository_id     uuid not null references public.repositories (id) on delete cascade,
  patch_ref         text,
  diff_summary      text,
  files_changed     text[] not null default '{}',
  created_at        timestamptz not null default now()
);

create table public.validation_runs (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  code_change_id   uuid not null references public.code_changes (id) on delete cascade,
  status           public.run_status not null default 'queued',
  commands         jsonb not null default '[]'::jsonb,
  results_ref      text,
  created_at       timestamptz not null default now(),
  finished_at      timestamptz
);

create table public.pull_requests (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations (id) on delete cascade,
  code_change_id      uuid references public.code_changes (id) on delete set null,
  repository_id       uuid not null references public.repositories (id) on delete cascade,
  incident_id         uuid references public.incidents (id) on delete set null,
  provider_pr_number  integer,
  url                 text,
  title               text not null,
  source_branch       text not null,
  base_branch         text not null,
  status              public.pr_status not null default 'open',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (repository_id, provider_pr_number)
);
create index pull_requests_org_idx on public.pull_requests (organization_id, created_at desc);
create trigger pull_requests_updated_at before update on public.pull_requests
  for each row execute function private.set_updated_at();

create table public.approvals (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  investigation_id  uuid not null references public.investigations (id) on delete cascade,
  user_id           uuid not null references public.users (id),
  decision          public.approval_decision not null,
  comment           text,
  created_at        timestamptz not null default now()
);

create table public.incident_comments (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  incident_id      uuid not null references public.incidents (id) on delete cascade,
  user_id          uuid not null default app.current_user_id() references public.users (id),
  body             text not null check (char_length(body) between 1 and 5000),
  created_at       timestamptz not null default now()
);
create index incident_comments_incident_idx on public.incident_comments (incident_id, created_at);

-- -----------------------------------------------------------------------------
-- PII / secret findings and alerts
-- -----------------------------------------------------------------------------
-- Aggregated per (source, type). Raw values are NEVER stored; only a masked sample.
create table public.pii_findings (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  log_source_id     uuid not null references public.log_sources (id) on delete cascade,
  pii_type          text not null,               -- email, phone, credit_card, aadhaar, aws_access_key, ...
  category          public.sensitive_category not null,
  severity          public.severity not null,
  occurrences       bigint not null default 0,
  masked_sample     text,
  sample_log_stream text,
  sample_event_id   text,
  first_seen        timestamptz not null default now(),
  last_seen         timestamptz not null default now(),
  unique (log_source_id, pii_type)
);
create index pii_findings_org_idx on public.pii_findings (organization_id, last_seen desc);

create table public.alerts (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  kind              public.alert_kind not null,
  severity          public.severity not null,
  status            public.alert_status not null default 'open',
  title             text not null,
  body              text,                         -- never contains raw PII or secrets
  dedup_key         text not null,
  occurrences       integer not null default 1,
  incident_id       uuid references public.incidents (id) on delete set null,
  log_source_id     uuid references public.log_sources (id) on delete set null,
  details           jsonb not null default '{}'::jsonb,
  first_seen        timestamptz not null default now(),
  last_seen         timestamptz not null default now(),
  notified_at       timestamptz,
  notify_attempts   integer not null default 0,
  next_notify_at    timestamptz,
  acknowledged_by   uuid references public.users (id),
  resolved_at       timestamptz
);
-- One OPEN/ACKNOWLEDGED alert per dedup key; a resolved alert lets a new one open.
create unique index alerts_active_dedup_key on public.alerts (organization_id, dedup_key)
  where status <> 'resolved';
create index alerts_org_last_seen_idx on public.alerts (organization_id, last_seen desc);
create index alerts_pending_notify_idx on public.alerts (next_notify_at) where notified_at is null;

create table public.alert_deliveries (
  id               bigint generated always as identity primary key,
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  alert_id         uuid not null references public.alerts (id) on delete cascade,
  channel          text not null,                 -- slack, email
  succeeded        boolean not null,
  error            text,
  created_at       timestamptz not null default now()
);
create index alert_deliveries_alert_idx on public.alert_deliveries (alert_id);

-- -----------------------------------------------------------------------------
-- Scheduler, usage, audit
-- -----------------------------------------------------------------------------
create table public.scheduler_runs (
  id           bigint generated always as identity primary key,
  job          text not null,
  host         text,
  status       public.run_status not null default 'running',
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  stats        jsonb not null default '{}'::jsonb,
  error        text
);
create index scheduler_runs_job_idx on public.scheduler_runs (job, started_at desc);

create table public.model_usage_events (
  id                  bigint generated always as identity primary key,
  organization_id     uuid not null references public.organizations (id) on delete cascade,
  incident_id         uuid references public.incidents (id) on delete set null,
  agent_run_id        uuid references public.agent_runs (id) on delete set null,
  model               text not null,
  input_tokens        integer not null default 0,
  output_tokens       integer not null default 0,
  cached_input_tokens integer not null default 0,
  latency_ms          integer,
  succeeded           boolean not null default true,
  estimated_cost_usd  numeric(12, 6),
  created_at          timestamptz not null default now()
);
create index model_usage_events_org_time_idx on public.model_usage_events (organization_id, created_at desc);

create table public.audit_events (
  id               bigint generated always as identity primary key,
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  actor_id         uuid,
  actor_type       text not null default 'user' check (actor_type in ('user', 'system', 'agent')),
  action           text not null,
  resource_type    text,
  resource_id      text,
  metadata         jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);
create index audit_events_org_time_idx on public.audit_events (organization_id, created_at desc);

create or replace function private.prevent_audit_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'audit_events is append-only';
end;
$$;
create trigger audit_events_append_only before update or delete on public.audit_events
  for each row execute function private.prevent_audit_mutation();

create or replace function app.write_audit(
  org uuid, action text, resource_type text, resource_id text, metadata jsonb default '{}'::jsonb
)
returns void language sql security definer set search_path = '' as $$
  insert into public.audit_events (organization_id, actor_id, actor_type, action, resource_type, resource_id, metadata)
  values (org, app.current_user_id(),
          case when app.current_user_id() is null then 'system' else 'user' end,
          action, resource_type, resource_id, metadata);
$$;

-- -----------------------------------------------------------------------------
-- Row-Level Security (defense in depth for the dashboard role)
-- -----------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'users', 'organizations', 'organization_members', 'aws_accounts', 'log_connectors',
    'log_sources', 'connector_health_checks', 'repositories', 'repository_mappings',
    'incidents', 'incident_events', 'investigations', 'agent_runs', 'code_changes',
    'validation_runs', 'pull_requests', 'approvals', 'incident_comments', 'pii_findings',
    'alerts', 'alert_deliveries', 'scheduler_runs', 'model_usage_events', 'audit_events'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
  end loop;

  -- Tenant tables: members of the organization can read.
  foreach t in array array[
    'aws_accounts', 'log_connectors', 'log_sources', 'connector_health_checks',
    'repositories', 'repository_mappings', 'incidents', 'incident_events', 'investigations',
    'agent_runs', 'code_changes', 'validation_runs', 'pull_requests', 'approvals',
    'incident_comments', 'pii_findings', 'alerts', 'alert_deliveries', 'model_usage_events'
  ]
  loop
    execute format(
      'create policy "members read %1$s" on public.%1$I for select to sre_app
         using (app.is_org_member(organization_id))', t);
  end loop;
end;
$$;

create policy "members read their organizations" on public.organizations
  for select to sre_app using (app.is_org_member(id));

create policy "members read memberships" on public.organization_members
  for select to sre_app using (app.is_org_member(organization_id));

create policy "users read self and co-members" on public.users
  for select to sre_app using (
    id = app.current_user_id()
    or exists (
      select 1 from public.organization_members mine
      join public.organization_members theirs on theirs.organization_id = mine.organization_id
      where mine.user_id = app.current_user_id() and theirs.user_id = users.id
    )
  );

create policy "admins read audit events" on public.audit_events
  for select to sre_app
  using (app.has_org_role(organization_id, array['owner', 'admin']::public.org_role[]));

-- Scheduler health is platform-wide operational data; any signed-in user may read it.
create policy "signed-in users read scheduler runs" on public.scheduler_runs
  for select to sre_app using (app.current_user_id() is not null);

create policy "members comment on incidents" on public.incident_comments
  for insert to sre_app with check (
    user_id = app.current_user_id()
    and app.has_org_role(organization_id, array['owner', 'admin', 'member']::public.org_role[])
    and exists (select 1 from public.incidents i
                where i.id = incident_id and i.organization_id = incident_comments.organization_id)
  );

grant select on all tables in schema public to sre_app;
grant insert (organization_id, incident_id, body) on public.incident_comments to sre_app;
revoke all on all tables in schema private from sre_app;

-- -----------------------------------------------------------------------------
-- Auth functions (security definer: the dashboard never reads private tables)
-- -----------------------------------------------------------------------------
create or replace function app.sign_up(p_email text, p_password_hash text, p_display_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  new_id uuid;
begin
  insert into public.users (email, display_name)
  values (lower(trim(p_email)), nullif(trim(p_display_name), ''))
  returning id into new_id;
  insert into private.user_credentials (user_id, password_hash) values (new_id, p_password_hash);
  return new_id;
end;
$$;

create or replace function app.get_login(p_email text)
returns table (user_id uuid, password_hash text)
language sql stable security definer set search_path = '' as $$
  select u.id, c.password_hash
  from public.users u join private.user_credentials c on c.user_id = u.id
  where u.email = lower(trim(p_email));
$$;

create or replace function app.create_session(p_user_id uuid, p_token_hash text, p_ttl_seconds integer)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare
  exp timestamptz := now() + make_interval(secs => p_ttl_seconds);
begin
  insert into private.sessions (token_hash, user_id, expires_at) values (p_token_hash, p_user_id, exp);
  return exp;
end;
$$;

create or replace function app.session_user(p_token_hash text)
returns table (user_id uuid, email text, display_name text)
language sql security definer set search_path = '' as $$
  update private.sessions s set last_seen_at = now()
  from public.users u
  where s.token_hash = p_token_hash and s.expires_at > now() and u.id = s.user_id
  returning u.id, u.email, u.display_name;
$$;

create or replace function app.delete_session(p_token_hash text)
returns void language sql security definer set search_path = '' as $$
  delete from private.sessions where token_hash = p_token_hash;
$$;

-- -----------------------------------------------------------------------------
-- Write functions for the dashboard (role-checked + audited)
-- -----------------------------------------------------------------------------
create or replace function app.create_organization(org_name text, org_slug text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := app.current_user_id();
  new_id uuid;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  insert into public.organizations (name, slug) values (org_name, org_slug) returning id into new_id;
  insert into public.organization_members (organization_id, user_id, role) values (new_id, uid, 'owner');
  perform app.write_audit(new_id, 'organization.created', 'organization', new_id::text,
                          jsonb_build_object('slug', org_slug));
  return new_id;
end;
$$;

create or replace function app.register_repository(
  org_id uuid, repo_owner text, repo_name text, base_branch text default 'main',
  repo_installation_id bigint default null, repo_technology text[] default '{}',
  repo_services text[] default '{}', repo_test_commands text[] default '{}',
  repo_pr_policy public.pr_policy default 'approval_required'
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  new_id uuid;
begin
  if not app.has_org_role(org_id, array['owner', 'admin']::public.org_role[]) then
    raise exception 'only organization owners and admins can register repositories' using errcode = '42501';
  end if;
  insert into public.repositories (organization_id, owner, name, default_branch, installation_id,
                                   technology, services, test_commands, pr_policy)
  values (org_id, repo_owner, repo_name, base_branch, repo_installation_id,
          repo_technology, repo_services, repo_test_commands, repo_pr_policy)
  returning id into new_id;
  perform app.write_audit(org_id, 'repository.registered', 'repository', new_id::text,
                          jsonb_build_object('owner', repo_owner, 'name', repo_name));
  return new_id;
end;
$$;

create or replace function app.set_repository_enabled(repo_id uuid, is_enabled boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  org uuid;
begin
  select organization_id into org from public.repositories where id = repo_id;
  if org is null or not app.has_org_role(org, array['owner', 'admin']::public.org_role[]) then
    raise exception 'repository not found or not permitted' using errcode = '42501';
  end if;
  update public.repositories set enabled = is_enabled where id = repo_id;
  perform app.write_audit(org, case when is_enabled then 'repository.enabled' else 'repository.disabled' end,
                          'repository', repo_id::text);
end;
$$;

create or replace function app.add_cloudwatch_source(
  org_id uuid, p_region text, p_log_group text, p_service_name text, p_environment text,
  p_ingest_mode public.ingest_mode default 'errors_only', p_filter_pattern text default null,
  p_pii_scan boolean default true, p_poll_interval_seconds integer default 60,
  p_aws_account_id uuid default null
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  conn_id uuid;
  new_id uuid;
  conn_name text;
begin
  if not app.has_org_role(org_id, array['owner', 'admin']::public.org_role[]) then
    raise exception 'only organization owners and admins can add log sources' using errcode = '42501';
  end if;
  if p_aws_account_id is not null and not exists (
    select 1 from public.aws_accounts where id = p_aws_account_id and organization_id = org_id
  ) then
    raise exception 'AWS account not found' using errcode = '42501';
  end if;

  select id into conn_id from public.log_connectors
  where organization_id = org_id and provider = 'cloudwatch' and region = p_region
    and aws_account_id is not distinct from p_aws_account_id;

  if conn_id is null then
    conn_name := 'CloudWatch ' || p_region || coalesce(
      ' · ' || (select display_name from public.aws_accounts where id = p_aws_account_id), ' · instance role');
    insert into public.log_connectors (organization_id, aws_account_id, provider, name, region)
    values (org_id, p_aws_account_id, 'cloudwatch', conn_name, p_region)
    returning id into conn_id;
  end if;

  insert into public.log_sources (organization_id, connector_id, source_name, service_name, environment,
                                  ingest_mode, filter_pattern, pii_scan, poll_interval_seconds)
  values (org_id, conn_id, p_log_group, nullif(trim(p_service_name), ''), nullif(trim(p_environment), ''),
          p_ingest_mode, nullif(trim(p_filter_pattern), ''), p_pii_scan, p_poll_interval_seconds)
  returning id into new_id;

  perform app.write_audit(org_id, 'log_source.added', 'log_source', new_id::text,
                          jsonb_build_object('provider', 'cloudwatch', 'region', p_region, 'logGroup', p_log_group));
  return new_id;
end;
$$;

create or replace function app.set_log_source_enabled(source_id uuid, is_enabled boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  org uuid;
begin
  select organization_id into org from public.log_sources where id = source_id;
  if org is null or not app.has_org_role(org, array['owner', 'admin']::public.org_role[]) then
    raise exception 'log source not found or not permitted' using errcode = '42501';
  end if;
  update public.log_sources set enabled = is_enabled where id = source_id;
  perform app.write_audit(org, case when is_enabled then 'log_source.enabled' else 'log_source.disabled' end,
                          'log_source', source_id::text);
end;
$$;

create or replace function app.set_incident_status(target_incident uuid, new_status public.incident_status)
returns void language plpgsql security definer set search_path = '' as $$
declare
  org uuid;
begin
  select organization_id into org from public.incidents where id = target_incident;
  if org is null or not app.has_org_role(org, array['owner', 'admin', 'member']::public.org_role[]) then
    raise exception 'incident not found or not permitted' using errcode = '42501';
  end if;
  update public.incidents set status = new_status where id = target_incident;
  perform app.write_audit(org, 'incident.status_changed', 'incident', target_incident::text,
                          jsonb_build_object('status', new_status));
end;
$$;

create or replace function app.set_alert_status(target_alert uuid, new_status public.alert_status)
returns void language plpgsql security definer set search_path = '' as $$
declare
  org uuid;
begin
  select organization_id into org from public.alerts where id = target_alert;
  if org is null or not app.has_org_role(org, array['owner', 'admin', 'member']::public.org_role[]) then
    raise exception 'alert not found or not permitted' using errcode = '42501';
  end if;
  update public.alerts
  set status = new_status,
      acknowledged_by = case when new_status = 'acknowledged' then app.current_user_id() else acknowledged_by end,
      resolved_at = case when new_status = 'resolved' then now() else null end
  where id = target_alert;
  perform app.write_audit(org, 'alert.' || new_status::text, 'alert', target_alert::text);
end;
$$;

revoke all on all functions in schema app from public;
grant execute on all functions in schema app to sre_app;

-- -----------------------------------------------------------------------------
-- Dashboard views (security_invoker => caller's RLS applies)
-- -----------------------------------------------------------------------------
create view public.organization_overview with (security_invoker = true) as
select
  o.id as organization_id,
  (select count(*)::int from public.incidents i
     where i.organization_id = o.id and i.status in ('new', 'investigating', 'needs_review')) as open_incidents,
  (select count(*)::int from public.incidents i
     where i.organization_id = o.id and i.severity in ('high', 'critical')
       and i.status in ('new', 'investigating', 'needs_review')) as open_high_severity,
  (select count(*)::int from public.alerts a
     where a.organization_id = o.id and a.status = 'open') as open_alerts,
  (select count(*)::int from public.alerts a
     where a.organization_id = o.id and a.status = 'open'
       and a.kind in ('pii_detected', 'secret_detected')) as open_pii_alerts,
  (select count(*)::int from public.pull_requests p
     where p.organization_id = o.id and p.status in ('draft', 'open')) as pull_requests_awaiting_review,
  (select count(*)::int from public.repositories r
     where r.organization_id = o.id and r.enabled) as repositories_enabled,
  (select count(*)::int from public.log_sources s
     where s.organization_id = o.id and s.enabled) as log_sources_enabled,
  (select count(*)::int from public.log_sources s
     where s.organization_id = o.id and s.enabled and s.last_error is not null) as log_sources_failing,
  (select coalesce(sum(m.input_tokens + m.output_tokens), 0)::bigint from public.model_usage_events m
     where m.organization_id = o.id and m.created_at > now() - interval '30 days') as model_tokens_30d,
  (select coalesce(sum(m.estimated_cost_usd), 0) from public.model_usage_events m
     where m.organization_id = o.id and m.created_at > now() - interval '30 days') as model_cost_usd_30d
from public.organizations o;

grant select on public.organization_overview to sre_app;

-- Platform data the scheduler owns must stay owner-only even if new tables are added later.
alter default privileges in schema private revoke all on tables from public;
