-- The Web console now owns the Codex runtime safety modes. New and
-- existing Codex rows default to full access + automatic approval, matching
-- the installer defaults. Kimi / Antigravity / Claude Code keep these modes
-- device-owned: their desired columns stay null and the Web UI hides the
-- controls for those runtimes.

alter table public.ai_connection_bridge_settings
  add column desired_permission_mode text
    check (
      desired_permission_mode in ('safe', 'inherit', 'danger-full-access')
    ),
  add column desired_approval_mode text
    check (
      desired_approval_mode in ('decline', 'accept', 'accept-session')
    ),
  add column effective_permission_mode text
    check (
      effective_permission_mode in ('safe', 'inherit', 'danger-full-access')
    ),
  add column effective_approval_mode text
    check (
      effective_approval_mode in ('decline', 'accept', 'accept-session')
    );

-- Previously applied rows inherit the device-reported values until the first
-- new report replaces them.
update public.ai_connection_bridge_settings
set effective_permission_mode = constraint_permission_mode,
    effective_approval_mode = constraint_approval_mode
where applied_at is not null
  and effective_permission_mode is null;

-- Every Codex row gains the Web-owned defaults. There was no Web-facing
-- opt-out for these fields before, so the backfill is unconditional.
update public.ai_connection_bridge_settings
set desired_permission_mode = 'danger-full-access',
    desired_approval_mode = 'accept',
    updated_at = clock_timestamp()
where platform = 'codex'
  and (
    desired_permission_mode is null
    or desired_approval_mode is null
  );

create or replace function public._default_bridge_safety_modes()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.platform = 'codex' then
    new.desired_permission_mode := coalesce(
      new.desired_permission_mode, 'danger-full-access'
    );
    new.desired_approval_mode := coalesce(
      new.desired_approval_mode, 'accept'
    );
  end if;
  return new;
end;
$$;

revoke all on function public._default_bridge_safety_modes()
from public, anon, authenticated;

drop trigger if exists ai_connection_bridge_settings_default_safety_modes
on public.ai_connection_bridge_settings;
create trigger ai_connection_bridge_settings_default_safety_modes
before insert on public.ai_connection_bridge_settings
for each row execute function public._default_bridge_safety_modes();

-- Keep the effective/status group invariants in sync with the new columns.
alter table public.ai_connection_bridge_settings
  drop constraint if exists
    ai_connection_bridge_settings_effective_group;
alter table public.ai_connection_bridge_settings
  add constraint ai_connection_bridge_settings_effective_group
  check (
    (
      effective_enabled is null
      and effective_include_thread_titles is null
      and effective_max_threads is null
      and effective_max_concurrent_turns is null
      and effective_permission_mode is null
      and effective_approval_mode is null
    )
    or
    (
      effective_enabled is not null
      and effective_include_thread_titles is not null
      and effective_max_threads is not null
      and effective_max_concurrent_turns is not null
      and effective_permission_mode is not null
      and effective_approval_mode is not null
    )
  );

alter table public.ai_connection_bridge_settings
  drop constraint if exists
    ai_connection_bridge_settings_status_group;
alter table public.ai_connection_bridge_settings
  add constraint ai_connection_bridge_settings_status_group
  check (
    (
      applied_at is null
      and applied_version is null
      and effective_enabled is null
      and effective_include_thread_titles is null
      and effective_max_threads is null
      and effective_max_concurrent_turns is null
      and effective_permission_mode is null
      and effective_approval_mode is null
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
      and effective_permission_mode is not null
      and effective_approval_mode is not null
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
  );

-- Canonical payloads now carry the Web-owned safety modes for both desired
-- and applied states.
create or replace function public._bridge_configuration_payload(
  p_connection_id uuid,
  p_platform text
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
      'platform', settings.platform,
      'version', settings.version,
      'desired', jsonb_build_object(
        'enabled', settings.desired_enabled,
        'include_thread_titles', settings.desired_include_thread_titles,
        'max_threads', settings.desired_max_threads,
        'max_concurrent_turns', settings.desired_max_concurrent_turns,
        'sync_history', settings.desired_sync_history,
        'history_turn_limit', settings.desired_history_turn_limit,
        'working_directories', settings.desired_working_directories,
        'permission_mode', settings.desired_permission_mode,
        'approval_mode', settings.desired_approval_mode
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
              'working_directories', settings.effective_working_directories,
              'permission_mode', settings.effective_permission_mode,
              'approval_mode', settings.effective_approval_mode
            ) end,
          'constraints', jsonb_build_object(
            'remote_configuration_enabled',
              settings.constraint_remote_configuration_enabled,
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
          settings.active_runtime_lease_expires_at > clock_timestamp(),
          false
        ),
        'lease_expires_at', settings.active_runtime_lease_expires_at
      ),
      'updated_at', settings.updated_at
    )
  )
  from public.ai_connection_bridge_settings settings
  where settings.connection_id = p_connection_id
    and settings.platform = public._canonical_bridge_platform(p_platform);
