-- Task pause/resume. A paused task keeps its session assignment but is never
-- handed out by the claim RPCs (they only select status = 'ready'). Pausing a
-- claimed/running task additionally enqueues a best-effort interrupt command
-- for the owning Bridge runtime; resuming re-queues the task for the same
-- session after the standard dependency re-check.

alter type public.task_status add value if not exists 'paused';

-- Web thread commands gain a pause action: interrupt the session's active turn.
-- task_id pins the command to the task that was paused, so a Bridge that has
-- already moved on to the session's next task treats it as a no-op instead of
-- interrupting the wrong turn.
alter table public.ai_thread_commands
  drop constraint if exists ai_thread_commands_action_check,
  drop constraint if exists ai_thread_commands_name_shape;
alter table public.ai_thread_commands
  add constraint ai_thread_commands_action_check
    check (action in ('create', 'rename', 'delete', 'pause')),
  add constraint ai_thread_commands_name_shape check (
    (action in ('create', 'rename')
      and name is not null
      and length(btrim(name)) between 1 and 200)
    or (action in ('delete', 'pause') and name is null)
  );

alter table public.ai_thread_commands
  add column if not exists task_id uuid;
alter table public.ai_thread_commands
  drop constraint if exists ai_thread_commands_task_fk,
  add constraint ai_thread_commands_task_fk
    foreign key (workspace_id, task_id)
    references public.tasks(workspace_id, id) on delete cascade;

