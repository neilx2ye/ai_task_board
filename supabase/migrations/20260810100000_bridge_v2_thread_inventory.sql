-- Bridge V2 device presence and full local-thread inventory.
-- A connection represents one installed Bridge device; each session with an
-- external_conversation_ref represents one local Harness thread. Inventory
-- synchronization is a naturally idempotent heartbeat and deliberately does
-- not create a 24-hour idempotency record on every refresh.

alter table public.ai_connections
  add column if not exists last_seen_at timestamptz,
  add column if not exists bridge_version text;

alter table public.ai_sessions
  add column if not exists working_directory text,
  add column if not exists archived_at timestamptz,
  add column if not exists inventory_active boolean not null default true;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'ai_connections_bridge_version_length'
      and conrelid = 'public.ai_connections'::regclass
  ) then
    alter table public.ai_connections
      add constraint ai_connections_bridge_version_length
      check (
        bridge_version is null
        or length(btrim(bridge_version)) between 1 and 100
      );
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'ai_sessions_working_directory_length'
      and conrelid = 'public.ai_sessions'::regclass
  ) then
    alter table public.ai_sessions
      add constraint ai_sessions_working_directory_length
      check (
        working_directory is null
        or length(btrim(working_directory)) between 1 and 4096
      );
  end if;
end;
$$;

-- Any generic cleanup path that derives an idle state must preserve the
-- authoritative inventory/archive fence instead of reviving the row.
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

-- Fence all session-scoped Bridge requests against the authoritative device
-- inventory snapshot. This deliberately uses a connection-level advisory lock
-- instead of locking the session row here: AI commands acquire the workspace
-- task-state lock later, while cancellation/revocation takes task-state before
-- session rows. Taking a row lock in this assertion would invert that order.
--
-- A request that owns the shared fence finishes before a waiting snapshot; the
-- snapshot then wins last. A snapshot that owns the exclusive fence marks an
-- omitted session inactive before a waiting request rechecks this predicate.
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
    and session.archived_at is null;
  if not found then
    perform public._raise('SESSION_NOT_AUTHORIZED');
  end if;
end;
$$;

revoke all on function public._assert_active_session(
  uuid, uuid, text, uuid
) from public, anon, authenticated;

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
     or length(btrim(p_bridge_version)) > 100
     or p_threads is null
     or jsonb_typeof(p_threads) <> 'array' then
    perform public._raise('INVALID_SESSION');
  end if;

  if jsonb_array_length(p_threads) > 500
     or octet_length(p_threads::text) > 1048576 then
    perform public._raise('INVALID_SESSION');
  end if;

  -- One installed Bridge is expected to send snapshots serially. Serialize at
  -- the database boundary as well, so an HTTP retry cannot interleave the
  -- omission pass with another snapshot for the same device.
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

  -- The snapshot is authoritative for this device. Missing rows stay in the
  -- database so conversation history and future thread rediscovery retain the
  -- same Board session id; they simply stop accepting new Web turns.
  update public.ai_sessions session
  set status = 'offline',
      inventory_active = false
  where session.workspace_id = p_workspace_id
    and session.connection_id = p_connection_id
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

comment on function public.sync_ai_sessions(
  uuid, uuid, text, text, jsonb, text, text
) is
  'Atomically refreshes one Bridge device and its complete local-thread inventory; omitted sessions are retained offline and fenced from later writes. A Bridge must finish release_task before its final snapshot omits that thread.';

revoke all on function public.sync_ai_sessions(
  uuid, uuid, text, text, jsonb, text, text
) from public, anon, authenticated;
grant execute on function public.sync_ai_sessions(
  uuid, uuid, text, text, jsonb, text, text
) to service_role;

