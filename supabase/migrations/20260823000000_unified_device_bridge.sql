-- Unified device Bridge: one ai_connections row and token per device user now
-- hosts every Bridge runtime. The per-connection settings/lease state becomes
-- platform-scoped so Codex, Kimi, Antigravity and Claude Code each keep their
-- own effective configuration, quota snapshot, model catalog and lease while
-- sharing a single connection token.

create or replace function public._canonical_bridge_platform(p_platform text)
returns text
language sql
immutable
strict
set search_path = pg_catalog
as $$
  select case
    when lower(trim(p_platform)) in ('codex', 'codex app server')
      then 'codex'
    when lower(trim(p_platform)) like '%kimi%' then 'kimi'
    when lower(trim(p_platform)) like '%antigravity%' then 'antigravity'
    when lower(trim(p_platform)) like '%claude%' then 'claude'
    when lower(trim(p_platform)) = 'all' then 'codex'
    else lower(btrim(p_platform))
  end;
$$;

revoke all on function public._canonical_bridge_platform(text)
from public, anon, authenticated;

-- 1) Scope the settings table by platform and backfill existing rows with the
-- canonical kind of their owning connection.
alter table public.ai_connection_bridge_settings
  add column if not exists platform text;

update public.ai_connection_bridge_settings settings
set platform = public._canonical_bridge_platform(connection.platform)
from public.ai_connections connection
where settings.workspace_id = connection.workspace_id
  and settings.connection_id = connection.id
  and (settings.platform is null or btrim(settings.platform) = '');

alter table public.ai_connection_bridge_settings
  alter column platform set default 'codex',
  alter column platform set not null,
  drop constraint if exists ai_connection_bridge_settings_platform_shape,
  add constraint ai_connection_bridge_settings_platform_shape
    check (length(btrim(platform)) between 1 and 100);

comment on column public.ai_connection_bridge_settings.platform is
  'Canonical Bridge runtime kind (codex, kimi, antigravity, claude) that owns this settings row; a unified device connection keeps one row per kind.';

-- 2) Give runtime lease tombstones the same platform dimension.
alter table public.ai_connection_bridge_runtimes
  add column if not exists platform text;

update public.ai_connection_bridge_runtimes runtime
set platform = settings.platform
from public.ai_connection_bridge_settings settings
where runtime.workspace_id = settings.workspace_id
  and runtime.connection_id = settings.connection_id
  and (runtime.platform is null or btrim(runtime.platform) = '');

alter table public.ai_connection_bridge_runtimes
  alter column platform set default 'codex',
  alter column platform set not null,
  drop constraint if exists ai_connection_bridge_runtimes_platform_shape,
  add constraint ai_connection_bridge_runtimes_platform_shape
    check (length(btrim(platform)) between 1 and 100);

comment on column public.ai_connection_bridge_runtimes.platform is
  'Canonical Bridge runtime kind that owned this lease generation.';

-- 3) Drop the runtime tombstones' old linkage first: its foreign key depends
-- on the connection-scoped settings uniqueness being replaced next.
alter table public.ai_connection_bridge_runtimes
  drop constraint if exists ai_connection_bridge_runtimes_settings_fk,
  drop constraint if exists ai_connection_bridge_runtimes_pkey;

drop index if exists public.ai_connection_bridge_runtimes_active_uidx;

-- 4) Re-key settings: primary key and uniqueness become per platform, while
-- the connection foreign key is unchanged.
alter table public.ai_connection_bridge_settings
  drop constraint if exists ai_connection_bridge_settings_pkey,
  drop constraint if exists
    ai_connection_bridge_settings_workspace_id_connection_id_key;

alter table public.ai_connection_bridge_settings
  add constraint ai_connection_bridge_settings_pkey
    primary key (connection_id, platform),
  add constraint ai_connection_bridge_settings_workspace_connection_platform_key
    unique (workspace_id, connection_id, platform);

-- 5) Re-key runtime tombstones onto the new settings uniqueness.
alter table public.ai_connection_bridge_runtimes
  add constraint ai_connection_bridge_runtimes_pkey
    primary key (connection_id, platform, runtime_instance_id),
  add constraint ai_connection_bridge_runtimes_settings_fk
    foreign key (workspace_id, connection_id, platform)
    references public.ai_connection_bridge_settings(
      workspace_id, connection_id, platform
    )
    on delete cascade;

