-- AI Task Board: core schema for Supabase Hosted PostgreSQL.
-- This migration is intentionally self-contained and does not require a local
-- Supabase or PostgreSQL runtime.

create extension if not exists pgcrypto with schema extensions;

do $$ begin
  create type public.workspace_role as enum ('owner', 'member');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.ai_session_status as enum ('online', 'busy', 'waiting', 'offline');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.task_status as enum (
    'inbox', 'ready', 'claimed', 'running', 'waiting_user',
    'blocked', 'completed', 'failed', 'cancelled'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.actor_type as enum ('user', 'ai', 'system');
exception when duplicate_object then null; end $$;

create table if not exists public.workspaces (
  id uuid primary key default extensions.gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.workspace_role not null default 'member',
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table if not exists public.ai_connections (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 200),
  platform text not null check (length(btrim(platform)) between 1 and 100),
  api_token_hash text not null check (length(api_token_hash) >= 32),
  created_by_user_id uuid references auth.users(id) on delete set null,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (workspace_id, id)
);

create table if not exists public.ai_sessions (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  connection_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 200),
  platform text not null check (length(btrim(platform)) between 1 and 100),
  model text,
  external_conversation_ref text,
  capabilities text[] not null default '{}'::text[],
  status public.ai_session_status not null default 'online',
  current_task_id uuid,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  constraint ai_sessions_connection_fk
    foreign key (workspace_id, connection_id)
    references public.ai_connections(workspace_id, id) on delete cascade,
  constraint ai_sessions_capabilities_no_nulls
    check (array_position(capabilities, null) is null)
);

create table if not exists public.tasks (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  parent_task_id uuid,
  root_task_id uuid not null,

  title text not null check (length(btrim(title)) between 1 and 500),
  description text,
  acceptance_criteria text,
  status public.task_status not null default 'inbox',
  priority integer not null default 0 check (priority between -1000000 and 1000000),
  position integer,

  assigned_session_id uuid,
  claimed_by_session_id uuid,
  claim_token_hash text,
  claimed_at timestamptz,
  lease_expires_at timestamptz,

  required_capabilities text[] not null default '{}'::text[],
  external_source text,
  external_task_ref text,
  external_conversation_ref text,

  progress_note text,
  progress_percent_estimate integer
    check (progress_percent_estimate between 0 and 100),
  result_summary text,
  result_json jsonb,

  created_by_type public.actor_type not null,
  created_by_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,

  unique (workspace_id, id),
  constraint tasks_parent_fk
    foreign key (workspace_id, parent_task_id)
    references public.tasks(workspace_id, id)
    on delete cascade deferrable initially deferred,
  constraint tasks_root_fk
    foreign key (workspace_id, root_task_id)
    references public.tasks(workspace_id, id)
    on delete cascade deferrable initially deferred,
  constraint tasks_assigned_session_fk
    foreign key (workspace_id, assigned_session_id)
    references public.ai_sessions(workspace_id, id) on delete set null,
  constraint tasks_claimed_session_fk
    foreign key (workspace_id, claimed_by_session_id)
    references public.ai_sessions(workspace_id, id) on delete set null,
  constraint tasks_required_capabilities_no_nulls
    check (array_position(required_capabilities, null) is null),
  constraint tasks_external_ref_pair
    check (external_task_ref is null or external_source is not null),
  constraint tasks_claim_fields_consistent check (
    (claimed_by_session_id is null and claim_token_hash is null and claimed_at is null and lease_expires_at is null)
    or
    (claimed_by_session_id is not null and claim_token_hash is not null and claimed_at is not null and lease_expires_at is not null)
  ),
  constraint tasks_claim_status_consistent check (
    (status = 'claimed' and claimed_by_session_id is not null)
    or
    (status = 'running')
    or
    (status not in ('claimed', 'running') and claimed_by_session_id is null)
  ),
  constraint tasks_completion_consistent check (
    (status = 'completed' and completed_at is not null)
    or
    (status <> 'completed' and completed_at is null)
  )
);

alter table public.ai_sessions
  add constraint ai_sessions_current_task_fk
  foreign key (workspace_id, current_task_id)
  references public.tasks(workspace_id, id) on delete set null
  deferrable initially deferred;

