-- AI Task Board: local PostgreSQL bootstrap.
--
-- The canonical migrations in supabase/migrations/ assume the Supabase-hosted
-- environment: the anon/authenticated/service_role roles, an `extensions`
-- schema exposing gen_random_uuid, a minimal `auth` schema (users + uid()),
-- and a minimal `storage` schema. A fresh local PostgreSQL has none of these,
-- so this file creates that small compatibility layer before the migrations
-- run.
--
-- scripts/init-local-db.mjs applies this file first and then every migration
-- in filename order. Apply it manually only to a disposable local database;
-- hosted Supabase already provides all of these objects and must never receive
-- this file.

-- Roles referenced by revoke/grant statements, RLS policies, and the RPC
-- authorization contract. They are login-disabled: applications connect as a
-- real PostgreSQL role (for example `postgres`) and bypass RLS, exactly like
-- the hosted service_role path.
do $$
begin
  create role anon nologin;
exception when duplicate_object then null;
end $$;

do $$
begin
  create role authenticated nologin;
exception when duplicate_object then null;
end $$;

do $$
begin
  create role service_role nologin;
exception when duplicate_object then null;
end $$;

-- Prefer the real pgcrypto when the contrib package is available; it provides
-- both gen_random_uuid and digest. When it is not (for example embedded
-- PostgreSQL builds without contrib), install thin shims instead:
-- gen_random_uuid wraps the built-in pg_catalog implementation (PostgreSQL
-- 13+) and digest falls back to md5. The md5 fallback only ever feeds the
-- deliberately unusable demo seed token, never real application tokens.
create schema if not exists extensions;
do $install_pgcrypto$
begin
  create extension if not exists pgcrypto with schema extensions;
exception when others then
  raise notice 'pgcrypto unavailable, installing local shims: %', sqlerrm;
end $install_pgcrypto$;

do $shim_gen_random_uuid$
begin
  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'extensions' and p.proname = 'gen_random_uuid'
  ) then
    create function extensions.gen_random_uuid()
    returns uuid
    language sql
    volatile
    parallel safe
    as $body$ select pg_catalog.gen_random_uuid() $body$;
  end if;
end $shim_gen_random_uuid$;

do $shim_digest$
begin
  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'extensions' and p.proname = 'digest'
  ) then
    create function extensions.digest(p_data text, p_type text)
    returns bytea
    language sql
    immutable
    parallel safe
    as $body$ select pg_catalog.decode(pg_catalog.md5(p_data), 'hex') $body$;
  end if;
end $shim_digest$;

-- Minimal auth compatibility layer. The migrations create a trigger on
-- auth.users, and RLS policies read the request JWT through auth.uid().
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key,
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table auth.users add column if not exists password_hash text;
create unique index if not exists auth_users_email_uidx
  on auth.users (lower(email))
  where email is not null;
create or replace function auth.uid()
returns uuid
language sql
stable
parallel safe
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')
  )::uuid
$$;

-- Local credential sessions. Hosted Supabase manages its own auth.sessions
-- table; these rows only ever exist in the local PostgreSQL deployment.
create table if not exists auth.sessions (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index if not exists auth_sessions_user_idx on auth.sessions (user_id);

-- Minimal storage compatibility layer. The migrations insert the private
-- task-artifacts bucket and attach RLS policies to storage.objects. Object
-- bytes live in the application's storage backend (hosted Storage or a local
-- path), never inside these tables.
create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint
);
create table if not exists storage.objects (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  bucket_id text not null,
  name text not null
);

-- Mirrors the migration ledger table the Supabase CLI reads. The init script
-- records every applied filename here so re-runs skip finished work and a
-- later `supabase db push` against this database does not re-apply history.
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (
  version text primary key,
  statements text[],
  name text
);
