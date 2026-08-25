-- Web-managed Codex Threads. User requests are persisted on the Board and
-- executed by the single Bridge runtime that owns the connection lease.

alter table public.ai_sessions
  add column if not exists user_name text,
  add column if not exists deletion_requested_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'ai_sessions_user_name_length'
      and conrelid = 'public.ai_sessions'::regclass
  ) then
    alter table public.ai_sessions
      add constraint ai_sessions_user_name_length
      check (
        user_name is null
        or length(btrim(user_name)) between 1 and 200
      );
  end if;
end;
$$;

create table if not exists public.ai_thread_commands (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  connection_id uuid not null,
  session_id uuid,
  action text not null check (action in ('create', 'rename', 'delete')),
  name text,
  external_thread_id text,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 100),
  requested_by_user_id uuid references auth.users(id) on delete set null,
  runtime_instance_id uuid,
  lease_expires_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  constraint ai_thread_commands_connection_fk
    foreign key (workspace_id, connection_id)
    references public.ai_connections(workspace_id, id) on delete cascade,
  constraint ai_thread_commands_session_fk
    foreign key (workspace_id, session_id)
    references public.ai_sessions(workspace_id, id) on delete cascade,
  constraint ai_thread_commands_name_shape check (
    (action in ('create', 'rename')
      and name is not null
      and length(btrim(name)) between 1 and 200)
    or (action = 'delete' and name is null)
  ),
  constraint ai_thread_commands_external_ref_length check (
    external_thread_id is null
    or length(btrim(external_thread_id)) between 1 and 500
  ),
  constraint ai_thread_commands_error_length check (
    error is null or length(error) <= 2000
  )
);

create index if not exists ai_thread_commands_claim_idx
  on public.ai_thread_commands (connection_id, status, created_at, id);
create index if not exists ai_thread_commands_session_idx
  on public.ai_thread_commands (session_id, created_at desc)
  where session_id is not null;

drop trigger if exists ai_thread_commands_set_updated_at
on public.ai_thread_commands;
create trigger ai_thread_commands_set_updated_at
before update on public.ai_thread_commands
for each row execute function public._set_updated_at();

alter table public.ai_thread_commands enable row level security;
revoke all on table public.ai_thread_commands from public, anon, authenticated;
grant all privileges on table public.ai_thread_commands to service_role;
grant select (user_name, deletion_requested_at)
on table public.ai_sessions to authenticated;