create table if not exists public.task_dependencies (
  task_id uuid not null references public.tasks(id) on delete cascade,
  depends_on_task_id uuid not null references public.tasks(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (task_id, depends_on_task_id),
  constraint task_dependencies_not_self check (task_id <> depends_on_task_id)
);

create table if not exists public.task_messages (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  task_id uuid not null,
  sender_type public.actor_type not null,
  sender_id uuid,
  content text not null check (length(btrim(content)) between 1 and 100000),
  reply_to_message_id uuid,
  requires_response boolean not null default false,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  constraint task_messages_task_fk
    foreign key (workspace_id, task_id)
    references public.tasks(workspace_id, id) on delete cascade,
  constraint task_messages_reply_fk
    foreign key (workspace_id, reply_to_message_id)
    references public.task_messages(workspace_id, id) on delete set null
);

create table if not exists public.task_events (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  task_id uuid not null,
  type text not null check (length(btrim(type)) between 1 and 100),
  actor_type public.actor_type not null,
  actor_id uuid,
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  created_at timestamptz not null default now(),
  constraint task_events_task_fk
    foreign key (workspace_id, task_id)
    references public.tasks(workspace_id, id) on delete cascade
);

create table if not exists public.artifacts (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  task_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 500),
  mime_type text not null check (length(btrim(mime_type)) between 1 and 255),
  size bigint not null check (size >= 0),
  storage_path text,
  external_url text,
  created_by_session_id uuid,
  created_at timestamptz not null default now(),
  constraint artifacts_task_fk
    foreign key (workspace_id, task_id)
    references public.tasks(workspace_id, id) on delete cascade,
  constraint artifacts_session_fk
    foreign key (workspace_id, created_by_session_id)
    references public.ai_sessions(workspace_id, id) on delete set null,
  constraint artifacts_single_location
    check (num_nonnulls(storage_path, external_url) = 1)
);

create table if not exists public.idempotency_records (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  actor_key text not null check (length(btrim(actor_key)) between 1 and 300),
  idempotency_key text not null check (length(btrim(idempotency_key)) between 1 and 300),
  operation text not null check (length(btrim(operation)) between 1 and 100),
  request_hash text not null check (length(btrim(request_hash)) >= 16),
  response_json jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  primary key (workspace_id, actor_key, idempotency_key)
);

-- Required scheduling, hierarchy and activity indexes.
create index if not exists tasks_workspace_status_priority_created_idx
  on public.tasks (workspace_id, status, priority desc, created_at asc);
create index if not exists tasks_parent_task_id_idx on public.tasks (parent_task_id);
create index if not exists tasks_root_task_id_idx on public.tasks (root_task_id);
create index if not exists tasks_claimed_by_session_id_idx on public.tasks (claimed_by_session_id);
create index if not exists tasks_lease_expires_at_idx
  on public.tasks (lease_expires_at) where lease_expires_at is not null;
create unique index if not exists tasks_external_reference_uidx
  on public.tasks (workspace_id, external_source, external_task_ref)
  where external_source is not null and external_task_ref is not null;

create index if not exists task_dependencies_task_id_idx
  on public.task_dependencies (task_id);
create index if not exists task_dependencies_depends_on_idx
  on public.task_dependencies (depends_on_task_id);
create index if not exists task_messages_task_created_idx
  on public.task_messages (task_id, created_at);
create index if not exists task_events_task_created_idx
  on public.task_events (task_id, created_at);
create index if not exists task_events_workspace_id_idx
  on public.task_events (workspace_id, id);
create index if not exists artifacts_task_created_idx
  on public.artifacts (task_id, created_at);
create index if not exists ai_sessions_workspace_last_seen_idx
  on public.ai_sessions (workspace_id, last_seen_at desc);
create unique index if not exists ai_connections_active_token_hash_uidx
  on public.ai_connections (api_token_hash)
  where revoked_at is null;
create unique index if not exists ai_sessions_external_conversation_uidx
  on public.ai_sessions (connection_id, external_conversation_ref)
  where external_conversation_ref is not null;
create index if not exists idempotency_records_expiry_idx
  on public.idempotency_records (expires_at);

-- Generic timestamp maintenance.
create or replace function public._set_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists workspaces_set_updated_at on public.workspaces;
create trigger workspaces_set_updated_at
before update on public.workspaces
for each row execute function public._set_updated_at();

drop trigger if exists ai_sessions_set_updated_at on public.ai_sessions;
create trigger ai_sessions_set_updated_at
before update on public.ai_sessions
for each row execute function public._set_updated_at();

