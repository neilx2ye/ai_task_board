-- Corrective follow-up for the unified device Bridge migration.
--
-- `import_session_history` is the Codex-only history import path, but its
-- settings fence still looked up the connection row without a platform
-- filter. Under the unified migration a single connection owns one
-- ai_connection_bridge_settings row per platform (codex, kimi, antigravity,
-- claude), so the unfiltered `SELECT ... INTO` silently binds the first row
-- the planner returns. Depending on the plan that row may belong to another
-- platform, whose runtime lease is held by a different process; the Codex
-- runtime then fails its own history sync with BRIDGE_INSTANCE_CONFLICT.
-- Scope the fence to the codex platform so the comparison always targets the
-- row owned by the reporting Codex runtime.
CREATE OR REPLACE FUNCTION public.import_session_history(p_workspace_id uuid, p_connection_id uuid, p_api_token_hash text, p_session_id uuid, p_runtime_instance_id uuid, p_report_sequence bigint, p_items jsonb, p_sync jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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
    and settings.platform = 'codex'
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
$function$