create or replace function public._thread_command_payload(p_command_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select to_jsonb(command)
  from public.ai_thread_commands command
  where command.id = p_command_id;
$$;

-- A deletion request immediately fences the Session from new task/turn writes,
-- even while the owning Bridge is offline and has not deleted the local Thread.
create or replace function public._assert_active_session(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_api_token_hash text,
  p_session_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
begin
  perform public._assert_active_connection(
    p_workspace_id, p_connection_id, p_api_token_hash
  );

  perform pg_advisory_xact_lock_shared(
    hashtextextended('thread-inventory:' || p_connection_id::text, 0)
  );

  perform 1
  from public.ai_sessions session
  where session.workspace_id = p_workspace_id
    and session.connection_id = p_connection_id
    and session.id = p_session_id
    and session.inventory_active
    and session.archived_at is null
    and session.deletion_requested_at is null;
  if not found then
    perform public._raise('SESSION_NOT_AUTHORIZED');
  end if;
end;
$$;

revoke all on function public._assert_active_session(
  uuid, uuid, text, uuid
) from public, anon, authenticated;

create or replace function public._idle_session_status(p_session_id uuid)
returns public.ai_session_status
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select case
    when not exists (
      select 1
      from public.ai_sessions session
      where session.id = p_session_id
        and session.inventory_active
        and session.archived_at is null
        and session.deletion_requested_at is null
    ) then 'offline'::public.ai_session_status
    when exists (
      select 1
      from public.tasks waiting
      where waiting.assigned_session_id = p_session_id
        and waiting.status = 'waiting_user'
    ) then 'waiting'::public.ai_session_status
    else 'online'::public.ai_session_status
  end;
$$;

revoke all on function public._idle_session_status(uuid)
from public, anon, authenticated;

create or replace function public.rename_ai_connection(
  p_workspace_id uuid,
  p_user_id uuid,
  p_connection_id uuid,
  p_name text,
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
  v_idempotency jsonb;
  v_response jsonb;
begin
  perform public._assert_owner(p_workspace_id, p_user_id);
  v_idempotency := public._idempotency_begin(
    p_workspace_id, 'user:' || p_user_id::text,
    p_idempotency_key, 'rename_ai_connection', p_request_hash
  );
  if v_idempotency ? 'cached_response' then
    return v_idempotency -> 'cached_response';
  end if;

  if nullif(btrim(p_name), '') is null or length(btrim(p_name)) > 200 then
    perform public._raise('INVALID_CONNECTION');
  end if;

  update public.ai_connections
  set name = btrim(p_name)
  where workspace_id = p_workspace_id
    and id = p_connection_id
    and revoked_at is null;
  if not found then
    perform public._raise('SESSION_NOT_AUTHORIZED');
  end if;

  v_response := jsonb_build_object(
    'connection', public._connection_payload(p_connection_id)
  );
  perform public._idempotency_finish(
    p_workspace_id, 'user:' || p_user_id::text,
    p_idempotency_key, v_response
  );
  return v_response;
end;
$$;

create or replace function public.enqueue_ai_thread_command(
  p_workspace_id uuid,
  p_user_id uuid,
  p_command_id uuid,
  p_connection_id uuid,
  p_session_id uuid,
  p_action text,
  p_name text,
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
  v_idempotency jsonb;
  v_connection public.ai_connections%rowtype;
  v_session public.ai_sessions%rowtype;
  v_external_thread_id text;
  v_version_parts text[];
  v_response jsonb;
begin
  perform public._assert_owner(p_workspace_id, p_user_id);
  v_idempotency := public._idempotency_begin(
    p_workspace_id, 'user:' || p_user_id::text,
    p_idempotency_key, 'enqueue_ai_thread_command', p_request_hash
  );
  if v_idempotency ? 'cached_response' then
    return v_idempotency -> 'cached_response';
  end if;

  select * into v_connection
  from public.ai_connections connection
  where connection.workspace_id = p_workspace_id
    and connection.id = p_connection_id
    and connection.revoked_at is null;
  if not found then
    perform public._raise('SESSION_NOT_AUTHORIZED');
  end if;
  v_version_parts := regexp_match(
    coalesce(v_connection.bridge_version, ''),
    '^([0-9]+)\.([0-9]+)(?:\.|$)'
  );
  if v_version_parts is null or (
    v_version_parts[1]::integer = 0
    and v_version_parts[2]::integer < 5
  ) then
    perform public._raise('THREAD_MANAGEMENT_NOT_SUPPORTED');
  end if;

  if p_action = 'create' then
    if p_session_id is not null
       or nullif(btrim(p_name), '') is null
       or length(btrim(p_name)) > 200 then
      perform public._raise('INVALID_THREAD_COMMAND');
    end if;
  elsif p_action in ('rename', 'delete') then
    if p_session_id is null then
      perform public._raise('INVALID_THREAD_COMMAND');
    end if;
    if p_action = 'delete' then
      -- Match all task commands' lock order. A task reservation that wins
      -- first makes this delete fail; a delete that wins first sets the
      -- Session offline before the waiting reservation revalidates it.
      perform public._lock_task_state_exclusive(p_workspace_id);
    end if;
    select * into v_session
    from public.ai_sessions session
    where session.workspace_id = p_workspace_id
      and session.connection_id = p_connection_id
      and session.id = p_session_id
      and session.external_conversation_ref is not null
      and session.inventory_active
      and session.archived_at is null
    for update;
    if not found then
      perform public._raise('SESSION_NOT_AUTHORIZED');
    end if;
    if v_session.deletion_requested_at is not null then
      perform public._raise('INVALID_STATE_TRANSITION');
    end if;
    v_external_thread_id := v_session.external_conversation_ref;

    if p_action = 'rename' then
      if nullif(btrim(p_name), '') is null or length(btrim(p_name)) > 200 then
        perform public._raise('INVALID_THREAD_COMMAND');
      end if;
      update public.ai_sessions
      set user_name = btrim(p_name)
      where id = p_session_id;
    else
      if p_name is not null then
        perform public._raise('INVALID_THREAD_COMMAND');
      end if;
      if v_session.current_task_id is not null or exists (
        select 1
        from public.tasks task
        where task.workspace_id = p_workspace_id
          and (
            task.assigned_session_id = p_session_id
            or task.claimed_by_session_id = p_session_id
          )
          and task.status not in ('completed', 'failed', 'cancelled')
      ) then
        perform public._raise('THREAD_NOT_IDLE');
      end if;
      update public.ai_sessions
      set deletion_requested_at = clock_timestamp(),
          status = 'offline'
      where id = p_session_id;
    end if;
  else
    perform public._raise('INVALID_THREAD_COMMAND');
  end if;

  begin
    insert into public.ai_thread_commands (
      id, workspace_id, connection_id, session_id, action, name,
      external_thread_id, requested_by_user_id
    ) values (
      p_command_id, p_workspace_id, p_connection_id, p_session_id,
      p_action, case when p_name is null then null else btrim(p_name) end,
      v_external_thread_id, p_user_id
    );
  exception when unique_violation then
    perform public._raise('IDEMPOTENCY_CONFLICT');
  end;

  v_response := jsonb_build_object(
    'command', public._thread_command_payload(p_command_id)
  );
  perform public._idempotency_finish(
    p_workspace_id, 'user:' || p_user_id::text,
    p_idempotency_key, v_response
  );
  return v_response;
end;
$$;

create or replace function public.claim_ai_thread_command(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_api_token_hash text,
  p_runtime_instance_id uuid,
  p_lease_seconds integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_command_id uuid;
begin
  perform public._assert_active_connection(
    p_workspace_id, p_connection_id, p_api_token_hash
  );
  if p_lease_seconds not between 15 and 300 then
    perform public._raise('INVALID_THREAD_COMMAND');
  end if;

  perform 1
  from public.ai_connection_bridge_settings settings
  where settings.workspace_id = p_workspace_id
    and settings.connection_id = p_connection_id
    and settings.active_runtime_instance_id = p_runtime_instance_id
    and settings.active_runtime_lease_expires_at > clock_timestamp();
  if not found then
    perform public._raise('BRIDGE_INSTANCE_CONFLICT');
  end if;

  -- A local create cannot be made exactly-once across a process crash because
  -- thread/start has no client idempotency key. Never replay an expired create
  -- lease and risk silently creating a duplicate Thread. Rename is naturally
  -- idempotent; delete is reconciled against the next managed inventory.
  update public.ai_thread_commands command
  set status = 'failed',
      lease_expires_at = null,
      error = 'Bridge stopped before confirming Thread creation',
      completed_at = clock_timestamp()
  where command.workspace_id = p_workspace_id
    and command.connection_id = p_connection_id
    and command.action = 'create'
    and command.status = 'running'
    and command.lease_expires_at < clock_timestamp();

  select command.id into v_command_id
  from public.ai_thread_commands command
  where command.workspace_id = p_workspace_id
    and command.connection_id = p_connection_id
    and (
      command.status = 'queued'
      or (
        command.status = 'running'
        and command.action <> 'create'
        and command.lease_expires_at < clock_timestamp()
      )
    )
  order by command.created_at, command.id
  for update skip locked
  limit 1;

  if v_command_id is null then
    return jsonb_build_object('command', null);
  end if;

  update public.ai_thread_commands
  set status = 'running',
      attempt_count = attempt_count + 1,
      runtime_instance_id = p_runtime_instance_id,
      lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
      started_at = coalesce(started_at, clock_timestamp()),
      error = null
  where id = v_command_id;

  return jsonb_build_object(
    'command', public._thread_command_payload(v_command_id)
  );
end;
$$;

create or replace function public.complete_ai_thread_command(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_api_token_hash text,
  p_runtime_instance_id uuid,
  p_command_id uuid,
  p_succeeded boolean,
  p_external_thread_id text,
  p_error text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_command public.ai_thread_commands%rowtype;
begin
  perform public._assert_active_connection(
    p_workspace_id, p_connection_id, p_api_token_hash
  );
  perform 1
  from public.ai_connection_bridge_settings settings
  where settings.workspace_id = p_workspace_id
    and settings.connection_id = p_connection_id
    and settings.active_runtime_instance_id = p_runtime_instance_id
    and settings.active_runtime_lease_expires_at > clock_timestamp();
  if not found then
    perform public._raise('BRIDGE_INSTANCE_CONFLICT');
  end if;

  select * into v_command
  from public.ai_thread_commands command
  where command.workspace_id = p_workspace_id
    and command.connection_id = p_connection_id
    and command.id = p_command_id
  for update;
  if not found then
    perform public._raise('INVALID_THREAD_COMMAND');
  end if;
  if v_command.status <> 'running'
     or v_command.runtime_instance_id is distinct from p_runtime_instance_id then
    perform public._raise('INVALID_STATE_TRANSITION');
  end if;
  if p_succeeded and v_command.action = 'create' and (
    nullif(btrim(p_external_thread_id), '') is null
    or length(btrim(p_external_thread_id)) > 500
  ) then
    perform public._raise('INVALID_THREAD_COMMAND');
  end if;
  if p_succeeded
     and v_command.action <> 'create'
     and nullif(btrim(p_external_thread_id), '')
       is distinct from v_command.external_thread_id then
    perform public._raise('INVALID_THREAD_COMMAND');
  end if;
  if not p_succeeded and (
    nullif(btrim(p_error), '') is null or length(p_error) > 2000
  ) then
    perform public._raise('INVALID_THREAD_COMMAND');
  end if;

  update public.ai_thread_commands
  set status = case when p_succeeded then 'succeeded' else 'failed' end,
      external_thread_id = case
        when p_succeeded and p_external_thread_id is not null
          then btrim(p_external_thread_id)
        else external_thread_id
      end,
      lease_expires_at = null,
      error = case when p_succeeded then null else btrim(p_error) end,
      completed_at = clock_timestamp()
  where id = p_command_id;

  if p_succeeded and v_command.action = 'create' then
    update public.ai_sessions
    set user_name = v_command.name
    where workspace_id = p_workspace_id
      and connection_id = p_connection_id
      and external_conversation_ref = btrim(p_external_thread_id);
  elsif not p_succeeded and v_command.action = 'delete' then
    update public.ai_sessions
    set deletion_requested_at = null,
        status = case
          when inventory_active and archived_at is null
            then 'online'::public.ai_session_status
          else 'offline'::public.ai_session_status
        end
    where workspace_id = p_workspace_id
      and id = v_command.session_id;
  end if;

  return jsonb_build_object(
    'command', public._thread_command_payload(p_command_id)
  );
end;
$$;

-- If a create succeeded before its next inventory upload, apply its Web name
-- when that new Session row eventually arrives.
create or replace function public.apply_created_thread_user_name()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.user_name is null and new.external_conversation_ref is not null then
    select command.name into new.user_name
    from public.ai_thread_commands command
    where command.workspace_id = new.workspace_id
      and command.connection_id = new.connection_id
      and command.action = 'create'
      and command.status = 'succeeded'
      and command.external_thread_id = new.external_conversation_ref
    order by command.completed_at desc nulls last, command.id desc
    limit 1;
  end if;
  return new;
end;
$$;

drop trigger if exists ai_sessions_apply_created_thread_user_name
on public.ai_sessions;
create trigger ai_sessions_apply_created_thread_user_name
before insert or update of external_conversation_ref on public.ai_sessions
for each row execute function public.apply_created_thread_user_name();

revoke execute on function public._thread_command_payload(uuid)
from public, anon, authenticated;
revoke execute on function public.rename_ai_connection(
  uuid, uuid, uuid, text, text, text
) from public, anon, authenticated;
revoke execute on function public.enqueue_ai_thread_command(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text
) from public, anon, authenticated;
revoke execute on function public.claim_ai_thread_command(
  uuid, uuid, text, uuid, integer
) from public, anon, authenticated;
revoke execute on function public.complete_ai_thread_command(
  uuid, uuid, text, uuid, uuid, boolean, text, text
) from public, anon, authenticated;
revoke execute on function public.apply_created_thread_user_name()
from public, anon, authenticated;

grant execute on function public.rename_ai_connection(
  uuid, uuid, uuid, text, text, text
) to service_role;
grant execute on function public.enqueue_ai_thread_command(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text
) to service_role;
grant execute on function public.claim_ai_thread_command(
  uuid, uuid, text, uuid, integer
) to service_role;
grant execute on function public.complete_ai_thread_command(
  uuid, uuid, text, uuid, uuid, boolean, text, text
) to service_role;

comment on table public.ai_thread_commands is
  'Owner-requested Codex Thread lifecycle commands, leased to one active Bridge runtime.';