drop trigger if exists tasks_set_updated_at on public.tasks;
create trigger tasks_set_updated_at
before update on public.tasks
for each row execute function public._set_updated_at();

-- Enforce a workspace-local acyclic task tree and derive root_task_id server-side.
create or replace function public._validate_task_hierarchy()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_parent_root uuid;
  v_cycle boolean;
begin
  if new.id is null then
    new.id := extensions.gen_random_uuid();
  end if;

  if new.workspace_id is null then
    raise exception using errcode = 'P0001', message = 'INVALID_TASK';
  end if;
  if tg_op = 'UPDATE' and new.workspace_id is distinct from old.workspace_id then
    -- Moving a task between workspaces would also require rewriting its entire
    -- subtree, dependencies, messages, events and artifacts. No product command
    -- supports that operation.
    raise exception using errcode = 'P0001', message = 'INVALID_STATE_TRANSITION';
  end if;

  -- Serialize hierarchy reads and writes per workspace. Without this lock two
  -- concurrent reparents (A -> B and B -> A) can each validate against the old
  -- snapshot and together commit a cycle.
  perform pg_advisory_xact_lock(
    hashtextextended('task-hierarchy:' || new.workspace_id::text, 0)
  );

  if tg_op = 'UPDATE'
     and new.parent_task_id is distinct from old.parent_task_id
     and exists (select 1 from public.tasks child where child.parent_task_id = new.id) then
    -- Reparenting an aggregation node would require rewriting every descendant
    -- root_task_id. Product commands intentionally model this as a new tree.
    raise exception using errcode = 'P0001', message = 'INVALID_STATE_TRANSITION';
  end if;

  if new.parent_task_id is null then
    if new.root_task_id is not null and new.root_task_id <> new.id then
      raise exception using errcode = 'P0001', message = 'INVALID_TASK_ROOT';
    end if;
    new.root_task_id := new.id;
    return new;
  end if;

  if new.parent_task_id = new.id then
    raise exception using errcode = 'P0001', message = 'DEPENDENCY_CYCLE';
  end if;

  select t.root_task_id into v_parent_root
  from public.tasks t
  where t.workspace_id = new.workspace_id and t.id = new.parent_task_id;

  if not found then
    raise exception using errcode = 'P0001', message = 'PARENT_TASK_NOT_FOUND';
  end if;

  if tg_op = 'UPDATE' then
    with recursive ancestors(id, parent_task_id) as (
      select t.id, t.parent_task_id
      from public.tasks t
      where t.workspace_id = new.workspace_id and t.id = new.parent_task_id
      union all
      select t.id, t.parent_task_id
      from public.tasks t
      join ancestors a on a.parent_task_id = t.id
      where t.workspace_id = new.workspace_id
    )
    select exists(select 1 from ancestors where id = new.id) into v_cycle;

    if v_cycle then
      raise exception using errcode = 'P0001', message = 'DEPENDENCY_CYCLE';
    end if;
  end if;

  new.root_task_id := v_parent_root;
  return new;
end;
$$;

drop trigger if exists tasks_validate_hierarchy on public.tasks;
create trigger tasks_validate_hierarchy
before insert or update of workspace_id, parent_task_id, root_task_id
on public.tasks
for each row execute function public._validate_task_hierarchy();

-- Dependencies must remain workspace-local and acyclic.
create or replace function public._validate_task_dependency()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_task_workspace uuid;
  v_dependency_workspace uuid;
  v_cycle boolean;
begin
  if new.task_id = new.depends_on_task_id then
    raise exception using errcode = 'P0001', message = 'DEPENDENCY_CYCLE';
  end if;

  select workspace_id into v_task_workspace from public.tasks where id = new.task_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'TASK_NOT_FOUND';
  end if;

  select workspace_id into v_dependency_workspace
  from public.tasks where id = new.depends_on_task_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'DEPENDENCY_NOT_FOUND';
  end if;

  if v_task_workspace <> v_dependency_workspace then
    raise exception using errcode = 'P0001', message = 'SESSION_NOT_AUTHORIZED';
  end if;

  -- Serialize graph mutations per workspace so two concurrent transactions
  -- cannot each observe an acyclic partial graph and together commit a cycle.
  perform pg_advisory_xact_lock(
    hashtextextended('task-dependencies:' || v_task_workspace::text, 0)
  );

  with recursive dependency_path(id) as (
    select new.depends_on_task_id
    union
    select td.depends_on_task_id
    from public.task_dependencies td
    join dependency_path p on td.task_id = p.id
  )
  select exists(select 1 from dependency_path where id = new.task_id) into v_cycle;

  if v_cycle then
    raise exception using errcode = 'P0001', message = 'DEPENDENCY_CYCLE';
  end if;

  return new;