create unique index ai_connection_bridge_runtimes_active_uidx
  on public.ai_connection_bridge_runtimes (connection_id, platform)
  where retired_at is null;

-- 6) New connections: create the canonical settings row. A unified "All"
-- connection starts with a codex row; other kinds are created lazily on the
-- first configuration exchange so future Bridge kinds never need a schema
-- migration.
create or replace function public._create_ai_connection_bridge_settings()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  insert into public.ai_connection_bridge_settings (
    connection_id, workspace_id, platform
  ) values (
    new.id, new.workspace_id, public._canonical_bridge_platform(new.platform)
  ) on conflict (connection_id, platform) do nothing;
  return new;
end;
$$;

revoke all on function public._create_ai_connection_bridge_settings()
from public, anon, authenticated;

-- 7) Token rotation retires every active lease generation, now carrying the
-- platform of each settings row.
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
      workspace_id, connection_id, platform, runtime_instance_id,
      last_report_sequence, retired_at, updated_at
    )
    select settings.workspace_id, settings.connection_id, settings.platform,
           settings.active_runtime_instance_id,
           settings.active_runtime_last_sequence, v_now, v_now
    from public.ai_connection_bridge_settings settings
    where settings.workspace_id = new.workspace_id
      and settings.connection_id = new.id
      and settings.active_runtime_instance_id is not null
    on conflict (connection_id, platform, runtime_instance_id) do update
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

-- 8) Canonical payload for one settings row. The single-argument overload
-- keeps any straggling internal caller on the connection's canonical kind.
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
          settings.active_runtime_lease_expires_at > clock_timestamp(), false
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
    public._canonical_bridge_platform(
      (
        select connection.platform
        from public.ai_connections connection
        where connection.id = p_connection_id
      )
    )
  );
$$;

revoke all on function public._bridge_configuration_payload(uuid, text)
from public, anon, authenticated;
revoke all on function public._bridge_configuration_payload(uuid)
from public, anon, authenticated;

-- 9) Platform-scoped exchange core: merges the lease/sequence state machine
-- with the fail-closed history and Web-managed-directory normalization, and
-- accepts the explicit danger-full-access permission profile directly.
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

  -- Normalize missing report fields exactly like the previous wrappers so old
  -- Bridges keep working against the newer DTO shape.
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
  ) || p_constraints;

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
    or jsonb_typeof(v_effective -> 'enabled') <> 'boolean'
    or jsonb_typeof(v_effective -> 'include_thread_titles') <> 'boolean'
    or jsonb_typeof(v_effective -> 'max_threads') <> 'number'
    or jsonb_typeof(v_effective -> 'max_concurrent_turns') <> 'number'
    or jsonb_typeof(v_effective -> 'sync_history') <> 'boolean'
    or jsonb_typeof(v_effective -> 'history_turn_limit') <> 'number'
    or jsonb_typeof(v_effective -> 'working_directories')
       not in ('array', 'null')
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
      -- A release from an old/non-owner runtime is a visible no-op and never
      -- clears the current writer. Retire an unseen id internally so one of
      -- its delayed reports cannot acquire after a later generation exits.
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

    -- Retain an expired settings-row tombstone. A lower-sequence request that
    -- reached PostgreSQL after this release is therefore a no-op, while a new
    -- runtime may take over immediately.
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
      -- Network retries and delayed reports are successful no-ops. They do
      -- not renew the lease or replace the last applied DTO.
      return public._bridge_configuration_payload(p_connection_id, v_platform);
    end if;
  elsif v_settings.active_runtime_instance_id is not null then
    if v_settings.active_runtime_lease_expires_at > v_now then
      perform public._raise('BRIDGE_INSTANCE_CONFLICT');
    end if;

    -- Expiry permits takeover but permanently retires the former generation.
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

-- 10) Public exchange overloads. The legacy signature resolves the platform
-- from the connection so pre-1.7 Bridges keep working; the new signature
-- carries the explicit runtime kind from a unified device Bridge.
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
  v_platform text;
