-- One Bridge can own an explicit local working-directory allowlist. Directory
-- keys are stable, device-chosen identifiers; absolute paths remain a local
-- safety decision and are only reported as inventory metadata.

create table if not exists public.ai_bridge_directories (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  connection_id uuid not null,
  directory_key text not null,
  name text not null,
  working_directory text not null,
  inventory_active boolean not null default true,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (connection_id, directory_key),
  unique (workspace_id, connection_id, directory_key),
  unique (connection_id, working_directory),
  constraint ai_bridge_directories_connection_fk
    foreign key (workspace_id, connection_id)
    references public.ai_connections(workspace_id, id) on delete cascade,
  constraint ai_bridge_directories_key_shape check (
    directory_key ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$'
  ),
  constraint ai_bridge_directories_name_length check (
    length(btrim(name)) between 1 and 200
  ),
  constraint ai_bridge_directories_path_length check (
    length(btrim(working_directory)) between 1 and 4096
  )
);

comment on table public.ai_bridge_directories is
  'Device-reported working-directory allowlist for one Bridge connection. directory_key is stable and paths are never accepted from Web thread commands.';

alter table public.ai_sessions
  add column if not exists bridge_directory_key text;

alter table public.ai_thread_commands
  add column if not exists directory_key text;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'ai_sessions_bridge_directory_fk'
      and conrelid = 'public.ai_sessions'::regclass
  ) then
    alter table public.ai_sessions
      add constraint ai_sessions_bridge_directory_fk
      foreign key (workspace_id, connection_id, bridge_directory_key)
      references public.ai_bridge_directories(
        workspace_id, connection_id, directory_key
      );
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'ai_thread_commands_directory_fk'
      and conrelid = 'public.ai_thread_commands'::regclass
  ) then
    alter table public.ai_thread_commands
      add constraint ai_thread_commands_directory_fk
      foreign key (workspace_id, connection_id, directory_key)
      references public.ai_bridge_directories(
        workspace_id, connection_id, directory_key
      );
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'ai_sessions_bridge_directory_key_length'
      and conrelid = 'public.ai_sessions'::regclass
  ) then
    alter table public.ai_sessions
      add constraint ai_sessions_bridge_directory_key_length check (
        bridge_directory_key is null
        or length(btrim(bridge_directory_key)) between 1 and 100
      );
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'ai_thread_commands_directory_key_length'
      and conrelid = 'public.ai_thread_commands'::regclass
  ) then
    alter table public.ai_thread_commands
      add constraint ai_thread_commands_directory_key_length check (
        directory_key is null
        or length(btrim(directory_key)) between 1 and 100
      );
  end if;
end;
$$;

create index if not exists ai_sessions_bridge_directory_idx
  on public.ai_sessions (connection_id, bridge_directory_key, created_at)
  where bridge_directory_key is not null;

drop trigger if exists ai_bridge_directories_set_updated_at
on public.ai_bridge_directories;
create trigger ai_bridge_directories_set_updated_at
before update on public.ai_bridge_directories
for each row execute function public._set_updated_at();

alter table public.ai_bridge_directories enable row level security;

drop policy if exists ai_bridge_directories_member_select
on public.ai_bridge_directories;
create policy ai_bridge_directories_member_select
on public.ai_bridge_directories
for select to authenticated
using (public.is_workspace_member(workspace_id));

grant all privileges on table public.ai_bridge_directories to service_role;
revoke all on table public.ai_bridge_directories
from public, anon, authenticated;
grant select on table public.ai_bridge_directories to authenticated;

