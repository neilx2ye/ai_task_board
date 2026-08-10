-- Web-managed Bridge configuration with a device-reported effective status.
-- Raw connection tokens never enter this table or any response payload.

create table if not exists public.ai_connection_bridge_settings (
  connection_id uuid primary key,
  workspace_id uuid not null,

  version integer not null default 1
    check (version between 1 and 2147483647),
  desired_enabled boolean not null default true,
  desired_include_thread_titles boolean not null default false,
  desired_max_threads integer not null default 50
    check (desired_max_threads between 1 and 500),
  desired_max_concurrent_turns integer not null default 2
    check (desired_max_concurrent_turns between 1 and 32),

  applied_version integer
    check (applied_version between 1 and 2147483647),
  effective_enabled boolean,
  effective_include_thread_titles boolean,
  effective_max_threads integer
    check (effective_max_threads between 1 and 500),
  effective_max_concurrent_turns integer
    check (effective_max_concurrent_turns between 1 and 32),

  constraint_remote_configuration_enabled boolean,
  constraint_allow_thread_titles boolean,
  constraint_max_threads integer
    check (constraint_max_threads between 1 and 500),
  constraint_max_concurrent_turns integer
    check (constraint_max_concurrent_turns between 1 and 32),
  constraint_thread_scope text
    check (constraint_thread_scope in ('cwd', 'all')),
  constraint_working_directory text
    check (length(constraint_working_directory) <= 4096),
  constraint_fixed_thread boolean,
  constraint_permission_mode text
    check (constraint_permission_mode in ('safe', 'inherit')),
  constraint_approval_mode text
    check (constraint_approval_mode in ('decline', 'accept', 'accept-session')),

  error text check (error is null or length(error) <= 2000),
  applied_at timestamptz,
  active_runtime_instance_id uuid,
  active_runtime_last_sequence bigint
    check (
      active_runtime_last_sequence between 1 and 9007199254740991
    ),
  active_runtime_lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (workspace_id, connection_id),
  constraint ai_connection_bridge_settings_connection_fk
    foreign key (workspace_id, connection_id)
    references public.ai_connections(workspace_id, id) on delete cascade,
  constraint ai_connection_bridge_settings_applied_version_fence
    check (applied_version is null or applied_version <= version),
  constraint ai_connection_bridge_settings_effective_group
    check (
      (
        effective_enabled is null
        and effective_include_thread_titles is null
        and effective_max_threads is null
        and effective_max_concurrent_turns is null
      )
      or
      (
        effective_enabled is not null
        and effective_include_thread_titles is not null
        and effective_max_threads is not null
        and effective_max_concurrent_turns is not null
      )
    ),
  constraint ai_connection_bridge_settings_runtime_group
    check (
      (
        active_runtime_instance_id is null
        and active_runtime_last_sequence is null
        and active_runtime_lease_expires_at is null
      )
      or
      (
        active_runtime_instance_id is not null
        and active_runtime_last_sequence is not null
        and active_runtime_lease_expires_at is not null
      )
    ),
  constraint ai_connection_bridge_settings_status_group
    check (
      (
        applied_at is null
        and applied_version is null
        and effective_enabled is null
        and effective_include_thread_titles is null
        and effective_max_threads is null
        and effective_max_concurrent_turns is null
        and constraint_remote_configuration_enabled is null
        and constraint_allow_thread_titles is null
        and constraint_max_threads is null
        and constraint_max_concurrent_turns is null
        and constraint_thread_scope is null
        and constraint_working_directory is null
        and constraint_fixed_thread is null
        and constraint_permission_mode is null
        and constraint_approval_mode is null
        and error is null
      )
      or
      (
        applied_at is not null
        and constraint_remote_configuration_enabled is not null
        and constraint_allow_thread_titles is not null
        and constraint_max_threads is not null
        and constraint_max_concurrent_turns is not null
        and constraint_thread_scope is not null
        and constraint_working_directory is not null
        and constraint_fixed_thread is not null
        and constraint_permission_mode is not null
        and constraint_approval_mode is not null
      )
    )
);

