-- Planning workspace: per project-directory thinking notes and per-Thread
-- turn plan queues. Draft steps dispatch atomically into a dependency-chained
-- run of Web conversation turns; the existing completion path
-- (_refresh_unblocked_tasks) releases the next step, so a finished turn
-- automatically triggers the following one without any new completion logic.

create table if not exists public.planning_notes (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  connection_id uuid not null references public.ai_connections(id) on delete cascade,
  directory_ref text not null check (
    length(btrim(directory_ref)) between 1 and 1000
  ),
  content text not null default '' check (length(content) <= 100000),
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, connection_id, directory_ref)
);

comment on table public.planning_notes is
  'One free-form planning note per Bridge working directory. directory_ref mirrors the client directory group id (configured:<key> / path:<cwd> / unassigned).';

create table if not exists public.session_turn_plans (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  session_id uuid not null,
  position integer not null,
  content text not null check (length(btrim(content)) between 1 and 100000),
  model text check (model is null or length(btrim(model)) between 1 and 200),
  reasoning_effort text check (
    reasoning_effort is null or length(btrim(reasoning_effort)) between 1 and 50
  ),
  status text not null default 'draft'
    check (status in ('draft', 'dispatched', 'cancelled')),
  dispatched_task_id uuid,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint session_turn_plans_session_fk
    foreign key (workspace_id, session_id)
    references public.ai_sessions(workspace_id, id) on delete cascade,
  constraint session_turn_plans_task_fk
    foreign key (workspace_id, dispatched_task_id)
    references public.tasks(workspace_id, id) on delete set null
);

comment on table public.session_turn_plans is
  'Ordered draft turns planned for one AI Session. Dispatch converts drafts into dependency-chained conversation tasks so each completed turn releases the next.';

create index if not exists session_turn_plans_session_order_idx
  on public.session_turn_plans (workspace_id, session_id, status, position, created_at);

drop trigger if exists planning_notes_set_updated_at on public.planning_notes;
create trigger planning_notes_set_updated_at
before update on public.planning_notes
for each row execute function public._set_updated_at();

drop trigger if exists session_turn_plans_set_updated_at on public.session_turn_plans;
create trigger session_turn_plans_set_updated_at
before update on public.session_turn_plans
for each row execute function public._set_updated_at();

