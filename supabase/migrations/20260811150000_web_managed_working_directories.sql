-- Owner-managed desired Bridge working directories. A null desired value keeps
-- the device's startup configuration authoritative; a non-null value can only
-- be selected by a device that explicitly permits Web directory management.

create function public._bridge_working_directories_are_valid(
  p_directories jsonb
)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
declare
  v_directory jsonb;
begin
  if p_directories is null
     or jsonb_typeof(p_directories) <> 'array'
     or jsonb_array_length(p_directories) not between 1 and 100 then
    return false;
  end if;

  for v_directory in
    select value from jsonb_array_elements(p_directories)
  loop
    if jsonb_typeof(v_directory) <> 'object'
       or (select count(*) from jsonb_object_keys(v_directory)) <> 3
       or exists (
         select 1
         from jsonb_object_keys(v_directory) field_name
         where field_name not in (
           'directory_key', 'name', 'working_directory'
         )
       )
       or jsonb_typeof(v_directory -> 'directory_key') <> 'string'
       or jsonb_typeof(v_directory -> 'name') <> 'string'
       or jsonb_typeof(v_directory -> 'working_directory') <> 'string'
       or v_directory ->> 'directory_key'
          !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$'
       or length(v_directory ->> 'name') not between 1 and 200
       or v_directory ->> 'name' <> btrim(v_directory ->> 'name')
       or length(v_directory ->> 'working_directory') not between 1 and 4096
       or v_directory ->> 'working_directory'
          <> btrim(v_directory ->> 'working_directory') then
      return false;
    end if;
  end loop;

  if exists (
    select 1
    from jsonb_array_elements(p_directories) as directory(value)
    group by value ->> 'directory_key'
    having count(*) > 1
  ) or exists (
    select 1
    from jsonb_array_elements(p_directories) as directory(value)
    group by value ->> 'working_directory'
    having count(*) > 1
  ) then
    return false;
  end if;

  return true;
exception
  when others then
    return false;
end;
$$;

revoke all on function public._bridge_working_directories_are_valid(jsonb)
from public, anon, authenticated;
grant execute on function public._bridge_working_directories_are_valid(jsonb)
to service_role;

alter table public.ai_connection_bridge_settings
  add column desired_working_directories jsonb,
  add column effective_working_directories jsonb,
  add column constraint_allow_working_directory_configuration boolean;

update public.ai_connection_bridge_settings
set constraint_allow_working_directory_configuration = false
where applied_at is not null;

alter table public.ai_connection_bridge_settings
  add constraint ai_connection_bridge_settings_desired_directories_shape
    check (
      desired_working_directories is null
      or public._bridge_working_directories_are_valid(
        desired_working_directories
      )
    ),
  add constraint ai_connection_bridge_settings_effective_directories_shape
    check (
      effective_working_directories is null
      or public._bridge_working_directories_are_valid(
        effective_working_directories
      )
    ),
  add constraint ai_connection_bridge_settings_directory_status_group
    check (
      applied_at is not null
      or (
        effective_working_directories is null
        and constraint_allow_working_directory_configuration is null
      )
    );

comment on column public.ai_connection_bridge_settings.desired_working_directories is
  'Owner-desired [{directory_key,name,working_directory}] list; null preserves the Bridge startup configuration.';
comment on column public.ai_connection_bridge_settings.effective_working_directories is
  'Last runtime-reported concrete effective directory list; null is retained for legacy reports without directory detail.';
comment on column public.ai_connection_bridge_settings.constraint_allow_working_directory_configuration is
  'Device-local gate for adopting a non-null Web desired list; it does not restrict reporting the current effective list.';

