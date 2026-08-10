-- Session conversation timeline and Harness bridge commands.
-- Existing tasks remain the reliable dispatch queue: a companion process on
-- the Harness machine claims assigned tasks, resumes the local AI thread, and
-- reports the structured items exposed by that Harness.

create table if not exists public.session_activities (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  session_id uuid not null,
  task_id uuid,
  task_message_id uuid,
  kind text not null check (kind in (
    'user_message', 'assistant_message', 'reasoning', 'command',
    'file_change', 'mcp_tool', 'web_search', 'plan', 'error', 'usage', 'status'
  )),
  actor_type public.actor_type not null,
  content text check (content is null or length(content) between 1 and 100000),
  data jsonb not null default '{}'::jsonb
    check (jsonb_typeof(data) = 'object' and octet_length(data::text) <= 262144),
  external_ref text check (
    external_ref is null or length(btrim(external_ref)) between 1 and 500
  ),
  created_at timestamptz not null default now(),
  constraint session_activities_session_fk
    foreign key (workspace_id, session_id)
    references public.ai_sessions(workspace_id, id) on delete cascade,
  constraint session_activities_task_fk
    foreign key (workspace_id, task_id)
    references public.tasks(workspace_id, id) on delete cascade,
  constraint session_activities_message_fk
    foreign key (workspace_id, task_message_id)
    references public.task_messages(workspace_id, id) on delete cascade
);

create index if not exists session_activities_session_cursor_idx
  on public.session_activities (workspace_id, session_id, id);
create index if not exists session_activities_task_cursor_idx
  on public.session_activities (task_id, id) where task_id is not null;
create unique index if not exists session_activities_external_ref_uidx
  on public.session_activities (session_id, external_ref)
  where external_ref is not null;

create or replace function public._reject_session_activity_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception using errcode = 'P0001', message = 'SESSION_ACTIVITY_IMMUTABLE';
end;
$$;

drop trigger if exists session_activities_immutable on public.session_activities;
create trigger session_activities_immutable
before update on public.session_activities
for each row execute function public._reject_session_activity_mutation();

comment on table public.session_activities is
  'Append-only conversation and Harness event stream. reasoning rows contain provider-exposed summaries, never hidden chain-of-thought.';