begin
  select public._canonical_bridge_platform(connection.platform)
  into v_platform
  from public.ai_connections connection
  where connection.id = p_connection_id;
  return public._exchange_ai_connection_bridge_config_platform(
    p_workspace_id, p_connection_id, p_api_token_hash, v_platform,
    p_runtime_instance_id, p_report_sequence, p_lease_seconds,
    p_release_runtime, p_applied_version, p_effective, p_constraints, p_error
  );
end;
$$;

create or replace function public.exchange_ai_connection_bridge_config(
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
begin
  return public._exchange_ai_connection_bridge_config_platform(
    p_workspace_id, p_connection_id, p_api_token_hash, p_platform,
    p_runtime_instance_id, p_report_sequence, p_lease_seconds,
    p_release_runtime, p_applied_version, p_effective, p_constraints, p_error
  );
end;
$$;

comment on function public.exchange_ai_connection_bridge_config(
  uuid, uuid, text, text, uuid, bigint, integer, boolean,
  integer, jsonb, jsonb, text
) is
  'Exchanges one runtime-fenced, platform-scoped Bridge status for its current desired configuration.';

revoke all on function public.exchange_ai_connection_bridge_config(
  uuid, uuid, text, uuid, bigint, integer, boolean,
  integer, jsonb, jsonb, text
) from public, anon, authenticated;
grant execute on function public.exchange_ai_connection_bridge_config(
  uuid, uuid, text, uuid, bigint, integer, boolean,
  integer, jsonb, jsonb, text
) to service_role;
revoke all on function public.exchange_ai_connection_bridge_config(
  uuid, uuid, text, text, uuid, bigint, integer, boolean,
  integer, jsonb, jsonb, text
) from public, anon, authenticated;
grant execute on function public.exchange_ai_connection_bridge_config(
  uuid, uuid, text, text, uuid, bigint, integer, boolean,
  integer, jsonb, jsonb, text
) to service_role;

-- 11) Owner-only desired-configuration update, now targeting one platform row
-- of the connection. The legacy signature keeps the previous behavior for
-- single-platform connections.
create or replace function public.update_ai_connection_bridge_config(
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

create or replace function public.update_ai_connection_bridge_config(
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
  v_platform text;
begin
  select public._canonical_bridge_platform(connection.platform)
  into v_platform
  from public.ai_connections connection
  where connection.id = p_connection_id;
  return public.update_ai_connection_bridge_config(
    p_workspace_id, p_user_id, p_connection_id, v_platform,
    p_expected_version, p_enabled, p_include_thread_titles, p_max_threads,
    p_max_concurrent_turns, p_sync_history, p_history_turn_limit,
    p_working_directories, p_idempotency_key, p_request_hash
  );
end;
$$;

comment on function public.update_ai_connection_bridge_config(
  uuid, uuid, uuid, text, integer, boolean, boolean, integer, integer,
  boolean, integer, jsonb, text, text
) is
  'Owner-only idempotent optimistic update for one platform-scoped Bridge configuration.';

revoke all on function public.update_ai_connection_bridge_config(
  uuid, uuid, uuid, text, integer, boolean, boolean, integer, integer,
  boolean, integer, jsonb, text, text
) from public, anon, authenticated;
grant execute on function public.update_ai_connection_bridge_config(
  uuid, uuid, uuid, text, integer, boolean, boolean, integer, integer,
  boolean, integer, jsonb, text, text
) to service_role;
revoke all on function public.update_ai_connection_bridge_config(
  uuid, uuid, uuid, integer, boolean, boolean, integer, integer,
  boolean, integer, jsonb, text, text
) from public, anon, authenticated;
grant execute on function public.update_ai_connection_bridge_config(
  uuid, uuid, uuid, integer, boolean, boolean, integer, integer,
  boolean, integer, jsonb, text, text
) to service_role;

-- 12) Canonicalize Session platforms so directory and thread-command foreign
-- keys can share one platform dimension across runtimes.
update public.ai_sessions session
set platform = public._canonical_bridge_platform(session.platform)
where session.platform <> public._canonical_bridge_platform(session.platform);

-- 13) Scope device-reported working directories by runtime kind. A unified
-- connection keeps one directory row per (kind, key) while the Web still sees
-- a single merged project view across the device.
alter table public.ai_bridge_directories
  add column if not exists platform text;