-- Compatibility wrapper around the existing authoritative inventory RPC.
-- Older Bridges omit p_directories and retain their previous behavior. New
-- Bridges atomically refresh both directory and thread inventory.
create or replace function public.sync_ai_sessions_with_directories(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_api_token_hash text,
  p_bridge_version text,
  p_directories jsonb,
  p_threads jsonb,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_directory jsonb;
  v_thread jsonb;
  v_directory_key text;
  v_directory_name text;
  v_working_directory text;
  v_directory_keys text[] := '{}'::text[];
  v_directory_paths text[] := '{}'::text[];
  v_legacy_threads jsonb;
  v_result jsonb;
  v_session_id uuid;
  v_sessions jsonb := '[]'::jsonb;
begin
  perform public._assert_active_connection(
    p_workspace_id, p_connection_id, p_api_token_hash
  );

  if p_threads is null or jsonb_typeof(p_threads) <> 'array' then
    perform public._raise('INVALID_SESSION');
  end if;

  if p_directories is null then
    if exists (
      select 1
      from jsonb_array_elements(p_threads) as thread(value)
      where thread.value ? 'directory_key'
        and thread.value -> 'directory_key' <> 'null'::jsonb
    ) then
      perform public._raise('INVALID_SESSION');
    end if;

    select coalesce(
      jsonb_agg(item.value - 'directory_key' order by item.ordinality),
      '[]'::jsonb
    )
    into v_legacy_threads
    from jsonb_array_elements(p_threads)
      with ordinality as item(value, ordinality);

    return public.sync_ai_sessions(
      p_workspace_id, p_connection_id, p_api_token_hash, p_bridge_version,
      v_legacy_threads, p_idempotency_key, p_request_hash
    );
  end if;

  if jsonb_typeof(p_directories) <> 'array'
     or jsonb_array_length(p_directories) = 0
     or jsonb_array_length(p_directories) > 100
     or octet_length(p_directories::text) > 524288 then
    perform public._raise('INVALID_SESSION');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('thread-inventory:' || p_connection_id::text, 0)
  );

  for v_directory in select value from jsonb_array_elements(p_directories)
  loop
    if jsonb_typeof(v_directory) <> 'object'
       or exists (
         select 1
         from jsonb_object_keys(v_directory) as field_name
         where field_name not in ('directory_key', 'name', 'working_directory')
       )
       or jsonb_typeof(v_directory -> 'directory_key') <> 'string'
       or jsonb_typeof(v_directory -> 'name') <> 'string'
       or jsonb_typeof(v_directory -> 'working_directory') <> 'string' then
      perform public._raise('INVALID_SESSION');
    end if;

    v_directory_key := nullif(btrim(v_directory ->> 'directory_key'), '');
    v_directory_name := nullif(btrim(v_directory ->> 'name'), '');
    v_working_directory := nullif(
      btrim(v_directory ->> 'working_directory'), ''
    );

    if v_directory_key is null
       or v_directory_key !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$'
       or v_directory_key = any(v_directory_keys)
       or v_directory_name is null
       or length(v_directory_name) > 200
       or v_working_directory is null
       or length(v_working_directory) > 4096
       or v_working_directory = any(v_directory_paths)
       or exists (
         select 1
         from public.ai_bridge_directories directory
         where directory.connection_id = p_connection_id
           and directory.working_directory = v_working_directory
           and directory.directory_key <> v_directory_key
       ) then
      perform public._raise('INVALID_SESSION');
    end if;

    v_directory_keys := array_append(v_directory_keys, v_directory_key);
    v_directory_paths := array_append(
      v_directory_paths, v_working_directory
    );

    insert into public.ai_bridge_directories (
      workspace_id, connection_id, directory_key, name,
      working_directory, inventory_active, last_seen_at
    ) values (
      p_workspace_id, p_connection_id, v_directory_key, v_directory_name,
      v_working_directory, true, v_now
    )
    on conflict (connection_id, directory_key) do update set
      name = excluded.name,
      working_directory = excluded.working_directory,
      inventory_active = true,
      last_seen_at = excluded.last_seen_at;
  end loop;

  update public.ai_bridge_directories directory
  set inventory_active = false
  where directory.workspace_id = p_workspace_id
    and directory.connection_id = p_connection_id
    and not (directory.directory_key = any(v_directory_keys));

  for v_thread in select value from jsonb_array_elements(p_threads)
  loop
    if v_thread ? 'directory_key'
       and jsonb_typeof(v_thread -> 'directory_key') not in ('string', 'null') then
      perform public._raise('INVALID_SESSION');
    end if;
    v_directory_key := nullif(btrim(v_thread ->> 'directory_key'), '');
    if v_directory_key is not null
       and not (v_directory_key = any(v_directory_keys)) then
      perform public._raise('INVALID_SESSION');
    end if;
  end loop;

  select coalesce(
    jsonb_agg(item.value - 'directory_key' order by item.ordinality),
    '[]'::jsonb
  )
  into v_legacy_threads
  from jsonb_array_elements(p_threads)
    with ordinality as item(value, ordinality);

  v_result := public.sync_ai_sessions(
    p_workspace_id, p_connection_id, p_api_token_hash, p_bridge_version,
    v_legacy_threads, p_idempotency_key, p_request_hash
  );

  -- Rebuild the Session payloads after attaching directory keys so the Bridge
  -- immediately receives the same rows that Web clients will observe.
  for v_thread in select value from jsonb_array_elements(p_threads)
  loop
    v_directory_key := nullif(btrim(v_thread ->> 'directory_key'), '');
    update public.ai_sessions session
    set bridge_directory_key = v_directory_key
    where session.workspace_id = p_workspace_id
      and session.connection_id = p_connection_id
      and session.external_conversation_ref = btrim(
        v_thread ->> 'external_conversation_ref'
      )
    returning id into v_session_id;

    if found then
      v_sessions := v_sessions || jsonb_build_array(
        public._session_payload(v_session_id)
      );
    end if;
  end loop;

  return jsonb_set(v_result, '{sessions}', v_sessions, true);
