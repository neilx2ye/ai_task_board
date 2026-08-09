-- Session-directed dispatch: Web Console work is reserved for a known, live
-- conversation. claim_next_task pulls only from the caller's own reservation
-- queue; it is not a workspace-wide task marketplace.

create index if not exists tasks_session_queue_idx
  on public.tasks (workspace_id, assigned_session_id, status, priority desc, created_at asc);

create or replace function public._enforce_directed_task_assignment()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'INSERT' then
    -- Work reported from CLI / APP, and subtasks created by an AI, remain in
    -- that same conversation context by default.
    if new.assigned_session_id is null
       and new.created_by_type = 'ai'
       and new.created_by_id is not null
       and exists (
         select 1 from public.ai_sessions s
         where s.workspace_id = new.workspace_id and s.id = new.created_by_id
       ) then
      new.assigned_session_id := new.created_by_id;
    end if;

    -- User-created Web Console work must target a session with a recent
    -- heartbeat. This applies to root tasks and user-created subtasks alike.
    if new.created_by_type = 'user' and (
      new.assigned_session_id is null or not exists (
        select 1 from public.ai_sessions s
        where s.workspace_id = new.workspace_id
          and s.id = new.assigned_session_id
          and s.status <> 'offline'
          and s.last_seen_at >= now() - interval '2 minutes'
      )
    ) then
      perform public._raise('SESSION_NOT_AUTHORIZED');
    end if;
  elsif tg_op = 'UPDATE' then
    -- Backfill old CLI-synced rows the next time their owning session reports
    -- them as running. Ordinary claims are intentionally not allowed to turn
    -- an unassigned legacy task into self-selected work.
    if new.status = 'running'
       and new.assigned_session_id is null
       and new.claimed_by_session_id is not null then
      new.assigned_session_id := new.claimed_by_session_id;
    end if;

    -- A Web reassignment of queued work is only valid while the destination
    -- session is alive. Active internal updates keep their existing binding.
    if new.assigned_session_id is distinct from old.assigned_session_id
       and new.assigned_session_id is not null
       and new.claimed_by_session_id is null
       and not exists (
         select 1 from public.ai_sessions s
         where s.workspace_id = new.workspace_id
           and s.id = new.assigned_session_id
           and s.status <> 'offline'
           and s.last_seen_at >= now() - interval '2 minutes'
       ) then
      perform public._raise('SESSION_NOT_AUTHORIZED');
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists tasks_directed_assignment_guard on public.tasks;
create trigger tasks_directed_assignment_guard
before insert or update on public.tasks
for each row execute function public._enforce_directed_task_assignment();