update public.ai_bridge_directories directory
set platform = public._canonical_bridge_platform(connection.platform)
from public.ai_connections connection
where directory.workspace_id = connection.workspace_id
  and directory.connection_id = connection.id
  and (directory.platform is null or btrim(directory.platform) = '');

alter table public.ai_bridge_directories
  alter column platform set default 'codex',
  alter column platform set not null,
  drop constraint if exists ai_bridge_directories_platform_shape,
  add constraint ai_bridge_directories_platform_shape
    check (length(btrim(platform)) between 1 and 100);

comment on column public.ai_bridge_directories.platform is
  'Canonical Bridge runtime kind that reported this working-directory row.';

alter table public.ai_sessions
  drop constraint if exists ai_sessions_bridge_directory_fk;
alter table public.ai_thread_commands
  drop constraint if exists ai_thread_commands_directory_fk;

alter table public.ai_bridge_directories
  drop constraint if exists ai_bridge_directories_pkey,
  drop constraint if exists
    ai_bridge_directories_workspace_id_connection_id_directory_key_key,
  drop constraint if exists
    ai_bridge_directories_connection_id_working_directory_key;

alter table public.ai_bridge_directories
  add constraint ai_bridge_directories_pkey
    primary key (connection_id, platform, directory_key),
  add constraint ai_bridge_directories_workspace_connection_platform_key_key
    unique (workspace_id, connection_id, platform, directory_key),
  add constraint ai_bridge_directories_connection_platform_path_key
    unique (connection_id, platform, working_directory);

alter table public.ai_sessions
  add constraint ai_sessions_bridge_directory_fk
    foreign key (workspace_id, connection_id, platform, bridge_directory_key)
    references public.ai_bridge_directories(
      workspace_id, connection_id, platform, directory_key
    );

-- 14) Scope Web thread commands by runtime kind so a Kimi runtime never claims
-- a Codex create/rename/delete command under a unified connection.
alter table public.ai_thread_commands
  add column if not exists platform text;

update public.ai_thread_commands command
set platform = coalesce(
  (
    select public._canonical_bridge_platform(session.platform)
    from public.ai_sessions session
    where session.workspace_id = command.workspace_id
      and session.id = command.session_id
  ),
  (
    select public._canonical_bridge_platform(connection.platform)
    from public.ai_connections connection
    where connection.workspace_id = command.workspace_id
      and connection.id = command.connection_id
  ),
  'codex'
)
where command.platform is null or btrim(command.platform) = '';

alter table public.ai_thread_commands
  alter column platform set default 'codex',
  alter column platform set not null,
  drop constraint if exists ai_thread_commands_platform_shape,
  add constraint ai_thread_commands_platform_shape
    check (length(btrim(platform)) between 1 and 100);

comment on column public.ai_thread_commands.platform is
  'Canonical Bridge runtime kind that owns this Web thread command.';

alter table public.ai_thread_commands
  add constraint ai_thread_commands_directory_fk
    foreign key (workspace_id, connection_id, platform, directory_key)
    references public.ai_bridge_directories(
      workspace_id, connection_id, platform, directory_key
    );

-- 15) The directory inventory sync is platform-scoped. Old Bridges keep the
-- legacy signature and resolve their platform from the connection.
create or replace function public.sync_ai_sessions_with_directories(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_api_token_hash text,
  p_bridge_version text,
  p_platform text,
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
  v_platform text := coalesce(
    public._canonical_bridge_platform(p_platform),
    (
      select public._canonical_bridge_platform(connection.platform)
      from public.ai_connections connection
      where connection.id = p_connection_id
    ),
    'codex'
  );
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
           and directory.platform = v_platform
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
      workspace_id, connection_id, platform, directory_key, name,
      working_directory, inventory_active, last_seen_at
    ) values (
      p_workspace_id, p_connection_id, v_platform, v_directory_key,
      v_directory_name, v_working_directory, true, v_now
    )
    on conflict (connection_id, platform, directory_key) do update set
      name = excluded.name,
      working_directory = excluded.working_directory,
      inventory_active = true,
      last_seen_at = excluded.last_seen_at;
  end loop;

  update public.ai_bridge_directories directory
  set inventory_active = false
  where directory.workspace_id = p_workspace_id
    and directory.connection_id = p_connection_id
    and directory.platform = v_platform
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
      and session.platform = public._canonical_bridge_platform(
        v_thread ->> 'platform'
      )
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
  v_platform text;
