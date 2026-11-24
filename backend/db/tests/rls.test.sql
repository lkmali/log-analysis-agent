-- Tenant-isolation tests for the dashboard role (sre_app).
-- Run: npm run db:test   (psql "$SCHEDULER_DATABASE_URL" -f backend/db/tests/rls.test.sql)
-- Everything runs in one transaction and is rolled back.
\set ON_ERROR_STOP on
begin;

-- Tiny assertion helpers (no pgTAP dependency) --------------------------------
create schema t;
create table t.results (n serial, ok boolean, description text);
create function t.check(ok boolean, description text) returns void language sql as $$
  insert into t.results (ok, description) values (coalesce(ok, false), description) $$;
create function t.throws(q text, code text, description text) returns void language plpgsql as $$
begin
  execute q;
  perform t.check(false, description || ' (no error raised)');
exception when others then
  perform t.check(sqlstate = code, description || ' (sqlstate ' || sqlstate || ')');
end $$;
create function t.lives(q text, description text) returns void language plpgsql as $$
begin
  execute q;
  perform t.check(true, description);
exception when others then
  perform t.check(false, description || ' (' || sqlstate || ': ' || sqlerrm || ')');
end $$;
grant usage on schema t to sre_app;
grant all on all tables in schema t to sre_app;
grant all on all sequences in schema t to sre_app;
grant execute on all functions in schema t to sre_app;

-- Fixtures (as owner) ---------------------------------------------------------
insert into public.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.test'),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.test'),
  ('33333333-3333-3333-3333-333333333333', 'viewer@example.test');
insert into public.organizations (id, name, slug) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Org A', 'org-a'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Org B', 'org-b');
insert into public.organization_members (organization_id, user_id, role) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'owner'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'owner'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333', 'viewer');
insert into public.incidents (id, organization_id, fingerprint, title, severity) values
  ('a1000000-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'fp-a', 'A error', 'high'),
  ('b1000000-0000-0000-0000-000000000001', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'fp-b', 'B error', 'critical');
insert into public.alerts (id, organization_id, kind, severity, title, dedup_key) values
  ('a2000000-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'pii_detected', 'high', 'PII in A', 'pii:a'),
  ('b2000000-0000-0000-0000-000000000001', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'pii_detected', 'high', 'PII in B', 'pii:b');
insert into public.audit_events (organization_id, action) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'test');
insert into private.user_credentials (user_id, password_hash) values ('11111111-1111-1111-1111-111111111111', 'hash');

-- No user context -------------------------------------------------------------
set local role sre_app;
select t.check((select count(*) from public.incidents) = 0, 'no app.user_id => no tenant rows');
select t.check((select count(*) from public.users) = 0, 'no app.user_id => no users');

-- Alice, owner of Org A -------------------------------------------------------
select set_config('app.user_id', '11111111-1111-1111-1111-111111111111', true);
select t.check((select count(*) from public.organizations) = 1, 'alice sees only her organization');
select t.check((select count(*) from public.incidents) = 1, 'alice sees only Org A incidents');
select t.check((select title from public.incidents) = 'A error', 'alice sees the Org A incident');
select t.check((select count(*) from public.alerts) = 1, 'alice sees only Org A alerts');
select t.check((select count(*) from public.audit_events) = 1, 'owner reads audit events');
select t.check((select open_alerts from public.organization_overview) = 1, 'overview view respects RLS');
select t.throws($$ update public.incidents set status = 'resolved' $$, '42501', 'cannot update incidents directly');
select t.throws($$ insert into public.repositories (organization_id, owner, name)
                   values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'x', 'y') $$, '42501', 'cannot insert repositories directly');
select t.throws($$ select * from private.user_credentials $$, '42501', 'password hashes are not readable');
select t.throws($$ select * from private.sessions $$, '42501', 'sessions are not readable');
select t.lives($$ select app.register_repository('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'acme', 'api') $$,
               'owner registers a repository via app function');
select t.throws($$ select app.register_repository('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'acme', 'evil') $$,
                '42501', 'cannot register repository in another org');
select t.lives($$ select app.add_cloudwatch_source('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'ap-south-1',
                   '/ecs/api', 'api', 'production') $$, 'owner adds a CloudWatch log group');
select t.check((select count(*) from public.log_connectors where region = 'ap-south-1') = 1,
               'connector auto-created for region');
select t.lives($$ select app.set_alert_status('a2000000-0000-0000-0000-000000000001', 'acknowledged') $$,
               'owner acknowledges own alert');
select t.throws($$ select app.set_alert_status('b2000000-0000-0000-0000-000000000001', 'resolved') $$,
                '42501', 'cannot change another org''s alert');
select t.lives($$ insert into public.incident_comments (organization_id, incident_id, body)
                  values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a1000000-0000-0000-0000-000000000001', 'looking') $$,
               'member comments on own incident');
select t.throws($$ insert into public.incident_comments (organization_id, incident_id, body)
                   values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'b1000000-0000-0000-0000-000000000001', 'hi') $$,
                '42501', 'cannot comment on another org''s incident');

-- Viewer in Org A -------------------------------------------------------------
select set_config('app.user_id', '33333333-3333-3333-3333-333333333333', true);
select t.check((select count(*) from public.audit_events) = 0, 'viewer cannot read audit events');
select t.throws($$ select app.add_cloudwatch_source('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'us-east-1',
                    '/ecs/x', 'x', 'prod') $$, '42501', 'viewer cannot add log sources');
select t.throws($$ select app.set_alert_status('a2000000-0000-0000-0000-000000000001', 'resolved') $$,
                '42501', 'viewer cannot resolve alerts');

reset role;

-- Report ----------------------------------------------------------------------
select case when ok then 'ok   ' else 'FAIL ' end || n || ' - ' || description as result from t.results order by n;
select count(*) filter (where ok) || ' passed, ' || count(*) filter (where not ok) || ' failed' as summary from t.results;
do $$
begin
  if exists (select 1 from t.results where not ok) then
    raise exception 'RLS tests failed';
  end if;
end $$;
rollback;
