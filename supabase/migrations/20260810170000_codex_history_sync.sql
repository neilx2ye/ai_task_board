-- Runtime-fenced, bounded Codex history import and Bridge 0.4 configuration.
-- Historical rows join the canonical session timeline without manufacturing a
-- Board task or mirroring into task_messages.

-- Add a source timeline rather than ordering by insertion id: an old event
-- imported today must not displace a live event from the newest page.
drop trigger if exists session_activities_immutable
on public.session_activities;

alter table public.session_activities
  add column if not exists occurred_at timestamptz,
  add column if not exists source_order bigint,
  add column if not exists source text;

update public.session_activities
set occurred_at = coalesce(occurred_at, created_at),
    source_order = coalesce(source_order, id),
    source = coalesce(source, 'live');

alter table public.session_activities
  alter column occurred_at set default now(),
  alter column occurred_at set not null,
  alter column source_order set default 0,
  alter column source_order set not null,
  alter column source set default 'live',
  alter column source set not null,
  add constraint session_activities_source_check
    check (source in ('live', 'codex_history')),
  add constraint session_activities_source_order_check
    check (source_order between 0 and 9007199254740991),
  add constraint session_activities_history_shape_check
    check (
      source <> 'codex_history'
      or (
        task_id is null
        and task_message_id is null
        and kind in ('user_message', 'assistant_message', 'reasoning')
        and external_ref is not null
      )
    );

create trigger session_activities_immutable
before update on public.session_activities
for each row execute function public._reject_session_activity_mutation();

drop index if exists public.session_activities_session_timeline_idx;
create index session_activities_session_timeline_idx
  on public.session_activities (
    workspace_id, session_id, occurred_at desc, source_order desc, id desc
  );
create index session_activities_history_count_idx
  on public.session_activities (session_id)
  where source = 'codex_history';

comment on column public.session_activities.occurred_at is
  'Source event time. Historical imports preserve Codex turn time; live rows default to insertion time.';
comment on column public.session_activities.source_order is
  'Stable source-side tie breaker within one event time. id remains the final total-order tie breaker.';
comment on column public.session_activities.source is
  'live for the existing realtime stream; codex_history for an explicitly authorized history snapshot.';

create table public.session_history_syncs (
  workspace_id uuid not null,
  connection_id uuid not null,
  session_id uuid not null,
  runtime_instance_id uuid not null,
  report_sequence bigint not null
    check (report_sequence between 1 and 9007199254740991),
  request_hash text not null
    check (request_hash ~ '^[0-9a-f]{32}$'),
  status text not null
    check (status in ('syncing', 'partial', 'complete', 'failed')),
  turn_limit integer not null check (turn_limit between 1 and 500),
  scanned_turns integer not null default 0
    check (scanned_turns between 0 and 500 and scanned_turns <= turn_limit),
  total_turns integer check (
    total_turns between 0 and 1000000 and total_turns >= scanned_turns
  ),
  imported_items integer not null default 0 check (imported_items >= 0),
  next_cursor text check (
    next_cursor is null or length(next_cursor) between 1 and 2000
  ),
  error text check (error is null or length(error) between 1 and 2000),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (session_id),
  unique (workspace_id, session_id),
  constraint session_history_syncs_session_fk
    foreign key (workspace_id, session_id)
    references public.ai_sessions(workspace_id, id) on delete cascade,
  constraint session_history_syncs_connection_fk
    foreign key (workspace_id, connection_id)
    references public.ai_connections(workspace_id, id) on delete cascade,
  constraint session_history_syncs_terminal_check check (
    (status = 'syncing' and completed_at is null and error is null)
    or (status in ('partial', 'complete') and completed_at is not null and error is null)
    or (status = 'failed' and completed_at is not null and error is not null)
  ),
  constraint session_history_syncs_complete_cursor_check
    check (status <> 'complete' or next_cursor is null)
);

comment on table public.session_history_syncs is
  'Latest bounded Codex history snapshot status for each session. Imported activities remain append-only.';

alter table public.session_history_syncs enable row level security;
create policy session_history_syncs_member_select
on public.session_history_syncs
for select to authenticated
using (public.is_workspace_member(workspace_id));

