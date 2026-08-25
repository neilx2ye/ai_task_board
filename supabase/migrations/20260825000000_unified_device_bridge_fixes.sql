-- Corrective follow-up for the unified device Bridge migration.

-- 1) The original directory table declared a connection-wide unique
-- constraint whose generated name exceeds PostgreSQL's 63-byte identifier
-- limit and was therefore truncated on disk. The earlier migration dropped
-- the full (untruncated) name, which silently matched nothing. Remove the
-- surviving constraint by pattern so Codex/Kimi/Antigravity/Claude can each
-- own a directory row with the same key under one unified connection.
do $$
declare
  v_constraint text;
begin
  select constraint_name into v_constraint
  from information_schema.table_constraints
  where table_schema = 'public'
    and table_name = 'ai_bridge_directories'
    and constraint_type = 'UNIQUE'
    and constraint_name like
      'ai_bridge_directories_workspace_id_connection_id_directory%';
  if v_constraint is not null then
    execute format(
      'alter table public.ai_bridge_directories drop constraint %I',
      v_constraint
    );
  end if;
end;
$$;

-- 2) Session inventory omission must be scoped to the reporting runtime.
-- Under one unified connection, a Kimi snapshot with no Kimi Sessions must
-- not take the connection's Codex Sessions offline. The legacy signature
-- keeps connection-wide omission for single-platform installs.
create or replace function public.sync_ai_sessions(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_api_token_hash text,
  p_bridge_version text,
  p_platform text,
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
  v_item jsonb;
  v_external_ref text;
  v_name text;
  v_platform text;
  v_model text;
  v_working_directory text;
  v_capabilities text[];
  v_archived boolean;
  v_refs text[] := '{}'::text[];
  v_session_id uuid;
  v_sessions jsonb := '[]'::jsonb;
begin
  perform public._assert_active_connection(
    p_workspace_id, p_connection_id, p_api_token_hash
  );

  if nullif(btrim(p_idempotency_key), '') is null
     or length(p_idempotency_key) > 300
     or nullif(btrim(p_request_hash), '') is null
     or length(p_request_hash) < 16 then
    perform public._raise('INVALID_IDEMPOTENCY_KEY');
  end if;

  if nullif(btrim(p_bridge_version), '') is null
     or length(p_bridge_version) > 100
     or p_threads is null
     or jsonb_typeof(p_threads) <> 'array' then
    perform public._raise('INVALID_SESSION');
  end if;

  if jsonb_array_length(p_threads) > 500
     or octet_length(p_threads::text) > 1048576 then
    perform public._raise('INVALID_SESSION');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('thread-inventory:' || p_connection_id::text, 0)
  );

  for v_item in select value from jsonb_array_elements(p_threads)
  loop
    if jsonb_typeof(v_item) <> 'object'
       or exists (
         select 1
         from jsonb_object_keys(v_item) as field_name
         where field_name not in (
           'external_conversation_ref', 'name', 'platform', 'model',
           'working_directory', 'capabilities', 'archived'
         )
       )
       or jsonb_typeof(v_item -> 'external_conversation_ref') <> 'string'
       or jsonb_typeof(v_item -> 'name') <> 'string'
       or (
         v_item ? 'platform'
         and jsonb_typeof(v_item -> 'platform') <> 'string'
       )
       or (
         v_item ? 'model'
         and jsonb_typeof(v_item -> 'model') not in ('string', 'null')
       )
       or (
         v_item ? 'working_directory'
         and jsonb_typeof(v_item -> 'working_directory') not in ('string', 'null')
       )
       or (
         v_item ? 'capabilities'
         and jsonb_typeof(v_item -> 'capabilities') <> 'array'
       )
       or (
         v_item ? 'archived'
         and jsonb_typeof(v_item -> 'archived') <> 'boolean'
       ) then
      perform public._raise('INVALID_SESSION');
    end if;

    v_external_ref := nullif(btrim(v_item ->> 'external_conversation_ref'), '');
    v_name := nullif(btrim(v_item ->> 'name'), '');
    v_platform := coalesce(nullif(btrim(v_item ->> 'platform'), ''), 'codex');
    v_model := nullif(btrim(v_item ->> 'model'), '');
    v_working_directory := nullif(btrim(v_item ->> 'working_directory'), '');
    v_archived := coalesce((v_item ->> 'archived')::boolean, false);

    if v_external_ref is null
       or length(v_external_ref) > 500
       or v_external_ref = any(v_refs)
       or v_name is null
       or length(v_name) > 200
       or length(v_platform) > 100
       or (v_model is not null and length(v_model) > 200)
       or (
         v_working_directory is not null
         and length(v_working_directory) > 4096
       )
       or jsonb_array_length(coalesce(v_item -> 'capabilities', '[]'::jsonb)) > 100
       or exists (
         select 1
         from jsonb_array_elements(
           coalesce(v_item -> 'capabilities', '[]'::jsonb)
         ) as capability(value)
         where jsonb_typeof(capability.value) <> 'string'
           or length(btrim(capability.value #>> '{}')) not between 1 and 100
       ) then
      perform public._raise('INVALID_SESSION');
    end if;

    select coalesce(
      array_agg(btrim(capability.value) order by capability.ordinality),
      '{}'::text[]
    )
    into v_capabilities
    from jsonb_array_elements_text(
      coalesce(v_item -> 'capabilities', '[]'::jsonb)
    ) with ordinality as capability(value, ordinality);

    v_refs := array_append(v_refs, v_external_ref);

    insert into public.ai_sessions (
      workspace_id, connection_id, name, platform, model,
      external_conversation_ref, capabilities, status, last_seen_at,
      working_directory, archived_at, inventory_active
    ) values (
      p_workspace_id, p_connection_id, v_name, v_platform, v_model,
      v_external_ref, v_capabilities,
      case when v_archived then 'offline'::public.ai_session_status
           else 'online'::public.ai_session_status end,
      v_now, v_working_directory,
      case when v_archived then v_now else null end,
      not v_archived
    )
    on conflict (connection_id, external_conversation_ref)
      where external_conversation_ref is not null
    do update set
      name = excluded.name,
      platform = excluded.platform,
      model = excluded.model,
      capabilities = excluded.capabilities,
      working_directory = excluded.working_directory,
      archived_at = case
        when excluded.archived_at is not null
          then coalesce(public.ai_sessions.archived_at, excluded.archived_at)
        else null
      end,
      inventory_active = excluded.inventory_active,
      status = case
        when excluded.archived_at is not null
          then 'offline'::public.ai_session_status
        when public.ai_sessions.current_task_id is not null
          then 'busy'::public.ai_session_status
        when exists (
          select 1
          from public.tasks waiting
          where waiting.assigned_session_id = public.ai_sessions.id
            and waiting.status = 'waiting_user'
        ) then 'waiting'::public.ai_session_status
        else 'online'::public.ai_session_status
      end,
      last_seen_at = v_now
    returning id into v_session_id;

    v_sessions := v_sessions || jsonb_build_array(
      public._session_payload(v_session_id)
    );
  end loop;

  -- The snapshot is authoritative for this runtime kind. Missing rows stay in
  -- the database so conversation history and future thread rediscovery retain
  -- the same Board session id; they simply stop accepting new Web turns.
  update public.ai_sessions session
  set status = 'offline',
      inventory_active = false
  where session.workspace_id = p_workspace_id
    and session.connection_id = p_connection_id
    and (
      p_platform is null
      or session.platform = public._canonical_bridge_platform(p_platform)
    )
    and (
      cardinality(v_refs) = 0
      or session.external_conversation_ref is null
      or not (session.external_conversation_ref = any(v_refs))
    );

  update public.ai_connections
  set last_seen_at = v_now,
      last_used_at = greatest(coalesce(last_used_at, v_now), v_now),
      bridge_version = btrim(p_bridge_version)
  where workspace_id = p_workspace_id
    and id = p_connection_id
    and revoked_at is null;

  if not found then
    perform public._raise('SESSION_NOT_AUTHORIZED');
  end if;

  return jsonb_build_object(
    'connection', public._connection_payload(p_connection_id),
    'sessions', v_sessions
  );
end;
$$;

create or replace function public.sync_ai_sessions(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_api_token_hash text,
  p_bridge_version text,
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
begin
  return public.sync_ai_sessions(
    p_workspace_id, p_connection_id, p_api_token_hash, p_bridge_version,
    null, p_threads, p_idempotency_key, p_request_hash
  );
end;
$$;

revoke all on function public.sync_ai_sessions(
  uuid, uuid, text, text, text, jsonb, text, text
) from public, anon, authenticated;
grant execute on function public.sync_ai_sessions(
  uuid, uuid, text, text, text, jsonb, text, text
) to service_role;
revoke all on function public.sync_ai_sessions(
  uuid, uuid, text, text, jsonb, text, text
) from public, anon, authenticated;
grant execute on function public.sync_ai_sessions(
  uuid, uuid, text, text, jsonb, text, text
) to service_role;

-- 3) Route the platform-scoped directory sync into the platform-scoped
-- session sync so one runtime's snapshot never affects the others.
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
      v_platform, v_legacy_threads, p_idempotency_key, p_request_hash
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
    v_platform, v_legacy_threads, p_idempotency_key, p_request_hash
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

revoke all on function public.sync_ai_sessions_with_directories(
  uuid, uuid, text, text, text, jsonb, jsonb, text, text
) from public, anon, authenticated;
grant execute on function public.sync_ai_sessions_with_directories(
  uuid, uuid, text, text, text, jsonb, jsonb, text, text
) to service_role;