create or replace function public._claim_next_internal(
  p_workspace_id uuid,
  p_session_id uuid,
  p_claim_token_hash text,
  p_lease_seconds integer,
  p_preferred_root_task_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_task public.tasks%rowtype;
  v_old_session_id uuid;
  v_lease_seconds integer := greatest(60, least(coalesce(p_lease_seconds, 900), 3600));
begin
  if nullif(p_claim_token_hash, '') is null then
    perform public._raise('INVALID_CLAIM_TOKEN');
  end if;
  perform public._lock_task_state_shared(p_workspace_id);
  perform public._lock_ai_session(p_workspace_id, p_session_id);

  if exists (
    select 1 from public.tasks active
    where active.workspace_id = p_workspace_id
      and active.claimed_by_session_id = p_session_id
      and active.status in ('claimed', 'running')
      and active.lease_expires_at > now()
  ) then
    perform public._raise('SESSION_ALREADY_HAS_ACTIVE_TASK');
  end if;

  select candidate.* into v_task
  from public.tasks candidate
  join public.ai_sessions session
    on session.workspace_id = candidate.workspace_id and session.id = p_session_id
  where candidate.workspace_id = p_workspace_id
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
  order by
    (candidate.root_task_id = p_preferred_root_task_id) desc,
    candidate.priority desc,
    candidate.created_at asc,
    candidate.id asc
  for update of candidate skip locked
  limit 1;

  if not found then
    return null;
  end if;

  v_old_session_id := v_task.claimed_by_session_id;
  if v_old_session_id is not null and v_old_session_id <> p_session_id then
    perform 1 from public.ai_sessions old_session
    where old_session.id = v_old_session_id
    for update skip locked;
    if not found then perform public._raise('TASK_ALREADY_CLAIMED'); end if;

    update public.ai_sessions
    set current_task_id = null, status = public._idle_session_status(v_old_session_id)
    where workspace_id = p_workspace_id
      and id = v_old_session_id
      and current_task_id = v_task.id;

    insert into public.task_events (
      workspace_id, task_id, type, actor_type, actor_id, data
    ) values (
      p_workspace_id, v_task.id, 'claim_expired', 'system', null,
      jsonb_build_object('previous_session_id', v_old_session_id)
    );
  end if;

  update public.tasks
  set status = 'claimed',
      claimed_by_session_id = p_session_id,
      claim_token_hash = p_claim_token_hash,
      claimed_at = now(),
      lease_expires_at = now() + make_interval(secs => v_lease_seconds),
      completed_at = null
  where id = v_task.id;

  update public.ai_sessions
  set current_task_id = v_task.id, status = 'busy', last_seen_at = now()
  where workspace_id = p_workspace_id and id = p_session_id;

  insert into public.task_events (
    workspace_id, task_id, type, actor_type, actor_id, data
  ) values (
    p_workspace_id, v_task.id, 'task_claimed', 'ai', p_session_id,
    jsonb_build_object('lease_seconds', v_lease_seconds)
  );

  perform public._recompute_ancestors(v_task.id);
  return public._task_payload(v_task.id);
end;
$$;

create or replace function public._claim_task_internal(
  p_workspace_id uuid,
  p_session_id uuid,
  p_task_id uuid,
  p_claim_token_hash text,
  p_lease_seconds integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_task public.tasks%rowtype;
  v_session public.ai_sessions%rowtype;
  v_old_session_id uuid;
  v_lease_seconds integer := greatest(60, least(coalesce(p_lease_seconds, 900), 3600));
begin
  if nullif(p_claim_token_hash, '') is null then
    perform public._raise('INVALID_CLAIM_TOKEN');
  end if;
  perform public._lock_task_state_shared(p_workspace_id);
  perform public._lock_ai_session(p_workspace_id, p_session_id);
  if exists (
    select 1 from public.tasks active
    where active.workspace_id = p_workspace_id
      and active.claimed_by_session_id = p_session_id
      and active.id <> p_task_id
      and active.status in ('claimed', 'running')
      and active.lease_expires_at > now()
  ) then
    perform public._raise('SESSION_ALREADY_HAS_ACTIVE_TASK');
  end if;

  select * into v_session from public.ai_sessions
  where workspace_id = p_workspace_id and id = p_session_id;
  select * into v_task from public.tasks
  where workspace_id = p_workspace_id and id = p_task_id
  for update;

  if not found then perform public._raise('TASK_NOT_FOUND'); end if;
  if exists (select 1 from public.tasks child where child.parent_task_id = p_task_id) then
    perform public._raise('TASK_NOT_READY');
  end if;
  if not (
    v_task.status = 'ready'
    or (v_task.status in ('claimed', 'running') and v_task.lease_expires_at <= now())
  ) then
    if v_task.status in ('claimed', 'running') then
      perform public._raise('TASK_ALREADY_CLAIMED');
    end if;
    perform public._raise('TASK_NOT_READY');
  end if;
  if exists (
    select 1 from public.task_dependencies edge
    join public.tasks dependency on dependency.id = edge.depends_on_task_id
    where edge.task_id = p_task_id and dependency.status <> 'completed'
  ) then
    perform public._raise('TASK_NOT_READY');
  end if;
  if v_task.assigned_session_id is distinct from p_session_id then
    perform public._raise('SESSION_NOT_AUTHORIZED');
  end if;
  if not (v_task.required_capabilities <@ v_session.capabilities) then
    perform public._raise('CAPABILITY_MISMATCH');
  end if;

  v_old_session_id := v_task.claimed_by_session_id;
  if v_old_session_id is not null and v_old_session_id <> p_session_id then
    perform 1 from public.ai_sessions old_session
    where old_session.id = v_old_session_id
    for update skip locked;
    if not found then perform public._raise('TASK_ALREADY_CLAIMED'); end if;

    update public.ai_sessions
    set current_task_id = null, status = public._idle_session_status(v_old_session_id)
    where id = v_old_session_id and current_task_id = p_task_id;
    insert into public.task_events (workspace_id, task_id, type, actor_type, data)
    values (
      p_workspace_id, p_task_id, 'claim_expired', 'system',
      jsonb_build_object('previous_session_id', v_old_session_id)
    );
  end if;

  update public.tasks
  set status = 'claimed', claimed_by_session_id = p_session_id,
      claim_token_hash = p_claim_token_hash, claimed_at = now(),
      lease_expires_at = now() + make_interval(secs => v_lease_seconds),
      completed_at = null
  where id = p_task_id;
  update public.ai_sessions
  set current_task_id = p_task_id, status = 'busy', last_seen_at = now()
  where id = p_session_id;
  insert into public.task_events (workspace_id, task_id, type, actor_type, actor_id, data)
  values (
    p_workspace_id, p_task_id, 'task_claimed', 'ai', p_session_id,
    jsonb_build_object('lease_seconds', v_lease_seconds)
  );
  perform public._recompute_ancestors(p_task_id);
  return public._task_payload(p_task_id);
end;
$$;

-- The functions remain internal helpers; keep the privilege posture explicit.
revoke all on function public._enforce_directed_task_assignment() from public, anon, authenticated;
revoke all on function public._claim_next_internal(uuid, uuid, text, integer, uuid) from public, anon, authenticated;
revoke all on function public._claim_task_internal(uuid, uuid, uuid, text, integer) from public, anon, authenticated;