comment on table public.ai_connection_bridge_settings is
  'One safe desired/effective Bridge configuration row per AI connection. Connection token hashes remain only on ai_connections.';

-- Retired runtime ids are retained so a request delayed across more than one
-- graceful takeover can never reacquire the writer lease. The settings row
-- remains the hot, row-locked lease record; this history is only a generation
-- tombstone and contains no connection token material.
create table if not exists public.ai_connection_bridge_runtimes (
  workspace_id uuid not null,
  connection_id uuid not null,
  runtime_instance_id uuid not null,
  last_report_sequence bigint not null
    check (last_report_sequence between 1 and 9007199254740991),
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (connection_id, runtime_instance_id),
  constraint ai_connection_bridge_runtimes_settings_fk
    foreign key (workspace_id, connection_id)
    references public.ai_connection_bridge_settings(workspace_id, connection_id)
    on delete cascade
);

create unique index if not exists ai_connection_bridge_runtimes_active_uidx
  on public.ai_connection_bridge_runtimes (connection_id)
  where retired_at is null;

-- Token rotation is a control-plane generation change. The existing rotate
-- RPC already holds the exclusive ai-connection advisory lock, while exchange
-- takes the matching shared lock, so expiring and retiring this runtime is
-- atomic with making the old token unusable.
create or replace function public._retire_bridge_runtime_on_token_rotation()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
begin
  if old.api_token_hash is distinct from new.api_token_hash then
    insert into public.ai_connection_bridge_runtimes (
      workspace_id, connection_id, runtime_instance_id,
      last_report_sequence, retired_at, updated_at
    )
    select settings.workspace_id, settings.connection_id,
           settings.active_runtime_instance_id,
           settings.active_runtime_last_sequence, v_now, v_now
    from public.ai_connection_bridge_settings settings
    where settings.workspace_id = new.workspace_id
      and settings.connection_id = new.id
      and settings.active_runtime_instance_id is not null
    on conflict (connection_id, runtime_instance_id) do update
    set last_report_sequence = greatest(
          public.ai_connection_bridge_runtimes.last_report_sequence,
          excluded.last_report_sequence
        ),
        retired_at = coalesce(
          public.ai_connection_bridge_runtimes.retired_at, v_now
        ),
        updated_at = v_now;

    update public.ai_connection_bridge_settings
    set active_runtime_lease_expires_at = v_now
    where workspace_id = new.workspace_id
      and connection_id = new.id
      and active_runtime_instance_id is not null;
  end if;
  return new;
end;
$$;

revoke all on function public._retire_bridge_runtime_on_token_rotation()
from public, anon, authenticated;

drop trigger if exists ai_connections_retire_bridge_runtime_on_token_rotation
on public.ai_connections;
create trigger ai_connections_retire_bridge_runtime_on_token_rotation
after update of api_token_hash on public.ai_connections
for each row
when (old.api_token_hash is distinct from new.api_token_hash)
execute function public._retire_bridge_runtime_on_token_rotation();

-- Keep the one-to-one settings row invariant for every future connection.
create or replace function public._create_ai_connection_bridge_settings()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  insert into public.ai_connection_bridge_settings (
    connection_id, workspace_id
  ) values (
    new.id, new.workspace_id
  ) on conflict (connection_id) do nothing;
  return new;
end;
$$;

revoke all on function public._create_ai_connection_bridge_settings()
from public, anon, authenticated;

drop trigger if exists ai_connections_create_bridge_settings
on public.ai_connections;
create trigger ai_connections_create_bridge_settings
after insert on public.ai_connections
for each row execute function public._create_ai_connection_bridge_settings();

insert into public.ai_connection_bridge_settings (connection_id, workspace_id)
select connection.id, connection.workspace_id
from public.ai_connections connection
on conflict (connection_id) do nothing;

