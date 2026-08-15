-- Persist whether the Web composer submitted a turn as Goal mode.
--
-- Codex Bridge maps `true` to `thread/goal/set` (objective = prompt) and
-- `false` to `thread/goal/clear` before starting the turn. Kimi Bridge maps
-- the value to the local `kimi web` goal lifecycle (`goal_objective` /
-- `goal_control`). A null value leaves the Thread goal untouched, which keeps
-- planning-workspace turns and older clients on the previous behavior.

alter table public.tasks
  add column if not exists goal_mode boolean;

-- Add a goal-aware overload instead of replacing the existing 11-argument
-- function: the planning workspace still calls the original signature, and
-- those turns intentionally leave `goal_mode` null.
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
  v_model text := nullif(btrim(p_model), '');
  v_reasoning_effort text := nullif(btrim(p_reasoning_effort), '');
begin
  if (v_model is not null and length(v_model) > 200)
     or (
       v_reasoning_effort is not null
       and length(v_reasoning_effort) > 50
     ) then
    perform public._raise('INVALID_TASK');
  end if;

  -- The original function owns membership, Session liveness, image binding
  -- and idempotency. A failure after this nested call rolls back the complete
  -- transaction, including its idempotency record and uploaded-artifact rows.
  v_result := public.create_session_turn_with_images(
    p_workspace_id, p_user_id, p_session_id, p_title, p_content,
    p_priority, p_images, p_idempotency_key, p_request_hash
  );
  v_task_id := nullif(v_result -> 'task' ->> 'id', '')::uuid;
  if v_task_id is null then
    perform public._raise('INVALID_TASK');
  end if;

  update public.tasks task
  set model = v_model,
      reasoning_effort = v_reasoning_effort,
      goal_mode = p_goal_mode
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
  uuid, uuid, uuid, text, text, integer, jsonb, text, text, boolean, text, text
) is
  'Creates a Web conversation turn whose queued task carries exact Codex model, reasoning and goal-mode overrides.';

revoke all on function public.create_session_turn_with_settings(
  uuid, uuid, uuid, text, text, integer, jsonb, text, text, boolean, text, text
) from public, anon, authenticated;
grant execute on function public.create_session_turn_with_settings(
  uuid, uuid, uuid, text, text, integer, jsonb, text, text, boolean, text, text
) to service_role;