$$;

create or replace function public._bridge_configuration_payload(
  p_connection_id uuid
)
returns jsonb
language sql
volatile
security definer
set search_path = pg_catalog, public
as $$
  select public._bridge_configuration_payload(
    p_connection_id,
    (
      select public._canonical_bridge_platform(connection.platform)
      from public.ai_connections connection
      where connection.id = p_connection_id
    )
  );
$$;

revoke all on function public._bridge_configuration_payload(uuid, text)
from public, anon, authenticated;
revoke all on function public._bridge_configuration_payload(uuid)
from public, anon, authenticated;

-- New overload for the Owner update. The previous signature stays available
-- during a rolling deployment; callers that omit the two new fields keep the
-- device-owned values untouched.
create function public.update_ai_connection_bridge_config(
  p_workspace_id uuid,
  p_user_id uuid,
  p_connection_id uuid,
  p_platform text,
  p_expected_version integer,
  p_enabled boolean,
  p_include_thread_titles boolean,
  p_max_threads integer,
  p_max_concurrent_turns integer,
  p_sync_history boolean,
  p_history_turn_limit integer,
  p_working_directories jsonb,
  p_permission_mode text,
  p_approval_mode text,
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
  v_platform text := public._canonical_bridge_platform(p_platform);
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
       p_permission_mode is not null
       and p_permission_mode not in ('safe', 'inherit', 'danger-full-access')
     )
     or (
       p_approval_mode is not null
       and p_approval_mode not in ('decline', 'accept', 'accept-session')
     )
     or (
       v_platform = 'codex'
       and (p_permission_mode is null or p_approval_mode is null)
     )
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

  insert into public.ai_connection_bridge_settings (
    connection_id, workspace_id, platform
  ) values (
    p_connection_id, p_workspace_id, v_platform
  ) on conflict (connection_id, platform) do nothing;

  select settings.version into v_current_version
  from public.ai_connection_bridge_settings settings
  where settings.workspace_id = p_workspace_id
    and settings.connection_id = p_connection_id
    and settings.platform = v_platform
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
      desired_permission_mode = case
        when v_platform = 'codex' then p_permission_mode
        else null
      end,
      desired_approval_mode = case
        when v_platform = 'codex' then p_approval_mode
        else null
      end,
      updated_at = clock_timestamp()
  where workspace_id = p_workspace_id
    and connection_id = p_connection_id
    and platform = v_platform;

  v_response := public._bridge_configuration_payload(p_connection_id, v_platform);
  perform public._idempotency_finish(
    p_workspace_id, 'user:' || p_user_id::text,
    p_idempotency_key, v_response
  );
  return v_response;
end;
$$;