end;
$$;

comment on function public.sync_ai_sessions_with_directories(
  uuid, uuid, text, text, jsonb, jsonb, text, text
) is
  'Atomically refreshes one Bridge directory allowlist and its authoritative Thread inventory while retaining the legacy sync_ai_sessions contract.';

revoke all on function public.sync_ai_sessions_with_directories(
  uuid, uuid, text, text, jsonb, jsonb, text, text
) from public, anon, authenticated;
grant execute on function public.sync_ai_sessions_with_directories(
  uuid, uuid, text, text, jsonb, jsonb, text, text
) to service_role;

-- The Web sends only a stable key selected from device-reported inventory.
-- The absolute path is resolved locally by the Bridge and never enters this
-- command, so Web cannot expand the device's write boundary.
create or replace function public.enqueue_ai_thread_command_with_directory(
  p_workspace_id uuid,
  p_user_id uuid,
  p_command_id uuid,
  p_connection_id uuid,
  p_session_id uuid,
  p_action text,
  p_name text,
  p_directory_key text,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_result jsonb;
  v_directory_key text := nullif(btrim(p_directory_key), '');
begin
  -- Authenticate, apply idempotency and validate the base action first. Any
  -- directory failure below rolls this nested call back with the transaction.
  v_result := public.enqueue_ai_thread_command(
    p_workspace_id, p_user_id, p_command_id, p_connection_id,
    p_session_id, p_action, p_name, p_idempotency_key, p_request_hash
  );

  if p_action = 'create' and v_directory_key is not null then
    perform 1
    from public.ai_bridge_directories directory
    where directory.workspace_id = p_workspace_id
      and directory.connection_id = p_connection_id
      and directory.directory_key = v_directory_key
      and directory.inventory_active;
    if not found then
      perform public._raise('INVALID_THREAD_COMMAND');
    end if;
  elsif p_action <> 'create' and v_directory_key is not null then
    perform public._raise('INVALID_THREAD_COMMAND');
  end if;

  if p_action = 'create' then
    update public.ai_thread_commands command
    set directory_key = v_directory_key
    where command.workspace_id = p_workspace_id
      and command.connection_id = p_connection_id
      and command.id = p_command_id;
  end if;

  return jsonb_build_object(
    'command', public._thread_command_payload(p_command_id)
  );
end;
$$;

comment on function public.enqueue_ai_thread_command_with_directory(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text, text
) is
  'Queues a Web Thread command with an optional device-reported directory key; arbitrary local paths are never accepted.';

revoke all on function public.enqueue_ai_thread_command_with_directory(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.enqueue_ai_thread_command_with_directory(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text, text
) to service_role;

do $$
begin
  if exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) and not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'ai_bridge_directories'
  ) then
    alter publication supabase_realtime add table public.ai_bridge_directories;
  end if;
end;
$$;
