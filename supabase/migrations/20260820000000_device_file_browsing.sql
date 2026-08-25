-- Device-mediated file browsing for the /files page. The Board persists
-- Owner-requested list/read commands; the single Bridge runtime that owns the
-- connection lease claims, executes them against its local filesystem (only
-- inside the connection's managed working directories), and completes with a
-- JSON payload holding directory entries or a capped file preview.

create table if not exists public.ai_file_commands (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  connection_id uuid not null,
  action text not null check (action in ('list', 'read')),
  path text not null,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 100),
  requested_by_user_id uuid references auth.users(id) on delete set null,
  runtime_instance_id uuid,
  lease_expires_at timestamptz,
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  constraint ai_file_commands_connection_fk
    foreign key (workspace_id, connection_id)
    references public.ai_connections(workspace_id, id) on delete cascade,
  constraint ai_file_commands_path_length check (
    length(btrim(path)) between 1 and 4096
  ),
  constraint ai_file_commands_error_length check (
    error is null or length(error) <= 2000
  )
);

create index if not exists ai_file_commands_claim_idx
  on public.ai_file_commands (connection_id, status, created_at, id);
create index if not exists ai_file_commands_workspace_idx
  on public.ai_file_commands (workspace_id, created_at desc);

drop trigger if exists ai_file_commands_set_updated_at
on public.ai_file_commands;
create trigger ai_file_commands_set_updated_at
before update on public.ai_file_commands
for each row execute function public._set_updated_at();

alter table public.ai_file_commands enable row level security;
revoke all on table public.ai_file_commands from public, anon, authenticated;
grant all privileges on table public.ai_file_commands to service_role;

comment on table public.ai_file_commands is
  'Owner-requested device filesystem list/read commands, leased to one active Bridge runtime.';

create or replace function public._file_command_payload(p_command_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select to_jsonb(command)
  from public.ai_file_commands command
  where command.id = p_command_id;
$$;

revoke all on function public._file_command_payload(uuid)
from public, anon, authenticated;

create or replace function public.enqueue_ai_file_command(
  p_workspace_id uuid,
  p_user_id uuid,
  p_command_id uuid,
  p_connection_id uuid,
  p_action text,
  p_path text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_connection public.ai_connections%rowtype;
  v_response jsonb;
begin
  perform public._assert_owner(p_workspace_id, p_user_id);

  select * into v_connection
  from public.ai_connections connection
  where connection.workspace_id = p_workspace_id
    and connection.id = p_connection_id
    and connection.revoked_at is null;
  if not found then
    perform public._raise('SESSION_NOT_AUTHORIZED');
  end if;

  if p_action not in ('list', 'read')
     or nullif(btrim(p_path), '') is null
     or length(btrim(p_path)) > 4096 then
    perform public._raise('INVALID_FILE_COMMAND');
  end if;

  begin
    insert into public.ai_file_commands (
      id, workspace_id, connection_id, action, path, requested_by_user_id
    ) values (
      p_command_id, p_workspace_id, p_connection_id,
      p_action, btrim(p_path), p_user_id
    );
  exception when unique_violation then
    perform public._raise('IDEMPOTENCY_CONFLICT');
  end;

  v_response := jsonb_build_object(
    'command', public._file_command_payload(p_command_id)
  );
  return v_response;
end;
$$;

create or replace function public.claim_ai_file_command(
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
    perform public._raise('INVALID_FILE_COMMAND');
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

  -- File operations are read-only, so replaying an expired running lease is
  -- safe and only re-reads the same filesystem state.
  select command.id into v_command_id
  from public.ai_file_commands command
  where command.workspace_id = p_workspace_id
    and command.connection_id = p_connection_id
    and (
      command.status = 'queued'
      or (
        command.status = 'running'
        and command.lease_expires_at < clock_timestamp()
      )
    )
  order by command.created_at, command.id
  for update skip locked
  limit 1;

  if v_command_id is null then
    return jsonb_build_object('command', null);
  end if;

  update public.ai_file_commands
  set status = 'running',
      attempt_count = attempt_count + 1,
      runtime_instance_id = p_runtime_instance_id,
      lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
      started_at = coalesce(started_at, clock_timestamp()),
      error = null
  where id = v_command_id;

  return jsonb_build_object(
    'command', public._file_command_payload(v_command_id)
  );
end;
$$;

create or replace function public.complete_ai_file_command(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_api_token_hash text,
  p_runtime_instance_id uuid,
  p_command_id uuid,
  p_succeeded boolean,
  p_result jsonb,
  p_error text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_command public.ai_file_commands%rowtype;
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
  from public.ai_file_commands command
  where command.workspace_id = p_workspace_id
    and command.connection_id = p_connection_id
    and command.id = p_command_id
  for update;
  if not found then
    perform public._raise('INVALID_FILE_COMMAND');
  end if;
  if v_command.status <> 'running'
     or v_command.runtime_instance_id is distinct from p_runtime_instance_id then
    perform public._raise('INVALID_STATE_TRANSITION');
  end if;
  if p_succeeded and (
    p_result is null
    or jsonb_typeof(p_result) <> 'object'
    or pg_column_size(p_result) > 20 * 1024 * 1024
  ) then
    perform public._raise('INVALID_FILE_COMMAND');
  end if;
  if not p_succeeded and (
    nullif(btrim(p_error), '') is null or length(p_error) > 2000
  ) then
    perform public._raise('INVALID_FILE_COMMAND');
  end if;

  update public.ai_file_commands
  set status = case when p_succeeded then 'succeeded' else 'failed' end,
      result = case when p_succeeded then p_result else null end,
      lease_expires_at = null,
      error = case when p_succeeded then null else btrim(p_error) end,
      completed_at = clock_timestamp()
  where id = p_command_id;

  return jsonb_build_object(
    'command', public._file_command_payload(p_command_id)
  );
end;
$$;

revoke all on function public.enqueue_ai_file_command(
  uuid, uuid, uuid, uuid, text, text
) from public, anon, authenticated;
revoke all on function public.claim_ai_file_command(
  uuid, uuid, text, uuid, integer
) from public, anon, authenticated;
revoke all on function public.complete_ai_file_command(
  uuid, uuid, text, uuid, uuid, boolean, jsonb, text
) from public, anon, authenticated;

grant execute on function public.enqueue_ai_file_command(
  uuid, uuid, uuid, uuid, text, text
) to service_role;
grant execute on function public.claim_ai_file_command(
  uuid, uuid, text, uuid, integer
) to service_role;
grant execute on function public.complete_ai_file_command(
  uuid, uuid, text, uuid, uuid, boolean, jsonb, text
) to service_role;