-- Produce the only Bridge configuration shape exposed by either HTTP API.
create or replace function public._bridge_configuration_payload(
  p_connection_id uuid
)
returns jsonb
language sql
volatile
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'configuration', jsonb_build_object(
      'connection_id', settings.connection_id,
      'version', settings.version,
      'desired', jsonb_build_object(
        'enabled', settings.desired_enabled,
        'include_thread_titles', settings.desired_include_thread_titles,
        'max_threads', settings.desired_max_threads,
        'max_concurrent_turns', settings.desired_max_concurrent_turns
      ),
      'applied', case when settings.applied_at is null then null else
        jsonb_build_object(
          'version', settings.applied_version,
          'effective', case when settings.effective_enabled is null then null else
            jsonb_build_object(
              'enabled', settings.effective_enabled,
              'include_thread_titles', settings.effective_include_thread_titles,
              'max_threads', settings.effective_max_threads,
              'max_concurrent_turns', settings.effective_max_concurrent_turns
            ) end,
          'constraints', jsonb_build_object(
            'remote_configuration_enabled', settings.constraint_remote_configuration_enabled,
            'allow_thread_titles', settings.constraint_allow_thread_titles,
            'max_threads', settings.constraint_max_threads,
            'max_concurrent_turns', settings.constraint_max_concurrent_turns,
            'thread_scope', settings.constraint_thread_scope,
            'working_directory', settings.constraint_working_directory,
            'fixed_thread', settings.constraint_fixed_thread,
            'permission_mode', settings.constraint_permission_mode,
            'approval_mode', settings.constraint_approval_mode
          ),
          'error', settings.error,
          'applied_at', settings.applied_at
        ) end,
      'runtime', jsonb_build_object(
        'online', coalesce(
          settings.active_runtime_lease_expires_at > clock_timestamp(),
          false
        ),
        'lease_expires_at', settings.active_runtime_lease_expires_at
      ),
      'updated_at', settings.updated_at
    )
  )
  from public.ai_connection_bridge_settings settings
  where settings.connection_id = p_connection_id;
$$;

revoke all on function public._bridge_configuration_payload(uuid)
from public, anon, authenticated;