revoke all on function public.update_ai_connection_bridge_config(
  uuid, uuid, uuid, text, integer, boolean, boolean, integer, integer,
  boolean, integer, jsonb, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.update_ai_connection_bridge_config(
  uuid, uuid, uuid, text, integer, boolean, boolean, integer, integer,
  boolean, integer, jsonb, text, text, text, text
) to service_role;

-- Extend the platform-scoped exchange core to accept and persist the
-- Web-owned safety modes. Older Bridges omit them; their effective values
-- fall back to the device-reported constraint values.
create or replace function public._exchange_ai_connection_bridge_config_platform(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_api_token_hash text,
  p_platform text,
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
  v_platform text := coalesce(
    public._canonical_bridge_platform(p_platform),
    (
      select public._canonical_bridge_platform(connection.platform)
      from public.ai_connections connection
      where connection.id = p_connection_id
    ),
    'codex'
  );
  v_settings public.ai_connection_bridge_settings%rowtype;
  v_runtime public.ai_connection_bridge_runtimes%rowtype;
  v_runtime_exists boolean := false;
  v_effective jsonb;
  v_constraints jsonb;
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
     or (p_effective is not null and jsonb_typeof(p_effective) <> 'object')
     or octet_length(coalesce(p_effective, 'null'::jsonb)::text)
        + octet_length(p_constraints::text)
        + octet_length(coalesce(p_error, '')) > 1179648
     or (p_error is not null and length(p_error) > 2000) then
    perform public._raise('INVALID_BRIDGE_CONFIG');
  end if;

  -- Normalize missing report fields exactly like the previous wrapper so old
  -- Bridges keep working against the newer DTO shape. The safety modes fall
  -- back to the device-reported constraints.
  v_effective := case when p_effective is null then null else
    jsonb_build_object(
      'sync_history', false,
      'history_turn_limit', 50,
      'working_directories', null,
      'permission_mode', p_constraints -> 'permission_mode',
      'approval_mode', p_constraints -> 'approval_mode'
    ) || p_effective
  end;
  v_constraints := jsonb_build_object(
    'allow_history_sync', false,
    'max_history_turns', 50,
    'allow_working_directory_configuration', false
  ) || p_constraints;

  if v_effective is not null and (
    (select count(*) from jsonb_object_keys(v_effective)) <> 9
    or exists (
      select 1 from jsonb_object_keys(v_effective) field_name
      where field_name not in (
        'enabled', 'include_thread_titles', 'max_threads',
        'max_concurrent_turns', 'sync_history', 'history_turn_limit',
        'working_directories', 'permission_mode', 'approval_mode'
      )
    )
    or jsonb_typeof(v_effective -> 'enabled') <> 'boolean'
    or jsonb_typeof(v_effective -> 'include_thread_titles') <> 'boolean'
    or jsonb_typeof(v_effective -> 'max_threads') <> 'number'
    or jsonb_typeof(v_effective -> 'max_concurrent_turns') <> 'number'
    or jsonb_typeof(v_effective -> 'sync_history') <> 'boolean'
    or jsonb_typeof(v_effective -> 'history_turn_limit') <> 'number'
    or jsonb_typeof(v_effective -> 'working_directories')
       not in ('array', 'null')
    or jsonb_typeof(v_effective -> 'permission_mode') <> 'string'
    or jsonb_typeof(v_effective -> 'approval_mode') <> 'string'
    or v_effective ->> 'permission_mode'
       not in ('safe', 'inherit', 'danger-full-access')
    or v_effective ->> 'approval_mode'
       not in ('decline', 'accept', 'accept-session')
    or (v_effective ->> 'max_threads')::numeric
       <> trunc((v_effective ->> 'max_threads')::numeric)
    or (v_effective ->> 'max_threads')::numeric not between 1 and 500
    or (v_effective ->> 'max_concurrent_turns')::numeric
       <> trunc((v_effective ->> 'max_concurrent_turns')::numeric)
    or (v_effective ->> 'max_concurrent_turns')::numeric
       not between 1 and 32
    or (v_effective ->> 'history_turn_limit')::numeric
       <> trunc((v_effective ->> 'history_turn_limit')::numeric)
    or (v_effective ->> 'history_turn_limit')::numeric not between 1 and 500
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
     or jsonb_typeof(v_constraints -> 'remote_configuration_enabled')
        <> 'boolean'
     or jsonb_typeof(v_constraints -> 'allow_thread_titles') <> 'boolean'
     or jsonb_typeof(v_constraints -> 'max_threads') <> 'number'
     or jsonb_typeof(v_constraints -> 'max_concurrent_turns') <> 'number'
     or jsonb_typeof(v_constraints -> 'thread_scope') <> 'string'
     or jsonb_typeof(v_constraints -> 'working_directory') <> 'string'
     or jsonb_typeof(v_constraints -> 'fixed_thread') <> 'boolean'
     or jsonb_typeof(v_constraints -> 'permission_mode') <> 'string'
     or jsonb_typeof(v_constraints -> 'approval_mode') <> 'string'
     or jsonb_typeof(v_constraints -> 'allow_history_sync') <> 'boolean'
     or jsonb_typeof(v_constraints -> 'max_history_turns') <> 'number'
     or jsonb_typeof(v_constraints -> 'allow_working_directory_configuration')
        <> 'boolean'
     or (v_constraints ->> 'max_threads')::numeric
        <> trunc((v_constraints ->> 'max_threads')::numeric)
     or (v_constraints ->> 'max_threads')::numeric not between 1 and 500
     or (v_constraints ->> 'max_concurrent_turns')::numeric
        <> trunc((v_constraints ->> 'max_concurrent_turns')::numeric)
     or (v_constraints ->> 'max_concurrent_turns')::numeric
        not between 1 and 32
     or (v_constraints ->> 'max_history_turns')::numeric
        <> trunc((v_constraints ->> 'max_history_turns')::numeric)
     or (v_constraints ->> 'max_history_turns')::numeric not between 1 and 500
     or v_constraints ->> 'thread_scope' not in ('cwd', 'all')
     or length(v_constraints ->> 'working_directory') > 4096
     or v_constraints ->> 'permission_mode'
        not in ('safe', 'inherit', 'danger-full-access')
     or v_constraints ->> 'approval_mode'
        not in ('decline', 'accept', 'accept-session') then
    perform public._raise('INVALID_BRIDGE_CONFIG');
  end if;

  -- The locally effective values must fit inside the reported immutable
  -- device envelope.
  if v_effective is not null and (
    (v_effective ->> 'max_threads')::integer
      > (v_constraints ->> 'max_threads')::integer
    or (v_effective ->> 'max_concurrent_turns')::integer
      > (v_constraints ->> 'max_concurrent_turns')::integer
    or (v_effective ->> 'history_turn_limit')::integer
      > (v_constraints ->> 'max_history_turns')::integer
    or (
      (v_effective ->> 'include_thread_titles')::boolean
      and not (v_constraints ->> 'allow_thread_titles')::boolean
    )
  ) then
    perform public._raise('INVALID_BRIDGE_CONFIG');
  end if;

  -- A unified connection creates platform rows lazily: the first exchange of
  -- a Bridge kind is also the moment its settings row comes into existence.
  insert into public.ai_connection_bridge_settings (
    connection_id, workspace_id, platform
  ) values (
    p_connection_id, p_workspace_id, v_platform
  ) on conflict (connection_id, platform) do nothing;

  -- Serialize every status decision for this connection/platform. The
  -- runtime lease and sequence fence prevent an older process from rolling
  -- status back after another Bridge process has taken over.
  select settings.* into v_settings
  from public.ai_connection_bridge_settings settings
  where settings.workspace_id = p_workspace_id
    and settings.connection_id = p_connection_id
    and settings.platform = v_platform
  for update;
  if not found then
    perform public._raise('SESSION_NOT_AUTHORIZED');
  end if;

  select runtime.* into v_runtime
  from public.ai_connection_bridge_runtimes runtime
  where runtime.connection_id = p_connection_id
    and runtime.platform = v_platform
    and runtime.runtime_instance_id = p_runtime_instance_id;
  v_runtime_exists := found;

  if v_runtime_exists and v_runtime.retired_at is not null then
    if p_release_runtime or (
      v_settings.active_runtime_instance_id = p_runtime_instance_id
      and p_report_sequence <= v_settings.active_runtime_last_sequence
    ) then
      return public._bridge_configuration_payload(p_connection_id, v_platform);
    end if;
    perform public._raise('BRIDGE_INSTANCE_CONFLICT');
  end if;

  if p_release_runtime then
    if v_settings.active_runtime_instance_id is null then
      return public._bridge_configuration_payload(p_connection_id, v_platform);
    end if;

    if v_settings.active_runtime_instance_id <> p_runtime_instance_id then
      insert into public.ai_connection_bridge_runtimes (
        workspace_id, connection_id, platform, runtime_instance_id,
        last_report_sequence, retired_at, updated_at
      ) values (
        p_workspace_id, p_connection_id, v_platform, p_runtime_instance_id,
        p_report_sequence, v_now, v_now
      )
      on conflict (connection_id, platform, runtime_instance_id) do update
      set last_report_sequence = greatest(
            public.ai_connection_bridge_runtimes.last_report_sequence,
            excluded.last_report_sequence
          ),
          retired_at = coalesce(
            public.ai_connection_bridge_runtimes.retired_at, v_now
          ),
          updated_at = v_now;
      return public._bridge_configuration_payload(p_connection_id, v_platform);
    end if;

    if p_report_sequence <= v_settings.active_runtime_last_sequence then
      return public._bridge_configuration_payload(p_connection_id, v_platform);
    end if;

    insert into public.ai_connection_bridge_runtimes (
      workspace_id, connection_id, platform, runtime_instance_id,
      last_report_sequence, retired_at, updated_at
    ) values (
      p_workspace_id, p_connection_id, v_platform, p_runtime_instance_id,
      p_report_sequence, v_now, v_now
    )
    on conflict (connection_id, platform, runtime_instance_id) do update
    set last_report_sequence = excluded.last_report_sequence,
        retired_at = v_now,
        updated_at = v_now;

    update public.ai_connection_bridge_settings
    set active_runtime_instance_id = p_runtime_instance_id,
        active_runtime_last_sequence = p_report_sequence,
        active_runtime_lease_expires_at = v_now
    where workspace_id = p_workspace_id
      and connection_id = p_connection_id
      and platform = v_platform;
    return public._bridge_configuration_payload(p_connection_id, v_platform);
  end if;

  if v_settings.active_runtime_instance_id = p_runtime_instance_id then
    if p_report_sequence <= v_settings.active_runtime_last_sequence then
      return public._bridge_configuration_payload(p_connection_id, v_platform);
    end if;
  elsif v_settings.active_runtime_instance_id is not null then
    if v_settings.active_runtime_lease_expires_at > v_now then
      perform public._raise('BRIDGE_INSTANCE_CONFLICT');
    end if;

    insert into public.ai_connection_bridge_runtimes (
      workspace_id, connection_id, platform, runtime_instance_id,
      last_report_sequence, retired_at, updated_at
    ) values (
      p_workspace_id, p_connection_id, v_platform,
      v_settings.active_runtime_instance_id,
      v_settings.active_runtime_last_sequence, v_now, v_now
    )
    on conflict (connection_id, platform, runtime_instance_id) do update
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
    workspace_id, connection_id, platform, runtime_instance_id,
    last_report_sequence, retired_at, updated_at
  ) values (
    p_workspace_id, p_connection_id, v_platform, p_runtime_instance_id,
    p_report_sequence, null, v_now
  )
  on conflict (connection_id, platform, runtime_instance_id) do update
  set last_report_sequence = excluded.last_report_sequence,
      updated_at = v_now
  where public.ai_connection_bridge_runtimes.retired_at is null;

  update public.ai_connection_bridge_settings
  set applied_version = p_applied_version,
      effective_enabled = case when v_effective is null then null
        else (v_effective ->> 'enabled')::boolean end,
      effective_include_thread_titles = case when v_effective is null then null
        else (v_effective ->> 'include_thread_titles')::boolean end,
      effective_max_threads = case when v_effective is null then null
        else (v_effective ->> 'max_threads')::integer end,
      effective_max_concurrent_turns = case when v_effective is null then null
        else (v_effective ->> 'max_concurrent_turns')::integer end,
      effective_sync_history = case when v_effective is null then null
        else (v_effective ->> 'sync_history')::boolean end,
      effective_history_turn_limit = case when v_effective is null then null
        else (v_effective ->> 'history_turn_limit')::integer end,
      effective_permission_mode = case when v_effective is null then null
        else v_effective ->> 'permission_mode' end,
      effective_approval_mode = case when v_effective is null then null
        else v_effective ->> 'approval_mode' end,
      effective_working_directories = case
        when v_effective is null
          or v_effective -> 'working_directories' = 'null'::jsonb then null
        else v_effective -> 'working_directories'
      end,
      constraint_remote_configuration_enabled =
        (v_constraints ->> 'remote_configuration_enabled')::boolean,
      constraint_allow_thread_titles =
        (v_constraints ->> 'allow_thread_titles')::boolean,
      constraint_max_threads = (v_constraints ->> 'max_threads')::integer,
      constraint_max_concurrent_turns =
        (v_constraints ->> 'max_concurrent_turns')::integer,
      constraint_thread_scope = v_constraints ->> 'thread_scope',
      constraint_working_directory = v_constraints ->> 'working_directory',
      constraint_fixed_thread = (v_constraints ->> 'fixed_thread')::boolean,
      constraint_permission_mode = v_constraints ->> 'permission_mode',
      constraint_approval_mode = v_constraints ->> 'approval_mode',
      constraint_allow_history_sync =
        (v_constraints ->> 'allow_history_sync')::boolean,
      constraint_max_history_turns =
        (v_constraints ->> 'max_history_turns')::integer,
      constraint_allow_working_directory_configuration =
        (
          v_constraints ->> 'allow_working_directory_configuration'
        )::boolean,
      error = p_error,
      applied_at = v_now,
      active_runtime_instance_id = p_runtime_instance_id,
      active_runtime_last_sequence = p_report_sequence,
      active_runtime_lease_expires_at =
        v_now + p_lease_seconds * interval '1 second'
  where workspace_id = p_workspace_id
    and connection_id = p_connection_id
    and platform = v_platform;

  return public._bridge_configuration_payload(p_connection_id, v_platform);
end;
$$;

revoke all on function public._exchange_ai_connection_bridge_config_platform(
  uuid, uuid, text, text, uuid, bigint, integer, boolean,
  integer, jsonb, jsonb, text
) from public, anon, authenticated;
