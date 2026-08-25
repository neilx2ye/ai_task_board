-- Persist the model and reasoning effort selected beside the Web composer on
-- the queued task that represents that exact Codex turn. This keeps settings
-- stable even when several turns are queued before the Bridge claims them.

alter table public.tasks
  add column if not exists model text,
  add column if not exists reasoning_effort text;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'tasks_model_length'
      and conrelid = 'public.tasks'::regclass
  ) then
    alter table public.tasks
      add constraint tasks_model_length check (
        model is null or length(btrim(model)) between 1 and 200
      );
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'tasks_reasoning_effort_length'
      and conrelid = 'public.tasks'::regclass
  ) then
    alter table public.tasks
      add constraint tasks_reasoning_effort_length check (
        reasoning_effort is null
        or length(btrim(reasoning_effort)) between 1 and 50
      );
  end if;
end;
$$;

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

  -- The existing function owns membership, Session liveness, image binding
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
      reasoning_effort = v_reasoning_effort
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
  uuid, uuid, uuid, text, text, integer, jsonb, text, text, text, text
) is
  'Creates a Web conversation turn whose queued task carries exact Codex model and reasoning overrides.';

revoke all on function public.create_session_turn_with_settings(
  uuid, uuid, uuid, text, text, integer, jsonb, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.create_session_turn_with_settings(
  uuid, uuid, uuid, text, text, integer, jsonb, text, text, text, text
) to service_role;
