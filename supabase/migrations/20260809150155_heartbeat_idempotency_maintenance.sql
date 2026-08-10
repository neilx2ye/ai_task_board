-- High-frequency Bridge heartbeats are naturally repeatable state refreshes. Keep the
-- public RPC signatures stable, but do not turn every poll into a 24-hour
-- idempotency row or a permanent task event.

-- Expiry cleanup can delete a conflicting row between INSERT ... ON CONFLICT
-- and SELECT ... FOR UPDATE. Retry that narrow gap instead of reporting a
-- spurious IDEMPOTENCY_INCOMPLETE error.
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
  v_inserted boolean;
  v_record public.idempotency_records%rowtype;
begin
  if nullif(btrim(p_idempotency_key), '') is null
     or length(p_idempotency_key) > 300
     or nullif(btrim(p_request_hash), '') is null
     or length(p_request_hash) < 16 then
    perform public._raise('INVALID_IDEMPOTENCY_KEY');
  end if;

  loop
    v_inserted := false;
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

    if found then
      exit;
    end if;
    -- A concurrent cleanup deleted the expired conflict; retry the insert.
  end loop;

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
    perform public._raise('IDEMPOTENCY_INCOMPLETE');
  end if;

  return jsonb_build_object('cached_response', v_record.response_json);
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
  v_response jsonb;
begin
  perform public._assert_active_session(
    p_workspace_id, p_connection_id, p_api_token_hash, p_session_id
  );

  -- Preserve the existing request contract even though heartbeat responses are
  -- no longer cached by idempotency key.
  if nullif(btrim(p_idempotency_key), '') is null
     or length(p_idempotency_key) > 300
     or nullif(btrim(p_request_hash), '') is null
     or length(p_request_hash) < 16 then
    perform public._raise('INVALID_IDEMPOTENCY_KEY');
  end if;

  perform public._lock_task_state_shared(p_workspace_id);
  perform public._lock_ai_session(p_workspace_id, p_session_id);

  update public.ai_sessions
  set last_seen_at = greatest(last_seen_at, clock_timestamp()),
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
  where workspace_id = p_workspace_id and id = p_session_id;

  v_response := jsonb_build_object('session', public._session_payload(p_session_id));
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
  v_claim public.tasks%rowtype;
  v_lease_seconds integer := greatest(60, least(coalesce(p_lease_seconds, 900), 3600));
  v_response jsonb;
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

  perform public._lock_task_state_shared(p_workspace_id);
  perform public._lock_ai_session(p_workspace_id, p_session_id);

  select claim.* into v_claim
  from public._lock_valid_claim(
    p_workspace_id, p_session_id, p_task_id, p_claim_token_hash
  ) as claim;

  update public.tasks
  set lease_expires_at = greatest(
        lease_expires_at,
        clock_timestamp() + make_interval(secs => v_lease_seconds)
      )
  where workspace_id = p_workspace_id and id = p_task_id;
  update public.ai_sessions
  set status = 'busy', current_task_id = p_task_id,
      last_seen_at = greatest(last_seen_at, clock_timestamp())
  where workspace_id = p_workspace_id and id = p_session_id;

  v_response := jsonb_build_object('task', public._task_payload(p_task_id));
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
  v_actor_key text := 'session:' || p_session_id::text;
  v_existing public.idempotency_records%rowtype;
  v_idempotency jsonb;
  v_task jsonb;
  v_response jsonb;
