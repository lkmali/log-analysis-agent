-- =============================================================================
-- Accounts are created only by a superadmin.
--   * Public sign-up is removed: the dashboard role can no longer call app.sign_up().
--   * app.create_user(): superadmin-only, optionally adds the user to an organization.
--   * app.list_users(): superadmin-only account list for the Users page.
--   * The very first superadmin is created with `npm run user:create` (owner role).
-- =============================================================================

revoke execute on function app.sign_up(text, text, text) from public, sre_app;

create or replace function app.create_user(
  p_email         text,
  p_password_hash text,
  p_display_name  text,
  p_is_superadmin boolean,
  p_org           uuid,
  p_role          public.org_role
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  new_id uuid;
begin
  if not app.is_superadmin() then
    raise exception 'only a superadmin can create users' using errcode = '42501';
  end if;
  if p_org is not null and not exists (select 1 from public.organizations o where o.id = p_org) then
    raise exception 'unknown organization' using errcode = '22023';
  end if;

  insert into public.users (email, display_name, is_superadmin)
  values (lower(trim(p_email)), nullif(trim(p_display_name), ''), coalesce(p_is_superadmin, false))
  returning id into new_id;
  insert into private.user_credentials (user_id, password_hash) values (new_id, p_password_hash);

  if p_org is not null then
    insert into public.organization_members (organization_id, user_id, role)
    values (p_org, new_id, coalesce(p_role, 'member'));
    perform app.write_audit(p_org, 'user.created', 'user', new_id::text,
      jsonb_build_object('email', lower(trim(p_email)), 'role', coalesce(p_role, 'member'),
                         'superadmin', coalesce(p_is_superadmin, false)));
  end if;
  return new_id;
end;
$$;

create or replace function app.list_users()
returns table (user_id uuid, email text, display_name text, is_superadmin boolean, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.is_superadmin() then
    raise exception 'only a superadmin can list users' using errcode = '42501';
  end if;
  return query
    select u.id, u.email, u.display_name, u.is_superadmin, u.created_at
      from public.users u
     order by u.created_at;
end;
$$;

revoke execute on function app.create_user(text, text, text, boolean, uuid, public.org_role) from public;
revoke execute on function app.list_users() from public;
grant execute on function app.create_user(text, text, text, boolean, uuid, public.org_role) to sre_app;
grant execute on function app.list_users() to sre_app;