-- V1 clients announce one session at a time instead of sending a complete
-- inventory. Serialize that announcement with V2 snapshots and reactivate a
-- previously omitted row when its stable external reference returns.
create or replace function public.register_ai_session(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_api_token_hash text,
  p_name text,
  p_platform text,
  p_model text,
  p_external_conversation_ref text,
  p_capabilities text[],
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
  v_session_id uuid;
  v_response jsonb;
begin
  perform public._assert_active_connection(
    p_workspace_id, p_connection_id, p_api_token_hash
  );
  if nullif(btrim(p_name), '') is null or nullif(btrim(p_platform), '') is null then
    perform public._raise('INVALID_SESSION');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('thread-inventory:' || p_connection_id::text, 0)
  );

  v_idempotency := public._idempotency_begin(
    p_workspace_id, 'connection:' || p_connection_id::text,
    p_idempotency_key, 'register_ai_session', p_request_hash
  );
  if v_idempotency ? 'cached_response' then
    return v_idempotency -> 'cached_response';
  end if;

  if nullif(btrim(p_external_conversation_ref), '') is not null then
    insert into public.ai_sessions (
      workspace_id, connection_id, name, platform, model,
      external_conversation_ref, capabilities, status, last_seen_at,
      inventory_active
    ) values (
      p_workspace_id, p_connection_id, btrim(p_name), btrim(p_platform),
      nullif(btrim(p_model), ''), btrim(p_external_conversation_ref),
      coalesce(p_capabilities, '{}'::text[]), 'online', now(), true
    )
    on conflict (connection_id, external_conversation_ref)
      where external_conversation_ref is not null
    do update set
      name = excluded.name,
      platform = excluded.platform,
      model = excluded.model,
      capabilities = excluded.capabilities,
      archived_at = null,
      inventory_active = true,
      status = case
        when public.ai_sessions.current_task_id is null
          and exists (
            select 1
            from public.tasks waiting
            where waiting.assigned_session_id = public.ai_sessions.id
              and waiting.status = 'waiting_user'
          ) then 'waiting'::public.ai_session_status
        when public.ai_sessions.current_task_id is not null
          then 'busy'::public.ai_session_status
        else 'online'::public.ai_session_status
      end,
      last_seen_at = now()
    returning id into v_session_id;
  else
    insert into public.ai_sessions (
      workspace_id, connection_id, name, platform, model,
      capabilities, status, last_seen_at, inventory_active
    ) values (
      p_workspace_id, p_connection_id, btrim(p_name), btrim(p_platform),
      nullif(btrim(p_model), ''), coalesce(p_capabilities, '{}'::text[]),
      'online', now(), true
    ) returning id into v_session_id;
  end if;

  update public.ai_connections set last_used_at = now()
  where workspace_id = p_workspace_id and id = p_connection_id;

  v_response := jsonb_build_object('session', public._session_payload(v_session_id));
  perform public._idempotency_finish(
    p_workspace_id, 'connection:' || p_connection_id::text,
    p_idempotency_key, v_response
  );
  return v_response;
end;
$$;

revoke all on function public.register_ai_session(
  uuid, uuid, text, text, text, text, text, text[], text, text
) from public, anon, authenticated;
grant execute on function public.register_ai_session(
  uuid, uuid, text, text, text, text, text, text[], text, text
) to service_role;

-- Keep all task insertion/reassignment paths aligned with the inventory fence,
-- even if a stale status/heartbeat briefly remains after another transaction.
create or replace function public._enforce_directed_task_assignment()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'INSERT' then
    if new.assigned_session_id is null
       and new.created_by_type = 'ai'
       and new.created_by_id is not null
       and exists (
         select 1 from public.ai_sessions session
         where session.workspace_id = new.workspace_id
           and session.id = new.created_by_id
       ) then
      new.assigned_session_id := new.created_by_id;
    end if;

    if new.created_by_type = 'user' and (
      new.assigned_session_id is null or not exists (
        select 1 from public.ai_sessions session
        where session.workspace_id = new.workspace_id
          and session.id = new.assigned_session_id
          and session.inventory_active
          and session.archived_at is null
          and session.status <> 'offline'
          and session.last_seen_at >= now() - interval '2 minutes'
      )
    ) then
      perform public._raise('SESSION_NOT_AUTHORIZED');
    end if;
  elsif tg_op = 'UPDATE' then
    if new.status = 'running'
       and new.assigned_session_id is null
       and new.claimed_by_session_id is not null then
      new.assigned_session_id := new.claimed_by_session_id;
    end if;

    if new.assigned_session_id is distinct from old.assigned_session_id
       and new.assigned_session_id is not null
       and new.claimed_by_session_id is null
       and not exists (
         select 1 from public.ai_sessions session
         where session.workspace_id = new.workspace_id
           and session.id = new.assigned_session_id
           and session.inventory_active
           and session.archived_at is null
           and session.status <> 'offline'
           and session.last_seen_at >= now() - interval '2 minutes'
       ) then
      perform public._raise('SESSION_NOT_AUTHORIZED');
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public._enforce_directed_task_assignment()
from public, anon, authenticated;