end;
$$;

drop trigger if exists task_dependencies_validate on public.task_dependencies;
create trigger task_dependencies_validate
before insert or update on public.task_dependencies
for each row execute function public._validate_task_dependency();

-- A reply target must belong to the same task, not merely the same workspace.
create or replace function public._validate_message_reply()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.reply_to_message_id is not null and not exists (
    select 1 from public.task_messages m
    where m.id = new.reply_to_message_id
      and m.workspace_id = new.workspace_id
      and m.task_id = new.task_id
  ) then
    raise exception using errcode = 'P0001', message = 'INVALID_REPLY_TARGET';
  end if;
  return new;
end;
$$;

drop trigger if exists task_messages_validate_reply on public.task_messages;
create trigger task_messages_validate_reply
before insert or update of workspace_id, task_id, reply_to_message_id
on public.task_messages
for each row execute function public._validate_message_reply();

-- TaskEvent is an append-only audit cursor, even for privileged application code.
create or replace function public._reject_task_event_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception using errcode = 'P0001', message = 'TASK_EVENT_IMMUTABLE';
end;
$$;

drop trigger if exists task_events_immutable on public.task_events;
create trigger task_events_immutable
before update on public.task_events
for each row execute function public._reject_task_event_mutation();

comment on column public.tasks.progress_percent_estimate is
  'AI-provided estimate only. Structured progress is derived from completed leaf tasks.';
comment on table public.task_events is
  'Immutable event stream. Use id as the reconnect/update cursor.';
comment on table public.idempotency_records is
  'A null response_json is an in-transaction reservation and must never be committed by an RPC.';

-- Every newly-created Auth user receives an isolated personal workspace. Teams
-- can add more memberships later without changing any business-table key.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_workspace_id uuid := extensions.gen_random_uuid();
  v_name text;
begin
  v_name := coalesce(
    nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(btrim(new.raw_user_meta_data ->> 'name'), ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'My Workspace'
  );

  insert into public.workspaces (id, name)
  values (v_workspace_id, left(v_name || '''s Workspace', 200));

  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_workspace_id, new.id, 'owner');

  return new;
end;
$$;

drop trigger if exists on_auth_user_created_ai_task_board on auth.users;
create trigger on_auth_user_created_ai_task_board
after insert on auth.users
for each row execute function public.handle_new_auth_user();

-- Fail closed in this first migration. Supabase applies each migration in a
-- transaction, so business tables are never committed to the Data API without
-- RLS and explicit privilege removal, even if a later migration fails.
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.ai_connections enable row level security;
alter table public.ai_sessions enable row level security;
alter table public.tasks enable row level security;
alter table public.task_dependencies enable row level security;
alter table public.task_messages enable row level security;
alter table public.task_events enable row level security;
alter table public.artifacts enable row level security;
alter table public.idempotency_records enable row level security;

revoke all on table public.workspaces from public, anon, authenticated;
revoke all on table public.workspace_members from public, anon, authenticated;
revoke all on table public.ai_connections from public, anon, authenticated;
revoke all on table public.ai_sessions from public, anon, authenticated;
revoke all on table public.tasks from public, anon, authenticated;
revoke all on table public.task_dependencies from public, anon, authenticated;
revoke all on table public.task_messages from public, anon, authenticated;
revoke all on table public.task_events from public, anon, authenticated;
revoke all on table public.artifacts from public, anon, authenticated;
revoke all on table public.idempotency_records from public, anon, authenticated;
revoke all on all sequences in schema public from public, anon, authenticated;

revoke execute on function public._set_updated_at()
from public, anon, authenticated;
revoke execute on function public._validate_task_hierarchy()
from public, anon, authenticated;
revoke execute on function public._validate_task_dependency()
from public, anon, authenticated;
revoke execute on function public._validate_message_reply()
from public, anon, authenticated;
revoke execute on function public._reject_task_event_mutation()
from public, anon, authenticated;
revoke execute on function public.handle_new_auth_user()
from public, anon, authenticated;
