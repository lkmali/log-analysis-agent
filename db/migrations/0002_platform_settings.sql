-- =============================================================================
-- Platform settings managed from the dashboard (instead of environment variables)
--   * public.users.is_superadmin: platform-level admin. The first account becomes one.
--   * public.platform_settings: non-secret values; every signed-in user can read them.
--   * private.platform_secrets: API keys/tokens; only the owner role (scheduler) reads
--     values. The dashboard sees whether each one is set, never the value.
--   * Writes go through app.update_platform_settings(), which requires a superadmin.
-- =============================================================================

alter table public.users add column if not exists is_superadmin boolean not null default false;

-- Existing installs: promote the earliest account if nobody is superadmin yet.
update public.users set is_superadmin = true
 where id = (select id from public.users order by created_at limit 1)
   and not exists (select 1 from public.users where is_superadmin);

create or replace function app.is_superadmin()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select u.is_superadmin from public.users u where u.id = app.current_user_id()), false);
$$;

-- First account on a fresh install becomes the superadmin.
create or replace function app.sign_up(p_email text, p_password_hash text, p_display_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  new_id uuid;
  first_user boolean;
begin
  perform pg_advisory_xact_lock(hashtext('app.sign_up'));
  first_user := not exists (select 1 from public.users);
  insert into public.users (email, display_name, is_superadmin)
  values (lower(trim(p_email)), nullif(trim(p_display_name), ''), first_user)
  returning id into new_id;
  insert into private.user_credentials (user_id, password_hash) values (new_id, p_password_hash);
  return new_id;
end;
$$;

-- session_user now also returns is_superadmin (return type change needs a drop).
drop function if exists app.session_user(text);
create function app.session_user(p_token_hash text)
returns table (user_id uuid, email text, display_name text, is_superadmin boolean)
language sql security definer set search_path = '' as $$
  update private.sessions s set last_seen_at = now()
  from public.users u
  where s.token_hash = p_token_hash and s.expires_at > now() and u.id = s.user_id
  returning u.id, u.email, u.display_name, u.is_superadmin;
$$;

create table public.platform_settings (
  key         text primary key check (key ~ '^[A-Z][A-Z0-9_]*$'),
  value       jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.users (id) on delete set null
);
alter table public.platform_settings enable row level security;
create policy "signed-in users read platform settings" on public.platform_settings
  for select to sre_app using (app.current_user_id() is not null);
grant select on public.platform_settings to sre_app;

create table private.platform_secrets (
  key         text primary key check (key ~ '^[A-Z][A-Z0-9_]*$'),
  value       text not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.users (id) on delete set null
);

-- Which secrets are set (never their values). Any signed-in user.
create or replace function app.platform_secret_status()
returns table (key text, updated_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select s.key, s.updated_at from private.platform_secrets s where app.current_user_id() is not null;
$$;

-- p_values:  {"KEY": <json value> | null}   null removes the override (back to default)
-- p_secrets: {"KEY": "value" | null}        null clears the secret; omitted keys are untouched
create or replace function app.update_platform_settings(p_values jsonb, p_secrets jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := app.current_user_id();
  k text;
  v jsonb;
begin
  if not app.is_superadmin() then
    raise exception 'only a superadmin can change platform settings' using errcode = '42501';
  end if;

  for k, v in select * from jsonb_each(coalesce(p_values, '{}'::jsonb)) loop
    if v = 'null'::jsonb then
      delete from public.platform_settings where key = k;
    else
      insert into public.platform_settings (key, value, updated_at, updated_by) values (k, v, now(), uid)
      on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = uid;
    end if;
  end loop;

  for k, v in select * from jsonb_each(coalesce(p_secrets, '{}'::jsonb)) loop
    if v = 'null'::jsonb then
      delete from private.platform_secrets where key = k;
    else
      insert into private.platform_secrets (key, value, updated_at, updated_by) values (k, v #>> '{}', now(), uid)
      on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = uid;
    end if;
  end loop;
end;
$$;

-- Superadmins can promote or demote other accounts (but not remove the last superadmin).
create or replace function app.set_superadmin(p_email text, p_value boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not app.is_superadmin() then
    raise exception 'only a superadmin can change superadmins' using errcode = '42501';
  end if;
  update public.users set is_superadmin = p_value where email = lower(trim(p_email));
  if not found then
    raise exception 'no account with that email' using errcode = '22023';
  end if;
  if not exists (select 1 from public.users where is_superadmin) then
    raise exception 'at least one superadmin is required' using errcode = '23514';
  end if;
end;
$$;
