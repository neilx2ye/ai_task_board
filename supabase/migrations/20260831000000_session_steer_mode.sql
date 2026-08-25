-- Session Steer（实时调整）模式：
--
-- Web 对话面板可以选择把下一条消息标记为 steer。Codex Bridge 在某个
-- Thread 的 turn 正在运行时领取这类任务，并通过 App Server `turn/steer`
-- 把它追加进当前 turn，而不是排队到下一张 Task。turn 空闲时发送的 steer
-- 消息与普通消息行为一致。

alter table public.tasks
  add column if not exists steer boolean not null default false;

-- 在既有 12 参数版本之后追加带 p_steer 的重载。规划工作台仍调用旧签名，
-- 那些 turn 保持 steer = false。
create or replace function public.create_session_turn_with_settings(
  p_workspace_id uuid,
  p_user_id uuid,
  p_session_id uuid,
  p_title text,
  p_content text,
  p_priority integer,
  p_images jsonb,
  p_model text,
  p_reasoning_effort text,
  p_goal_mode boolean,
  p_steer boolean,
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
  v_task_id uuid;
begin
  v_result := public.create_session_turn_with_settings(
    p_workspace_id, p_user_id, p_session_id, p_title, p_content,
    p_priority, p_images, p_model, p_reasoning_effort, p_goal_mode,
    p_idempotency_key, p_request_hash
  );
  v_task_id := nullif(v_result -> 'task' ->> 'id', '')::uuid;
  if v_task_id is null then
    perform public._raise('INVALID_TASK');
  end if;

  update public.tasks task
  set steer = coalesce(p_steer, false)
  where task.workspace_id = p_workspace_id
    and task.id = v_task_id;
  if not found then
    perform public._raise('INVALID_TASK');
  end if;

  return jsonb_set(
    v_result,
    '{task}',
    public._task_payload(v_task_id),
    true
  );
end;
$$;

comment on function public.create_session_turn_with_settings(
  uuid, uuid, uuid, text, text, integer, jsonb, text, text, boolean, boolean,
  text, text
) is
  'Creates a Web conversation turn whose queued task carries exact Codex model, reasoning, goal-mode and steer-mode overrides.';

revoke all on function public.create_session_turn_with_settings(
  uuid, uuid, uuid, text, text, integer, jsonb, text, text, boolean, boolean,
  text, text
) from public, anon, authenticated;
grant execute on function public.create_session_turn_with_settings(
  uuid, uuid, uuid, text, text, integer, jsonb, text, text, boolean, boolean,
  text, text
) to service_role;

-- 专用于运行中 turn 的 steer 领取。claim_next_task 拒绝在 Session 已有活跃
-- Task 时再领取，这里只允许领取 steer = true 的辅助任务，且不触碰
-- ai_sessions.current_task_id / status：主 turn 的归属与状态保持不变。
create or replace function public.claim_steer_task(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_api_token_hash text,
  p_session_id uuid,
  p_claim_token_hash text,
  p_lease_seconds integer,
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
  v_actor_key text := 'session:' || p_session_id::text;
  v_existing public.idempotency_records%rowtype;
  v_idempotency jsonb;
  v_task public.tasks%rowtype;
  v_response jsonb;
  v_lease_seconds integer := greatest(60, least(coalesce(p_lease_seconds, 900), 3600));
begin
  perform public._assert_active_session(
    p_workspace_id, p_connection_id, p_api_token_hash, p_session_id
  );

  if nullif(btrim(p_idempotency_key), '') is null
     or length(p_idempotency_key) > 300
     or nullif(btrim(p_request_hash), '') is null
     or length(p_request_hash) < 16 then
    perform public._raise('INVALID_IDEMPOTENCY_KEY');
  end if;

  select * into v_existing
  from public.idempotency_records record
  where record.workspace_id = p_workspace_id
    and record.actor_key = v_actor_key
    and record.idempotency_key = p_idempotency_key
    and record.expires_at > now()
  for update;
  if found then
    if v_existing.operation <> 'claim_steer_task'
       or v_existing.request_hash <> p_request_hash then
      perform public._raise('IDEMPOTENCY_CONFLICT');
    end if;
    if v_existing.response_json is null then
      perform public._raise('IDEMPOTENCY_INCOMPLETE');
    end if;
    return v_existing.response_json;
  end if;

  if nullif(p_claim_token_hash, '') is null then
    perform public._raise('INVALID_CLAIM_TOKEN');
  end if;

  -- 只有 Session 正在执行一个非 steer 主 turn、且队列里有可领取的 steer
  -- 任务时才继续；否则空轮询，不产生任何副作用。
  if not exists (
    select 1 from public.tasks active
    where active.workspace_id = p_workspace_id
      and active.claimed_by_session_id = p_session_id
      and active.status in ('claimed', 'running')
      and active.lease_expires_at > now()
      and active.steer = false
  ) or not exists (
    select 1
    from public.tasks candidate
    join public.ai_sessions session
      on session.workspace_id = candidate.workspace_id
     and session.id = p_session_id
    where candidate.workspace_id = p_workspace_id
      and candidate.steer = true
      and (
        candidate.status = 'ready'
        or (
          candidate.status in ('claimed', 'running')
          and candidate.lease_expires_at <= now()
        )
      )
      and not exists (
        select 1 from public.tasks child where child.parent_task_id = candidate.id
      )
      and not exists (
        select 1
        from public.task_dependencies edge
        join public.tasks dependency on dependency.id = edge.depends_on_task_id
        where edge.task_id = candidate.id and dependency.status <> 'completed'
      )
      and candidate.assigned_session_id = p_session_id
      and candidate.required_capabilities <@ session.capabilities
  ) then
    return jsonb_build_object('task', null);
  end if;

  v_idempotency := public._idempotency_begin(
    p_workspace_id, v_actor_key,
    p_idempotency_key, 'claim_steer_task', p_request_hash
  );
  if v_idempotency ? 'cached_response' then
    return v_idempotency -> 'cached_response';
  end if;

  perform public._lock_task_state_shared(p_workspace_id);
  perform public._lock_ai_session(p_workspace_id, p_session_id);

  select candidate.* into v_task
  from public.tasks candidate
  join public.ai_sessions session
    on session.workspace_id = candidate.workspace_id and session.id = p_session_id
  where candidate.workspace_id = p_workspace_id
    and candidate.steer = true
    and (
      candidate.status = 'ready'
      or (
        candidate.status in ('claimed', 'running')
        and candidate.lease_expires_at <= now()
      )
    )
    and not exists (
      select 1 from public.tasks child where child.parent_task_id = candidate.id
    )
    and not exists (
      select 1
      from public.task_dependencies edge
      join public.tasks dependency on dependency.id = edge.depends_on_task_id
      where edge.task_id = candidate.id and dependency.status <> 'completed'
    )
    and candidate.assigned_session_id = p_session_id
    and candidate.required_capabilities <@ session.capabilities
  order by candidate.priority desc, candidate.created_at asc, candidate.id asc
  for update of candidate skip locked
  limit 1;

  if not found then
    delete from public.idempotency_records record
    where record.workspace_id = p_workspace_id
      and record.actor_key = v_actor_key
      and record.idempotency_key = p_idempotency_key
      and record.operation = 'claim_steer_task'
      and record.request_hash = p_request_hash
      and record.response_json is null;
    if not found then
      perform public._raise('IDEMPOTENCY_INCOMPLETE');
    end if;
    return jsonb_build_object('task', null);
  end if;

  update public.tasks
  set status = 'claimed',
      claimed_by_session_id = p_session_id,
      claim_token_hash = p_claim_token_hash,
      claimed_at = now(),
      lease_expires_at = now() + make_interval(secs => v_lease_seconds),
      completed_at = null
  where id = v_task.id;

  insert into public.task_events (
    workspace_id, task_id, type, actor_type, actor_id, data
  ) values (
    p_workspace_id, v_task.id, 'task_claimed', 'ai', p_session_id,
    jsonb_build_object('steer', true, 'lease_seconds', v_lease_seconds)
  );

  v_response := jsonb_build_object('task', public._task_payload(v_task.id));
  perform public._idempotency_finish(
    p_workspace_id, v_actor_key, p_idempotency_key, v_response
  );
  return v_response;
end;
$$;

comment on function public.claim_steer_task(
  uuid, uuid, text, uuid, text, integer, text, text
) is
  'Claims the next steer-mode task for a Session that is already running a main turn. Returns task null when the Thread is idle or no steer task is ready.';

revoke all on function public.claim_steer_task(
  uuid, uuid, text, uuid, text, integer, text, text
) from public, anon, authenticated;
grant execute on function public.claim_steer_task(
  uuid, uuid, text, uuid, text, integer, text, text
) to service_role;