-- Turn every draft step of one Session into a queued conversation turn in a
-- single transaction. Step N depends on step N-1 through task_dependencies;
-- while that dependency is still open the new task starts as blocked and the
-- existing _refresh_unblocked_tasks flips it to ready on completion, which
-- also fires the Bridge wake subscription (assigned_session_id + ready).
create or replace function public.dispatch_session_turn_chain(
  p_workspace_id uuid,
  p_user_id uuid,
  p_session_id uuid,
  p_titles jsonb,
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
  v_titles jsonb := coalesce(p_titles, '{}'::jsonb);
  v_step record;
  v_task_id uuid;
  v_previous_task_id uuid;
  v_previous_open boolean := false;
  v_turn_result jsonb;
  v_dispatched jsonb := '[]'::jsonb;
  v_response jsonb;
begin
  perform public._assert_member(p_workspace_id, p_user_id);
  v_idempotency := public._idempotency_begin(
    p_workspace_id, 'user:' || p_user_id::text,
    p_idempotency_key, 'dispatch_session_turn_chain', p_request_hash
  );
  if v_idempotency ? 'cached_response' then
    return v_idempotency -> 'cached_response';
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
      and session.status <> 'offline'
      and session.last_seen_at >= now() - interval '2 minutes'
      and connection.revoked_at is null
  ) then
    perform public._raise('SESSION_NOT_AUTHORIZED');
  end if;

  if not exists (
    select 1 from public.session_turn_plans
    where workspace_id = p_workspace_id
      and session_id = p_session_id
      and status = 'draft'
  ) then
    perform public._raise('INVALID_TASK');
  end if;

  -- A later dispatch appends to the still-running chain: the first new step
  -- depends on the most recently dispatched step whose task has not ended.
  select task.id into v_previous_task_id
  from public.session_turn_plans plan
  join public.tasks task
    on task.workspace_id = plan.workspace_id
   and task.id = plan.dispatched_task_id
  where plan.workspace_id = p_workspace_id
    and plan.session_id = p_session_id
    and plan.status = 'dispatched'
    and task.status not in ('completed', 'cancelled', 'failed')
  order by plan.position desc, plan.created_at desc
  limit 1;
  v_previous_open := v_previous_task_id is not null;

  for v_step in
    select *
    from public.session_turn_plans
    where workspace_id = p_workspace_id
      and session_id = p_session_id
      and status = 'draft'
    order by position asc, created_at asc
  loop
    -- Derived per-step keys keep the nested idempotency records distinct; a
    -- retry of the outer key short-circuits before any of this runs.
    v_turn_result := public.create_session_turn_with_settings(
      p_workspace_id,
      p_user_id,
      p_session_id,
      coalesce(
        nullif(btrim(v_titles ->> v_step.id::text), ''),
        left(btrim(v_step.content), 80)
      ),
      v_step.content,
      50,
      '[]'::jsonb,
      v_step.model,
      v_step.reasoning_effort,
      p_idempotency_key || ':step:' || v_step.id::text,
      p_request_hash
    );
    v_task_id := nullif(v_turn_result -> 'task' ->> 'id', '')::uuid;
    if v_task_id is null then
      perform public._raise('INVALID_TASK');
    end if;

    if v_previous_task_id is not null then
      insert into public.task_dependencies (task_id, depends_on_task_id)
      values (v_task_id, v_previous_task_id);
      if v_previous_open then
        update public.tasks
        set status = 'blocked'
        where workspace_id = p_workspace_id
          and id = v_task_id;
      end if;
    end if;

    update public.session_turn_plans
    set status = 'dispatched',
        dispatched_task_id = v_task_id
    where id = v_step.id;

    -- A freshly created turn is never completed, so the next step always
    -- starts blocked behind it.
    v_previous_task_id := v_task_id;
    v_previous_open := true;
    v_dispatched := v_dispatched || jsonb_build_array(
      jsonb_build_object('step_id', v_step.id, 'task_id', v_task_id)
    );
  end loop;

  v_response := jsonb_build_object('dispatched', v_dispatched);
  perform public._idempotency_finish(
    p_workspace_id, 'user:' || p_user_id::text, p_idempotency_key, v_response
  );
  return v_response;
end;
$$;

comment on function public.dispatch_session_turn_chain(
  uuid, uuid, uuid, jsonb, text, text
) is
  'Atomically converts all draft turn plan steps of one live Session into a dependency-chained run of conversation tasks.';

alter table public.planning_notes enable row level security;
drop policy if exists planning_notes_member_select on public.planning_notes;
create policy planning_notes_member_select on public.planning_notes
for select to authenticated
using (public.is_workspace_member(workspace_id));

alter table public.session_turn_plans enable row level security;
drop policy if exists session_turn_plans_member_select on public.session_turn_plans;
create policy session_turn_plans_member_select on public.session_turn_plans
for select to authenticated
using (public.is_workspace_member(workspace_id));

grant all privileges on table public.planning_notes to service_role;
grant all privileges on table public.session_turn_plans to service_role;
revoke all on table public.planning_notes from public, anon, authenticated;
revoke all on table public.session_turn_plans from public, anon, authenticated;
grant select on table public.planning_notes to authenticated;
grant select on table public.session_turn_plans to authenticated;

-- Functions default to EXECUTE for PUBLIC; the chain dispatcher must stay a
-- server-side domain RPC like every other create/complete function.
revoke all on function public.dispatch_session_turn_chain(
  uuid, uuid, uuid, jsonb, text, text
) from public, anon, authenticated;
grant execute on function public.dispatch_session_turn_chain(
  uuid, uuid, uuid, jsonb, text, text
) to service_role;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'planning_notes'
     ) then
    alter publication supabase_realtime add table public.planning_notes;
  end if;
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'session_turn_plans'
     ) then
    alter publication supabase_realtime add table public.session_turn_plans;
  end if;
end;
$$;