grant all privileges on table public.session_history_syncs to service_role;
revoke all on table public.session_history_syncs
from public, anon, authenticated;
-- Runtime generation, sequence, and request hash are internal fences.
-- Workspace clients only receive the public status projection needed by UI.
grant select (
  workspace_id, connection_id, session_id, status, turn_limit,
  scanned_turns, total_turns, imported_items, next_cursor, error,
  started_at, completed_at, updated_at
) on table public.session_history_syncs to authenticated;

-- Keep every accepted runtime/sequence request fingerprint for the lifetime of
-- the session. The latest-status row above is intentionally mutable and cannot
-- prove an old sequence is the same request after a newer report supersedes it.
create table public.session_history_import_requests (
  workspace_id uuid not null,
  connection_id uuid not null,
  session_id uuid not null,
  runtime_instance_id uuid not null,
  report_sequence bigint not null
    check (report_sequence between 1 and 9007199254740991),
  request_hash text not null
    check (request_hash ~ '^[0-9a-f]{32}$'),
  created_at timestamptz not null default now(),
  primary key (session_id, runtime_instance_id, report_sequence),
  constraint session_history_import_requests_session_fk
    foreign key (workspace_id, session_id)
    references public.ai_sessions(workspace_id, id) on delete cascade,
  constraint session_history_import_requests_connection_fk
    foreign key (workspace_id, connection_id)
    references public.ai_connections(workspace_id, id) on delete cascade
);

comment on table public.session_history_import_requests is
  'Service-only request ledger binding every Codex runtime report sequence to its complete canonical payload fingerprint.';

alter table public.session_history_import_requests enable row level security;
grant all privileges on table public.session_history_import_requests
to service_role;
revoke all on table public.session_history_import_requests
from public, anon, authenticated;

-- Desired history sync is off on upgrade. Existing Bridge 0.3 applied rows are
-- backfilled to an explicit fail-closed effective/local state.
alter table public.ai_connection_bridge_settings
  add column desired_sync_history boolean not null default false,
  add column desired_history_turn_limit integer not null default 50
    check (desired_history_turn_limit between 1 and 500),
  add column effective_sync_history boolean,
  add column effective_history_turn_limit integer
    check (effective_history_turn_limit between 1 and 500),
  add column constraint_allow_history_sync boolean,
  add column constraint_max_history_turns integer
    check (constraint_max_history_turns between 1 and 500);

update public.ai_connection_bridge_settings
set effective_sync_history = false,
    effective_history_turn_limit = 50,
    constraint_allow_history_sync = false,
    constraint_max_history_turns = 50
where applied_at is not null;

alter table public.ai_connection_bridge_settings
  add constraint ai_connection_bridge_settings_history_effective_group
    check (
      (effective_sync_history is null and effective_history_turn_limit is null)
      or
      (effective_sync_history is not null and effective_history_turn_limit is not null)
    ),
  add constraint ai_connection_bridge_settings_history_status_empty_group
    check (
      applied_at is not null
      or (
        effective_sync_history is null
        and effective_history_turn_limit is null
        and constraint_allow_history_sync is null
        and constraint_max_history_turns is null
      )
    );

-- One canonical DTO is shared by the owner Web API and token-authenticated
-- Bridge exchange endpoint.
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
        'history_turn_limit', settings.desired_history_turn_limit
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
              'history_turn_limit', settings.effective_history_turn_limit
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
            'max_history_turns', settings.constraint_max_history_turns
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

-- New optimistic owner update overload. The former four-field overload stays
-- callable during a rolling Web deployment and preserves history settings.
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
     or p_history_turn_limit not between 1 and 500 then
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

revoke all on function public.update_ai_connection_bridge_config(
  uuid, uuid, uuid, integer, boolean, boolean, integer, integer,
  boolean, integer, text, text
) from public, anon, authenticated;
grant execute on function public.update_ai_connection_bridge_config(
  uuid, uuid, uuid, integer, boolean, boolean, integer, integer,
  boolean, integer, text, text
) to service_role;

-- Retain the proven 0.3 lease/tombstone state machine behind a private name.
-- The 0.4 wrapper supplies fail-closed defaults for old 4/9-field reports and
-- writes the two new field groups only when that state machine accepted a new
-- report sequence.
alter function public.exchange_ai_connection_bridge_config(
  uuid, uuid, text, uuid, bigint, integer, boolean,
  integer, jsonb, jsonb, text
) rename to _exchange_ai_connection_bridge_config_v3;

