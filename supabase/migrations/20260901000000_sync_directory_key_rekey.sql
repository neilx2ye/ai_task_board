-- Web 期望清单允许 Owner 修改某个工作路径的 directory_key（例如在 Bridge
-- 设置中重命名项目标识）。此前同步会因「同一路径必须沿用同一 key」而拒绝
-- 设备上报，导致运行时反复启动失败、无法续约。改为：新 key 未被其他路径
-- 占用时，把存量目录行连同引用它的 Session / Thread 命令一起迁移到新 key，
-- 让设备上报与 Web 期望保持一致。

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
  v_rekey_session_ids uuid[] := '{}'::uuid[];
  v_rekey_command_ids uuid[] := '{}'::uuid[];
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
       or v_working_directory = any(v_directory_paths) then
      perform public._raise('INVALID_SESSION');
    end if;

    -- 同一路径已登记在另一个 key 下（例如 Web 期望清单重命名了 key）：
    -- 把存量目录行连同引用它的 Session / Thread 命令迁移到新 key，而不是
    -- 拒绝上报让设备陷入重启循环。
    if exists (
      select 1
      from public.ai_bridge_directories directory
      where directory.connection_id = p_connection_id
        and directory.platform = v_platform
        and directory.working_directory = v_working_directory
        and directory.directory_key <> v_directory_key
    ) then
      -- 新 key 已被另一条路径占用时无法安全迁移，仍视为无效上报。
      if exists (
        select 1
        from public.ai_bridge_directories directory
        where directory.connection_id = p_connection_id
          and directory.platform = v_platform
          and directory.directory_key = v_directory_key
          and directory.working_directory <> v_working_directory
      ) then
        perform public._raise('INVALID_SESSION');
      end if;

      select coalesce(array_agg(session.id), '{}'::uuid[])
      into v_rekey_session_ids
      from public.ai_sessions session
      where session.workspace_id = p_workspace_id
        and session.connection_id = p_connection_id
        and session.platform = v_platform
        and session.bridge_directory_key in (
          select previous.directory_key
          from public.ai_bridge_directories previous
          where previous.connection_id = p_connection_id
            and previous.platform = v_platform
            and previous.working_directory = v_working_directory
        );

      select coalesce(array_agg(command.id), '{}'::uuid[])
      into v_rekey_command_ids
      from public.ai_thread_commands command
      where command.workspace_id = p_workspace_id
        and command.connection_id = p_connection_id
        and command.platform = v_platform
        and command.directory_key in (
          select previous.directory_key
          from public.ai_bridge_directories previous
          where previous.connection_id = p_connection_id
            and previous.platform = v_platform
            and previous.working_directory = v_working_directory
        );

      -- 先把外键引用摘除，再改主行 key，最后回挂，避免同一语句内先改
      -- 子表再改主表时违反引用约束。
      update public.ai_sessions session
      set bridge_directory_key = null
      where session.id = any(v_rekey_session_ids);

      update public.ai_thread_commands command
      set directory_key = null
      where command.id = any(v_rekey_command_ids);

      update public.ai_bridge_directories directory
      set directory_key = v_directory_key,
          name = v_directory_name,
          inventory_active = true,
          last_seen_at = v_now
      where directory.connection_id = p_connection_id
        and directory.platform = v_platform
        and directory.working_directory = v_working_directory
        and directory.directory_key <> v_directory_key;

      update public.ai_sessions session
      set bridge_directory_key = v_directory_key
      where session.id = any(v_rekey_session_ids);

      update public.ai_thread_commands command
      set directory_key = v_directory_key
      where command.id = any(v_rekey_command_ids);
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