-- Owner-only, idempotent optimistic update. An idempotent replay is resolved
-- before the expected-version check so a lost successful response can be
-- retried with the original version and key.
create or replace function public.update_ai_connection_bridge_config(
  p_workspace_id uuid,
  p_user_id uuid,
  p_connection_id uuid,
  p_expected_version integer,
  p_enabled boolean,
  p_include_thread_titles boolean,
  p_max_threads integer,
  p_max_concurrent_turns integer,
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
  v_current_version integer;
  v_response jsonb;
begin
  perform public._assert_owner(p_workspace_id, p_user_id);

  -- Match every existing owner command's lock order: reserve/resolve the
  -- user idempotency row before taking the connection advisory lock. This
  -- prevents an update and a revoke/rotate that accidentally reuse one key
  -- from waiting on those two locks in opposite directions.
  v_idempotency := public._idempotency_begin(
    p_workspace_id, 'user:' || p_user_id::text,
    p_idempotency_key, 'update_ai_connection_bridge_config', p_request_hash
  );
  if v_idempotency ? 'cached_response' then
    return v_idempotency -> 'cached_response';
  end if;

  -- Serialize against revocation and ensure a revoked/cross-workspace device
  -- cannot be configured, including through the service-role RPC surface.
  perform pg_advisory_xact_lock_shared(
    hashtextextended('ai-connection:' || p_connection_id::text, 0)
  );
  perform 1
  from public.ai_connections connection
  where connection.workspace_id = p_workspace_id
    and connection.id = p_connection_id
    and connection.revoked_at is null;
  if not found then
    perform public._raise('SESSION_NOT_AUTHORIZED');
  end if;

  if p_expected_version is null
     or p_expected_version not between 1 and 2147483647
     or p_enabled is null
     or p_include_thread_titles is null
     or p_max_threads is null
     or p_max_threads not between 1 and 500
     or p_max_concurrent_turns is null
     or p_max_concurrent_turns not between 1 and 32 then
    perform public._raise('INVALID_BRIDGE_CONFIG');
  end if;

  select settings.version into v_current_version
  from public.ai_connection_bridge_settings settings
  where settings.workspace_id = p_workspace_id
    and settings.connection_id = p_connection_id
  for update;
  if not found then
    perform public._raise('SESSION_NOT_AUTHORIZED');
  end if;

  if v_current_version <> p_expected_version then
    perform public._raise('VERSION_CONFLICT');
  end if;
  if v_current_version = 2147483647 then
    perform public._raise('VERSION_CONFLICT');
  end if;

  update public.ai_connection_bridge_settings
  set version = v_current_version + 1,
      desired_enabled = p_enabled,
      desired_include_thread_titles = p_include_thread_titles,
      desired_max_threads = p_max_threads,
      desired_max_concurrent_turns = p_max_concurrent_turns,
      updated_at = clock_timestamp()
  where workspace_id = p_workspace_id
    and connection_id = p_connection_id;

  v_response := public._bridge_configuration_payload(p_connection_id);
  perform public._idempotency_finish(
    p_workspace_id, 'user:' || p_user_id::text,
    p_idempotency_key, v_response
  );
  return v_response;
end;
$$;

comment on function public.update_ai_connection_bridge_config(
  uuid, uuid, uuid, integer, boolean, boolean, integer, integer, text, text
) is
  'Owner-only idempotent optimistic update for one active Bridge device desired configuration.';

revoke all on function public.update_ai_connection_bridge_config(
  uuid, uuid, uuid, integer, boolean, boolean, integer, integer, text, text
) from public, anon, authenticated;
grant execute on function public.update_ai_connection_bridge_config(
  uuid, uuid, uuid, integer, boolean, boolean, integer, integer, text, text
) to service_role;

-- A token-authenticated Bridge reports the locally effective state and its
-- immutable safety envelope, then receives the current desired configuration.
create or replace function public.exchange_ai_connection_bridge_config(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_api_token_hash text,
  p_runtime_instance_id uuid,
  p_report_sequence bigint,
  p_lease_seconds integer,
  p_release_runtime boolean,
  p_applied_version integer,
  p_effective jsonb,
  p_constraints jsonb,
  p_error text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_settings public.ai_connection_bridge_settings%rowtype;
  v_runtime public.ai_connection_bridge_runtimes%rowtype;
  v_runtime_exists boolean := false;
  v_now timestamptz := clock_timestamp();
begin
  perform public._assert_active_connection(
    p_workspace_id, p_connection_id, p_api_token_hash
  );

  if p_runtime_instance_id is null
     or p_report_sequence is null
     or p_report_sequence not between 1 and 9007199254740991
     or p_lease_seconds is null
     or p_lease_seconds not between 15 and 1800
     or p_release_runtime is null
     or (p_applied_version is not null and
      p_applied_version not between 1 and 2147483647)
     or p_constraints is null
     or jsonb_typeof(p_constraints) <> 'object'
     or octet_length(coalesce(p_effective, 'null'::jsonb)::text)
        + octet_length(p_constraints::text)
        + octet_length(coalesce(p_error, '')) > 32768
     or (p_error is not null and length(p_error) > 2000) then
    perform public._raise('INVALID_BRIDGE_CONFIG');
  end if;

  if p_effective is not null and (
    jsonb_typeof(p_effective) <> 'object'
    or (select count(*) from jsonb_object_keys(p_effective)) <> 4
    or exists (
      select 1 from jsonb_object_keys(p_effective) field_name
      where field_name not in (
        'enabled', 'include_thread_titles', 'max_threads',
        'max_concurrent_turns'
      )
    )
    or jsonb_typeof(p_effective -> 'enabled') <> 'boolean'
    or jsonb_typeof(p_effective -> 'include_thread_titles') <> 'boolean'
    or jsonb_typeof(p_effective -> 'max_threads') <> 'number'
    or jsonb_typeof(p_effective -> 'max_concurrent_turns') <> 'number'
    or (p_effective ->> 'max_threads')::numeric
       <> trunc((p_effective ->> 'max_threads')::numeric)
    or (p_effective ->> 'max_threads')::numeric not between 1 and 500
    or (p_effective ->> 'max_concurrent_turns')::numeric
       <> trunc((p_effective ->> 'max_concurrent_turns')::numeric)
    or (p_effective ->> 'max_concurrent_turns')::numeric not between 1 and 32
  ) then
    perform public._raise('INVALID_BRIDGE_CONFIG');
  end if;

  if (select count(*) from jsonb_object_keys(p_constraints)) <> 9
     or exists (
       select 1 from jsonb_object_keys(p_constraints) field_name
       where field_name not in (
         'remote_configuration_enabled', 'allow_thread_titles',
         'max_threads', 'max_concurrent_turns', 'thread_scope',
         'working_directory', 'fixed_thread', 'permission_mode',
         'approval_mode'
       )
     )
     or jsonb_typeof(p_constraints -> 'remote_configuration_enabled') <> 'boolean'
     or jsonb_typeof(p_constraints -> 'allow_thread_titles') <> 'boolean'
     or jsonb_typeof(p_constraints -> 'max_threads') <> 'number'
     or jsonb_typeof(p_constraints -> 'max_concurrent_turns') <> 'number'
     or jsonb_typeof(p_constraints -> 'thread_scope') <> 'string'
     or jsonb_typeof(p_constraints -> 'working_directory') <> 'string'
     or jsonb_typeof(p_constraints -> 'fixed_thread') <> 'boolean'
     or jsonb_typeof(p_constraints -> 'permission_mode') <> 'string'
     or jsonb_typeof(p_constraints -> 'approval_mode') <> 'string'
     or (p_constraints ->> 'max_threads')::numeric
        <> trunc((p_constraints ->> 'max_threads')::numeric)
     or (p_constraints ->> 'max_threads')::numeric not between 1 and 500
     or (p_constraints ->> 'max_concurrent_turns')::numeric
        <> trunc((p_constraints ->> 'max_concurrent_turns')::numeric)
     or (p_constraints ->> 'max_concurrent_turns')::numeric not between 1 and 32
     or p_constraints ->> 'thread_scope' not in ('cwd', 'all')
     or length(p_constraints ->> 'working_directory') > 4096
     or p_constraints ->> 'permission_mode' not in ('safe', 'inherit')
     or p_constraints ->> 'approval_mode'
        not in ('decline', 'accept', 'accept-session') then
    perform public._raise('INVALID_BRIDGE_CONFIG');
  end if;

  -- The locally effective values must fit inside the reported immutable
  -- device envelope. `allow_thread_titles` represents either remote or local
  -- opt-in, so the rule remains valid even when remote configuration is off.
  if p_effective is not null and (
    (p_effective ->> 'max_threads')::integer
      > (p_constraints ->> 'max_threads')::integer
    or (p_effective ->> 'max_concurrent_turns')::integer
      > (p_constraints ->> 'max_concurrent_turns')::integer
    or (
      (p_effective ->> 'include_thread_titles')::boolean
      and not (p_constraints ->> 'allow_thread_titles')::boolean
    )
  ) then
    perform public._raise('INVALID_BRIDGE_CONFIG');
  end if;

  -- Serialize every status decision for this connection. The runtime lease
  -- and sequence fence prevent an older process from rolling status back
  -- after another Bridge process has taken over.
  select settings.* into v_settings
  from public.ai_connection_bridge_settings settings
  where settings.workspace_id = p_workspace_id
    and settings.connection_id = p_connection_id
  for update;
  if not found then
    perform public._raise('SESSION_NOT_AUTHORIZED');
  end if;

  select runtime.* into v_runtime
  from public.ai_connection_bridge_runtimes runtime
  where runtime.connection_id = p_connection_id
    and runtime.runtime_instance_id = p_runtime_instance_id;
  v_runtime_exists := found;

  if v_runtime_exists and v_runtime.retired_at is not null then
    if p_release_runtime or (
      v_settings.active_runtime_instance_id = p_runtime_instance_id
      and p_report_sequence <= v_settings.active_runtime_last_sequence
    ) then
      return public._bridge_configuration_payload(p_connection_id);
    end if;
    perform public._raise('BRIDGE_INSTANCE_CONFLICT');
  end if;

  if p_release_runtime then
    if v_settings.active_runtime_instance_id is null then
      return public._bridge_configuration_payload(p_connection_id);
    end if;

    if v_settings.active_runtime_instance_id <> p_runtime_instance_id then
      -- A release from an old/non-owner runtime is a visible no-op and never
      -- clears the current writer. Retire an unseen id internally so one of
      -- its delayed reports cannot acquire after a later generation exits.
      insert into public.ai_connection_bridge_runtimes (
        workspace_id, connection_id, runtime_instance_id,
        last_report_sequence, retired_at, updated_at
      ) values (
        p_workspace_id, p_connection_id, p_runtime_instance_id,
        p_report_sequence, v_now, v_now
      )
      on conflict (connection_id, runtime_instance_id) do update
      set last_report_sequence = greatest(
            public.ai_connection_bridge_runtimes.last_report_sequence,
            excluded.last_report_sequence
          ),
          retired_at = coalesce(
            public.ai_connection_bridge_runtimes.retired_at, v_now
          ),
          updated_at = v_now;
      return public._bridge_configuration_payload(p_connection_id);
    end if;

    if p_report_sequence <= v_settings.active_runtime_last_sequence then
      return public._bridge_configuration_payload(p_connection_id);
    end if;

    insert into public.ai_connection_bridge_runtimes (
      workspace_id, connection_id, runtime_instance_id,
      last_report_sequence, retired_at, updated_at
    ) values (
      p_workspace_id, p_connection_id, p_runtime_instance_id,
      p_report_sequence, v_now, v_now
    )
    on conflict (connection_id, runtime_instance_id) do update
    set last_report_sequence = excluded.last_report_sequence,
        retired_at = v_now,
        updated_at = v_now;

    -- Retain an expired settings-row tombstone. A lower-sequence request that
    -- reached PostgreSQL after this release is therefore a no-op, while a new
    -- runtime may take over immediately.
    update public.ai_connection_bridge_settings
    set active_runtime_instance_id = p_runtime_instance_id,
        active_runtime_last_sequence = p_report_sequence,
        active_runtime_lease_expires_at = v_now
    where workspace_id = p_workspace_id
      and connection_id = p_connection_id;
    return public._bridge_configuration_payload(p_connection_id);
  end if;

  if v_settings.active_runtime_instance_id = p_runtime_instance_id then
    if p_report_sequence <= v_settings.active_runtime_last_sequence then
      -- Network retries and delayed reports are successful no-ops. They do
      -- not renew the lease or replace the last applied DTO.
      return public._bridge_configuration_payload(p_connection_id);
    end if;
  elsif v_settings.active_runtime_instance_id is not null then
    if v_settings.active_runtime_lease_expires_at > v_now then
      perform public._raise('BRIDGE_INSTANCE_CONFLICT');
    end if;

    -- Expiry permits takeover but permanently retires the former generation.
    insert into public.ai_connection_bridge_runtimes (
      workspace_id, connection_id, runtime_instance_id,
      last_report_sequence, retired_at, updated_at
    ) values (
      p_workspace_id, p_connection_id,
      v_settings.active_runtime_instance_id,
      v_settings.active_runtime_last_sequence, v_now, v_now
    )
    on conflict (connection_id, runtime_instance_id) do update
    set last_report_sequence = greatest(
          public.ai_connection_bridge_runtimes.last_report_sequence,
          excluded.last_report_sequence
        ),
        retired_at = coalesce(
          public.ai_connection_bridge_runtimes.retired_at, v_now
        ),
        updated_at = v_now;
  end if;

  if v_runtime_exists
     and v_runtime.retired_at is null
     and v_settings.active_runtime_instance_id
       is distinct from p_runtime_instance_id then
    perform public._raise('BRIDGE_INSTANCE_CONFLICT');
  end if;

  if p_applied_version is not null and p_applied_version > v_settings.version then
    perform public._raise('INVALID_BRIDGE_CONFIG');
  end if;

  insert into public.ai_connection_bridge_runtimes (
    workspace_id, connection_id, runtime_instance_id,
    last_report_sequence, retired_at, updated_at
  ) values (
    p_workspace_id, p_connection_id, p_runtime_instance_id,
    p_report_sequence, null, v_now
  )
  on conflict (connection_id, runtime_instance_id) do update
  set last_report_sequence = excluded.last_report_sequence,
      updated_at = v_now
  where public.ai_connection_bridge_runtimes.retired_at is null;

  update public.ai_connection_bridge_settings
  set applied_version = p_applied_version,
      effective_enabled = case when p_effective is null then null
        else (p_effective ->> 'enabled')::boolean end,
      effective_include_thread_titles = case when p_effective is null then null
        else (p_effective ->> 'include_thread_titles')::boolean end,
      effective_max_threads = case when p_effective is null then null
        else (p_effective ->> 'max_threads')::integer end,
      effective_max_concurrent_turns = case when p_effective is null then null
        else (p_effective ->> 'max_concurrent_turns')::integer end,
      constraint_remote_configuration_enabled =
        (p_constraints ->> 'remote_configuration_enabled')::boolean,
      constraint_allow_thread_titles =
        (p_constraints ->> 'allow_thread_titles')::boolean,
      constraint_max_threads = (p_constraints ->> 'max_threads')::integer,
      constraint_max_concurrent_turns =
        (p_constraints ->> 'max_concurrent_turns')::integer,
      constraint_thread_scope = p_constraints ->> 'thread_scope',
      constraint_working_directory = p_constraints ->> 'working_directory',
      constraint_fixed_thread = (p_constraints ->> 'fixed_thread')::boolean,
      constraint_permission_mode = p_constraints ->> 'permission_mode',
      constraint_approval_mode = p_constraints ->> 'approval_mode',
      error = p_error,
      applied_at = v_now,
      active_runtime_instance_id = p_runtime_instance_id,
      active_runtime_last_sequence = p_report_sequence,
      active_runtime_lease_expires_at =
        v_now + p_lease_seconds * interval '1 second'
  where workspace_id = p_workspace_id
    and connection_id = p_connection_id;

  return public._bridge_configuration_payload(p_connection_id);
end;
$$;

comment on function public.exchange_ai_connection_bridge_config(
  uuid, uuid, text, uuid, bigint, integer, boolean,
  integer, jsonb, jsonb, text
) is
  'Exchanges one runtime-fenced, token-authenticated Bridge effective status for its current desired configuration.';

revoke all on function public.exchange_ai_connection_bridge_config(
  uuid, uuid, text, uuid, bigint, integer, boolean,
  integer, jsonb, jsonb, text
) from public, anon, authenticated;
grant execute on function public.exchange_ai_connection_bridge_config(
  uuid, uuid, text, uuid, bigint, integer, boolean,
  integer, jsonb, jsonb, text
) to service_role;

alter table public.ai_connection_bridge_settings enable row level security;
alter table public.ai_connection_bridge_runtimes enable row level security;

drop policy if exists ai_connection_bridge_settings_owner_select
on public.ai_connection_bridge_settings;
create policy ai_connection_bridge_settings_owner_select
on public.ai_connection_bridge_settings
for select to authenticated
using (public.is_workspace_owner(workspace_id));

grant all privileges on table public.ai_connection_bridge_settings to service_role;
grant all privileges on table public.ai_connection_bridge_runtimes to service_role;
revoke all on table public.ai_connection_bridge_settings
from public, anon, authenticated;
revoke all on table public.ai_connection_bridge_runtimes
from public, anon, authenticated;
grant select (
  connection_id, workspace_id, version,
  desired_enabled, desired_include_thread_titles,
  desired_max_threads, desired_max_concurrent_turns,
  applied_version, effective_enabled, effective_include_thread_titles,
  effective_max_threads, effective_max_concurrent_turns,
  constraint_remote_configuration_enabled, constraint_allow_thread_titles,
  constraint_max_threads, constraint_max_concurrent_turns,
  constraint_thread_scope, constraint_working_directory,
  constraint_fixed_thread, constraint_permission_mode,
  constraint_approval_mode, error, applied_at, created_at, updated_at
) on table public.ai_connection_bridge_settings to authenticated;