begin
  perform public._assert_active_session(
    p_workspace_id, p_connection_id, p_api_token_hash, p_session_id
  );

  -- Validate the existing command contract before the read-only empty-poll
  -- path. The bigint/UUID task scan below intentionally takes no row locks;
  -- work committed just after this statement is picked up by the next poll.
  if nullif(btrim(p_idempotency_key), '') is null
     or length(p_idempotency_key) > 300
     or nullif(btrim(p_request_hash), '') is null
     or length(p_request_hash) < 16 then
    perform public._raise('INVALID_IDEMPOTENCY_KEY');
  end if;
  -- A successful claim remains replayable for the full idempotency window,
  -- even after that task has completed and the queue is empty. Lock the live
  -- record so cleanup cannot remove it between validation and replay.
  select * into v_existing
  from public.idempotency_records record
  where record.workspace_id = p_workspace_id
    and record.actor_key = v_actor_key
    and record.idempotency_key = p_idempotency_key
    and record.expires_at > now()
  for update;
  if found then
    if v_existing.operation <> 'claim_next_task'
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

  if not exists (
    select 1 from public.tasks active
    where active.workspace_id = p_workspace_id
      and active.claimed_by_session_id = p_session_id
      and active.status in ('claimed', 'running')
      and active.lease_expires_at > now()
  ) and not exists (
    select 1
    from public.tasks candidate
    join public.ai_sessions session
      on session.workspace_id = candidate.workspace_id
     and session.id = p_session_id
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
  ) then
    return jsonb_build_object('task', null);
  end if;

  v_idempotency := public._idempotency_begin(
    p_workspace_id, v_actor_key,
    p_idempotency_key, 'claim_next_task', p_request_hash
  );
  if v_idempotency ? 'cached_response' then
    return v_idempotency -> 'cached_response';
  end if;

  v_task := public._claim_next_internal(
    p_workspace_id, p_session_id, p_claim_token_hash, p_lease_seconds, null
  );
  v_response := jsonb_build_object('task', v_task);

  if v_task is null then
    -- A null poll has no durable side effect worth replaying. Deleting only
    -- this transaction's unfinished reservation keeps a later task visible to
    -- a retry that happens to reuse the same request key.
    delete from public.idempotency_records record
    where record.workspace_id = p_workspace_id
      and record.actor_key = v_actor_key
      and record.idempotency_key = p_idempotency_key
      and record.operation = 'claim_next_task'
      and record.request_hash = p_request_hash
      and record.response_json is null;
    if not found then
      perform public._raise('IDEMPOTENCY_INCOMPLETE');
    end if;
    return v_response;
  end if;

  perform public._idempotency_finish(
    p_workspace_id, v_actor_key, p_idempotency_key, v_response
  );
  return v_response;
end;
$$;

-- Bounded cleanup primitive for pg_cron or another trusted scheduler.
create or replace function public.cleanup_expired_idempotency_records(
  p_batch_size integer default 10000
)
returns integer
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_deleted integer;
begin
  if p_batch_size is null or p_batch_size not between 1 and 10000 then
    perform public._raise('INVALID_REQUEST');
  end if;

  with expired as (
    select idem.ctid
    from public.idempotency_records idem
    where idem.expires_at <= now()
    order by idem.expires_at
    limit p_batch_size
    for update skip locked
  ), deleted as (
    delete from public.idempotency_records idem
    using expired
    where idem.ctid = expired.ctid
    returning 1
  )
  select count(*)::integer into v_deleted from deleted;

  return v_deleted;
end;
$$;

comment on function public.cleanup_expired_idempotency_records(integer) is
  'Deletes at most p_batch_size expired idempotency rows. Invoke only from a trusted recurring scheduler.';

-- Replacing an existing function preserves its ACL, but spell out all grants
-- and revoke the newly-created cleanup function's default PUBLIC EXECUTE.
revoke all on function public.heartbeat_ai_session(
  uuid, uuid, text, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.heartbeat_ai_session(
  uuid, uuid, text, uuid, text, text
) to service_role;
revoke all on function public.heartbeat_claim(
  uuid, uuid, text, uuid, uuid, text, integer, text, text
) from public, anon, authenticated;
grant execute on function public.heartbeat_claim(
  uuid, uuid, text, uuid, uuid, text, integer, text, text
) to service_role;
revoke all on function public.claim_next_task(
  uuid, uuid, text, uuid, text, integer, text, text
) from public, anon, authenticated;
grant execute on function public.claim_next_task(
  uuid, uuid, text, uuid, text, integer, text, text
) to service_role;
revoke all on function public.cleanup_expired_idempotency_records(integer)
from public, anon, authenticated, service_role;

-- Hosted Supabase advertises pg_cron through pg_available_extensions. Install
-- and schedule it there; lightweight PostgreSQL implementations such as
-- PGlite omit the extension and safely skip this dynamic block.
do $maintenance_schedule$
declare
  v_job_id bigint;
begin
  if exists (
    select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron'
  ) then
    execute 'create extension if not exists pg_cron with schema pg_catalog';
    execute
      'select jobid from cron.job '
      'where jobname = $1 and username = current_user '
      'order by jobid limit 1'
      into v_job_id
      using 'ai-task-board-idempotency-cleanup';

    if v_job_id is null then
      execute 'select cron.schedule($1, $2, $3)'
      using
        'ai-task-board-idempotency-cleanup',
        '*/10 * * * *',
        'select public.cleanup_expired_idempotency_records(10000);';
    else
      execute
        'select cron.alter_job($1, schedule := $2, command := $3, active := true)'
      using
        v_job_id,
        '*/10 * * * *',
        'select public.cleanup_expired_idempotency_records(10000);';
    end if;
  end if;
end;
$maintenance_schedule$;
