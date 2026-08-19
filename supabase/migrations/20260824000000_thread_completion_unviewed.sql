-- Thread 完成状态：网页端需要区分“已完成但还没查看”与“已查看”。
--  - unviewed_completed_count：本 Thread 累计完成、但用户尚未打开的叶子任务数。
--  - last_completed_task_id：最近一次完成的任务，用户查看后仍用于展示“已完成”。

alter table public.ai_sessions
  add column if not exists unviewed_completed_count integer not null default 0;

alter table public.ai_sessions
  add column if not exists last_completed_task_id uuid;

alter table public.ai_sessions
  add constraint ai_sessions_unviewed_completed_count_nonnegative
  check (unviewed_completed_count >= 0);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'ai_sessions_last_completed_task_fk'
      and conrelid = 'public.ai_sessions'::regclass
  ) then
    alter table public.ai_sessions
      add constraint ai_sessions_last_completed_task_fk
      foreign key (workspace_id, last_completed_task_id)
      references public.tasks(workspace_id, id) on delete set null
      deferrable initially deferred;
  end if;
end;
$$;

-- 完成叶子任务时：在清空 current_task_id 的同一更新里累计待查看数，
-- 并记录最近完成的任务，供“已完成（已查看）”状态展示。
create or replace function public._complete_task_internal(
  p_workspace_id uuid,
  p_session_id uuid,
  p_task_id uuid,
  p_result_summary text,
  p_result_json jsonb,
  p_message_content text,
  p_artifacts jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_message_id uuid;
  v_artifact_payload jsonb;
begin
  if exists (select 1 from public.tasks c where c.parent_task_id = p_task_id) then
    perform public._raise('INVALID_STATE_TRANSITION');
  end if;
  if p_result_json is not null and jsonb_typeof(p_result_json) is null then
    perform public._raise('INVALID_RESULT');
  end if;

  update public.tasks
  set status = 'completed',
      result_summary = p_result_summary,
      result_json = p_result_json,
      progress_percent_estimate = 100,
      completed_at = now(),
      claimed_by_session_id = null,
      claim_token_hash = null,
      claimed_at = null,
      lease_expires_at = null
  where workspace_id = p_workspace_id and id = p_task_id;

  if nullif(btrim(p_message_content), '') is not null then
    v_message_id := extensions.gen_random_uuid();
    insert into public.task_messages (
      id, workspace_id, task_id, sender_type, sender_id, content
    ) values (
      v_message_id, p_workspace_id, p_task_id, 'ai', p_session_id,
      btrim(p_message_content)
    );
  end if;

  v_artifact_payload := public._insert_completion_artifacts(
    p_workspace_id, p_task_id, p_session_id, coalesce(p_artifacts, '[]'::jsonb)
  );

  update public.ai_sessions
  set current_task_id = null,
      status = public._idle_session_status(p_session_id),
      last_seen_at = now(),
      last_completed_task_id = p_task_id,
      unviewed_completed_count = public.ai_sessions.unviewed_completed_count + 1
  where workspace_id = p_workspace_id and id = p_session_id
    and current_task_id = p_task_id;

  insert into public.task_events (
    workspace_id, task_id, type, actor_type, actor_id, data
  ) values (
    p_workspace_id, p_task_id, 'task_completed', 'ai', p_session_id,
    jsonb_strip_nulls(jsonb_build_object(
      'message_id', v_message_id,
      'artifact_count', jsonb_array_length(v_artifact_payload)
    ))
  );

  perform public._refresh_unblocked_tasks(p_workspace_id, p_task_id);
  perform public._recompute_ancestors(p_task_id);

  return jsonb_build_object(
    'task', public._task_payload(p_task_id),
    'message_id', v_message_id,
    'artifacts', v_artifact_payload
  );
end;
$$;