begin
  select public._canonical_bridge_platform(connection.platform)
  into v_platform
  from public.ai_connections connection
  where connection.id = p_connection_id;
  return public.sync_ai_sessions_with_directories(
    p_workspace_id, p_connection_id, p_api_token_hash, p_bridge_version,
    v_platform, p_directories, p_threads, p_idempotency_key, p_request_hash
  );
end;
$$;

revoke all on function public.sync_ai_sessions_with_directories(
  uuid, uuid, text, text, text, jsonb, jsonb, text, text
) from public, anon, authenticated;
grant execute on function public.sync_ai_sessions_with_directories(
  uuid, uuid, text, text, text, jsonb, jsonb, text, text
) to service_role;
revoke all on function public.sync_ai_sessions_with_directories(
  uuid, uuid, text, text, jsonb, jsonb, text, text
) from public, anon, authenticated;
grant execute on function public.sync_ai_sessions_with_directories(
  uuid, uuid, text, text, jsonb, jsonb, text, text
) to service_role;

-- 16) Enqueue and claim Web thread commands with an explicit runtime kind.
create or replace function public.enqueue_ai_thread_command_with_directory(
  p_workspace_id uuid,
  p_user_id uuid,
  p_command_id uuid,
  p_connection_id uuid,
  p_session_id uuid,
  p_action text,
  p_name text,
  p_directory_key text,
  p_platform text,
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
  v_platform text := coalesce(
    public._canonical_bridge_platform(p_platform),
    (
      select public._canonical_bridge_platform(connection.platform)
      from public.ai_connections connection
      where connection.id = p_connection_id
    ),
    'codex'
  );
begin
  v_result := public.enqueue_ai_thread_command(
    p_workspace_id, p_user_id, p_command_id, p_connection_id,
    p_session_id, p_action, p_name, p_idempotency_key, p_request_hash
  );

  if p_action = 'create' and v_directory_key is not null then
    perform 1
    from public.ai_bridge_directories directory
    where directory.workspace_id = p_workspace_id
      and directory.connection_id = p_connection_id
      and directory.platform = v_platform
      and directory.directory_key = v_directory_key
      and directory.inventory_active;
    if not found then
      perform public._raise('INVALID_THREAD_COMMAND');
    end if;
  elsif p_action <> 'create' and v_directory_key is not null then
    perform public._raise('INVALID_THREAD_COMMAND');
  end if;

  update public.ai_thread_commands command
  set directory_key = case
        when p_action = 'create' then v_directory_key
        else directory_key
      end,
      platform = case
        when command.session_id is null then v_platform
        else (
          select public._canonical_bridge_platform(session.platform)
          from public.ai_sessions session
          where session.workspace_id = p_workspace_id
            and session.id = command.session_id
        )
      end
  where command.workspace_id = p_workspace_id
    and command.connection_id = p_connection_id
    and command.id = p_command_id;

  return jsonb_build_object(
    'command', public._thread_command_payload(p_command_id)
  );
end;
$$;

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
  v_platform text;
begin
  select public._canonical_bridge_platform(connection.platform)
  into v_platform
  from public.ai_connections connection
  where connection.id = p_connection_id;
  return public.enqueue_ai_thread_command_with_directory(
    p_workspace_id, p_user_id, p_command_id, p_connection_id, p_session_id,
    p_action, p_name, p_directory_key, v_platform, p_idempotency_key,
    p_request_hash
  );
end;
$$;

revoke all on function public.enqueue_ai_thread_command_with_directory(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.enqueue_ai_thread_command_with_directory(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, text
) to service_role;
revoke all on function public.enqueue_ai_thread_command_with_directory(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.enqueue_ai_thread_command_with_directory(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text, text
) to service_role;

create or replace function public.claim_ai_thread_command(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_api_token_hash text,
  p_runtime_instance_id uuid,
  p_lease_seconds integer,
  p_platform text
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

  update public.ai_thread_commands command
  set status = 'failed',
      lease_expires_at = null,
      error = 'Bridge stopped before confirming Thread creation',
      completed_at = clock_timestamp()
  where command.workspace_id = p_workspace_id
    and command.connection_id = p_connection_id
    and (
      p_platform is null
      or command.platform = public._canonical_bridge_platform(p_platform)
    )
    and command.action = 'create'
    and command.status = 'running'
    and command.lease_expires_at < clock_timestamp();

  select command.id into v_command_id
  from public.ai_thread_commands command
  where command.workspace_id = p_workspace_id
    and command.connection_id = p_connection_id
    and (
      p_platform is null
      or command.platform = public._canonical_bridge_platform(p_platform)
    )
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
begin
  return public.claim_ai_thread_command(
    p_workspace_id, p_connection_id, p_api_token_hash,
    p_runtime_instance_id, p_lease_seconds, null
  );
end;
$$;

revoke all on function public.claim_ai_thread_command(
  uuid, uuid, text, uuid, integer, text
) from public, anon, authenticated;
grant execute on function public.claim_ai_thread_command(
  uuid, uuid, text, uuid, integer, text
) to service_role;
revoke all on function public.claim_ai_thread_command(
  uuid, uuid, text, uuid, integer
) from public, anon, authenticated;
grant execute on function public.claim_ai_thread_command(
  uuid, uuid, text, uuid, integer
) to service_role;

-- 17) The settings-aware enqueue overload forwards the platform choice.
create or replace function public.enqueue_ai_thread_command_with_settings(
  p_workspace_id uuid,
  p_user_id uuid,
  p_command_id uuid,
  p_connection_id uuid,
  p_session_id uuid,
  p_action text,
  p_name text,
  p_directory_key text,
  p_model text,
  p_reasoning_effort text,
  p_platform text,
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
  v_model text := nullif(btrim(p_model), '');
  v_reasoning_effort text := nullif(btrim(p_reasoning_effort), '');
begin
  if p_action in ('create', 'rename') then
    if (v_model is not null and length(v_model) > 200)
       or (
         v_reasoning_effort is not null
         and length(v_reasoning_effort) > 50
       ) then
      perform public._raise('INVALID_THREAD_COMMAND');
    end if;
  elsif v_model is not null or v_reasoning_effort is not null then
    perform public._raise('INVALID_THREAD_COMMAND');
  end if;

  v_result := public.enqueue_ai_thread_command_with_directory(
    p_workspace_id, p_user_id, p_command_id, p_connection_id, p_session_id,
    p_action, p_name, p_directory_key, p_platform, p_idempotency_key,
    p_request_hash
  );

  if p_action in ('create', 'rename') then
    update public.ai_thread_commands command
    set model = v_model,
        reasoning_effort = v_reasoning_effort
    where command.workspace_id = p_workspace_id
      and command.connection_id = p_connection_id
      and command.id = p_command_id;
  end if;

  return jsonb_build_object(
    'command', public._thread_command_payload(p_command_id)
  );
end;
$$;

create or replace function public.enqueue_ai_thread_command_with_settings(
  p_workspace_id uuid,
  p_user_id uuid,
  p_command_id uuid,
  p_connection_id uuid,
  p_session_id uuid,
  p_action text,
  p_name text,
  p_directory_key text,
  p_model text,
  p_reasoning_effort text,
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
  v_platform text;
begin
  select public._canonical_bridge_platform(connection.platform)
  into v_platform
  from public.ai_connections connection
  where connection.id = p_connection_id;
  return public.enqueue_ai_thread_command_with_settings(
    p_workspace_id, p_user_id, p_command_id, p_connection_id, p_session_id,
    p_action, p_name, p_directory_key, p_model, p_reasoning_effort, v_platform,
    p_idempotency_key, p_request_hash
  );
end;
$$;

revoke all on function public.enqueue_ai_thread_command_with_settings(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.enqueue_ai_thread_command_with_settings(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, text, text, text
) to service_role;
revoke all on function public.enqueue_ai_thread_command_with_settings(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.enqueue_ai_thread_command_with_settings(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, text, text
) to service_role;
