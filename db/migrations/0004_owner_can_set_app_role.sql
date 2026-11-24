-- =============================================================================
-- The dashboard no longer has its own login role. It connects as the owner and
-- runs `set local role sre_app` in every transaction (backend/db/index.ts withUser),
-- so the owner must be a member of sre_app. Superusers can already switch to any role.
-- =============================================================================

do $$
begin
  if not (select rolsuper from pg_roles where rolname = current_user) then
    execute format('grant sre_app to %I', current_user);
  end if;
end;
$$;
