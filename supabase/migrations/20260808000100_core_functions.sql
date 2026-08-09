-- AI Task Board: transaction-safe domain functions.
-- Claim/connection token *hashes* are supplied by trusted server code. Raw
-- tokens never enter PostgreSQL, event data, or idempotency responses.

create or replace function public._raise(p_code text)
returns void
language plpgsql
volatile
set search_path = pg_catalog
as $$
begin
  raise exception using errcode = 'P0001', message = p_code;
end;
$$;

create or replace function public.is_workspace_member(
  p_workspace_id uuid,
  p_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select p_user_id is not null and exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = p_workspace_id and wm.user_id = p_user_id
  );
$$;

create or replace function public.is_workspace_member(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.is_workspace_member(p_workspace_id, auth.uid());
$$;

create or replace function public.is_workspace_owner(
  p_workspace_id uuid,
  p_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select p_user_id is not null and exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = p_workspace_id
      and wm.user_id = p_user_id
      and wm.role = 'owner'
  );
$$;

create or replace function public.is_workspace_owner(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.is_workspace_owner(p_workspace_id, auth.uid());
$$;

create or replace function public._assert_member(p_workspace_id uuid, p_user_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if not public.is_workspace_member(p_workspace_id, p_user_id) then
    perform public._raise('SESSION_NOT_AUTHORIZED');
  end if;
end;
$$;

create or replace function public._assert_owner(p_workspace_id uuid, p_user_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if not public.is_workspace_owner(p_workspace_id, p_user_id) then
    perform public._raise('SESSION_NOT_AUTHORIZED');
  end if;
end;
$$;

-- The server passes the peppered hash of the bearer token it authenticated.
-- Comparing it again while holding the connection's shared advisory lock makes
-- rotation linearizable: an old-token request can only commit when it entered
-- this lock before the rotation transaction.
create or replace function public._assert_active_connection(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_api_token_hash text
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_connection_id is null or nullif(p_api_token_hash, '') is null then
    perform public._raise('SESSION_NOT_AUTHORIZED');
  end if;

  perform pg_advisory_xact_lock_shared(
    hashtextextended('ai-connection:' || p_connection_id::text, 0)
  );
  perform 1 from public.ai_connections c
  where c.workspace_id = p_workspace_id
    and c.id = p_connection_id
    and c.api_token_hash = p_api_token_hash
    and c.revoked_at is null;
  if not found then
    perform public._raise('SESSION_NOT_AUTHORIZED');
  end if;
end;
$$;

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

  if not exists (
    select 1 from public.ai_sessions s
    where s.workspace_id = p_workspace_id
      and s.connection_id = p_connection_id
      and s.id = p_session_id
  ) then
    perform public._raise('SESSION_NOT_AUTHORIZED');
  end if;
end;
$$;

-- Reserve an idempotency key before doing work. A concurrent request with the
-- same key blocks on this row, then observes the committed cached response.
create or replace function public._idempotency_begin(
  p_workspace_id uuid,
  p_actor_key text,
  p_idempotency_key text,
  p_operation text,
  p_request_hash text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_inserted boolean := false;
  v_record public.idempotency_records%rowtype;
begin
  if nullif(btrim(p_idempotency_key), '') is null
     or length(p_idempotency_key) > 300
     or nullif(btrim(p_request_hash), '') is null
     or length(p_request_hash) < 16 then
    perform public._raise('INVALID_IDEMPOTENCY_KEY');
  end if;

  insert into public.idempotency_records (
    workspace_id, actor_key, idempotency_key, operation, request_hash
  ) values (
    p_workspace_id, p_actor_key, p_idempotency_key, p_operation, p_request_hash
  )
  on conflict (workspace_id, actor_key, idempotency_key) do nothing
  returning true into v_inserted;

  if coalesce(v_inserted, false) then
    return jsonb_build_object('fresh', true);
  end if;

  select * into v_record
  from public.idempotency_records
  where workspace_id = p_workspace_id
    and actor_key = p_actor_key
    and idempotency_key = p_idempotency_key
  for update;

  if v_record.expires_at <= now() then
    update public.idempotency_records
    set operation = p_operation,
        request_hash = p_request_hash,
        response_json = null,
        created_at = now(),
        expires_at = now() + interval '24 hours'
    where workspace_id = p_workspace_id
      and actor_key = p_actor_key
      and idempotency_key = p_idempotency_key;
    return jsonb_build_object('fresh', true);
  end if;

  if v_record.operation <> p_operation or v_record.request_hash <> p_request_hash then
    perform public._raise('IDEMPOTENCY_CONFLICT');
  end if;

  if v_record.response_json is null then
    -- This should only be reachable if a privileged caller manually inserted a
    -- reservation outside these functions.
    perform public._raise('IDEMPOTENCY_INCOMPLETE');
  end if;

  return jsonb_build_object('cached_response', v_record.response_json);
end;
$$;

create or replace function public._idempotency_finish(
  p_workspace_id uuid,
  p_actor_key text,
  p_idempotency_key text,
  p_response jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_response is null then
    perform public._raise('IDEMPOTENCY_INCOMPLETE');
  end if;

  update public.idempotency_records
  set response_json = p_response
  where workspace_id = p_workspace_id
    and actor_key = p_actor_key
    and idempotency_key = p_idempotency_key
    and response_json is null;

  if not found then
    perform public._raise('IDEMPOTENCY_INCOMPLETE');
  end if;
end;
$$;

create or replace function public._task_payload(p_task_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with recursive task_tree as (
    select t.id, t.status, 0 as depth
    from public.tasks t
    where t.id = p_task_id
    union all
    select child.id, child.status, tree.depth + 1
    from public.tasks child
    join task_tree tree on child.parent_task_id = tree.id
    where child.status <> 'cancelled'
  ),
  leaf_progress as (
    select
      count(*) filter (where tree.status = 'completed')::integer as completed_leaves,
      count(*)::integer as total_leaves
    from task_tree tree
    where
      (tree.depth > 0 or not exists (
        select 1 from public.tasks any_child where any_child.parent_task_id = tree.id
      ))
      and not exists (
        select 1
        from public.tasks active_child
        where active_child.parent_task_id = tree.id
          and active_child.status <> 'cancelled'
      )
  )
  select
    (to_jsonb(t) - 'claim_token_hash') ||
    jsonb_build_object(
      'structured_progress', jsonb_build_object(
        'completed_leaves', coalesce(lp.completed_leaves, 0),
        'total_leaves', coalesce(lp.total_leaves, 0)
      )
    )
  from public.tasks t
  cross join leaf_progress lp
  where t.id = p_task_id;
$$;

create or replace function public._session_payload(p_session_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select to_jsonb(s) from public.ai_sessions s where s.id = p_session_id;
$$;

create or replace function public._connection_payload(p_connection_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select to_jsonb(c) - 'api_token_hash'
  from public.ai_connections c where c.id = p_connection_id;
$$;

create or replace function public._idle_session_status(p_session_id uuid)
returns public.ai_session_status
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select case when exists (
    select 1 from public.tasks waiting
    where waiting.assigned_session_id = p_session_id
      and waiting.status = 'waiting_user'
  ) then 'waiting'::public.ai_session_status else 'online'::public.ai_session_status end;
$$;

-- Claims take a shared workspace scheduling lock, so independent sessions may
-- still claim concurrently with SKIP LOCKED. Operations that can change whether
-- dependencies are satisfied take the matching exclusive lock.
create or replace function public._lock_task_state_shared(p_workspace_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
begin
  perform pg_advisory_xact_lock_shared(
    hashtextextended('task-state:' || p_workspace_id::text, 0)
  );
end;
$$;

create or replace function public._lock_task_state_exclusive(p_workspace_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('task-state:' || p_workspace_id::text, 0)
  );
end;
$$;

-- Session rows are locked only after the workspace task-state lock. Keeping
-- that order consistent prevents cancel/revoke (task -> session cleanup) from
-- deadlocking with an AI command (session -> leaf -> parent).
create or replace function public._lock_ai_session(
  p_workspace_id uuid,
  p_session_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
begin
  perform 1 from public.ai_sessions session
  where session.workspace_id = p_workspace_id and session.id = p_session_id
  for update;
  if not found then perform public._raise('SESSION_NOT_AUTHORIZED'); end if;
end;
$$;

create or replace function public._lock_valid_claim(
  p_workspace_id uuid,
  p_session_id uuid,
  p_task_id uuid,
  p_claim_token_hash text
)
returns public.tasks
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_task public.tasks%rowtype;
begin
  select * into v_task
  from public.tasks t
  where t.workspace_id = p_workspace_id and t.id = p_task_id
  for update;

  if not found then
    perform public._raise('TASK_NOT_FOUND');
  end if;
  if v_task.claimed_by_session_id is distinct from p_session_id then
    perform public._raise('SESSION_NOT_AUTHORIZED');
  end if;
  if nullif(p_claim_token_hash, '') is null
     or v_task.claim_token_hash is distinct from p_claim_token_hash then
    perform public._raise('INVALID_CLAIM_TOKEN');
  end if;
  if v_task.lease_expires_at is null or v_task.lease_expires_at <= now() then
    perform public._raise('LEASE_EXPIRED');
  end if;
  if v_task.status not in ('claimed', 'running') then
    perform public._raise('INVALID_STATE_TRANSITION');
  end if;
  return v_task;
end;
$$;

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

create or replace function public._recompute_ancestors(p_task_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_parent_id uuid;
begin
  select parent_task_id into v_parent_id from public.tasks where id = p_task_id;
  while v_parent_id is not null loop
    perform public._recompute_parent(v_parent_id);
    select parent_task_id into v_parent_id from public.tasks where id = v_parent_id;
  end loop;
end;
$$;

-- Keep task claim invariants valid if privileged maintenance physically deletes
-- a session (normal product behavior revokes connections instead of deleting).
create or replace function public._prepare_ai_session_delete()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_task record;
  v_new_status public.task_status;
begin
  -- During a workspace FK cascade, its tasks are removed as well; avoid
  -- manufacturing release events inside the disappearing workspace.
  if not exists (select 1 from public.workspaces w where w.id = old.workspace_id) then
    return old;
  end if;

  -- The DELETE executor already owns the session row. Never wait for the state
  -- lock while holding it: fail fast so a concurrent task command can finish
  -- instead of forming session-row -> state / state -> session-row deadlock.
  if not pg_try_advisory_xact_lock(
    hashtextextended('task-state:' || old.workspace_id::text, 0)
  ) then
    perform public._raise('INVALID_STATE_TRANSITION');
  end if;

  -- Lock the complete set before recomputing any shared parent. This avoids a
  -- multi-task maintenance delete taking parent -> sibling in the opposite
  -- order from a concurrent leaf command.
  perform 1
  from public.tasks t
  where t.workspace_id = old.workspace_id
    and t.claimed_by_session_id = old.id
  order by t.id
  for update;

  for v_task in
    select t.id
    from public.tasks t
    where t.workspace_id = old.workspace_id
      and t.claimed_by_session_id = old.id
    order by t.id
  loop
    v_new_status := case when exists (
      select 1 from public.task_dependencies edge
      join public.tasks dependency on dependency.id = edge.depends_on_task_id
      where edge.task_id = v_task.id and dependency.status <> 'completed'
    ) then 'blocked'::public.task_status else 'ready'::public.task_status end;
    update public.tasks
    set status = v_new_status,
        claimed_by_session_id = null, claim_token_hash = null,
        claimed_at = null, lease_expires_at = null
    where id = v_task.id;
    insert into public.task_events (workspace_id, task_id, type, actor_type, data)
    values (
      old.workspace_id, v_task.id, 'task_released', 'system',
      jsonb_build_object('reason', 'session deleted', 'session_id', old.id, 'to', v_new_status)
    );
    perform public._recompute_ancestors(v_task.id);
  end loop;

  update public.tasks
  set assigned_session_id = null
  where workspace_id = old.workspace_id and assigned_session_id = old.id;
  return old;
end;
$$;

drop trigger if exists ai_sessions_prepare_delete on public.ai_sessions;
create trigger ai_sessions_prepare_delete
before delete on public.ai_sessions
for each row execute function public._prepare_ai_session_delete();

create or replace function public._cleanup_session_after_task_delete()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.ai_sessions session
  set current_task_id = case when current_task_id = old.id then null else current_task_id end,
      status = case
        when current_task_id is not null and current_task_id <> old.id then status
        when current_task_id = old.id or session.id = old.assigned_session_id
          then public._idle_session_status(session.id)
        else status
      end
  where session.workspace_id = old.workspace_id
    and (
      session.current_task_id = old.id
      or session.id = old.claimed_by_session_id
      or session.id = old.assigned_session_id
    );
  if old.parent_task_id is not null
     and exists (select 1 from public.tasks parent where parent.id = old.parent_task_id) then
    perform public._recompute_parent(old.parent_task_id);
    perform public._recompute_ancestors(old.parent_task_id);
  end if;
  return old;
end;
$$;

drop trigger if exists tasks_cleanup_session_after_delete on public.tasks;
create trigger tasks_cleanup_session_after_delete
after delete on public.tasks
for each row execute function public._cleanup_session_after_task_delete();

-- Physical task deletion is service-maintenance only, but it can still change
-- an aggregate parent's completion boundary. Take the same state lock used by
-- product commands before the row disappears so cleanup/aggregation remains
-- serialized with downstream claims.
create or replace function public._lock_task_state_before_task_delete()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
begin
  -- As above, a row-level DELETE trigger must not block on the workspace lock
  -- after PostgreSQL has already locked the task tuple.
  if not pg_try_advisory_xact_lock(
    hashtextextended('task-state:' || old.workspace_id::text, 0)
  ) then
    perform public._raise('INVALID_STATE_TRANSITION');
  end if;
  return old;
end;
$$;

drop trigger if exists tasks_lock_state_before_delete on public.tasks;
create trigger tasks_lock_state_before_delete
before delete on public.tasks
for each row execute function public._lock_task_state_before_task_delete();

create or replace function public._refresh_unblocked_tasks(
  p_workspace_id uuid,
  p_completed_task_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_row record;
begin
  perform public._lock_task_state_exclusive(p_workspace_id);
  for v_row in
    update public.tasks t
    set status = 'ready'
    where t.workspace_id = p_workspace_id
      and t.status in ('inbox', 'blocked')
      and exists (
        select 1 from public.task_dependencies edge
        where edge.task_id = t.id and edge.depends_on_task_id = p_completed_task_id
      )
      and not exists (
        select 1 from public.tasks child where child.parent_task_id = t.id
      )
      and not exists (
        select 1
        from public.task_dependencies edge
        join public.tasks dependency on dependency.id = edge.depends_on_task_id
        where edge.task_id = t.id and dependency.status <> 'completed'
      )
    returning t.id, t.workspace_id
  loop
    insert into public.task_events (
      workspace_id, task_id, type, actor_type, actor_id, data
    ) values (
      v_row.workspace_id, v_row.id, 'dependencies_satisfied',
      'system', null, '{}'::jsonb
    );
    perform public._recompute_ancestors(v_row.id);
  end loop;
end;
$$;

create or replace function public._block_newly_unmet_dependents(
  p_workspace_id uuid,
  p_changed_task_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_row record;
begin
  perform public._lock_task_state_exclusive(p_workspace_id);
  for v_row in
    update public.tasks dependent
    set status = 'blocked'
    where dependent.workspace_id = p_workspace_id
      and dependent.status in ('inbox', 'ready')
      and not exists (
        select 1 from public.tasks child where child.parent_task_id = dependent.id
      )
      and exists (
        select 1 from public.task_dependencies edge
        where edge.task_id = dependent.id
          and edge.depends_on_task_id = p_changed_task_id
      )
      and exists (
        select 1
        from public.task_dependencies edge
        join public.tasks dependency on dependency.id = edge.depends_on_task_id
        where edge.task_id = dependent.id and dependency.status <> 'completed'
      )
    returning dependent.id, dependent.workspace_id
  loop
    insert into public.task_events (
      workspace_id, task_id, type, actor_type, actor_id, data
    ) values (
      v_row.workspace_id, v_row.id, 'dependency_became_unmet',
      'system', null, jsonb_build_object('dependency_task_id', p_changed_task_id)
    );
    perform public._recompute_ancestors(v_row.id);
  end loop;
end;
$$;

create or replace function public._assert_no_active_dependents(p_task_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_workspace_id uuid;
begin
  select workspace_id into v_workspace_id from public.tasks where id = p_task_id;
  if not found then perform public._raise('TASK_NOT_FOUND'); end if;
  perform public._lock_task_state_exclusive(v_workspace_id);
  perform 1
  from public.task_dependencies edge
  join public.tasks dependent on dependent.id = edge.task_id
  where edge.depends_on_task_id = p_task_id
  order by dependent.id
  for update of dependent;

  if exists (
    select 1
    from public.task_dependencies edge
    join public.tasks dependent on dependent.id = edge.task_id
    where edge.depends_on_task_id = p_task_id
      and dependent.status in ('claimed', 'running', 'waiting_user')
  ) then
    perform public._raise('INVALID_STATE_TRANSITION');
  end if;
end;
$$;

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
    -- claim_next is a pull transport for this session's reserved queue, not a
    -- workspace-wide marketplace where an AI chooses unassigned work.
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
    -- Never wait for an expired holder after locking the new holder and task.
    -- Two sessions can otherwise cross-take over each other's expired tasks as
    -- session A -> task B -> session B / session B -> task A -> session A.
    -- A lock collision rolls this attempt back; the caller can retry the same
    -- idempotency key once the competing session transaction finishes.
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

create or replace function public._create_subtasks_internal(
  p_workspace_id uuid,
  p_parent_task_id uuid,
  p_subtasks jsonb,
  p_actor_type public.actor_type,
  p_actor_id uuid,
  p_allow_existing_children boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_parent public.tasks%rowtype;
  v_item jsonb;
  v_ordinal bigint;
  v_client_ref text;
  v_task_id uuid;
  v_dependency_ref text;
  v_dependency_id uuid;
  v_mapping jsonb := '{}'::jsonb;
  v_created_ids uuid[] := '{}'::uuid[];
  v_created_payload jsonb;
  v_old_claimed_session_id uuid;
  v_old_assigned_session_id uuid;
begin
  if jsonb_typeof(p_subtasks) <> 'array'
     or jsonb_array_length(p_subtasks) < 1
     or jsonb_array_length(p_subtasks) > 100 then
    perform public._raise('INVALID_SUBTASKS');
  end if;

  select * into v_parent
  from public.tasks
  where workspace_id = p_workspace_id and id = p_parent_task_id
  for update;
  if not found then perform public._raise('TASK_NOT_FOUND'); end if;
  if not coalesce(p_allow_existing_children, false)
     and exists (select 1 from public.tasks c where c.parent_task_id = p_parent_task_id) then
    perform public._raise('INVALID_STATE_TRANSITION');
  end if;
  if v_parent.status in ('cancelled', 'waiting_user') then
    perform public._raise('INVALID_STATE_TRANSITION');
  end if;
  if v_parent.status = 'completed' then
    perform public._assert_no_active_dependents(p_parent_task_id);
  end if;

  -- First pass creates every task, allowing dependencies to reference later
  -- client refs without making input order significant.
  for v_item, v_ordinal in
    select value, ordinality from jsonb_array_elements(p_subtasks) with ordinality
  loop
    if jsonb_typeof(v_item) <> 'object'
       or nullif(btrim(v_item ->> 'title'), '') is null then
      perform public._raise('INVALID_SUBTASKS');
    end if;

    v_client_ref := coalesce(
      nullif(v_item ->> 'client_ref', ''),
      nullif(v_item ->> 'client_id', ''),
      nullif(v_item ->> 'id', ''),
      v_ordinal::text
    );
    if v_mapping ? v_client_ref then
      perform public._raise('INVALID_SUBTASKS');
    end if;

    if v_item ? 'required_capabilities'
       and jsonb_typeof(v_item -> 'required_capabilities') <> 'array' then
      perform public._raise('INVALID_SUBTASKS');
    end if;

    v_task_id := extensions.gen_random_uuid();
    v_mapping := v_mapping || jsonb_build_object(v_client_ref, v_task_id::text);
    v_created_ids := array_append(v_created_ids, v_task_id);

    begin
      insert into public.tasks (
        id, workspace_id, parent_task_id, root_task_id,
        title, description, acceptance_criteria, status, priority, position,
        assigned_session_id, required_capabilities,
        created_by_type, created_by_id
      ) values (
        v_task_id, p_workspace_id, p_parent_task_id, v_parent.root_task_id,
        btrim(v_item ->> 'title'),
        nullif(v_item ->> 'description', ''),
        nullif(v_item ->> 'acceptance_criteria', ''),
        'inbox',
        coalesce((v_item ->> 'priority')::integer, v_parent.priority),
        coalesce((v_item ->> 'position')::integer, v_ordinal::integer - 1),
        case
          when nullif(v_item ->> 'assigned_session_id', '') is not null
            then (v_item ->> 'assigned_session_id')::uuid
          -- AI 拆分出来的工作默认留在当前对话上下文中，不能掉进公共池。
          when p_actor_type = 'ai' then p_actor_id
          else null
        end,
        array(
          select distinct capability
          from jsonb_array_elements_text(
            coalesce(v_item -> 'required_capabilities', '[]'::jsonb)
          ) as capability
          where nullif(btrim(capability), '') is not null
        ),
        p_actor_type, p_actor_id
      );
    exception
      when invalid_text_representation or numeric_value_out_of_range or foreign_key_violation then
        perform public._raise('INVALID_SUBTASKS');
    end;
  end loop;

  -- Second pass resolves either a client ref from this batch or an existing
  -- workspace task UUID. The dependency trigger performs recursive cycle checks.
  for v_item, v_ordinal in
    select value, ordinality from jsonb_array_elements(p_subtasks) with ordinality
  loop
    v_task_id := v_created_ids[v_ordinal::integer];
    if v_item ? 'depends_on' and jsonb_typeof(v_item -> 'depends_on') <> 'array' then
      perform public._raise('INVALID_SUBTASKS');
    end if;
    if v_item ? 'depends_on_task_ids'
       and jsonb_typeof(v_item -> 'depends_on_task_ids') <> 'array' then
      perform public._raise('INVALID_SUBTASKS');
    end if;

    for v_dependency_ref in
      select distinct ref
      from jsonb_array_elements_text(
        coalesce(v_item -> 'depends_on', '[]'::jsonb) ||
        coalesce(v_item -> 'depends_on_task_ids', '[]'::jsonb)
      ) as ref
    loop
      if v_mapping ? v_dependency_ref then
        v_dependency_id := (v_mapping ->> v_dependency_ref)::uuid;
      else
        begin
          v_dependency_id := v_dependency_ref::uuid;
        exception when invalid_text_representation then
          perform public._raise('DEPENDENCY_NOT_FOUND');
        end;
      end if;

      if exists (
        with recursive ancestors(id, parent_task_id) as (
          select parent.id, parent.parent_task_id
          from public.tasks parent where parent.id = p_parent_task_id
          union all
          select ancestor.id, ancestor.parent_task_id
          from public.tasks ancestor
          join ancestors current_parent on current_parent.parent_task_id = ancestor.id
        )
        select 1 from ancestors where id = v_dependency_id
      ) then
        perform public._raise('DEPENDENCY_CYCLE');
      end if;
      if not exists (
        select 1 from public.tasks dependency
        where dependency.workspace_id = p_workspace_id
          and dependency.id = v_dependency_id
      ) then
        perform public._raise('DEPENDENCY_NOT_FOUND');
      end if;

      insert into public.task_dependencies (task_id, depends_on_task_id)
      values (v_task_id, v_dependency_id);
    end loop;
  end loop;

  -- A task becomes aggregation-only after splitting, so its prerequisites must
  -- also gate every runnable leaf. Copy every parent edge to all effective
  -- direct children in the same graph-locked transaction. Keep the parent edge
  -- as inheritance metadata so children appended in a later request receive the
  -- same prerequisite set.
  perform pg_advisory_xact_lock(
    hashtextextended('task-dependencies:' || p_workspace_id::text, 0)
  );
  insert into public.task_dependencies (task_id, depends_on_task_id)
  select child.id, edge.depends_on_task_id
  from public.tasks child
  join public.task_dependencies edge on edge.task_id = p_parent_task_id
  where child.parent_task_id = p_parent_task_id
    and child.status <> 'cancelled'
  on conflict (task_id, depends_on_task_id) do nothing;

  -- Dependency readiness is a leaf concern. An existing aggregate child gets
  -- its status from its own descendants; rewriting it here would flatten a
  -- blocked/waiting/completed aggregate back to ready merely because a sibling
  -- was appended to the parent.
  update public.tasks child
  set status = case when exists (
    select 1
    from public.task_dependencies edge
    join public.tasks dependency on dependency.id = edge.depends_on_task_id
    where edge.task_id = child.id and dependency.status <> 'completed'
  ) then 'blocked'::public.task_status else 'ready'::public.task_status end
  where child.parent_task_id = p_parent_task_id
    and child.status in ('inbox', 'ready', 'blocked')
    and not exists (
      select 1
      from public.tasks grandchild
      where grandchild.parent_task_id = child.id
    );

  -- A parent with children is aggregation-only and can no longer own a lease.
  v_old_claimed_session_id := v_parent.claimed_by_session_id;
  v_old_assigned_session_id := v_parent.assigned_session_id;
  update public.tasks
  set status = 'blocked',
      assigned_session_id = null,
      claimed_by_session_id = null,
      claim_token_hash = null,
      claimed_at = null,
      lease_expires_at = null,
      completed_at = null
  where id = p_parent_task_id;

  if v_old_claimed_session_id is not null or v_old_assigned_session_id is not null then
    update public.ai_sessions session
    set current_task_id = case
          when session.current_task_id = p_parent_task_id then null
          else session.current_task_id
        end,
        status = case
          when session.current_task_id is not null
               and session.current_task_id <> p_parent_task_id then session.status
          else public._idle_session_status(session.id)
        end,
        last_seen_at = now()
    where session.id = any(array_remove(
      array[v_old_claimed_session_id, v_old_assigned_session_id], null
    ));
  end if;

  foreach v_task_id in array v_created_ids loop
    update public.tasks t
    set status = case
      when not exists (
        select 1
        from public.task_dependencies edge
        join public.tasks dependency on dependency.id = edge.depends_on_task_id
        where edge.task_id = t.id and dependency.status <> 'completed'
      ) then 'ready'::public.task_status
      else 'blocked'::public.task_status
    end
    where t.id = v_task_id;

    insert into public.task_events (
      workspace_id, task_id, type, actor_type, actor_id, data
    ) values (
      p_workspace_id, v_task_id, 'subtask_created', p_actor_type, p_actor_id,
      jsonb_build_object('parent_task_id', p_parent_task_id)
    );
  end loop;

  insert into public.task_events (
    workspace_id, task_id, type, actor_type, actor_id, data
  ) values (
    p_workspace_id, p_parent_task_id, 'task_split', p_actor_type, p_actor_id,
    jsonb_build_object('subtask_count', cardinality(v_created_ids))
  );

  perform public._recompute_parent(p_parent_task_id);
  perform public._recompute_ancestors(p_parent_task_id);
  if v_parent.status = 'completed' then
    perform public._block_newly_unmet_dependents(p_workspace_id, p_parent_task_id);
  end if;

  select jsonb_agg(public._task_payload(item.id) order by item.ordinality)
  into v_created_payload
  from unnest(v_created_ids) with ordinality as item(id, ordinality);

  return jsonb_build_object(
    'parent_task', public._task_payload(p_parent_task_id),
    'subtasks', coalesce(v_created_payload, '[]'::jsonb)
  );
end;
$$;

create or replace function public._insert_completion_artifacts(
  p_workspace_id uuid,
  p_task_id uuid,
  p_session_id uuid,
  p_artifacts jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_item jsonb;
  v_artifact_id uuid;
  v_storage_path text;
  v_external_url text;
  v_path_parts text[];
  v_ids uuid[] := '{}'::uuid[];
  v_response jsonb;
begin
  if p_artifacts is null then return '[]'::jsonb; end if;
  if jsonb_typeof(p_artifacts) <> 'array' or jsonb_array_length(p_artifacts) > 100 then
    perform public._raise('INVALID_ARTIFACTS');
  end if;

  for v_item in select value from jsonb_array_elements(p_artifacts)
  loop
    if jsonb_typeof(v_item) <> 'object'
       or nullif(btrim(v_item ->> 'name'), '') is null
       or nullif(btrim(v_item ->> 'mime_type'), '') is null then
      perform public._raise('INVALID_ARTIFACTS');
    end if;
    v_storage_path := nullif(v_item ->> 'storage_path', '');
    v_external_url := nullif(v_item ->> 'external_url', '');
    if v_storage_path is not null and v_external_url is not null then
      perform public._raise('INVALID_ARTIFACTS');
    end if;
    if v_storage_path is null and v_external_url is null then
      perform public._raise('INVALID_ARTIFACTS');
    end if;
    if v_storage_path is not null then
      v_path_parts := string_to_array(v_storage_path, '/');
      if cardinality(v_path_parts) <> 3
         or v_path_parts[1] <> p_workspace_id::text
         or v_path_parts[2] <> p_task_id::text
         or v_path_parts[3] !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}-[A-Za-z0-9][A-Za-z0-9._ -]{0,199}$'
         or position('..' in v_path_parts[3]) > 0 then
        perform public._raise('INVALID_ARTIFACTS');
      end if;
    end if;
    if v_external_url is not null and v_external_url !~ '^https?://' then
      perform public._raise('INVALID_ARTIFACTS');
    end if;

    v_artifact_id := extensions.gen_random_uuid();
    begin
      insert into public.artifacts (
        id, workspace_id, task_id, name, mime_type, size,
        storage_path, external_url, created_by_session_id
      ) values (
        v_artifact_id, p_workspace_id, p_task_id,
        btrim(v_item ->> 'name'), btrim(v_item ->> 'mime_type'),
        coalesce((v_item ->> 'size')::bigint, 0),
        v_storage_path, v_external_url, p_session_id
      );
    exception when invalid_text_representation or numeric_value_out_of_range then
      perform public._raise('INVALID_ARTIFACTS');
    end;
    v_ids := array_append(v_ids, v_artifact_id);
  end loop;

  select coalesce(jsonb_agg(to_jsonb(a) order by item.ordinality), '[]'::jsonb)
  into v_response
  from unnest(v_ids) with ordinality as item(id, ordinality)
  join public.artifacts a on a.id = item.id;
  return v_response;
end;
$$;

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
      last_seen_at = now()
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

-- ---------------------------------------------------------------------------
-- Required AI RPCs
-- ---------------------------------------------------------------------------

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
      external_conversation_ref, capabilities, status, last_seen_at
    ) values (
      p_workspace_id, p_connection_id, btrim(p_name), btrim(p_platform),
      nullif(btrim(p_model), ''), btrim(p_external_conversation_ref),
      coalesce(p_capabilities, '{}'::text[]), 'online', now()
    )
    on conflict (connection_id, external_conversation_ref)
      where external_conversation_ref is not null
    do update set
      name = excluded.name,
      platform = excluded.platform,
      model = excluded.model,
      capabilities = excluded.capabilities,
      status = case
        when public.ai_sessions.current_task_id is null
          then public._idle_session_status(public.ai_sessions.id)
        else 'busy'::public.ai_session_status
      end,
      last_seen_at = now()
    returning id into v_session_id;
  else
    insert into public.ai_sessions (
      workspace_id, connection_id, name, platform, model,
      capabilities, status, last_seen_at
    ) values (
      p_workspace_id, p_connection_id, btrim(p_name), btrim(p_platform),
      nullif(btrim(p_model), ''), coalesce(p_capabilities, '{}'::text[]),
      'online', now()
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

create or replace function public.report_current_task(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_api_token_hash text,
  p_session_id uuid,
  p_title text,
  p_description text,
  p_acceptance_criteria text,
  p_external_source text,
  p_external_task_ref text,
  p_external_conversation_ref text,
  p_priority integer,
  p_progress_note text,
  p_progress_percent_estimate integer,
  p_required_capabilities text[],
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
  v_idempotency jsonb;
  v_session public.ai_sessions%rowtype;
  v_task public.tasks%rowtype;
  v_source text;
  v_task_id uuid;
  v_old_session_id uuid;
  v_lease_seconds integer := greatest(60, least(coalesce(p_lease_seconds, 900), 3600));
  v_response jsonb;
begin
  perform public._assert_active_session(
    p_workspace_id, p_connection_id, p_api_token_hash, p_session_id
  );
  v_idempotency := public._idempotency_begin(
    p_workspace_id, 'session:' || p_session_id::text,
    p_idempotency_key, 'report_current_task', p_request_hash
  );
  if v_idempotency ? 'cached_response' then
    return v_idempotency -> 'cached_response';
  end if;

  perform public._lock_task_state_exclusive(p_workspace_id);
  perform public._lock_ai_session(p_workspace_id, p_session_id);

  if nullif(btrim(p_title), '') is null
     or nullif(btrim(p_external_task_ref), '') is null
     or nullif(p_claim_token_hash, '') is null
     or p_progress_percent_estimate not between 0 and 100 then
    perform public._raise('INVALID_TASK');
  end if;

  select * into v_session from public.ai_sessions
  where workspace_id = p_workspace_id and id = p_session_id;
  v_source := coalesce(nullif(btrim(p_external_source), ''), v_session.platform);

  -- Serialize the external identity so different idempotency keys cannot race
  -- into a duplicate card or steal one another's lease.
  perform pg_advisory_xact_lock(
    hashtextextended(p_workspace_id::text || ':' || v_source || ':' || p_external_task_ref, 0)
  );

  select * into v_task
  from public.tasks t
  where t.workspace_id = p_workspace_id
    and t.external_source = v_source
    and t.external_task_ref = p_external_task_ref
  for update;

  if found then
    v_task_id := v_task.id;
    if v_task.status in ('cancelled', 'waiting_user') then
      perform public._raise('INVALID_STATE_TRANSITION');
    end if;
    if v_task.status = 'completed' then
      perform public._assert_no_active_dependents(v_task.id);
    end if;
    if exists (select 1 from public.tasks child where child.parent_task_id = v_task.id) then
      perform public._raise('INVALID_STATE_TRANSITION');
    end if;
    if exists (
      select 1 from public.task_dependencies edge
      join public.tasks dependency on dependency.id = edge.depends_on_task_id
      where edge.task_id = v_task.id and dependency.status <> 'completed'
    ) then
      perform public._raise('TASK_NOT_READY');
    end if;
    if v_task.assigned_session_id is not null
       and v_task.assigned_session_id <> p_session_id then
      perform public._raise('SESSION_NOT_AUTHORIZED');
    end if;
    if v_task.claimed_by_session_id is not null
       and v_task.claimed_by_session_id <> p_session_id
       and v_task.lease_expires_at > now() then
      perform public._raise('TASK_ALREADY_CLAIMED');
    end if;
    v_old_session_id := v_task.claimed_by_session_id;
  else
    v_task_id := extensions.gen_random_uuid();
  end if;

  if exists (
    select 1 from public.tasks active
    where active.workspace_id = p_workspace_id
      and active.claimed_by_session_id = p_session_id
      and active.id <> v_task_id
      and active.status in ('claimed', 'running')
      and active.lease_expires_at > now()
  ) then
    perform public._raise('SESSION_ALREADY_HAS_ACTIVE_TASK');
  end if;

  if v_old_session_id is not null and v_old_session_id <> p_session_id then
    update public.ai_sessions
    set current_task_id = null, status = public._idle_session_status(v_old_session_id)
    where id = v_old_session_id and current_task_id = v_task_id;
    insert into public.task_events (workspace_id, task_id, type, actor_type, data)
    values (
      p_workspace_id, v_task_id, 'claim_expired', 'system',
      jsonb_build_object('previous_session_id', v_old_session_id)
    );
  end if;

  if v_task.id is null then
    insert into public.tasks (
      id, workspace_id, title, description, acceptance_criteria, status,
      priority, assigned_session_id, claimed_by_session_id, claim_token_hash, claimed_at,
      lease_expires_at, required_capabilities, external_source,
      external_task_ref, external_conversation_ref, progress_note,
      progress_percent_estimate, created_by_type, created_by_id
    ) values (
      v_task_id, p_workspace_id, btrim(p_title), nullif(p_description, ''),
      nullif(p_acceptance_criteria, ''), 'running', coalesce(p_priority, 0),
      p_session_id, p_session_id, p_claim_token_hash, now(),
      now() + make_interval(secs => v_lease_seconds),
      coalesce(p_required_capabilities, '{}'::text[]), v_source,
      btrim(p_external_task_ref),
      coalesce(nullif(p_external_conversation_ref, ''), v_session.external_conversation_ref),
      p_progress_note, p_progress_percent_estimate, 'ai', p_session_id
    );
  else
    update public.tasks
    set title = btrim(p_title),
        description = p_description,
        acceptance_criteria = p_acceptance_criteria,
        status = 'running',
        priority = coalesce(p_priority, priority),
        assigned_session_id = p_session_id,
        claimed_by_session_id = p_session_id,
        claim_token_hash = p_claim_token_hash,
        claimed_at = now(),
        lease_expires_at = now() + make_interval(secs => v_lease_seconds),
        required_capabilities = coalesce(p_required_capabilities, required_capabilities),
        external_conversation_ref = coalesce(
          nullif(p_external_conversation_ref, ''), external_conversation_ref,
          v_session.external_conversation_ref
        ),
        progress_note = p_progress_note,
        progress_percent_estimate = p_progress_percent_estimate,
        completed_at = null
    where id = v_task_id;
  end if;

  update public.ai_sessions
  set current_task_id = v_task_id, status = 'busy', last_seen_at = now()
  where id = p_session_id;
  insert into public.task_events (
    workspace_id, task_id, type, actor_type, actor_id, data
  ) values (
    p_workspace_id, v_task_id, 'current_task_reported', 'ai', p_session_id,
    jsonb_build_object('external_source', v_source, 'external_task_ref', p_external_task_ref)
  );
  if v_task.status = 'completed' then
    perform public._block_newly_unmet_dependents(p_workspace_id, v_task_id);
  end if;
  perform public._recompute_ancestors(v_task_id);

  v_response := jsonb_build_object('task', public._task_payload(v_task_id));
  perform public._idempotency_finish(
    p_workspace_id, 'session:' || p_session_id::text, p_idempotency_key, v_response
  );
  return v_response;
end;
$$;

create or replace function public.claim_next_task(
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
  v_idempotency jsonb;
  v_task jsonb;
  v_response jsonb;
begin
  perform public._assert_active_session(
    p_workspace_id, p_connection_id, p_api_token_hash, p_session_id
  );
  v_idempotency := public._idempotency_begin(
    p_workspace_id, 'session:' || p_session_id::text,
    p_idempotency_key, 'claim_next_task', p_request_hash
  );
  if v_idempotency ? 'cached_response' then
    return v_idempotency -> 'cached_response';
  end if;

  v_task := public._claim_next_internal(
    p_workspace_id, p_session_id, p_claim_token_hash, p_lease_seconds, null
  );
  v_response := jsonb_build_object('task', v_task);
  perform public._idempotency_finish(
    p_workspace_id, 'session:' || p_session_id::text, p_idempotency_key, v_response
  );
  return v_response;
end;
$$;

create or replace function public.create_subtasks(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_api_token_hash text,
  p_session_id uuid,
  p_parent_task_id uuid,
  p_claim_token_hash text,
  p_subtasks jsonb,
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
  v_response jsonb;
begin
  perform public._assert_active_session(
    p_workspace_id, p_connection_id, p_api_token_hash, p_session_id
  );
  v_idempotency := public._idempotency_begin(
    p_workspace_id, 'session:' || p_session_id::text,
    p_idempotency_key, 'create_subtasks', p_request_hash
  );
  if v_idempotency ? 'cached_response' then
    return v_idempotency -> 'cached_response';
  end if;

  perform public._lock_task_state_exclusive(p_workspace_id);
  perform public._lock_ai_session(p_workspace_id, p_session_id);

  select claim.* into v_claim
  from public._lock_valid_claim(
    p_workspace_id, p_session_id, p_parent_task_id, p_claim_token_hash
  ) as claim;

  v_response := public._create_subtasks_internal(
    p_workspace_id, p_parent_task_id, p_subtasks, 'ai', p_session_id, false
  );
  perform public._idempotency_finish(
    p_workspace_id, 'session:' || p_session_id::text, p_idempotency_key, v_response
  );
  return v_response;
end;
$$;

create or replace function public.heartbeat_claim(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_api_token_hash text,
  p_session_id uuid,
  p_task_id uuid,
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
  v_idempotency jsonb;
  v_claim public.tasks%rowtype;
  v_lease_seconds integer := greatest(60, least(coalesce(p_lease_seconds, 900), 3600));
  v_response jsonb;
begin
  perform public._assert_active_session(
    p_workspace_id, p_connection_id, p_api_token_hash, p_session_id
  );
  v_idempotency := public._idempotency_begin(
    p_workspace_id, 'session:' || p_session_id::text,
    p_idempotency_key, 'heartbeat_claim', p_request_hash
  );
  if v_idempotency ? 'cached_response' then
    return v_idempotency -> 'cached_response';
  end if;

  perform public._lock_task_state_shared(p_workspace_id);
  perform public._lock_ai_session(p_workspace_id, p_session_id);

  select claim.* into v_claim
  from public._lock_valid_claim(
    p_workspace_id, p_session_id, p_task_id, p_claim_token_hash
  ) as claim;
  update public.tasks
  set lease_expires_at = now() + make_interval(secs => v_lease_seconds)
  where id = p_task_id;
  update public.ai_sessions
  set status = 'busy', current_task_id = p_task_id, last_seen_at = now()
  where id = p_session_id;
  insert into public.task_events (workspace_id, task_id, type, actor_type, actor_id, data)
  values (
    p_workspace_id, p_task_id, 'claim_heartbeat', 'ai', p_session_id,
    jsonb_build_object('lease_seconds', v_lease_seconds)
  );

  v_response := jsonb_build_object('task', public._task_payload(p_task_id));
  perform public._idempotency_finish(
    p_workspace_id, 'session:' || p_session_id::text, p_idempotency_key, v_response
  );
  return v_response;
end;
$$;

create or replace function public.request_user_input(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_api_token_hash text,
  p_session_id uuid,
  p_task_id uuid,
  p_claim_token_hash text,
  p_question text,
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
  v_message_id uuid := extensions.gen_random_uuid();
  v_response jsonb;
begin
  perform public._assert_active_session(
    p_workspace_id, p_connection_id, p_api_token_hash, p_session_id
  );
  v_idempotency := public._idempotency_begin(
    p_workspace_id, 'session:' || p_session_id::text,
    p_idempotency_key, 'request_user_input', p_request_hash
  );
  if v_idempotency ? 'cached_response' then
    return v_idempotency -> 'cached_response';
  end if;
  if nullif(btrim(p_question), '') is null then
    perform public._raise('INVALID_MESSAGE');
  end if;

  perform public._lock_task_state_shared(p_workspace_id);
  perform public._lock_ai_session(p_workspace_id, p_session_id);

  select claim.* into v_claim
  from public._lock_valid_claim(
    p_workspace_id, p_session_id, p_task_id, p_claim_token_hash
  ) as claim;
  insert into public.task_messages (
    id, workspace_id, task_id, sender_type, sender_id, content, requires_response
  ) values (
    v_message_id, p_workspace_id, p_task_id, 'ai', p_session_id,
    btrim(p_question), true
  );
  update public.tasks
  set status = 'waiting_user',
      assigned_session_id = p_session_id,
      claimed_by_session_id = null,
      claim_token_hash = null,
      claimed_at = null,
      lease_expires_at = null
  where id = p_task_id;
  update public.ai_sessions
  set current_task_id = null, status = 'waiting', last_seen_at = now()
  where id = p_session_id;
  insert into public.task_events (workspace_id, task_id, type, actor_type, actor_id, data)
  values (
    p_workspace_id, p_task_id, 'user_input_requested', 'ai', p_session_id,
    jsonb_build_object('message_id', v_message_id, 'unread_for_user', true)
  );
  perform public._recompute_ancestors(p_task_id);

  v_response := jsonb_build_object(
    'task', public._task_payload(p_task_id),
    'message', (select to_jsonb(m) from public.task_messages m where m.id = v_message_id)
  );
  perform public._idempotency_finish(
    p_workspace_id, 'session:' || p_session_id::text, p_idempotency_key, v_response
  );
  return v_response;
end;
$$;

create or replace function public.complete_task_and_claim_next(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_api_token_hash text,
  p_session_id uuid,
  p_task_id uuid,
  p_claim_token_hash text,
  p_result_summary text,
  p_result_json jsonb,
  p_message_content text,
  p_artifacts jsonb,
  p_next_claim_token_hash text,
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
  v_idempotency jsonb;
  v_claim public.tasks%rowtype;
  v_root_task_id uuid;
  v_completion jsonb;
  v_next_task jsonb;
  v_response jsonb;
begin
  perform public._assert_active_session(
    p_workspace_id, p_connection_id, p_api_token_hash, p_session_id
  );
  v_idempotency := public._idempotency_begin(
    p_workspace_id, 'session:' || p_session_id::text,
    p_idempotency_key, 'complete_task_and_claim_next', p_request_hash
  );
  if v_idempotency ? 'cached_response' then
    return v_idempotency -> 'cached_response';
  end if;

  perform public._lock_task_state_exclusive(p_workspace_id);
  perform public._lock_ai_session(p_workspace_id, p_session_id);

  select claim.* into v_claim
  from public._lock_valid_claim(
    p_workspace_id, p_session_id, p_task_id, p_claim_token_hash
  ) as claim;
  v_root_task_id := v_claim.root_task_id;
  v_completion := public._complete_task_internal(
    p_workspace_id, p_session_id, p_task_id, p_result_summary,
    p_result_json, p_message_content, p_artifacts
  );
  v_next_task := public._claim_next_internal(
    p_workspace_id, p_session_id, p_next_claim_token_hash,
    p_lease_seconds, v_root_task_id
  );
  v_response := v_completion || jsonb_build_object('next_task', v_next_task);
  perform public._idempotency_finish(
    p_workspace_id, 'session:' || p_session_id::text, p_idempotency_key, v_response
  );
  return v_response;
end;
$$;

-- ---------------------------------------------------------------------------
-- Additional AI commands, sharing the same claim and state validators.
-- ---------------------------------------------------------------------------

create or replace function public.claim_task(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_api_token_hash text,
  p_session_id uuid,
  p_task_id uuid,
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
  v_idempotency jsonb;
  v_task jsonb;
  v_response jsonb;
begin
  perform public._assert_active_session(
    p_workspace_id, p_connection_id, p_api_token_hash, p_session_id
  );
  v_idempotency := public._idempotency_begin(
    p_workspace_id, 'session:' || p_session_id::text,
    p_idempotency_key, 'claim_task', p_request_hash
  );
  if v_idempotency ? 'cached_response' then return v_idempotency -> 'cached_response'; end if;

  v_task := public._claim_task_internal(
    p_workspace_id, p_session_id, p_task_id, p_claim_token_hash, p_lease_seconds
  );
  v_response := jsonb_build_object('task', v_task);
  perform public._idempotency_finish(
    p_workspace_id, 'session:' || p_session_id::text, p_idempotency_key, v_response
  );
  return v_response;
end;
$$;

create or replace function public.report_progress(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_api_token_hash text,
  p_session_id uuid,
  p_task_id uuid,
  p_claim_token_hash text,
  p_progress_note text,
  p_progress_percent_estimate integer,
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
  v_response jsonb;
begin
  perform public._assert_active_session(
    p_workspace_id, p_connection_id, p_api_token_hash, p_session_id
  );
  v_idempotency := public._idempotency_begin(
    p_workspace_id, 'session:' || p_session_id::text,
    p_idempotency_key, 'report_progress', p_request_hash
  );
  if v_idempotency ? 'cached_response' then return v_idempotency -> 'cached_response'; end if;
  if p_progress_percent_estimate is not null
     and p_progress_percent_estimate not between 0 and 100 then
    perform public._raise('INVALID_PROGRESS');
  end if;

  perform public._lock_task_state_shared(p_workspace_id);
  perform public._lock_ai_session(p_workspace_id, p_session_id);

  select claim.* into v_claim
  from public._lock_valid_claim(
    p_workspace_id, p_session_id, p_task_id, p_claim_token_hash
  ) as claim;
  update public.tasks
  set status = 'running', progress_note = p_progress_note,
      progress_percent_estimate = p_progress_percent_estimate
  where id = p_task_id;
  update public.ai_sessions set status = 'busy', last_seen_at = now()
  where id = p_session_id;
  insert into public.task_events (workspace_id, task_id, type, actor_type, actor_id, data)
  values (
    p_workspace_id, p_task_id, 'progress_reported', 'ai', p_session_id,
    jsonb_strip_nulls(jsonb_build_object(
      'note', p_progress_note, 'percent_estimate', p_progress_percent_estimate
    ))
  );
  perform public._recompute_ancestors(p_task_id);

  v_response := jsonb_build_object('task', public._task_payload(p_task_id));
  perform public._idempotency_finish(
    p_workspace_id, 'session:' || p_session_id::text, p_idempotency_key, v_response
  );
  return v_response;
end;
$$;

create or replace function public.post_task_message(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_api_token_hash text,
  p_session_id uuid,
  p_task_id uuid,
  p_claim_token_hash text,
  p_content text,
  p_reply_to_message_id uuid,
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
  v_message_id uuid := extensions.gen_random_uuid();
  v_response jsonb;
begin
  perform public._assert_active_session(
    p_workspace_id, p_connection_id, p_api_token_hash, p_session_id
  );
  v_idempotency := public._idempotency_begin(
    p_workspace_id, 'session:' || p_session_id::text,
    p_idempotency_key, 'post_task_message', p_request_hash
  );
  if v_idempotency ? 'cached_response' then return v_idempotency -> 'cached_response'; end if;
  if nullif(btrim(p_content), '') is null then perform public._raise('INVALID_MESSAGE'); end if;

  perform public._lock_task_state_shared(p_workspace_id);
  perform public._lock_ai_session(p_workspace_id, p_session_id);

  select claim.* into v_claim
  from public._lock_valid_claim(
    p_workspace_id, p_session_id, p_task_id, p_claim_token_hash
  ) as claim;
  insert into public.task_messages (
    id, workspace_id, task_id, sender_type, sender_id, content, reply_to_message_id
  ) values (
    v_message_id, p_workspace_id, p_task_id, 'ai', p_session_id,
    btrim(p_content), p_reply_to_message_id
  );
  insert into public.task_events (workspace_id, task_id, type, actor_type, actor_id, data)
  values (
    p_workspace_id, p_task_id, 'message_posted', 'ai', p_session_id,
    jsonb_build_object('message_id', v_message_id)
  );
  update public.ai_sessions set last_seen_at = now()
  where workspace_id = p_workspace_id and id = p_session_id;

  v_response := jsonb_build_object(
    'task', public._task_payload(p_task_id),
    'message', (select to_jsonb(m) from public.task_messages m where m.id = v_message_id)
  );
  perform public._idempotency_finish(
    p_workspace_id, 'session:' || p_session_id::text, p_idempotency_key, v_response
  );
  return v_response;
end;
$$;

create or replace function public.complete_task(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_api_token_hash text,
  p_session_id uuid,
  p_task_id uuid,
  p_claim_token_hash text,
  p_result_summary text,
  p_result_json jsonb,
  p_message_content text,
  p_artifacts jsonb,
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
  v_response jsonb;
begin
  perform public._assert_active_session(
    p_workspace_id, p_connection_id, p_api_token_hash, p_session_id
  );
  v_idempotency := public._idempotency_begin(
    p_workspace_id, 'session:' || p_session_id::text,
    p_idempotency_key, 'complete_task', p_request_hash
  );
  if v_idempotency ? 'cached_response' then return v_idempotency -> 'cached_response'; end if;

  perform public._lock_task_state_exclusive(p_workspace_id);
  perform public._lock_ai_session(p_workspace_id, p_session_id);

  select claim.* into v_claim
  from public._lock_valid_claim(
    p_workspace_id, p_session_id, p_task_id, p_claim_token_hash
  ) as claim;
  v_response := public._complete_task_internal(
    p_workspace_id, p_session_id, p_task_id, p_result_summary,
    p_result_json, p_message_content, p_artifacts
  );
  perform public._idempotency_finish(
    p_workspace_id, 'session:' || p_session_id::text, p_idempotency_key, v_response
  );
  return v_response;
end;
$$;

create or replace function public.fail_task(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_api_token_hash text,
  p_session_id uuid,
  p_task_id uuid,
  p_claim_token_hash text,
  p_reason text,
  p_result_json jsonb,
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
  v_response jsonb;
begin
  perform public._assert_active_session(
    p_workspace_id, p_connection_id, p_api_token_hash, p_session_id
  );
  v_idempotency := public._idempotency_begin(
    p_workspace_id, 'session:' || p_session_id::text,
    p_idempotency_key, 'fail_task', p_request_hash
  );
  if v_idempotency ? 'cached_response' then return v_idempotency -> 'cached_response'; end if;
  if nullif(btrim(p_reason), '') is null then perform public._raise('INVALID_FAILURE'); end if;

  perform public._lock_task_state_shared(p_workspace_id);
  perform public._lock_ai_session(p_workspace_id, p_session_id);

  select claim.* into v_claim
  from public._lock_valid_claim(
    p_workspace_id, p_session_id, p_task_id, p_claim_token_hash
  ) as claim;
  update public.tasks
  set status = 'failed', progress_note = p_reason,
      result_summary = p_reason, result_json = p_result_json,
      completed_at = null,
      claimed_by_session_id = null, claim_token_hash = null,
      claimed_at = null, lease_expires_at = null
  where id = p_task_id;
  update public.ai_sessions
  set current_task_id = null,
      status = public._idle_session_status(p_session_id),
      last_seen_at = now()
  where id = p_session_id and current_task_id = p_task_id;
  insert into public.task_events (workspace_id, task_id, type, actor_type, actor_id, data)
  values (
    p_workspace_id, p_task_id, 'task_failed', 'ai', p_session_id,
    jsonb_build_object('reason', p_reason)
  );
  perform public._recompute_ancestors(p_task_id);

  v_response := jsonb_build_object('task', public._task_payload(p_task_id));
  perform public._idempotency_finish(
    p_workspace_id, 'session:' || p_session_id::text, p_idempotency_key, v_response
  );
  return v_response;
end;
$$;

create or replace function public.release_task(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_api_token_hash text,
  p_session_id uuid,
  p_task_id uuid,
  p_claim_token_hash text,
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
  v_claim public.tasks%rowtype;
  v_new_status public.task_status;
  v_response jsonb;
begin
  perform public._assert_active_session(
    p_workspace_id, p_connection_id, p_api_token_hash, p_session_id
  );
  v_idempotency := public._idempotency_begin(
    p_workspace_id, 'session:' || p_session_id::text,
    p_idempotency_key, 'release_task', p_request_hash
  );
  if v_idempotency ? 'cached_response' then return v_idempotency -> 'cached_response'; end if;

  perform public._lock_task_state_shared(p_workspace_id);
  perform public._lock_ai_session(p_workspace_id, p_session_id);

  select claim.* into v_claim
  from public._lock_valid_claim(
    p_workspace_id, p_session_id, p_task_id, p_claim_token_hash
  ) as claim;
  v_new_status := case when exists (
    select 1 from public.task_dependencies edge
    join public.tasks dependency on dependency.id = edge.depends_on_task_id
    where edge.task_id = p_task_id and dependency.status <> 'completed'
  ) then 'blocked'::public.task_status else 'ready'::public.task_status end;

  update public.tasks
  set status = v_new_status, progress_note = coalesce(p_reason, progress_note),
      claimed_by_session_id = null, claim_token_hash = null,
      claimed_at = null, lease_expires_at = null
  where id = p_task_id;
  update public.ai_sessions
  set current_task_id = null,
      status = public._idle_session_status(p_session_id),
      last_seen_at = now()
  where id = p_session_id and current_task_id = p_task_id;
  insert into public.task_events (workspace_id, task_id, type, actor_type, actor_id, data)
  values (
    p_workspace_id, p_task_id, 'task_released', 'ai', p_session_id,
    jsonb_strip_nulls(jsonb_build_object('reason', p_reason, 'to', v_new_status))
  );
  perform public._recompute_ancestors(p_task_id);

  v_response := jsonb_build_object('task', public._task_payload(p_task_id));
  perform public._idempotency_finish(
    p_workspace_id, 'session:' || p_session_id::text, p_idempotency_key, v_response
  );
  return v_response;
end;
$$;

create or replace function public.heartbeat_ai_session(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_api_token_hash text,
  p_session_id uuid,
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
  v_response jsonb;
begin
  perform public._assert_active_session(
    p_workspace_id, p_connection_id, p_api_token_hash, p_session_id
  );
  v_idempotency := public._idempotency_begin(
    p_workspace_id, 'session:' || p_session_id::text,
    p_idempotency_key, 'heartbeat_ai_session', p_request_hash
  );
  if v_idempotency ? 'cached_response' then return v_idempotency -> 'cached_response'; end if;

  perform public._lock_task_state_shared(p_workspace_id);
  perform public._lock_ai_session(p_workspace_id, p_session_id);

  update public.ai_sessions
  set last_seen_at = now(),
      status = case
        when current_task_id is not null then status
        when exists (
          select 1 from public.tasks waiting
          where waiting.workspace_id = p_workspace_id
            and waiting.assigned_session_id = p_session_id
            and waiting.status = 'waiting_user'
        ) then 'waiting'::public.ai_session_status
        else 'online'::public.ai_session_status
      end
  where id = p_session_id;
  v_response := jsonb_build_object('session', public._session_payload(p_session_id));
  perform public._idempotency_finish(
    p_workspace_id, 'session:' || p_session_id::text, p_idempotency_key, v_response
  );
  return v_response;
end;
$$;

-- ---------------------------------------------------------------------------
-- User commands. Server routes pass the authenticated user id; membership is
-- rechecked in PostgreSQL so an admin client cannot accidentally cross tenants.
-- ---------------------------------------------------------------------------

create or replace function public.create_user_task(
  p_workspace_id uuid,
  p_user_id uuid,
  p_parent_task_id uuid,
  p_title text,
  p_description text,
  p_acceptance_criteria text,
  p_priority integer,
  p_position integer,
  p_assigned_session_id uuid,
  p_required_capabilities text[],
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
  v_parent public.tasks%rowtype;
  v_task_id uuid := extensions.gen_random_uuid();
  v_response jsonb;
begin
  perform public._assert_member(p_workspace_id, p_user_id);
  v_idempotency := public._idempotency_begin(
    p_workspace_id, 'user:' || p_user_id::text,
    p_idempotency_key, 'create_user_task', p_request_hash
  );
  if v_idempotency ? 'cached_response' then return v_idempotency -> 'cached_response'; end if;
  if nullif(btrim(p_title), '') is null then perform public._raise('INVALID_TASK'); end if;

  perform public._lock_task_state_exclusive(p_workspace_id);

  if p_parent_task_id is not null then
    select * into v_parent from public.tasks
    where workspace_id = p_workspace_id and id = p_parent_task_id
    for update;
    if not found then perform public._raise('TASK_NOT_FOUND'); end if;
    if v_parent.status in ('cancelled', 'waiting_user')
       or v_parent.claimed_by_session_id is not null then
      perform public._raise('INVALID_STATE_TRANSITION');
    end if;
    if v_parent.status = 'completed' then
      perform public._assert_no_active_dependents(p_parent_task_id);
    end if;
  end if;
  if p_assigned_session_id is null or not exists (
    select 1 from public.ai_sessions s
    where s.workspace_id = p_workspace_id
      and s.id = p_assigned_session_id
      and s.status <> 'offline'
      and s.last_seen_at >= now() - interval '2 minutes'
  ) then
    perform public._raise('SESSION_NOT_AUTHORIZED');
  end if;

  insert into public.tasks (
    id, workspace_id, parent_task_id, root_task_id, title, description,
    acceptance_criteria, status, priority, position, assigned_session_id,
    required_capabilities, created_by_type, created_by_id
  ) values (
    v_task_id, p_workspace_id, p_parent_task_id,
    coalesce(v_parent.root_task_id, v_task_id), btrim(p_title), p_description,
    p_acceptance_criteria, 'ready', coalesce(p_priority, 0), p_position,
    p_assigned_session_id, coalesce(p_required_capabilities, '{}'::text[]),
    'user', p_user_id
  );
  insert into public.task_events (workspace_id, task_id, type, actor_type, actor_id, data)
  values (
    p_workspace_id, v_task_id, 'task_created', 'user', p_user_id,
    jsonb_strip_nulls(jsonb_build_object('parent_task_id', p_parent_task_id))
  );
  if p_parent_task_id is not null then
    perform pg_advisory_xact_lock(
      hashtextextended('task-dependencies:' || p_workspace_id::text, 0)
    );
    insert into public.task_dependencies (task_id, depends_on_task_id)
    select child.id, edge.depends_on_task_id
    from public.tasks child
    join public.task_dependencies edge on edge.task_id = p_parent_task_id
    where child.parent_task_id = p_parent_task_id
      and child.status <> 'cancelled'
    on conflict (task_id, depends_on_task_id) do nothing;

    -- Only runnable leaves are gated directly by dependency edges. Preserve
    -- existing aggregate siblings: their status is derived from grandchildren.
    update public.tasks child
    set status = case when exists (
      select 1
      from public.task_dependencies edge
      join public.tasks dependency on dependency.id = edge.depends_on_task_id
      where edge.task_id = child.id and dependency.status <> 'completed'
    ) then 'blocked'::public.task_status else 'ready'::public.task_status end
    where child.parent_task_id = p_parent_task_id
      and child.status in ('inbox', 'ready', 'blocked')
      and not exists (
        select 1
        from public.tasks grandchild
        where grandchild.parent_task_id = child.id
      );

    -- Aggregates are not directly assigned. This also releases a session that
    -- had been waiting for user input on the former leaf.
    update public.tasks set assigned_session_id = null
    where id = p_parent_task_id;
    if v_parent.assigned_session_id is not null then
      update public.ai_sessions session
      set current_task_id = case
            when session.current_task_id = p_parent_task_id then null
            else session.current_task_id
          end,
          status = case
            when session.current_task_id is not null
                 and session.current_task_id <> p_parent_task_id then session.status
            else public._idle_session_status(session.id)
          end,
          last_seen_at = now()
      where session.id = v_parent.assigned_session_id;
    end if;
    perform public._recompute_parent(p_parent_task_id);
    perform public._recompute_ancestors(p_parent_task_id);
    if v_parent.status = 'completed' then
      perform public._block_newly_unmet_dependents(p_workspace_id, p_parent_task_id);
    end if;
  end if;

  v_response := jsonb_build_object('task', public._task_payload(v_task_id));
  perform public._idempotency_finish(
    p_workspace_id, 'user:' || p_user_id::text, p_idempotency_key, v_response
  );
  return v_response;
end;
$$;

create or replace function public.update_user_task(
  p_workspace_id uuid,
  p_user_id uuid,
  p_task_id uuid,
  p_patch jsonb,
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
  v_has_children boolean := false;
  v_response jsonb;
begin
  perform public._assert_member(p_workspace_id, p_user_id);
  v_idempotency := public._idempotency_begin(
    p_workspace_id, 'user:' || p_user_id::text,
    p_idempotency_key, 'update_user_task', p_request_hash
  );
  if v_idempotency ? 'cached_response' then return v_idempotency -> 'cached_response'; end if;
  if jsonb_typeof(p_patch) <> 'object'
     or exists (
       select 1 from jsonb_object_keys(p_patch) key
       where key not in (
         'title', 'description', 'acceptance_criteria', 'priority', 'position',
         'assigned_session_id', 'required_capabilities'
       )
  ) then
    perform public._raise('INVALID_TASK_PATCH');
  end if;

  if p_patch ? 'assigned_session_id' then
    perform public._lock_task_state_exclusive(p_workspace_id);
  end if;

  select * into v_task from public.tasks
  where workspace_id = p_workspace_id and id = p_task_id
  for update;
  if not found then perform public._raise('TASK_NOT_FOUND'); end if;
  if v_task.status = 'cancelled' then perform public._raise('INVALID_STATE_TRANSITION'); end if;
  if p_patch ? 'title' and nullif(btrim(p_patch ->> 'title'), '') is null then
    perform public._raise('INVALID_TASK_PATCH');
  end if;
  if p_patch ? 'assigned_session_id' then
    select exists (
      select 1 from public.tasks child where child.parent_task_id = p_task_id
    ) into v_has_children;

    -- Aggregates are scheduling summaries, never directly assignable work.
    -- A null patch remains available as a one-way repair for historical rows,
    -- including a parent currently shown as running because a child is active.
    if v_has_children
       and nullif(p_patch ->> 'assigned_session_id', '') is not null then
      perform public._raise('INVALID_STATE_TRANSITION');
    end if;

    if v_task.status in ('claimed', 'running')
       and not (
         v_has_children
         and nullif(p_patch ->> 'assigned_session_id', '') is null
       ) then
      perform public._raise('INVALID_STATE_TRANSITION');
    end if;
  end if;
  if p_patch ? 'assigned_session_id'
     and v_task.status = 'waiting_user'
     and nullif(p_patch ->> 'assigned_session_id', '') is not null then
    -- While waiting, the original AI remains the preferred responder. A user
    -- may remove that preference, but cannot silently hand the pending question
    -- to a different session.
    perform public._raise('INVALID_STATE_TRANSITION');
  end if;
  if p_patch ? 'assigned_session_id'
     and nullif(p_patch ->> 'assigned_session_id', '') is not null
     and not exists (
       select 1 from public.ai_sessions s
       where s.workspace_id = p_workspace_id
         and s.id = (p_patch ->> 'assigned_session_id')::uuid
         and s.status <> 'offline'
         and s.last_seen_at >= now() - interval '2 minutes'
     ) then
    perform public._raise('SESSION_NOT_AUTHORIZED');
  end if;
  if p_patch ? 'required_capabilities'
     and jsonb_typeof(p_patch -> 'required_capabilities') <> 'array' then
    perform public._raise('INVALID_TASK_PATCH');
  end if;

  begin
    update public.tasks
    set title = case when p_patch ? 'title' then btrim(p_patch ->> 'title') else title end,
        description = case when p_patch ? 'description' then p_patch ->> 'description' else description end,
        acceptance_criteria = case
          when p_patch ? 'acceptance_criteria' then p_patch ->> 'acceptance_criteria'
          else acceptance_criteria
        end,
        priority = case when p_patch ? 'priority' then (p_patch ->> 'priority')::integer else priority end,
        position = case when p_patch ? 'position' then (p_patch ->> 'position')::integer else position end,
        assigned_session_id = case
          when p_patch ? 'assigned_session_id'
            then nullif(p_patch ->> 'assigned_session_id', '')::uuid
          else assigned_session_id
        end,
        required_capabilities = case
          when p_patch ? 'required_capabilities' then array(
            select distinct capability
            from jsonb_array_elements_text(p_patch -> 'required_capabilities') capability
            where nullif(btrim(capability), '') is not null
          )
          else required_capabilities
        end
    where id = p_task_id;
  exception when invalid_text_representation or numeric_value_out_of_range then
    perform public._raise('INVALID_TASK_PATCH');
  end;

  if p_patch ? 'assigned_session_id'
     and v_task.assigned_session_id is not null then
    update public.ai_sessions session
    set status = public._idle_session_status(session.id)
    where session.id = v_task.assigned_session_id
      and session.current_task_id is null;
  end if;

  insert into public.task_events (workspace_id, task_id, type, actor_type, actor_id, data)
  values (
    p_workspace_id, p_task_id, 'task_updated', 'user', p_user_id,
    jsonb_build_object('fields', (select jsonb_agg(key) from jsonb_object_keys(p_patch) key))
  );
  v_response := jsonb_build_object('task', public._task_payload(p_task_id));
  perform public._idempotency_finish(
    p_workspace_id, 'user:' || p_user_id::text, p_idempotency_key, v_response
  );
  return v_response;
end;
$$;

create or replace function public.create_user_subtasks(
  p_workspace_id uuid,
  p_user_id uuid,
  p_parent_task_id uuid,
  p_subtasks jsonb,
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
  v_parent public.tasks%rowtype;
  v_response jsonb;
begin
  perform public._assert_member(p_workspace_id, p_user_id);
  v_idempotency := public._idempotency_begin(
    p_workspace_id, 'user:' || p_user_id::text,
    p_idempotency_key, 'create_user_subtasks', p_request_hash
  );
  if v_idempotency ? 'cached_response' then return v_idempotency -> 'cached_response'; end if;

  perform public._lock_task_state_exclusive(p_workspace_id);

  select * into v_parent from public.tasks
  where workspace_id = p_workspace_id and id = p_parent_task_id
  for update;
  if not found then perform public._raise('TASK_NOT_FOUND'); end if;
  if v_parent.status = 'waiting_user' then
    perform public._raise('INVALID_STATE_TRANSITION');
  end if;
  if v_parent.claimed_by_session_id is not null then
    perform public._raise('TASK_ALREADY_CLAIMED');
  end if;

  v_response := public._create_subtasks_internal(
    p_workspace_id, p_parent_task_id, p_subtasks, 'user', p_user_id, true
  );
  perform public._idempotency_finish(
    p_workspace_id, 'user:' || p_user_id::text, p_idempotency_key, v_response
  );
  return v_response;
end;
$$;

create or replace function public.post_user_task_message(
  p_workspace_id uuid,
  p_user_id uuid,
  p_task_id uuid,
  p_content text,
  p_reply_to_message_id uuid,
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
  v_message_id uuid := extensions.gen_random_uuid();
  v_response jsonb;
begin
  perform public._assert_member(p_workspace_id, p_user_id);
  v_idempotency := public._idempotency_begin(
    p_workspace_id, 'user:' || p_user_id::text,
    p_idempotency_key, 'post_user_task_message', p_request_hash
  );
  if v_idempotency ? 'cached_response' then return v_idempotency -> 'cached_response'; end if;
  if nullif(btrim(p_content), '') is null then perform public._raise('INVALID_MESSAGE'); end if;
  if not exists (
    select 1 from public.tasks t
    where t.workspace_id = p_workspace_id and t.id = p_task_id
  ) then perform public._raise('TASK_NOT_FOUND'); end if;

  insert into public.task_messages (
    id, workspace_id, task_id, sender_type, sender_id, content, reply_to_message_id
  ) values (
    v_message_id, p_workspace_id, p_task_id, 'user', p_user_id,
    btrim(p_content), p_reply_to_message_id
  );
  insert into public.task_events (workspace_id, task_id, type, actor_type, actor_id, data)
  values (
    p_workspace_id, p_task_id, 'message_posted', 'user', p_user_id,
    jsonb_build_object('message_id', v_message_id)
  );

  v_response := jsonb_build_object(
    'task', public._task_payload(p_task_id),
    'message', (select to_jsonb(m) from public.task_messages m where m.id = v_message_id)
  );
  perform public._idempotency_finish(
    p_workspace_id, 'user:' || p_user_id::text, p_idempotency_key, v_response
  );
  return v_response;
end;
$$;

create or replace function public.reply_to_task(
  p_workspace_id uuid,
  p_user_id uuid,
  p_task_id uuid,
  p_content text,
  p_reply_to_message_id uuid,
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
  v_message_id uuid := extensions.gen_random_uuid();
  v_new_status public.task_status;
  v_response jsonb;
begin
  perform public._assert_member(p_workspace_id, p_user_id);
  v_idempotency := public._idempotency_begin(
    p_workspace_id, 'user:' || p_user_id::text,
    p_idempotency_key, 'reply_to_task', p_request_hash
  );
  if v_idempotency ? 'cached_response' then return v_idempotency -> 'cached_response'; end if;
  if nullif(btrim(p_content), '') is null then perform public._raise('INVALID_MESSAGE'); end if;

  -- This command discovers the assigned session from the task row and updates
  -- that session afterwards. Exclusive state ownership drains AI commands that
  -- lock session -> task, preventing the inverse task -> session deadlock.
  perform public._lock_task_state_exclusive(p_workspace_id);

  select * into v_task from public.tasks
  where workspace_id = p_workspace_id and id = p_task_id
  for update;
  if not found then perform public._raise('TASK_NOT_FOUND'); end if;
  if v_task.status <> 'waiting_user' or not exists (
    select 1 from public.task_messages m
    where m.task_id = p_task_id and m.requires_response and m.read_at is null
  ) then
    perform public._raise('INVALID_STATE_TRANSITION');
  end if;

  insert into public.task_messages (
    id, workspace_id, task_id, sender_type, sender_id, content, reply_to_message_id
  ) values (
    v_message_id, p_workspace_id, p_task_id, 'user', p_user_id,
    btrim(p_content), p_reply_to_message_id
  );
  update public.task_messages
  set read_at = now()
  where task_id = p_task_id and requires_response and read_at is null;

  v_new_status := case when exists (
    select 1 from public.task_dependencies edge
    join public.tasks dependency on dependency.id = edge.depends_on_task_id
    where edge.task_id = p_task_id and dependency.status <> 'completed'
  ) then 'blocked'::public.task_status else 'ready'::public.task_status end;
  update public.tasks set status = v_new_status where id = p_task_id;
  if v_task.assigned_session_id is not null then
    update public.ai_sessions
    set status = case
      when current_task_id is null then public._idle_session_status(v_task.assigned_session_id)
      else status
    end
    where id = v_task.assigned_session_id;
  end if;
  insert into public.task_events (workspace_id, task_id, type, actor_type, actor_id, data)
  values (
    p_workspace_id, p_task_id, 'user_replied', 'user', p_user_id,
    jsonb_build_object('message_id', v_message_id, 'to', v_new_status, 'unread_for_ai', true)
  );
  perform public._recompute_ancestors(p_task_id);

  v_response := jsonb_build_object(
    'task', public._task_payload(p_task_id),
    'message', (select to_jsonb(m) from public.task_messages m where m.id = v_message_id)
  );
  perform public._idempotency_finish(
    p_workspace_id, 'user:' || p_user_id::text, p_idempotency_key, v_response
  );
  return v_response;
end;
$$;

create or replace function public.release_task_by_user(
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
    p_idempotency_key, 'release_task_by_user', p_request_hash
  );
  if v_idempotency ? 'cached_response' then return v_idempotency -> 'cached_response'; end if;

  perform public._lock_task_state_exclusive(p_workspace_id);

  select * into v_task from public.tasks
  where workspace_id = p_workspace_id and id = p_task_id for update;
  if not found then perform public._raise('TASK_NOT_FOUND'); end if;
  if v_task.claimed_by_session_id is null or v_task.status not in ('claimed', 'running') then
    perform public._raise('INVALID_STATE_TRANSITION');
  end if;
  v_new_status := case when exists (
    select 1 from public.task_dependencies edge
    join public.tasks dependency on dependency.id = edge.depends_on_task_id
    where edge.task_id = p_task_id and dependency.status <> 'completed'
  ) then 'blocked'::public.task_status else 'ready'::public.task_status end;

  update public.ai_sessions
  set current_task_id = null,
      status = public._idle_session_status(v_task.claimed_by_session_id)
  where id = v_task.claimed_by_session_id and current_task_id = p_task_id;
  update public.tasks
  set status = v_new_status, claimed_by_session_id = null,
      claim_token_hash = null, claimed_at = null, lease_expires_at = null
  where id = p_task_id;
  insert into public.task_events (workspace_id, task_id, type, actor_type, actor_id, data)
  values (
    p_workspace_id, p_task_id, 'task_released', 'user', p_user_id,
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

create or replace function public.cancel_task(
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
  v_target_ids uuid[];
  v_target_id uuid;
  v_old_status public.task_status;
  v_assigned_session_ids uuid[];
  v_response jsonb;
begin
  perform public._assert_member(p_workspace_id, p_user_id);
  v_idempotency := public._idempotency_begin(
    p_workspace_id, 'user:' || p_user_id::text,
    p_idempotency_key, 'cancel_task', p_request_hash
  );
  if v_idempotency ? 'cached_response' then return v_idempotency -> 'cached_response'; end if;

  perform public._lock_task_state_exclusive(p_workspace_id);

  select * into v_task from public.tasks
  where workspace_id = p_workspace_id and id = p_task_id for update;
  if not found then perform public._raise('TASK_NOT_FOUND'); end if;
  if v_task.status = 'cancelled' then perform public._raise('INVALID_STATE_TRANSITION'); end if;
  if v_task.status = 'completed' then
    perform public._assert_no_active_dependents(p_task_id);
  end if;

  with recursive descendants(id) as (
    select p_task_id
    union all
    select child.id from public.tasks child
    join descendants parent on child.parent_task_id = parent.id
    where child.workspace_id = p_workspace_id
  )
  select array_agg(id order by id) into v_target_ids from descendants;

  select array_agg(distinct assigned_session_id)
  into v_assigned_session_ids
  from public.tasks
  where id = any(v_target_ids) and assigned_session_id is not null;

  perform 1 from public.tasks
  where id = any(v_target_ids) order by id for update;

  foreach v_target_id in array v_target_ids loop
    select status into v_old_status from public.tasks where id = v_target_id;
    if v_target_id = p_task_id or v_old_status not in ('completed', 'cancelled') then
      update public.tasks
      set status = 'cancelled', completed_at = null,
          assigned_session_id = null,
          claimed_by_session_id = null, claim_token_hash = null,
          claimed_at = null, lease_expires_at = null
      where id = v_target_id;
      insert into public.task_events (workspace_id, task_id, type, actor_type, actor_id, data)
      values (
        p_workspace_id, v_target_id, 'task_cancelled', 'user', p_user_id,
        jsonb_strip_nulls(jsonb_build_object(
          'reason', p_reason, 'from', v_old_status,
          'cascade', v_target_id <> p_task_id
        ))
      );
    end if;
  end loop;

  -- Cancellation resolves every outstanding question in the cancelled
  -- subtree. `read_at is null` is the current persisted pending-response
  -- marker, so close it in the same transaction while retaining the message.
  update public.task_messages
  set read_at = now()
  where workspace_id = p_workspace_id
    and task_id = any(v_target_ids)
    and requires_response
    and read_at is null;

  update public.ai_sessions session
  set current_task_id = null,
      status = public._idle_session_status(session.id)
  where session.workspace_id = p_workspace_id
    and session.current_task_id = any(v_target_ids);

  update public.ai_sessions session
  set status = case when exists (
    select 1 from public.tasks waiting
    where waiting.assigned_session_id = session.id
      and waiting.status = 'waiting_user'
  ) then 'waiting'::public.ai_session_status else 'online'::public.ai_session_status end
  where session.id = any(coalesce(v_assigned_session_ids, '{}'::uuid[]))
    and session.current_task_id is null;

  if v_task.status = 'completed' then
    perform public._block_newly_unmet_dependents(p_workspace_id, p_task_id);
  end if;

  perform public._recompute_ancestors(p_task_id);
  v_response := jsonb_build_object('task', public._task_payload(p_task_id));
  perform public._idempotency_finish(
    p_workspace_id, 'user:' || p_user_id::text, p_idempotency_key, v_response
  );
  return v_response;
end;
$$;

create or replace function public.reopen_task(
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
    p_idempotency_key, 'reopen_task', p_request_hash
  );
  if v_idempotency ? 'cached_response' then return v_idempotency -> 'cached_response'; end if;

  perform public._lock_task_state_exclusive(p_workspace_id);

  select * into v_task from public.tasks
  where workspace_id = p_workspace_id and id = p_task_id for update;
  if not found then perform public._raise('TASK_NOT_FOUND'); end if;
  if v_task.status not in ('completed', 'failed')
     or exists (select 1 from public.tasks c where c.parent_task_id = p_task_id) then
    perform public._raise('INVALID_STATE_TRANSITION');
  end if;
  if v_task.status = 'completed' then
    perform public._assert_no_active_dependents(p_task_id);
  end if;
  v_new_status := case when exists (
    select 1 from public.task_dependencies edge
    join public.tasks dependency on dependency.id = edge.depends_on_task_id
    where edge.task_id = p_task_id and dependency.status <> 'completed'
  ) then 'blocked'::public.task_status else 'ready'::public.task_status end;

  update public.tasks
  set status = v_new_status, completed_at = null,
      result_summary = null, result_json = null,
      progress_percent_estimate = null,
      progress_note = coalesce(p_reason, progress_note)
  where id = p_task_id;
  insert into public.task_events (workspace_id, task_id, type, actor_type, actor_id, data)
  values (
    p_workspace_id, p_task_id, 'task_reopened', 'user', p_user_id,
    jsonb_strip_nulls(jsonb_build_object('reason', p_reason, 'from', v_task.status, 'to', v_new_status))
  );
  if v_task.status = 'completed' then
    perform public._block_newly_unmet_dependents(p_workspace_id, p_task_id);
  end if;
  perform public._recompute_ancestors(p_task_id);
  v_response := jsonb_build_object('task', public._task_payload(p_task_id));
  perform public._idempotency_finish(
    p_workspace_id, 'user:' || p_user_id::text, p_idempotency_key, v_response
  );
  return v_response;
end;
$$;

create or replace function public.create_user_artifact(
  p_workspace_id uuid,
  p_user_id uuid,
  p_task_id uuid,
  p_artifact_id uuid,
  p_name text,
  p_mime_type text,
  p_size bigint,
  p_storage_path text,
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
  v_parts text[];
  v_response jsonb;
begin
  perform public._assert_member(p_workspace_id, p_user_id);
  v_idempotency := public._idempotency_begin(
    p_workspace_id, 'user:' || p_user_id::text,
    p_idempotency_key, 'create_user_artifact', p_request_hash
  );
  if v_idempotency ? 'cached_response' then return v_idempotency -> 'cached_response'; end if;

  if not exists (
    select 1 from public.tasks t
    where t.workspace_id = p_workspace_id
      and t.id = p_task_id
      and t.status <> 'cancelled'
  ) then
    perform public._raise('TASK_NOT_FOUND');
  end if;
  if nullif(btrim(p_name), '') is null
     or length(btrim(p_name)) > 500
     or nullif(btrim(p_mime_type), '') is null
     or length(btrim(p_mime_type)) > 255
     or p_size is null or p_size < 0 or p_size > 52428800
     or nullif(p_storage_path, '') is null then
    perform public._raise('INVALID_ARTIFACTS');
  end if;

  v_parts := string_to_array(p_storage_path, '/');
  if cardinality(v_parts) <> 3
     or v_parts[1] <> p_workspace_id::text
     or v_parts[2] <> p_task_id::text
     or v_parts[3] not like p_artifact_id::text || '-%'
     or v_parts[3] !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}-[A-Za-z0-9][A-Za-z0-9._ -]{0,199}$'
     or position('..' in v_parts[3]) > 0 then
    perform public._raise('INVALID_ARTIFACTS');
  end if;

  begin
    insert into public.artifacts (
      id, workspace_id, task_id, name, mime_type, size,
      storage_path, external_url, created_by_session_id
    ) values (
      p_artifact_id, p_workspace_id, p_task_id, btrim(p_name),
      btrim(p_mime_type), p_size, p_storage_path, null, null
    );
  exception when unique_violation then
    perform public._raise('IDEMPOTENCY_CONFLICT');
  end;

  insert into public.task_events (workspace_id, task_id, type, actor_type, actor_id, data)
  values (
    p_workspace_id, p_task_id, 'artifact_uploaded', 'user', p_user_id,
    jsonb_build_object('artifact_id', p_artifact_id, 'name', btrim(p_name))
  );
  v_response := jsonb_build_object(
    'artifact', (select to_jsonb(a) from public.artifacts a where a.id = p_artifact_id)
  );
  perform public._idempotency_finish(
    p_workspace_id, 'user:' || p_user_id::text, p_idempotency_key, v_response
  );
  return v_response;
end;
$$;

-- Connection tokens are generated and hashed in server code; these commands
-- only persist hashes and cache hash-free responses.
create or replace function public.create_ai_connection(
  p_workspace_id uuid,
  p_user_id uuid,
  p_connection_id uuid,
  p_name text,
  p_platform text,
  p_token_hash text,
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
  v_response jsonb;
begin
  perform public._assert_owner(p_workspace_id, p_user_id);
  v_idempotency := public._idempotency_begin(
    p_workspace_id, 'user:' || p_user_id::text,
    p_idempotency_key, 'create_ai_connection', p_request_hash
  );
  if v_idempotency ? 'cached_response' then return v_idempotency -> 'cached_response'; end if;
  if nullif(btrim(p_name), '') is null
     or nullif(btrim(p_platform), '') is null
     or length(coalesce(p_token_hash, '')) < 32 then
    perform public._raise('INVALID_CONNECTION');
  end if;

  begin
    insert into public.ai_connections (
      id, workspace_id, name, platform, api_token_hash, created_by_user_id
    ) values (
      p_connection_id, p_workspace_id, btrim(p_name), btrim(p_platform),
      p_token_hash, p_user_id
    );
  exception when unique_violation then
    perform public._raise('IDEMPOTENCY_CONFLICT');
  end;

  v_response := jsonb_build_object(
    'connection', public._connection_payload(p_connection_id)
  );
  perform public._idempotency_finish(
    p_workspace_id, 'user:' || p_user_id::text, p_idempotency_key, v_response
  );
  return v_response;
end;
$$;

create or replace function public.revoke_ai_connection(
  p_workspace_id uuid,
  p_user_id uuid,
  p_connection_id uuid,
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
  v_connection public.ai_connections%rowtype;
  v_task record;
  v_new_status public.task_status;
  v_response jsonb;
begin
  perform public._assert_owner(p_workspace_id, p_user_id);
  v_idempotency := public._idempotency_begin(
    p_workspace_id, 'user:' || p_user_id::text,
    p_idempotency_key, 'revoke_ai_connection', p_request_hash
  );
  if v_idempotency ? 'cached_response' then return v_idempotency -> 'cached_response'; end if;

  perform pg_advisory_xact_lock(
    hashtextextended('ai-connection:' || p_connection_id::text, 0)
  );

  perform public._lock_task_state_exclusive(p_workspace_id);

  select * into v_connection from public.ai_connections
  where workspace_id = p_workspace_id and id = p_connection_id for update;
  if not found then perform public._raise('SESSION_NOT_AUTHORIZED'); end if;

  if v_connection.revoked_at is null then
    -- Lock every active claim owned by this connection before releasing it.
    perform 1
    from public.tasks t
    join public.ai_sessions s on s.id = t.claimed_by_session_id
    where s.connection_id = p_connection_id
      and t.status in ('claimed', 'running')
    order by t.id
    for update of t;

    for v_task in
      select t.id, t.claimed_by_session_id
      from public.tasks t
      join public.ai_sessions s on s.id = t.claimed_by_session_id
      where s.connection_id = p_connection_id
        and t.status in ('claimed', 'running')
    loop
      v_new_status := case when exists (
        select 1 from public.task_dependencies edge
        join public.tasks dependency on dependency.id = edge.depends_on_task_id
        where edge.task_id = v_task.id and dependency.status <> 'completed'
      ) then 'blocked'::public.task_status else 'ready'::public.task_status end;
      update public.tasks
      set status = v_new_status, claimed_by_session_id = null,
          claim_token_hash = null, claimed_at = null, lease_expires_at = null
      where id = v_task.id;
      insert into public.task_events (workspace_id, task_id, type, actor_type, actor_id, data)
      values (
        p_workspace_id, v_task.id, 'task_released', 'user', p_user_id,
        jsonb_strip_nulls(jsonb_build_object(
          'reason', coalesce(p_reason, 'connection revoked'),
          'connection_id', p_connection_id, 'to', v_new_status
        ))
      );
      perform public._recompute_ancestors(v_task.id);
    end loop;

    update public.tasks t
    set assigned_session_id = null
    where t.workspace_id = p_workspace_id
      and t.assigned_session_id in (
        select s.id from public.ai_sessions s where s.connection_id = p_connection_id
      );
    update public.ai_sessions
    set current_task_id = null, status = 'offline'
    where workspace_id = p_workspace_id and connection_id = p_connection_id;
    update public.ai_connections set revoked_at = now()
    where id = p_connection_id;
  end if;

  v_response := jsonb_build_object(
    'connection', public._connection_payload(p_connection_id)
  );
  perform public._idempotency_finish(
    p_workspace_id, 'user:' || p_user_id::text, p_idempotency_key, v_response
  );
  return v_response;
end;
$$;

create or replace function public.rotate_ai_connection(
  p_workspace_id uuid,
  p_user_id uuid,
  p_connection_id uuid,
  p_token_hash text,
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
  v_response jsonb;
begin
  perform public._assert_owner(p_workspace_id, p_user_id);
  v_idempotency := public._idempotency_begin(
    p_workspace_id, 'user:' || p_user_id::text,
    p_idempotency_key, 'rotate_ai_connection', p_request_hash
  );
  if v_idempotency ? 'cached_response' then return v_idempotency -> 'cached_response'; end if;
  if length(coalesce(p_token_hash, '')) < 32 then
    perform public._raise('INVALID_CONNECTION');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('ai-connection:' || p_connection_id::text, 0)
  );

  update public.ai_connections
  set api_token_hash = p_token_hash
  where workspace_id = p_workspace_id and id = p_connection_id and revoked_at is null;
  if not found then perform public._raise('SESSION_NOT_AUTHORIZED'); end if;

  v_response := jsonb_build_object(
    'connection', public._connection_payload(p_connection_id)
  );
  perform public._idempotency_finish(
    p_workspace_id, 'user:' || p_user_id::text, p_idempotency_key, v_response
  );
  return v_response;
end;
$$;

-- SECURITY DEFINER functions are executable by PUBLIC unless revoked. Keep the
-- database fail-closed in this migration itself; the next migration grants only
-- the documented RPC surface to service_role/authenticated.
revoke execute on all functions in schema public from public, anon, authenticated;