revoke all on function public._exchange_ai_connection_bridge_config_v3(
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
      'history_turn_limit', 50
    ) || p_effective
  end;
  v_constraints := jsonb_build_object(
    'allow_history_sync', false,
    'max_history_turns', 50
  ) || coalesce(p_constraints, '{}'::jsonb);

  if p_constraints is null
     or jsonb_typeof(p_constraints) <> 'object'
     or (p_effective is not null and jsonb_typeof(p_effective) <> 'object')
     or octet_length(coalesce(p_effective, 'null'::jsonb)::text)
        + octet_length(p_constraints::text)
        + octet_length(coalesce(p_error, '')) > 32768 then
    perform public._raise('INVALID_BRIDGE_CONFIG');
  end if;

  if v_effective is not null and (
    (select count(*) from jsonb_object_keys(v_effective)) <> 6
    or exists (
      select 1 from jsonb_object_keys(v_effective) field_name
      where field_name not in (
        'enabled', 'include_thread_titles', 'max_threads',
        'max_concurrent_turns', 'sync_history', 'history_turn_limit'
      )
    )
    or jsonb_typeof(v_effective -> 'sync_history') <> 'boolean'
    or jsonb_typeof(v_effective -> 'history_turn_limit') <> 'number'
    or (v_effective ->> 'history_turn_limit')::numeric
       <> trunc((v_effective ->> 'history_turn_limit')::numeric)
    or (v_effective ->> 'history_turn_limit')::numeric not between 1 and 500
  ) then
    perform public._raise('INVALID_BRIDGE_CONFIG');
  end if;

  if (select count(*) from jsonb_object_keys(v_constraints)) <> 11
     or exists (
       select 1 from jsonb_object_keys(v_constraints) field_name
       where field_name not in (
         'remote_configuration_enabled', 'allow_thread_titles',
         'max_threads', 'max_concurrent_turns', 'thread_scope',
         'working_directory', 'fixed_thread', 'permission_mode',
         'approval_mode', 'allow_history_sync', 'max_history_turns'
       )
     )
     or jsonb_typeof(v_constraints -> 'allow_history_sync') <> 'boolean'
     or jsonb_typeof(v_constraints -> 'max_history_turns') <> 'number'
     or (v_constraints ->> 'max_history_turns')::numeric
        <> trunc((v_constraints ->> 'max_history_turns')::numeric)
     or (v_constraints ->> 'max_history_turns')::numeric not between 1 and 500
     or (
       v_effective is not null
       and (
         (v_effective ->> 'history_turn_limit')::integer
           > (v_constraints ->> 'max_history_turns')::integer
         or (
           (v_effective ->> 'sync_history')::boolean
           and not (v_constraints ->> 'allow_history_sync')::boolean
         )
       )
     ) then
    perform public._raise('INVALID_BRIDGE_CONFIG');
  end if;

  -- Match the legacy exchange lock order (active connection, settings row),
  -- and keep the row locked through both parts of the one transaction.
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

  perform public._exchange_ai_connection_bridge_config_v3(
    p_workspace_id, p_connection_id, p_api_token_hash,
    p_runtime_instance_id, p_report_sequence, p_lease_seconds,
    p_release_runtime, p_applied_version,
    case when v_effective is null then null else
      v_effective - 'sync_history' - 'history_turn_limit'
    end,
    v_constraints - 'allow_history_sync' - 'max_history_turns',
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
    set effective_sync_history = case when v_effective is null then null
          else (v_effective ->> 'sync_history')::boolean end,
        effective_history_turn_limit = case when v_effective is null then null
          else (v_effective ->> 'history_turn_limit')::integer end,
        constraint_allow_history_sync =
          (v_constraints ->> 'allow_history_sync')::boolean,
        constraint_max_history_turns =
          (v_constraints ->> 'max_history_turns')::integer
    where workspace_id = p_workspace_id
      and connection_id = p_connection_id;
  end if;

  return public._bridge_configuration_payload(p_connection_id);
end;
$$;

revoke all on function public.exchange_ai_connection_bridge_config(
  uuid, uuid, text, uuid, bigint, integer, boolean,
  integer, jsonb, jsonb, text
) from public, anon, authenticated;
grant execute on function public.exchange_ai_connection_bridge_config(
  uuid, uuid, text, uuid, bigint, integer, boolean,
  integer, jsonb, jsonb, text
) to service_role;

-- Import a whole page atomically. Stable external_ref values are the row-level
-- idempotency key: identical replay succeeds, any changed field conflicts and
-- rolls back the complete batch and status update.
create function public.import_session_history(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_api_token_hash text,
  p_session_id uuid,
  p_runtime_instance_id uuid,
  p_report_sequence bigint,
  p_items jsonb,
  p_sync jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_thread_ref text;
  v_settings public.ai_connection_bridge_settings%rowtype;
  v_item jsonb;
  v_existing public.session_activities%rowtype;
  v_inserted integer := 0;
  v_replayed integer := 0;
  v_imported_items integer;
  v_sync public.session_history_syncs%rowtype;
  v_sync_found boolean := false;
  v_request_hash text;
  v_ledger_request_hash text;
  v_actor public.actor_type;
begin
  perform public._assert_active_session(
    p_workspace_id, p_connection_id, p_api_token_hash, p_session_id
  );

  if p_runtime_instance_id is null
     or p_report_sequence is null
     or p_report_sequence not between 1 and 9007199254740991
     or p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) > 100
     or octet_length(p_items::text) > 524288
     or p_sync is null or jsonb_typeof(p_sync) <> 'object'
     or octet_length(p_sync::text) > 8192 then
    perform public._raise('INVALID_HISTORY_IMPORT');
  end if;

  if (select count(*) from jsonb_object_keys(p_sync)) <> 6
     or exists (
       select 1 from jsonb_object_keys(p_sync) field_name
       where field_name not in (
         'status', 'turn_limit', 'scanned_turns', 'total_turns',
         'next_cursor', 'error'
       )
     )
     or jsonb_typeof(p_sync -> 'status') <> 'string'
     or p_sync ->> 'status'
        not in ('syncing', 'partial', 'complete', 'failed')
     or jsonb_typeof(p_sync -> 'turn_limit') <> 'number'
     or jsonb_typeof(p_sync -> 'scanned_turns') <> 'number'
     or jsonb_typeof(p_sync -> 'total_turns') not in ('number', 'null')
     or jsonb_typeof(p_sync -> 'next_cursor') not in ('string', 'null')
     or jsonb_typeof(p_sync -> 'error') not in ('string', 'null') then
    perform public._raise('INVALID_HISTORY_IMPORT');
  end if;

  if (p_sync ->> 'turn_limit')::numeric
       <> trunc((p_sync ->> 'turn_limit')::numeric)
     or (p_sync ->> 'turn_limit')::numeric not between 1 and 500
     or (p_sync ->> 'scanned_turns')::numeric
       <> trunc((p_sync ->> 'scanned_turns')::numeric)
     or (p_sync ->> 'scanned_turns')::numeric not between 0 and 500
     or (p_sync ->> 'scanned_turns')::integer
       > (p_sync ->> 'turn_limit')::integer
     or (
       p_sync -> 'total_turns' <> 'null'::jsonb
       and (
         (p_sync ->> 'total_turns')::numeric
           <> trunc((p_sync ->> 'total_turns')::numeric)
         or (p_sync ->> 'total_turns')::numeric not between 0 and 1000000
         or (p_sync ->> 'total_turns')::integer
           < (p_sync ->> 'scanned_turns')::integer
       )
     )
     or (
       p_sync -> 'next_cursor' <> 'null'::jsonb
       and length(p_sync ->> 'next_cursor') not between 1 and 2000
     )
     or (
       p_sync -> 'error' <> 'null'::jsonb
       and length(p_sync ->> 'error') not between 1 and 2000
     )
     or (p_sync ->> 'status' = 'failed')
       <> (p_sync -> 'error' <> 'null'::jsonb)
     or (
       p_sync ->> 'status' = 'complete'
       and p_sync -> 'next_cursor' <> 'null'::jsonb
     ) then
    perform public._raise('INVALID_HISTORY_IMPORT');
  end if;

  -- Serialize with config exchange/takeover. The inventory advisory fence is
  -- already held by _assert_active_session, so thread ownership cannot change
  -- while this transaction validates or inserts the snapshot.
  select settings.* into v_settings
  from public.ai_connection_bridge_settings settings
  where settings.workspace_id = p_workspace_id
    and settings.connection_id = p_connection_id
  for update;
  if not found then
    perform public._raise('SESSION_NOT_AUTHORIZED');
  end if;
  if v_settings.active_runtime_instance_id
       is distinct from p_runtime_instance_id
     or v_settings.active_runtime_lease_expires_at is null
     or v_settings.active_runtime_lease_expires_at <= v_now then
    perform public._raise('BRIDGE_INSTANCE_CONFLICT');
  end if;
  if v_settings.applied_version is distinct from v_settings.version
     or v_settings.effective_enabled is distinct from true
     or v_settings.desired_sync_history is distinct from true
     or v_settings.effective_sync_history is distinct from true
     or v_settings.constraint_allow_history_sync is distinct from true
     or v_settings.effective_history_turn_limit is null
     or v_settings.constraint_max_history_turns is null
     or (p_sync ->> 'turn_limit')::integer
       <> v_settings.effective_history_turn_limit
     or (p_sync ->> 'turn_limit')::integer
       > v_settings.desired_history_turn_limit
     or (p_sync ->> 'turn_limit')::integer
       > v_settings.constraint_max_history_turns then
    perform public._raise('HISTORY_SYNC_NOT_ALLOWED');
  end if;

  -- Global lock order for history writes is: active-connection advisory,
  -- inventory advisory, settings row, then this per-session advisory. The
  -- final fence makes SELECT -> INSERT row idempotency safe even if settings
  -- locking is later relaxed to permit parallel sessions on one device.
  perform pg_advisory_xact_lock(
    hashtextextended('session-history:' || p_session_id::text, 0)
  );

  -- jsonb text has deterministic key ordering while arrays retain their
  -- source order, so this binds one runtime sequence to the complete payload.
  -- MD5 is only an equality fingerprint under the session lock, not an
  -- authentication or authorization primitive.
  v_request_hash := pg_catalog.md5(
    jsonb_build_object('items', p_items, 'sync', p_sync)::text
  );

  -- Reserve or verify the immutable request identity before inspecting or
  -- writing any activity. Unlike the latest status row, this ledger retains
  -- old sequences after a newer report advances the public sync state.
  insert into public.session_history_import_requests (
    workspace_id, connection_id, session_id,
    runtime_instance_id, report_sequence, request_hash, created_at
  ) values (
    p_workspace_id, p_connection_id, p_session_id,
    p_runtime_instance_id, p_report_sequence, v_request_hash, v_now
  )
  on conflict (session_id, runtime_instance_id, report_sequence) do nothing;

  select request.request_hash into v_ledger_request_hash
  from public.session_history_import_requests request
  where request.session_id = p_session_id
    and request.runtime_instance_id = p_runtime_instance_id
    and request.report_sequence = p_report_sequence;
  if v_ledger_request_hash is distinct from v_request_hash then
    perform public._raise('IDEMPOTENCY_CONFLICT');
  end if;

  select status.* into v_sync
  from public.session_history_syncs status
  where status.session_id = p_session_id
  for update;
  v_sync_found := found;
  if v_sync_found
     and v_sync.runtime_instance_id = p_runtime_instance_id
     and v_sync.report_sequence = p_report_sequence
     and v_sync.request_hash is distinct from v_request_hash then
    perform public._raise('IDEMPOTENCY_CONFLICT');
  end if;

  select session.external_conversation_ref into v_thread_ref
  from public.ai_sessions session
  where session.workspace_id = p_workspace_id
    and session.connection_id = p_connection_id
    and session.id = p_session_id;
  if nullif(btrim(v_thread_ref), '') is null then
    perform public._raise('HISTORY_SYNC_NOT_ALLOWED');
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_items) entry(item)
    where jsonb_typeof(item) <> 'object'
  ) then
    perform public._raise('INVALID_HISTORY_IMPORT');
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_items) entry(item)
    where (select count(*) from jsonb_object_keys(item)) <> 6
       or exists (
         select 1 from jsonb_object_keys(item) field_name
         where field_name not in (
           'external_ref', 'kind', 'content', 'occurred_at',
           'source_order', 'data'
         )
       )
  ) then
    perform public._raise('INVALID_HISTORY_IMPORT');
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_items) entry(item)
    where jsonb_typeof(item -> 'external_ref') <> 'string'
       or length(btrim(item ->> 'external_ref')) not between 1 and 500
       or item ->> 'external_ref' <> btrim(item ->> 'external_ref')
       or jsonb_typeof(item -> 'kind') <> 'string'
       or item ->> 'kind'
          not in ('user_message', 'assistant_message', 'reasoning')
       or jsonb_typeof(item -> 'content') <> 'string'
       or length(btrim(item ->> 'content')) < 1
       or length(item ->> 'content') > 50000
       or jsonb_typeof(item -> 'occurred_at') <> 'string'
       or jsonb_typeof(item -> 'source_order') <> 'number'
       or jsonb_typeof(item -> 'data') <> 'object'
  ) then
    perform public._raise('INVALID_HISTORY_IMPORT');
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_items) entry(item)
    where octet_length((item -> 'data')::text) > 4096
       or (select count(*) from jsonb_object_keys(item -> 'data')) <> 4
       or exists (
         select 1 from jsonb_object_keys(item -> 'data') field_name
         where field_name not in ('protocol', 'thread_id', 'turn_id', 'item_id')
       )
       or item #>> '{data,protocol}' <> 'codex-app-server/v1'
       or jsonb_typeof(item #> '{data,thread_id}') <> 'string'
       or length(item #>> '{data,thread_id}') not between 1 and 500
       or item #>> '{data,thread_id}' <> btrim(item #>> '{data,thread_id}')
       or jsonb_typeof(item #> '{data,turn_id}') <> 'string'
       or length(item #>> '{data,turn_id}') not between 1 and 500
       or item #>> '{data,turn_id}' <> btrim(item #>> '{data,turn_id}')
       or jsonb_typeof(item #> '{data,item_id}') <> 'string'
       or length(item #>> '{data,item_id}') not between 1 and 500
       or item #>> '{data,item_id}' <> btrim(item #>> '{data,item_id}')
       or item #>> '{data,thread_id}' <> v_thread_ref
  ) then
    perform public._raise('INVALID_HISTORY_IMPORT');
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_items) entry(item)
    where (item ->> 'source_order')::numeric
            <> trunc((item ->> 'source_order')::numeric)
       or (item ->> 'source_order')::numeric
            not between 0 and 9007199254740991
       or (item ->> 'occurred_at') !~
            '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
       or (item ->> 'occurred_at')::timestamptz
            not between '1970-01-01 00:00:00+00'::timestamptz
                and v_now + interval '5 minutes'
  ) then
    perform public._raise('INVALID_HISTORY_IMPORT');
  end if;

  if (
    select count(*) <> count(distinct item ->> 'external_ref')
    from jsonb_array_elements(p_items) entry(item)
  ) then
    perform public._raise('INVALID_HISTORY_IMPORT');
  end if;

  for v_item in select item from jsonb_array_elements(p_items) entry(item)
  loop
    select activity.* into v_existing
    from public.session_activities activity
    where activity.workspace_id = p_workspace_id
      and activity.session_id = p_session_id
      and activity.external_ref = v_item ->> 'external_ref';

    v_actor := case when v_item ->> 'kind' = 'user_message'
      then 'user'::public.actor_type else 'ai'::public.actor_type end;

    if found then
      if v_existing.task_id is not null
         or v_existing.task_message_id is not null
         or v_existing.kind is distinct from (v_item ->> 'kind')
         or v_existing.actor_type is distinct from v_actor
         or v_existing.content is distinct from (v_item ->> 'content')
         or v_existing.data is distinct from v_item -> 'data'
         or v_existing.occurred_at is distinct from
              (v_item ->> 'occurred_at')::timestamptz
         or v_existing.source_order is distinct from
              (v_item ->> 'source_order')::bigint
         or v_existing.source is distinct from 'codex_history' then
        perform public._raise('IDEMPOTENCY_CONFLICT');
      end if;
      v_replayed := v_replayed + 1;
    else
      insert into public.session_activities (
        workspace_id, session_id, task_id, task_message_id,
        kind, actor_type, content, data, external_ref,
        occurred_at, source_order, source
      ) values (
        p_workspace_id, p_session_id, null, null,
        v_item ->> 'kind', v_actor, v_item ->> 'content',
        v_item -> 'data', v_item ->> 'external_ref',
        (v_item ->> 'occurred_at')::timestamptz,
        (v_item ->> 'source_order')::bigint, 'codex_history'
      );
      v_inserted := v_inserted + 1;
    end if;
  end loop;

  select count(*)::integer into v_imported_items
  from public.session_activities activity
  where activity.workspace_id = p_workspace_id
    and activity.session_id = p_session_id
    and activity.source = 'codex_history';

  if not v_sync_found then
    insert into public.session_history_syncs (
      workspace_id, connection_id, session_id,
      runtime_instance_id, report_sequence, request_hash,
      status, turn_limit, scanned_turns, total_turns, imported_items,
      next_cursor, error, started_at, completed_at, updated_at
    ) values (
      p_workspace_id, p_connection_id, p_session_id,
      p_runtime_instance_id, p_report_sequence, v_request_hash,
      p_sync ->> 'status', (p_sync ->> 'turn_limit')::integer,
      (p_sync ->> 'scanned_turns')::integer,
      case when p_sync -> 'total_turns' = 'null'::jsonb then null
        else (p_sync ->> 'total_turns')::integer end,
      v_imported_items,
      nullif(p_sync ->> 'next_cursor', ''),
      nullif(p_sync ->> 'error', ''),
      v_now,
      case when p_sync ->> 'status' = 'syncing' then null else v_now end,
      v_now
    ) returning * into v_sync;
  elsif v_sync.runtime_instance_id = p_runtime_instance_id
        and v_sync.report_sequence = p_report_sequence then
    -- The pre-write payload-hash check proved this is the same full request.
    if v_sync.imported_items is distinct from v_imported_items then
      update public.session_history_syncs
      set imported_items = v_imported_items,
          updated_at = v_now
      where session_id = p_session_id
      returning * into v_sync;
    end if;
  elsif v_sync.runtime_instance_id = p_runtime_instance_id
        and p_report_sequence < v_sync.report_sequence then
    -- A late page may still contain previously unseen immutable activities.
    -- Reflect that factual count, but never roll the public sync state back.
    if v_sync.imported_items is distinct from v_imported_items then
      update public.session_history_syncs
      set imported_items = v_imported_items,
          updated_at = v_now
      where session_id = p_session_id
      returning * into v_sync;
    end if;
  else
    -- A newer sequence advances the current generation. A different runtime
    -- can only reach this branch while it owns the active, unexpired settings
    -- lease checked above, so it starts a fresh status generation.
    update public.session_history_syncs
    set connection_id = p_connection_id,
        runtime_instance_id = p_runtime_instance_id,
        report_sequence = p_report_sequence,
        request_hash = v_request_hash,
        status = p_sync ->> 'status',
        turn_limit = (p_sync ->> 'turn_limit')::integer,
        scanned_turns = (p_sync ->> 'scanned_turns')::integer,
        total_turns = case
          when p_sync -> 'total_turns' = 'null'::jsonb then null
          else (p_sync ->> 'total_turns')::integer end,
        imported_items = v_imported_items,
        next_cursor = nullif(p_sync ->> 'next_cursor', ''),
        error = nullif(p_sync ->> 'error', ''),
        started_at = case
          when v_sync.runtime_instance_id <> p_runtime_instance_id then v_now
          when v_sync.status in ('partial', 'complete', 'failed')
               and p_sync ->> 'status' = 'syncing' then v_now
          else v_sync.started_at
        end,
        completed_at = case
          when p_sync ->> 'status' = 'syncing' then null else v_now end,
        updated_at = v_now
    where session_id = p_session_id
    returning * into v_sync;
  end if;

  return jsonb_build_object(
    'imported', jsonb_build_object(
      'inserted', v_inserted,
      'replayed', v_replayed
    ),
    'history_sync', to_jsonb(v_sync)
      - 'workspace_id' - 'connection_id' - 'session_id'
      - 'runtime_instance_id' - 'report_sequence' - 'request_hash'
  );
end;
$$;

comment on function public.import_session_history(
  uuid, uuid, text, uuid, uuid, bigint, jsonb, jsonb
) is
  'Imports a bounded, runtime-fenced Codex history page without a task claim or task_messages mirror.';

revoke all on function public.import_session_history(
  uuid, uuid, text, uuid, uuid, bigint, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.import_session_history(
  uuid, uuid, text, uuid, uuid, bigint, jsonb, jsonb
) to service_role;

grant select (
  desired_sync_history, desired_history_turn_limit,
  effective_sync_history, effective_history_turn_limit,
  constraint_allow_history_sync, constraint_max_history_turns
) on table public.ai_connection_bridge_settings to authenticated;

do $$
begin
  if exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) and not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'session_history_syncs'
  ) then
    alter publication supabase_realtime add table
      public.session_history_syncs (
        workspace_id, connection_id, session_id, status, turn_limit,
        scanned_turns, total_turns, imported_items, next_cursor, error,
        started_at, completed_at, updated_at
      );
  end if;
end;
$$;
