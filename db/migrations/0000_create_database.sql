-- =============================================================================
-- Bootstrap: create the owner role and the application database.
--
-- Run by run-migrations.sh BEFORE 0001_init.sql. It connects to the
-- maintenance database (SQL_ADMIN_DATABASE, default `postgres`) as an admin /
-- superuser, because CREATE DATABASE cannot run inside the target database.
--
-- psql variables (passed by run-migrations.sh from the root .env):
--   :owner            -> SQL_USER        (migration owner, e.g. sre_owner)
--   :owner_password   -> SQL_PASSWORD
--   :db               -> SQL_DATABASE    (e.g. sre)
--
-- Safe to re-run: existing role / database are left untouched.
-- =============================================================================

-- Owner role. CREATEROLE is needed because 0001_init.sql creates `sre_app`.
select format('create role %I login password %L createrole', :'owner', :'owner_password')
where not exists (select 1 from pg_roles where rolname = :'owner')
\gexec

-- Application database, owned by the owner role.
select format('create database %I owner %I', :'db', :'owner')
where not exists (select 1 from pg_database where datname = :'db')
\gexec