-- Atomically turn one Web chat message into the next task for a live session.
-- The caller supplies a deterministic title derived from the prompt.
create or replace function public.create_session_turn(
  p_workspace_id uuid,
  p_user_id uuid,
  p_session_id uuid,
  p_title text,
  p_content text,
  p_priority integer,
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
  v_task_id uuid := extensions.gen_random_uuid();
  v_message_id uuid := extensions.gen_random_uuid();
  v_activity_id bigint;
  v_response jsonb;
begin
  perform public._assert_member(p_workspace_id, p_user_id);
  v_idempotency := public._idempotency_begin(
    p_workspace_id, 'user:' || p_user_id::text,
    p_idempotency_key, 'create_session_turn', p_request_hash
  );
  if v_idempotency ? 'cached_response' then
    return v_idempotency -> 'cached_response';
  end if;

  if nullif(btrim(p_title), '') is null
     or length(btrim(p_title)) > 500
     or nullif(btrim(p_content), '') is null
     or length(btrim(p_content)) > 100000
     or coalesce(p_priority, 50) not between -1000 and 1000 then
    perform public._raise('INVALID_TASK');
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

  insert into public.tasks (
    id, workspace_id, root_task_id, title, description, status, priority,
    assigned_session_id, required_capabilities, created_by_type, created_by_id
  ) values (
    v_task_id, p_workspace_id, v_task_id, left(btrim(p_title), 500),
    btrim(p_content), 'ready', coalesce(p_priority, 50), p_session_id,
    '{}'::text[], 'user', p_user_id
  );

  insert into public.task_messages (
    id, workspace_id, task_id, sender_type, sender_id, content
  ) values (
    v_message_id, p_workspace_id, v_task_id, 'user', p_user_id, btrim(p_content)
  );

  insert into public.session_activities (
    workspace_id, session_id, task_id, task_message_id, kind, actor_type,
    content, data, external_ref
  ) values (
    p_workspace_id, p_session_id, v_task_id, v_message_id, 'user_message',
    'user', btrim(p_content), jsonb_build_object('message_id', v_message_id),
    'web:message:' || v_message_id::text
  ) returning id into v_activity_id;

  insert into public.task_events (
    workspace_id, task_id, type, actor_type, actor_id, data
  ) values
    (
      p_workspace_id, v_task_id, 'task_created', 'user', p_user_id,
      jsonb_build_object('source', 'session_conversation', 'session_id', p_session_id)
    ),
    (
      p_workspace_id, v_task_id, 'message_posted', 'user', p_user_id,
      jsonb_build_object('message_id', v_message_id, 'activity_id', v_activity_id)
    );

  v_response := jsonb_build_object(
    'task', public._task_payload(v_task_id),
    'message', (select to_jsonb(message) from public.task_messages message where message.id = v_message_id),
    'activity', (select to_jsonb(activity) from public.session_activities activity where activity.id = v_activity_id)
  );
  perform public._idempotency_finish(
    p_workspace_id, 'user:' || p_user_id::text, p_idempotency_key, v_response
  );
  return v_response;
end;
$$;

-- Store one structured item emitted by a Harness while it owns the task.
-- external_ref makes SDK retries and bridge restarts safe. Assistant messages
-- are mirrored into task_messages so existing task-detail clients keep working.
create or replace function public.report_session_activity(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_api_token_hash text,
  p_session_id uuid,
  p_task_id uuid,
  p_claim_token_hash text,
  p_kind text,
  p_content text,
  p_data jsonb,
  p_external_ref text,
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
  v_existing public.session_activities%rowtype;
  v_message_id uuid;
  v_activity_id bigint;
  v_response jsonb;
begin
  perform public._assert_active_session(
    p_workspace_id, p_connection_id, p_api_token_hash, p_session_id
  );
  v_idempotency := public._idempotency_begin(
    p_workspace_id, 'session:' || p_session_id::text,
    p_idempotency_key, 'report_session_activity', p_request_hash
  );
  if v_idempotency ? 'cached_response' then
    return v_idempotency -> 'cached_response';
  end if;

  if p_kind is null
     or p_kind not in (
      'assistant_message', 'reasoning', 'command', 'file_change',
      'mcp_tool', 'web_search', 'plan', 'error', 'usage', 'status'
     )
     or nullif(btrim(p_external_ref), '') is null
     or length(btrim(p_external_ref)) > 500
     or jsonb_typeof(coalesce(p_data, '{}'::jsonb)) <> 'object'
     or octet_length(coalesce(p_data, '{}'::jsonb)::text) > 262144
     or (p_content is not null and length(btrim(p_content)) not between 1 and 100000)
     or (p_kind in ('assistant_message', 'reasoning') and nullif(btrim(p_content), '') is null) then
    perform public._raise('INVALID_REQUEST');
  end if;

  perform public._lock_task_state_shared(p_workspace_id);
  perform public._lock_ai_session(p_workspace_id, p_session_id);

  perform pg_advisory_xact_lock(
    hashtextextended('session-activity:' || p_session_id::text || ':' || btrim(p_external_ref), 0)
  );
  select * into v_existing
  from public.session_activities activity
  where activity.workspace_id = p_workspace_id
    and activity.session_id = p_session_id
    and activity.external_ref = btrim(p_external_ref);

  if found then
    if v_existing.task_id is distinct from p_task_id
       or v_existing.kind is distinct from p_kind
       or v_existing.content is distinct from nullif(btrim(p_content), '')
       or v_existing.data is distinct from coalesce(p_data, '{}'::jsonb) then
      perform public._raise('IDEMPOTENCY_CONFLICT');
    end if;
    v_response := jsonb_build_object(
      'task', public._task_payload(p_task_id),
      'message', case when v_existing.task_message_id is null then null else (
        select to_jsonb(message) from public.task_messages message
        where message.id = v_existing.task_message_id
      ) end,
      'activity', to_jsonb(v_existing)
    );
    perform public._idempotency_finish(
      p_workspace_id, 'session:' || p_session_id::text, p_idempotency_key, v_response
    );
    return v_response;
  end if;

  -- Replaying an identical, already-authorized external item is read-only and
  -- remains safe after the original claim ends. Only a genuinely new item may
  -- mutate the timeline, so it must still prove current ownership of the task.
  select claim.* into v_claim
  from public._lock_valid_claim(
    p_workspace_id, p_session_id, p_task_id, p_claim_token_hash
  ) as claim;

  if p_kind = 'assistant_message' then
    v_message_id := extensions.gen_random_uuid();
    insert into public.task_messages (
      id, workspace_id, task_id, sender_type, sender_id, content
    ) values (
      v_message_id, p_workspace_id, p_task_id, 'ai', p_session_id, btrim(p_content)
    );
  end if;

  insert into public.session_activities (
    workspace_id, session_id, task_id, task_message_id, kind, actor_type,
    content, data, external_ref
  ) values (
    p_workspace_id, p_session_id, p_task_id, v_message_id, p_kind, 'ai',
    nullif(btrim(p_content), ''), coalesce(p_data, '{}'::jsonb), btrim(p_external_ref)
  ) returning id into v_activity_id;

  update public.tasks set status = 'running' where id = p_task_id;
  update public.ai_sessions
  set status = 'busy', current_task_id = p_task_id, last_seen_at = now()
  where id = p_session_id;
  insert into public.task_events (
    workspace_id, task_id, type, actor_type, actor_id, data
  ) values (
    p_workspace_id, p_task_id, 'session_activity_reported', 'ai', p_session_id,
    jsonb_strip_nulls(jsonb_build_object(
      'activity_id', v_activity_id,
      'kind', p_kind,
      'message_id', v_message_id
    ))
  );

  v_response := jsonb_build_object(
    'task', public._task_payload(p_task_id),
    'message', case when v_message_id is null then null else (
      select to_jsonb(message) from public.task_messages message where message.id = v_message_id
    ) end,
    'activity', (select to_jsonb(activity) from public.session_activities activity where activity.id = v_activity_id)
  );
  perform public._idempotency_finish(
    p_workspace_id, 'session:' || p_session_id::text, p_idempotency_key, v_response
  );
  return v_response;
end;
$$;

alter table public.session_activities enable row level security;
drop policy if exists session_activities_member_select on public.session_activities;
create policy session_activities_member_select on public.session_activities
for select to authenticated
using (public.is_workspace_member(workspace_id));

grant all privileges on table public.session_activities to service_role;
grant usage, select on sequence public.session_activities_id_seq to service_role;
revoke all on table public.session_activities from public, anon, authenticated;
revoke all on sequence public.session_activities_id_seq from public, anon, authenticated;
grant select on table public.session_activities to authenticated;

-- Functions default to EXECUTE for PUBLIC. This trigger helper is internal and
-- must not become an accidental browser-callable RPC just because it was
-- created after the blanket revocation in the RLS migration.
revoke all on function public._reject_session_activity_mutation()
from public, anon, authenticated;
revoke all on function public.create_session_turn(
  uuid, uuid, uuid, text, text, integer, text, text
) from public, anon, authenticated;
grant execute on function public.create_session_turn(
  uuid, uuid, uuid, text, text, integer, text, text
) to service_role;
revoke all on function public.report_session_activity(
  uuid, uuid, text, uuid, uuid, text, text, text, jsonb, text, text, text
) from public, anon, authenticated;
grant execute on function public.report_session_activity(
  uuid, uuid, text, uuid, uuid, text, text, text, jsonb, text, text, text
) to service_role;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'session_activities'
     ) then
    alter publication supabase_realtime add table public.session_activities;
  end if;
end;
$$;