create or replace function public.create_session_turn(
  p_workspace_id uuid,
  p_user_id uuid,
  p_session_id uuid,
  p_title text,
  p_content text,
  p_priority integer,
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
  v_task_id uuid := extensions.gen_random_uuid();
  v_message_id uuid := extensions.gen_random_uuid();
  v_activity_id bigint;
  v_response jsonb;
begin
  perform public._assert_member(p_workspace_id, p_user_id);
  v_idempotency := public._idempotency_begin(
    p_workspace_id, 'user:' || p_user_id::text,
    p_idempotency_key, 'create_session_turn', p_request_hash
  );
  if v_idempotency ? 'cached_response' then
    return v_idempotency -> 'cached_response';
  end if;

  if nullif(btrim(p_title), '') is null
     or length(btrim(p_title)) > 500
     or nullif(btrim(p_content), '') is null
     or length(btrim(p_content)) > 100000
     or coalesce(p_priority, 50) not between -1000 and 1000 then
    perform public._raise('INVALID_TASK');
  end if;

  perform public._lock_task_state_exclusive(p_workspace_id);
  perform public._lock_ai_session(p_workspace_id, p_session_id);

  if not exists (
    select 1
    from public.ai_sessions session
    join public.ai_connections connection
      on connection.workspace_id = session.workspace_id
     and connection.id = session.connection_id
    where session.workspace_id = p_workspace_id
      and session.id = p_session_id
      and session.inventory_active
      and session.archived_at is null
      and session.status <> 'offline'
      and session.last_seen_at >= now() - interval '2 minutes'
      and connection.revoked_at is null
  ) then
    perform public._raise('SESSION_NOT_AUTHORIZED');
  end if;

  insert into public.tasks (
    id, workspace_id, root_task_id, title, description, status, priority,
    assigned_session_id, required_capabilities, created_by_type, created_by_id
  ) values (
    v_task_id, p_workspace_id, v_task_id, left(btrim(p_title), 500),
    btrim(p_content), 'ready', coalesce(p_priority, 50), p_session_id,
    '{}'::text[], 'user', p_user_id
  );

  insert into public.task_messages (
    id, workspace_id, task_id, sender_type, sender_id, content
  ) values (
    v_message_id, p_workspace_id, v_task_id, 'user', p_user_id, btrim(p_content)
  );

  insert into public.session_activities (
    workspace_id, session_id, task_id, task_message_id, kind, actor_type,
    content, data, external_ref
  ) values (
    p_workspace_id, p_session_id, v_task_id, v_message_id, 'user_message',
    'user', btrim(p_content), jsonb_build_object('message_id', v_message_id),
    'web:message:' || v_message_id::text
  ) returning id into v_activity_id;

  insert into public.task_events (
    workspace_id, task_id, type, actor_type, actor_id, data
  ) values
    (
      p_workspace_id, v_task_id, 'task_created', 'user', p_user_id,
      jsonb_build_object('source', 'session_conversation', 'session_id', p_session_id)
    ),
    (
      p_workspace_id, v_task_id, 'message_posted', 'user', p_user_id,
      jsonb_build_object('message_id', v_message_id, 'activity_id', v_activity_id)
    );

  v_response := jsonb_build_object(
    'task', public._task_payload(v_task_id),
    'message', (
      select to_jsonb(message)
      from public.task_messages message
      where message.id = v_message_id
    ),
    'activity', (
      select to_jsonb(activity)
      from public.session_activities activity
      where activity.id = v_activity_id
    )
  );
  perform public._idempotency_finish(
    p_workspace_id, 'user:' || p_user_id::text, p_idempotency_key, v_response
  );
  return v_response;
end;
$$;

revoke all on function public.create_session_turn(
  uuid, uuid, uuid, text, text, integer, text, text
) from public, anon, authenticated;
grant execute on function public.create_session_turn(
  uuid, uuid, uuid, text, text, integer, text, text
) to service_role;

-- ai_connections uses an explicit authenticated column grant because the raw
-- token hash must never be browser-readable. Extend only that safe projection.
grant select (last_seen_at, bridge_version)
on table public.ai_connections to authenticated;

-- Streamed assistant deltas belong in the append-only activity timeline but
-- must not become one task_messages chat bubble per chunk. Missing phase keeps
-- the V1 completed-item behavior.
create or replace function public.report_session_activity(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_api_token_hash text,
  p_session_id uuid,
  p_task_id uuid,
  p_claim_token_hash text,
  p_kind text,
  p_content text,
  p_data jsonb,
  p_external_ref text,
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
  v_claim public.tasks%rowtype;
  v_existing public.session_activities%rowtype;
  v_message_id uuid;
  v_activity_id bigint;
  v_response jsonb;
  v_is_stream_event boolean :=
    p_data ->> 'protocol' = 'codex-app-server/v1'
    and coalesce(p_data ->> 'phase', '') in ('started', 'delta');
  v_is_stream_delta boolean :=
    p_data ->> 'protocol' = 'codex-app-server/v1'
    and p_data ->> 'phase' = 'delta';
  v_content text := case
    when v_is_stream_delta then p_content
    else nullif(btrim(p_content), '')
  end;
begin
  perform public._assert_active_session(
    p_workspace_id, p_connection_id, p_api_token_hash, p_session_id
  );
  -- started/delta rows already carry a stable external_ref and are naturally
  -- idempotent under the unique index below. Avoid a second high-frequency
  -- idempotency row for every streamed chunk.
  if not v_is_stream_event then
    v_idempotency := public._idempotency_begin(
      p_workspace_id, 'session:' || p_session_id::text,
      p_idempotency_key, 'report_session_activity', p_request_hash
    );
    if v_idempotency ? 'cached_response' then
      return v_idempotency -> 'cached_response';
    end if;
  end if;

  if p_kind is null
     or p_kind not in (
      'assistant_message', 'reasoning', 'command', 'file_change',
      'mcp_tool', 'web_search', 'plan', 'error', 'usage', 'status'
     )
     or nullif(btrim(p_external_ref), '') is null
     or length(btrim(p_external_ref)) > 500
     or jsonb_typeof(coalesce(p_data, '{}'::jsonb)) <> 'object'
     or octet_length(coalesce(p_data, '{}'::jsonb)::text) > 262144
     or (p_content is not null and (v_content is null or length(v_content) not between 1 and 100000))
     or (p_kind in ('assistant_message', 'reasoning') and v_content is null) then
    perform public._raise('INVALID_REQUEST');
  end if;

  perform public._lock_task_state_shared(p_workspace_id);
  perform public._lock_ai_session(p_workspace_id, p_session_id);

  perform pg_advisory_xact_lock(
    hashtextextended('session-activity:' || p_session_id::text || ':' || btrim(p_external_ref), 0)
  );
  select * into v_existing
  from public.session_activities activity
  where activity.workspace_id = p_workspace_id
    and activity.session_id = p_session_id
    and activity.external_ref = btrim(p_external_ref);

  if found then
    if v_existing.task_id is distinct from p_task_id
       or v_existing.kind is distinct from p_kind
       or v_existing.content is distinct from v_content
       or v_existing.data is distinct from coalesce(p_data, '{}'::jsonb) then
      perform public._raise('IDEMPOTENCY_CONFLICT');
    end if;
    if v_is_stream_event then
      v_response := jsonb_build_object(
        'task', jsonb_build_object('id', p_task_id),
        'message', null,
        'activity', to_jsonb(v_existing)
      );
    else
      v_response := jsonb_build_object(
        'task', public._task_payload(p_task_id),
        'message', case when v_existing.task_message_id is null then null else (
          select to_jsonb(message) from public.task_messages message
          where message.id = v_existing.task_message_id
        ) end,
        'activity', to_jsonb(v_existing)
      );
    end if;
    if not v_is_stream_event then
      perform public._idempotency_finish(
        p_workspace_id, 'session:' || p_session_id::text,
        p_idempotency_key, v_response
      );
    end if;
    return v_response;
  end if;

  select claim.* into v_claim
  from public._lock_valid_claim(
    p_workspace_id, p_session_id, p_task_id, p_claim_token_hash
  ) as claim;

  if p_kind = 'assistant_message'
     and (
       not (coalesce(p_data, '{}'::jsonb) ? 'phase')
       or p_data ->> 'phase' = 'completed'
     ) then
    v_message_id := extensions.gen_random_uuid();
    insert into public.task_messages (
      id, workspace_id, task_id, sender_type, sender_id, content
    ) values (
      v_message_id, p_workspace_id, p_task_id, 'ai', p_session_id, v_content
    );
  end if;

  insert into public.session_activities (
    workspace_id, session_id, task_id, task_message_id, kind, actor_type,
    content, data, external_ref
  ) values (
    p_workspace_id, p_session_id, p_task_id, v_message_id, p_kind, 'ai',
    v_content, coalesce(p_data, '{}'::jsonb), btrim(p_external_ref)
  ) returning id into v_activity_id;

  if not v_is_stream_event then
    -- Avoid emitting a no-op tasks UPDATE (and its Realtime row) for every
    -- completed App Server item after the task is already running.
    update public.tasks
    set status = 'running'
    where id = p_task_id
      and status is distinct from 'running';
    update public.ai_sessions
    set status = 'busy', current_task_id = p_task_id, last_seen_at = now()
    where id = p_session_id;
    insert into public.task_events (
      workspace_id, task_id, type, actor_type, actor_id, data
    ) values (
      p_workspace_id, p_task_id, 'session_activity_reported', 'ai', p_session_id,
      jsonb_strip_nulls(jsonb_build_object(
        'activity_id', v_activity_id,
        'kind', p_kind,
        'message_id', v_message_id
      ))
    );
  end if;

  if v_is_stream_event then
    v_response := jsonb_build_object(
      'task', jsonb_build_object('id', p_task_id),
      'message', null,
      'activity', (select to_jsonb(activity) from public.session_activities activity where activity.id = v_activity_id)
    );
  else
    v_response := jsonb_build_object(
      'task', public._task_payload(p_task_id),
      'message', case when v_message_id is null then null else (
        select to_jsonb(message) from public.task_messages message where message.id = v_message_id
      ) end,
      'activity', (select to_jsonb(activity) from public.session_activities activity where activity.id = v_activity_id)
    );
  end if;
  if not v_is_stream_event then
    perform public._idempotency_finish(
      p_workspace_id, 'session:' || p_session_id::text,
      p_idempotency_key, v_response
    );
  end if;
  return v_response;
end;
$$;

revoke all on function public.report_session_activity(
  uuid, uuid, text, uuid, uuid, text, text, text, jsonb, text, text, text
) from public, anon, authenticated;
grant execute on function public.report_session_activity(
  uuid, uuid, text, uuid, uuid, text, text, text, jsonb, text, text, text
) to service_role;