-- Keep the owner and Bridge endpoints on one canonical DTO.
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
        'max_concurrent_turns', settings.desired_max_concurrent_turns,
        'sync_history', settings.desired_sync_history,
        'history_turn_limit', settings.desired_history_turn_limit,
        'working_directories', settings.desired_working_directories
      ),
      'applied', case when settings.applied_at is null then null else
        jsonb_build_object(
          'version', settings.applied_version,
          'effective', case when settings.effective_enabled is null then null else
            jsonb_build_object(
              'enabled', settings.effective_enabled,
              'include_thread_titles', settings.effective_include_thread_titles,
              'max_threads', settings.effective_max_threads,
              'max_concurrent_turns', settings.effective_max_concurrent_turns,
              'sync_history', settings.effective_sync_history,
              'history_turn_limit', settings.effective_history_turn_limit,
              'working_directories', settings.effective_working_directories
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
            'approval_mode', settings.constraint_approval_mode,
            'allow_history_sync', settings.constraint_allow_history_sync,
            'max_history_turns', settings.constraint_max_history_turns,
            'allow_working_directory_configuration',
              settings.constraint_allow_working_directory_configuration
          ),
          'error', settings.error,
          'applied_at', settings.applied_at
        ) end,
      'runtime', jsonb_build_object(
        'online', coalesce(
          settings.active_runtime_lease_expires_at > clock_timestamp(), false
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

-- The new Web overload requires a complete desired state. Older overloads stay
-- available during a rolling deployment and preserve the new null default.
create function public.update_ai_connection_bridge_config(
  p_workspace_id uuid,
  p_user_id uuid,
  p_connection_id uuid,
  p_expected_version integer,
  p_enabled boolean,
  p_include_thread_titles boolean,
  p_max_threads integer,
  p_max_concurrent_turns integer,
  p_sync_history boolean,
  p_history_turn_limit integer,
  p_working_directories jsonb,
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
  v_idempotency := public._idempotency_begin(
    p_workspace_id, 'user:' || p_user_id::text,
    p_idempotency_key, 'update_ai_connection_bridge_config', p_request_hash
  );
  if v_idempotency ? 'cached_response' then
    return v_idempotency -> 'cached_response';
  end if;

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
     or p_max_threads is null or p_max_threads not between 1 and 500
     or p_max_concurrent_turns is null
     or p_max_concurrent_turns not between 1 and 32
     or p_sync_history is null
     or p_history_turn_limit is null
     or p_history_turn_limit not between 1 and 500
     or (
       p_working_directories is not null
       and not public._bridge_working_directories_are_valid(
         p_working_directories
       )
     )
     or octet_length(
       coalesce(p_working_directories, 'null'::jsonb)::text
     ) > 1146880 then
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
  if v_current_version <> p_expected_version
     or v_current_version = 2147483647 then
    perform public._raise('VERSION_CONFLICT');
  end if;

  update public.ai_connection_bridge_settings
  set version = v_current_version + 1,
      desired_enabled = p_enabled,
      desired_include_thread_titles = p_include_thread_titles,
      desired_max_threads = p_max_threads,
      desired_max_concurrent_turns = p_max_concurrent_turns,
      desired_sync_history = p_sync_history,
      desired_history_turn_limit = p_history_turn_limit,
      desired_working_directories = p_working_directories,
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
  uuid, uuid, uuid, integer, boolean, boolean, integer, integer,
  boolean, integer, jsonb, text, text
) is
  'Owner-only idempotent optimistic update for a complete desired Bridge configuration, including an optional managed directory list.';

revoke all on function public.update_ai_connection_bridge_config(
  uuid, uuid, uuid, integer, boolean, boolean, integer, integer,
  boolean, integer, jsonb, text, text
) from public, anon, authenticated;
grant execute on function public.update_ai_connection_bridge_config(
  uuid, uuid, uuid, integer, boolean, boolean, integer, integer,
  boolean, integer, jsonb, text, text
) to service_role;

-- Wrap the 0.4 exchange state machine. Missing fields from older Bridges are
-- normalized to fail-closed defaults, while accepted new reports persist the
-- effective directory list and its device-local authorization gate.
alter function public.exchange_ai_connection_bridge_config(
  uuid, uuid, text, uuid, bigint, integer, boolean,
  integer, jsonb, jsonb, text
) rename to _exchange_ai_connection_bridge_config_v4;

revoke all on function public._exchange_ai_connection_bridge_config_v4(
  uuid, uuid, text, uuid, bigint, integer, boolean,
  integer, jsonb, jsonb, text
) from public, anon, authenticated, service_role;

create function public.exchange_ai_connection_bridge_config(
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
  v_effective jsonb;
  v_constraints jsonb;
  v_previous_runtime uuid;
  v_previous_sequence bigint;
  v_should_apply boolean;
begin
  perform public._assert_active_connection(
    p_workspace_id, p_connection_id, p_api_token_hash
  );

  v_effective := case when p_effective is null then null else
    jsonb_build_object(
      'sync_history', false,
      'history_turn_limit', 50,
      'working_directories', null
    ) || p_effective
  end;
  v_constraints := jsonb_build_object(
    'allow_history_sync', false,
    'max_history_turns', 50,
    'allow_working_directory_configuration', false
  ) || coalesce(p_constraints, '{}'::jsonb);

  if p_constraints is null
     or jsonb_typeof(p_constraints) <> 'object'
     or (p_effective is not null and jsonb_typeof(p_effective) <> 'object')
     or octet_length(coalesce(p_effective, 'null'::jsonb)::text)
        + octet_length(p_constraints::text)
        + octet_length(coalesce(p_error, '')) > 1179648 then
    perform public._raise('INVALID_BRIDGE_CONFIG');
  end if;

  if v_effective is not null and (
    (select count(*) from jsonb_object_keys(v_effective)) <> 7
    or exists (
      select 1 from jsonb_object_keys(v_effective) field_name
      where field_name not in (
        'enabled', 'include_thread_titles', 'max_threads',
        'max_concurrent_turns', 'sync_history', 'history_turn_limit',
        'working_directories'
      )
    )
    or jsonb_typeof(v_effective -> 'working_directories')
       not in ('array', 'null')
    or (
      v_effective -> 'working_directories' <> 'null'::jsonb
      and not public._bridge_working_directories_are_valid(
        v_effective -> 'working_directories'
      )
    )
  ) then
    perform public._raise('INVALID_BRIDGE_CONFIG');
  end if;

  if (select count(*) from jsonb_object_keys(v_constraints)) <> 12
     or exists (
       select 1 from jsonb_object_keys(v_constraints) field_name
       where field_name not in (
         'remote_configuration_enabled', 'allow_thread_titles',
         'max_threads', 'max_concurrent_turns', 'thread_scope',
         'working_directory', 'fixed_thread', 'permission_mode',
         'approval_mode', 'allow_history_sync', 'max_history_turns',
         'allow_working_directory_configuration'
       )
     )
     or jsonb_typeof(
       v_constraints -> 'allow_working_directory_configuration'
     ) <> 'boolean' then
    perform public._raise('INVALID_BRIDGE_CONFIG');
  end if;

  select settings.active_runtime_instance_id,
         settings.active_runtime_last_sequence
  into v_previous_runtime, v_previous_sequence
  from public.ai_connection_bridge_settings settings
  where settings.workspace_id = p_workspace_id
    and settings.connection_id = p_connection_id
  for update;
  if not found then
    perform public._raise('SESSION_NOT_AUTHORIZED');
  end if;

  perform public._exchange_ai_connection_bridge_config_v4(
    p_workspace_id, p_connection_id, p_api_token_hash,
    p_runtime_instance_id, p_report_sequence, p_lease_seconds,
    p_release_runtime, p_applied_version,
    case when v_effective is null then null else
      v_effective - 'working_directories'
    end,
    v_constraints - 'allow_working_directory_configuration',
    p_error
  );

  v_should_apply := not p_release_runtime and (
    v_previous_runtime is distinct from p_runtime_instance_id
    or p_report_sequence > coalesce(v_previous_sequence, 0)
  ) and exists (
    select 1
    from public.ai_connection_bridge_settings settings
    where settings.workspace_id = p_workspace_id
      and settings.connection_id = p_connection_id
      and settings.active_runtime_instance_id = p_runtime_instance_id
      and settings.active_runtime_last_sequence = p_report_sequence
  );
  if v_should_apply then
    update public.ai_connection_bridge_settings
    set effective_working_directories = case
          when v_effective is null
            or v_effective -> 'working_directories' = 'null'::jsonb then null
          else v_effective -> 'working_directories'
        end,
        constraint_allow_working_directory_configuration =
          (
            v_constraints ->> 'allow_working_directory_configuration'
          )::boolean
    where workspace_id = p_workspace_id
      and connection_id = p_connection_id;
  end if;

  return public._bridge_configuration_payload(p_connection_id);
end;
$$;

comment on function public.exchange_ai_connection_bridge_config(
  uuid, uuid, text, uuid, bigint, integer, boolean,
  integer, jsonb, jsonb, text
) is
  'Exchanges one runtime-fenced Bridge status, including fail-closed Web-managed working directory state.';

revoke all on function public.exchange_ai_connection_bridge_config(
  uuid, uuid, text, uuid, bigint, integer, boolean,
  integer, jsonb, jsonb, text
) from public, anon, authenticated;
grant execute on function public.exchange_ai_connection_bridge_config(
  uuid, uuid, text, uuid, bigint, integer, boolean,
  integer, jsonb, jsonb, text
) to service_role;

grant select (
  desired_working_directories, effective_working_directories,
  constraint_allow_working_directory_configuration
) on table public.ai_connection_bridge_settings to authenticated;