-- Aggregate display: a paused leaf must not sink its parent into 'blocked'.
-- Precedence stays waiting_user > running > failed > ready > blocked > paused.
create or replace function public._recompute_parent(p_parent_task_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_parent public.tasks%rowtype;
  v_status public.task_status;
  v_active_count integer;
begin
  if p_parent_task_id is null then return; end if;

  select * into v_parent from public.tasks where id = p_parent_task_id for update;
  if not found or v_parent.status = 'cancelled' then return; end if;

  select count(*) into v_active_count
  from public.tasks c
  where c.parent_task_id = p_parent_task_id and c.status <> 'cancelled';

  if v_active_count = 0 then
    v_status := 'blocked';
  elsif not exists (
    select 1 from public.tasks c
    where c.parent_task_id = p_parent_task_id
      and c.status not in ('completed', 'cancelled')
  ) then
    v_status := 'completed';
  elsif exists (
    select 1 from public.tasks c
    where c.parent_task_id = p_parent_task_id and c.status = 'waiting_user'
  ) then
    v_status := 'waiting_user';
  elsif exists (
    select 1 from public.tasks c
    where c.parent_task_id = p_parent_task_id and c.status in ('claimed', 'running')
  ) then
    v_status := 'running';
  elsif exists (
    select 1 from public.tasks c
    where c.parent_task_id = p_parent_task_id and c.status = 'failed'
  ) then
    v_status := 'failed';
  elsif exists (
    select 1 from public.tasks c
    where c.parent_task_id = p_parent_task_id and c.status = 'ready'
  ) then
    v_status := 'ready';
  elsif exists (
    select 1 from public.tasks c
    where c.parent_task_id = p_parent_task_id and c.status = 'blocked'
  ) then
    v_status := 'blocked';
  elsif exists (
    select 1 from public.tasks c
    where c.parent_task_id = p_parent_task_id and c.status = 'paused'
  ) then
    v_status := 'paused';
  else
    v_status := 'blocked';
  end if;

  if v_parent.status is distinct from v_status
     or (v_status = 'completed' and v_parent.completed_at is null) then
    -- A dependent may have been claimed while this aggregate was completed.
    -- Reject the child mutation (and roll its transaction back) before making
    -- the aggregate incomplete; claims hold the matching shared workspace lock.
    if v_parent.status = 'completed' and v_status <> 'completed' then
      perform public._assert_no_active_dependents(p_parent_task_id);
    end if;

    update public.tasks
    set status = v_status,
        completed_at = case when v_status = 'completed' then now() else null end,
        claimed_by_session_id = null,
        claim_token_hash = null,
        claimed_at = null,
        lease_expires_at = null
    where id = p_parent_task_id;

    insert into public.task_events (
      workspace_id, task_id, type, actor_type, actor_id, data
    ) values (
      v_parent.workspace_id, p_parent_task_id, 'parent_status_aggregated',
      'system', null,
      jsonb_build_object('from', v_parent.status, 'to', v_status)
    );

    if v_parent.status <> 'completed' and v_status = 'completed' then
      perform public._refresh_unblocked_tasks(v_parent.workspace_id, p_parent_task_id);
    elsif v_parent.status = 'completed' and v_status <> 'completed' then
      perform public._block_newly_unmet_dependents(v_parent.workspace_id, p_parent_task_id);
    end if;
  end if;
end;
$$;

create or replace function public.pause_task(
  p_workspace_id uuid,
  p_user_id uuid,
  p_task_id uuid,
  p_reason text,
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
  v_task public.tasks%rowtype;
  v_session public.ai_sessions%rowtype;
  v_response jsonb;
begin
  perform public._assert_member(p_workspace_id, p_user_id);
  v_idempotency := public._idempotency_begin(
    p_workspace_id, 'user:' || p_user_id::text,
    p_idempotency_key, 'pause_task', p_request_hash
  );
  if v_idempotency ? 'cached_response' then return v_idempotency -> 'cached_response'; end if;

  perform public._lock_task_state_exclusive(p_workspace_id);

  select * into v_task from public.tasks
  where workspace_id = p_workspace_id and id = p_task_id for update;
  if not found then perform public._raise('TASK_NOT_FOUND'); end if;
  if v_task.status not in ('ready', 'claimed', 'running') then
    perform public._raise('INVALID_STATE_TRANSITION');
  end if;
  -- Aggregate parents derive their status from descendants; pause the leaves.
  if exists (
    select 1 from public.tasks child where child.parent_task_id = p_task_id
  ) then
    perform public._raise('INVALID_STATE_TRANSITION');
  end if;

  if v_task.claimed_by_session_id is not null then
    select * into v_session from public.ai_sessions
    where workspace_id = p_workspace_id and id = v_task.claimed_by_session_id;
    update public.ai_sessions
    set current_task_id = null,
        status = public._idle_session_status(v_task.claimed_by_session_id)
    where id = v_task.claimed_by_session_id and current_task_id = p_task_id;
    if v_session.id is not null then
      -- Best-effort interrupt: the owning Bridge claims this command on its
      -- regular poll; a turn that already finished is a successful no-op.
      insert into public.ai_thread_commands (
        workspace_id, connection_id, session_id, action, name,
        external_thread_id, platform, task_id, requested_by_user_id
      ) values (
        p_workspace_id, v_session.connection_id, v_session.id, 'pause', null,
        v_session.external_conversation_ref,
        public._canonical_bridge_platform(v_session.platform),
        p_task_id,
        p_user_id
      );
    end if;
  end if;

  update public.tasks
  set status = 'paused',
      progress_note = coalesce(p_reason, progress_note),
      claimed_by_session_id = null,
      claim_token_hash = null,
      claimed_at = null,
      lease_expires_at = null
  where id = p_task_id;
  insert into public.task_events (
    workspace_id, task_id, type, actor_type, actor_id, data
  ) values (
    p_workspace_id, p_task_id, 'task_paused', 'user', p_user_id,
    jsonb_strip_nulls(jsonb_build_object('reason', p_reason, 'from', v_task.status))
  );
  perform public._recompute_ancestors(p_task_id);
  v_response := jsonb_build_object('task', public._task_payload(p_task_id));
  perform public._idempotency_finish(
    p_workspace_id, 'user:' || p_user_id::text, p_idempotency_key, v_response
  );
  return v_response;
end;
$$;

create or replace function public.resume_task(
  p_workspace_id uuid,
  p_user_id uuid,
  p_task_id uuid,
  p_reason text,
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
  v_task public.tasks%rowtype;
  v_new_status public.task_status;
  v_response jsonb;
begin
  perform public._assert_member(p_workspace_id, p_user_id);
  v_idempotency := public._idempotency_begin(
    p_workspace_id, 'user:' || p_user_id::text,
    p_idempotency_key, 'resume_task', p_request_hash
  );
  if v_idempotency ? 'cached_response' then return v_idempotency -> 'cached_response'; end if;

  perform public._lock_task_state_exclusive(p_workspace_id);

  select * into v_task from public.tasks
  where workspace_id = p_workspace_id and id = p_task_id for update;
  if not found then perform public._raise('TASK_NOT_FOUND'); end if;
  if v_task.status <> 'paused' then
    perform public._raise('INVALID_STATE_TRANSITION');
  end if;

  v_new_status := case when exists (
    select 1 from public.task_dependencies edge
    join public.tasks dependency on dependency.id = edge.depends_on_task_id
    where edge.task_id = p_task_id and dependency.status <> 'completed'
  ) then 'blocked'::public.task_status else 'ready'::public.task_status end;

  update public.tasks
  set status = v_new_status
  where id = p_task_id;
  insert into public.task_events (
    workspace_id, task_id, type, actor_type, actor_id, data
  ) values (
    p_workspace_id, p_task_id, 'task_resumed', 'user', p_user_id,
    jsonb_strip_nulls(jsonb_build_object('reason', p_reason, 'to', v_new_status))
  );
  perform public._recompute_ancestors(p_task_id);
  v_response := jsonb_build_object('task', public._task_payload(p_task_id));
  perform public._idempotency_finish(
    p_workspace_id, 'user:' || p_user_id::text, p_idempotency_key, v_response
  );
  return v_response;
end;
$$;

revoke execute on function public.pause_task(uuid, uuid, uuid, text, text, text)
from public, anon, authenticated;
revoke execute on function public.resume_task(uuid, uuid, uuid, text, text, text)
from public, anon, authenticated;
grant execute on function public.pause_task(uuid, uuid, uuid, text, text, text)
to service_role;
grant execute on function public.resume_task(uuid, uuid, uuid, text, text, text)
to service_role;
