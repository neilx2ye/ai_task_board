-- Keep Codex App Server request_user_input calls inside their original turn.
-- Structured prompts are persisted for the Web Console while the task claim
-- remains active; only the trusted server can read answer payloads.

alter table public.tasks
  add column if not exists awaiting_user_input boolean not null default false;

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conname = 'tasks_awaiting_user_input_active'
      and conrelid = 'public.tasks'::regclass
  ) then
    alter table public.tasks
      add constraint tasks_awaiting_user_input_active
      check (
        not awaiting_user_input
        or (
          status in ('claimed', 'running')
          and claimed_by_session_id is not null
          and claim_token_hash is not null
        )
      );
  end if;
end;
$$;

create table if not exists public.task_user_input_requests (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  task_id uuid not null,
  session_id uuid not null,
  message_id uuid not null,
  external_request_id text not null,
  turn_id text not null,
  item_id text not null,
  is_blocking boolean not null default true,
  status text not null default 'pending'
    check (status in ('pending', 'answered', 'consumed', 'cancelled')),
  questions jsonb not null check (jsonb_typeof(questions) = 'array'),
  claim_token_hash text not null,
  answers jsonb,
  answered_by_user_id uuid references auth.users(id) on delete set null,
  answered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, session_id, external_request_id),
  constraint task_user_input_requests_task_fk
    foreign key (workspace_id, task_id)
    references public.tasks(workspace_id, id) on delete cascade,
  constraint task_user_input_requests_session_fk
    foreign key (workspace_id, session_id)
    references public.ai_sessions(workspace_id, id) on delete cascade,
  constraint task_user_input_requests_message_fk
    foreign key (workspace_id, message_id)
    references public.task_messages(workspace_id, id) on delete cascade,
  constraint task_user_input_requests_external_id_length
    check (length(btrim(external_request_id)) between 1 and 500),
  constraint task_user_input_requests_turn_id_length
    check (length(btrim(turn_id)) between 1 and 500),
  constraint task_user_input_requests_item_id_length
    check (length(btrim(item_id)) between 1 and 500),
  constraint task_user_input_requests_answer_state check (
    (status = 'pending'
      and answers is null
      and answered_by_user_id is null
      and answered_at is null)
    or (status = 'answered'
      and jsonb_typeof(answers) = 'object'
      and answered_by_user_id is not null
      and answered_at is not null)
    or (status in ('consumed', 'cancelled') and answers is null)
  )
);

create index if not exists task_user_input_requests_task_created_idx
  on public.task_user_input_requests (task_id, created_at desc);
create index if not exists task_user_input_requests_session_status_idx
  on public.task_user_input_requests (session_id, status, created_at desc);
create unique index if not exists task_user_input_requests_one_pending_per_task
  on public.task_user_input_requests (task_id)
  where status = 'pending';

drop trigger if exists task_user_input_requests_set_updated_at
on public.task_user_input_requests;
create trigger task_user_input_requests_set_updated_at
before update on public.task_user_input_requests
for each row execute function public._set_updated_at();

alter table public.task_user_input_requests enable row level security;
revoke all on table public.task_user_input_requests
from public, anon, authenticated;
grant all privileges on table public.task_user_input_requests to service_role;

create or replace function public._valid_task_user_input_questions(
  p_questions jsonb
)
returns boolean
language plpgsql
immutable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_question jsonb;
  v_option jsonb;
  v_ids text[] := '{}'::text[];
  v_id text;
  v_options jsonb;
begin
  if p_questions is null
     or jsonb_typeof(p_questions) <> 'array'
     or jsonb_array_length(p_questions) not between 1 and 3
     or pg_column_size(p_questions) > 100000 then
    return false;
  end if;

  for v_question in select value from jsonb_array_elements(p_questions)
  loop
    if jsonb_typeof(v_question) <> 'object' then return false; end if;
    v_id := nullif(btrim(v_question ->> 'id'), '');
    if v_id is null or length(v_id) > 200 or v_id = any(v_ids) then
      return false;
    end if;
    v_ids := array_append(v_ids, v_id);
    if nullif(btrim(v_question ->> 'header'), '') is null
       or length(btrim(v_question ->> 'header')) > 100
       or nullif(btrim(v_question ->> 'question'), '') is null
       or length(btrim(v_question ->> 'question')) > 10000 then
      return false;
    end if;
    if v_question ? 'isOther'
       and jsonb_typeof(v_question -> 'isOther') <> 'boolean' then
      return false;
    end if;
    if v_question ? 'isSecret'
       and jsonb_typeof(v_question -> 'isSecret') <> 'boolean' then
      return false;
    end if;

    v_options := v_question -> 'options';
    if v_options is null or jsonb_typeof(v_options) = 'null' then
      continue;
    end if;
    if jsonb_typeof(v_options) <> 'array'
       or jsonb_array_length(v_options) not between 1 and 20 then
      return false;
    end if;
    for v_option in select value from jsonb_array_elements(v_options)
    loop
      if jsonb_typeof(v_option) <> 'object'
         or nullif(btrim(v_option ->> 'label'), '') is null
         or length(btrim(v_option ->> 'label')) > 500
         or jsonb_typeof(v_option -> 'description') is distinct from 'string'
         or length(v_option ->> 'description') > 2000 then
        return false;
      end if;
    end loop;
  end loop;
  return true;
exception when others then
  return false;
end;
$$;

create or replace function public._valid_task_user_input_answers(
  p_questions jsonb,
  p_answers jsonb
)
returns boolean
language plpgsql
immutable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_question jsonb;
  v_answer_array jsonb;
  v_answer text;
  v_question_count integer;
  v_answer_count integer;
begin
  if not public._valid_task_user_input_questions(p_questions)
     or p_answers is null
     or jsonb_typeof(p_answers) <> 'object'
     or pg_column_size(p_answers) > 100000 then
    return false;
  end if;
  select count(*) into v_question_count from jsonb_array_elements(p_questions);
  select count(*) into v_answer_count from jsonb_object_keys(p_answers);
  if v_answer_count <> v_question_count then return false; end if;

  for v_question in select value from jsonb_array_elements(p_questions)
  loop
    if not (p_answers ? (v_question ->> 'id')) then return false; end if;
    v_answer_array := p_answers -> (v_question ->> 'id');
    if jsonb_typeof(v_answer_array) <> 'array'
       or jsonb_array_length(v_answer_array) <> 1
       or jsonb_typeof(v_answer_array -> 0) <> 'string' then
      return false;
    end if;
    v_answer := btrim(v_answer_array ->> 0);
    if v_answer = '' or length(v_answer) > 10000 then return false; end if;

    if jsonb_typeof(v_question -> 'options') = 'array'
       and not coalesce((v_question ->> 'isOther')::boolean, false)
       and not exists (
         select 1
         from jsonb_array_elements(v_question -> 'options') option
         where option ->> 'label' = v_answer
       ) then
      return false;
    end if;
  end loop;
  return true;
exception when others then
  return false;
end;
$$;

create or replace function public._task_user_input_public_payload(
  p_request_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'id', request.id,
    'workspace_id', request.workspace_id,
    'task_id', request.task_id,
    'session_id', request.session_id,
    'message_id', request.message_id,
    'external_request_id', request.external_request_id,
    'turn_id', request.turn_id,
    'item_id', request.item_id,
    'is_blocking', request.is_blocking,
    'status', request.status,
    'questions', request.questions,
    'answered_at', request.answered_at,
    'created_at', request.created_at,
    'updated_at', request.updated_at
  )
  from public.task_user_input_requests request
  where request.id = p_request_id;
$$;

create or replace function public.register_task_user_input_request(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_api_token_hash text,
  p_session_id uuid,
  p_task_id uuid,
  p_claim_token_hash text,
  p_request_id uuid,
  p_external_request_id text,
  p_turn_id text,
  p_item_id text,
  p_is_blocking boolean,
  p_questions jsonb,
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
  v_message text;
  v_response jsonb;
begin
  perform public._assert_active_session(
    p_workspace_id, p_connection_id, p_api_token_hash, p_session_id
  );
  v_idempotency := public._idempotency_begin(
    p_workspace_id, 'session:' || p_session_id::text,
    p_idempotency_key, 'register_task_user_input_request', p_request_hash
  );
  if v_idempotency ? 'cached_response' then
    return v_idempotency -> 'cached_response';
  end if;
  if p_request_id is null
     or nullif(btrim(p_external_request_id), '') is null
     or length(btrim(p_external_request_id)) > 500
     or nullif(btrim(p_turn_id), '') is null
     or length(btrim(p_turn_id)) > 500
     or nullif(btrim(p_item_id), '') is null
     or length(btrim(p_item_id)) > 500
     or not coalesce(p_is_blocking, false)
     or not public._valid_task_user_input_questions(p_questions) then
    perform public._raise('INVALID_REQUEST');
  end if;

  perform public._lock_task_state_shared(p_workspace_id);
  perform public._lock_ai_session(p_workspace_id, p_session_id);
  select claim.* into v_claim
  from public._lock_valid_claim(
    p_workspace_id, p_session_id, p_task_id, p_claim_token_hash
  ) as claim;
  if v_claim.awaiting_user_input or exists (
    select 1
    from public.task_user_input_requests request
    where request.task_id = p_task_id and request.status = 'pending'
  ) then
    perform public._raise('INVALID_STATE_TRANSITION');
  end if;

  -- A later prompt proves the App Server consumed any earlier answer.
  update public.task_user_input_requests
  set status = 'consumed', answers = null
  where workspace_id = p_workspace_id
    and task_id = p_task_id
    and status = 'answered';

  select string_agg(
    (question ->> 'header') || E'\n' || (question ->> 'question') ||
    case
      when jsonb_typeof(question -> 'options') = 'array' then
        E'\n可选：' || (
          select string_agg(option ->> 'label', ' / ' order by ordinal)
          from jsonb_array_elements(question -> 'options')
            with ordinality options(option, ordinal)
        )
      else ''
    end,
    E'\n\n' order by question_ordinal
  ) into v_message
  from jsonb_array_elements(p_questions)
    with ordinality questions(question, question_ordinal);

  insert into public.task_messages (
    id, workspace_id, task_id, sender_type, sender_id, content,
    requires_response
  ) values (
    v_message_id, p_workspace_id, p_task_id, 'ai', p_session_id,
    left(v_message, 100000), true
  );
  insert into public.task_user_input_requests (
    id, workspace_id, task_id, session_id, message_id,
    external_request_id, turn_id, item_id, is_blocking, questions,
    claim_token_hash
  ) values (
    p_request_id, p_workspace_id, p_task_id, p_session_id, v_message_id,
    btrim(p_external_request_id), btrim(p_turn_id), btrim(p_item_id), true,
    p_questions, p_claim_token_hash
  );
  update public.tasks
  set awaiting_user_input = true,
      assigned_session_id = p_session_id,
      progress_note = '等待用户在 Web Console 回答结构化问题'
  where workspace_id = p_workspace_id and id = p_task_id;
  update public.ai_sessions
  set current_task_id = p_task_id,
      status = 'waiting',
      last_seen_at = greatest(last_seen_at, clock_timestamp())
  where workspace_id = p_workspace_id and id = p_session_id;
  insert into public.task_events (
    workspace_id, task_id, type, actor_type, actor_id, data
  ) values (
    p_workspace_id, p_task_id, 'structured_user_input_requested',
    'ai', p_session_id,
    jsonb_build_object(
      'request_id', p_request_id,
      'message_id', v_message_id,
      'question_count', jsonb_array_length(p_questions),
      'turn_id', p_turn_id,
      'item_id', p_item_id,
      'claim_retained', true
    )
  );

  v_response := jsonb_build_object(
    'task', public._task_payload(p_task_id),
    'request', public._task_user_input_public_payload(p_request_id)
  );
  perform public._idempotency_finish(
    p_workspace_id, 'session:' || p_session_id::text,
    p_idempotency_key, v_response
  );
  return v_response;
end;
$$;

create or replace function public.answer_task_user_input_request(
  p_workspace_id uuid,
  p_user_id uuid,
  p_task_id uuid,
  p_request_id uuid,
  p_answers jsonb,
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
  v_request public.task_user_input_requests%rowtype;
  v_response_message_id uuid := extensions.gen_random_uuid();
  v_response jsonb;
begin
  perform public._assert_member(p_workspace_id, p_user_id);
  v_idempotency := public._idempotency_begin(
    p_workspace_id, 'user:' || p_user_id::text,
    p_idempotency_key, 'answer_task_user_input_request', p_request_hash
  );
  if v_idempotency ? 'cached_response' then
    return v_idempotency -> 'cached_response';
  end if;

  perform public._lock_task_state_shared(p_workspace_id);
  select * into v_request
  from public.task_user_input_requests request
  where request.workspace_id = p_workspace_id
    and request.id = p_request_id
    and request.task_id = p_task_id;
  if not found then perform public._raise('TASK_NOT_FOUND'); end if;
  perform public._lock_ai_session(p_workspace_id, v_request.session_id);

  select * into v_task
  from public.tasks task
  where task.workspace_id = p_workspace_id and task.id = p_task_id
  for update;
  if not found then perform public._raise('TASK_NOT_FOUND'); end if;
  select * into v_request
  from public.task_user_input_requests request
  where request.workspace_id = p_workspace_id
    and request.id = p_request_id
    and request.task_id = p_task_id
  for update;
  if not found then perform public._raise('TASK_NOT_FOUND'); end if;
  if v_request.status <> 'pending'
     or not v_task.awaiting_user_input
     or v_task.status not in ('claimed', 'running')
     or v_task.claimed_by_session_id is distinct from v_request.session_id
     or v_task.claim_token_hash is distinct from v_request.claim_token_hash
     or v_task.lease_expires_at is null
     or v_task.lease_expires_at <= now() then
    perform public._raise('INVALID_STATE_TRANSITION');
  end if;
  if not public._valid_task_user_input_answers(
    v_request.questions, p_answers
  ) then
    perform public._raise('INVALID_REQUEST');
  end if;

  update public.task_user_input_requests
  set status = 'answered',
      answers = p_answers,
      answered_by_user_id = p_user_id,
      answered_at = clock_timestamp()
  where id = p_request_id;
  update public.task_messages
  set read_at = clock_timestamp()
  where id = v_request.message_id;
  insert into public.task_messages (
    id, workspace_id, task_id, sender_type, sender_id, content,
    reply_to_message_id
  ) values (
    v_response_message_id, p_workspace_id, p_task_id, 'user', p_user_id,
    format('已提交结构化回答（%s 项）', jsonb_array_length(v_request.questions)),
    v_request.message_id
  );
  update public.tasks
  set awaiting_user_input = false,
      progress_note = '用户已回答，原 turn 正在继续执行'
  where workspace_id = p_workspace_id and id = p_task_id;
  update public.ai_sessions
  set current_task_id = p_task_id, status = 'busy'
  where workspace_id = p_workspace_id and id = v_request.session_id;
  insert into public.task_events (
    workspace_id, task_id, type, actor_type, actor_id, data
  ) values (
    p_workspace_id, p_task_id, 'structured_user_input_answered',
    'user', p_user_id,
    jsonb_build_object(
      'request_id', p_request_id,
      'message_id', v_response_message_id,
      'question_count', jsonb_array_length(v_request.questions),
      'turn_continues', true
    )
  );

  v_response := jsonb_build_object(
    'task', public._task_payload(p_task_id),
    'request', public._task_user_input_public_payload(p_request_id),
    'message', (
      select to_jsonb(message)
      from public.task_messages message
      where message.id = v_response_message_id
    )
  );
  perform public._idempotency_finish(
    p_workspace_id, 'user:' || p_user_id::text,
    p_idempotency_key, v_response
  );
  return v_response;
end;
$$;

create or replace function public.poll_task_user_input_request(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_api_token_hash text,
  p_session_id uuid,
  p_task_id uuid,
  p_claim_token_hash text,
  p_request_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_request public.task_user_input_requests%rowtype;
  v_claim public.tasks%rowtype;
begin
  perform public._assert_active_session(
    p_workspace_id, p_connection_id, p_api_token_hash, p_session_id
  );
  perform public._lock_task_state_shared(p_workspace_id);
  perform public._lock_ai_session(p_workspace_id, p_session_id);

  select * into v_request
  from public.task_user_input_requests request
  where request.workspace_id = p_workspace_id
    and request.id = p_request_id
    and request.task_id = p_task_id
    and request.session_id = p_session_id
    and request.claim_token_hash = p_claim_token_hash;
  if not found then perform public._raise('TASK_NOT_FOUND'); end if;

  if v_request.status in ('pending', 'answered') then
    select claim.* into v_claim
    from public._lock_valid_claim(
      p_workspace_id, p_session_id, p_task_id, p_claim_token_hash
    ) as claim;
  end if;

  return jsonb_build_object(
    'request', jsonb_build_object(
      'id', v_request.id,
      'status', v_request.status,
      'answers', case
        when v_request.status = 'answered' then v_request.answers
        else null
      end
    )
  );
end;
$$;

-- Clear answers when a claim rotates or a task leaves the active lifecycle.
-- This also catches user cancellation/release and lease-expiry reclamation.
create or replace function public._cleanup_task_user_input_on_claim_end()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.claim_token_hash is distinct from old.claim_token_hash
     or new.status not in ('claimed', 'running') then
    update public.task_user_input_requests request
    set status = case
          when request.status = 'answered' and new.status = 'completed'
            then 'consumed'
          else 'cancelled'
        end,
        answers = null
    where request.task_id = old.id
      and request.claim_token_hash = old.claim_token_hash
      and request.status in ('pending', 'answered');

    update public.task_messages message
    set read_at = coalesce(message.read_at, clock_timestamp())
    where message.id in (
      select request.message_id
      from public.task_user_input_requests request
      where request.task_id = old.id
        and request.claim_token_hash = old.claim_token_hash
    );
    new.awaiting_user_input := false;
  end if;
  return new;
end;
$$;

drop trigger if exists tasks_cleanup_structured_user_input on public.tasks;
create trigger tasks_cleanup_structured_user_input
before update of status, claim_token_hash on public.tasks
for each row execute function public._cleanup_task_user_input_on_claim_end();

-- Inventory snapshots and generic presence refreshes must not visually turn a
-- Web-waiting Thread back to busy while its App Server request is still open.
create or replace function public._preserve_structured_user_input_waiting()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.status <> 'offline'
     and new.current_task_id is not null
     and exists (
       select 1
       from public.tasks task
       where task.workspace_id = new.workspace_id
         and task.id = new.current_task_id
         and task.awaiting_user_input
     ) then
    new.status := 'waiting';
  end if;
  return new;
end;
$$;

drop trigger if exists ai_sessions_preserve_structured_waiting
on public.ai_sessions;
create trigger ai_sessions_preserve_structured_waiting
before update of status, current_task_id on public.ai_sessions
for each row execute function public._preserve_structured_user_input_waiting();

create or replace function public._idle_session_status(p_session_id uuid)
returns public.ai_session_status
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select case
    when not exists (
      select 1
      from public.ai_sessions session
      where session.id = p_session_id
        and session.inventory_active
        and session.archived_at is null
        and session.deletion_requested_at is null
    ) then 'offline'::public.ai_session_status
    when exists (
      select 1
      from public.tasks waiting
      where (
          waiting.assigned_session_id = p_session_id
          and waiting.status = 'waiting_user'
        ) or (
          waiting.claimed_by_session_id = p_session_id
          and waiting.awaiting_user_input
        )
    ) then 'waiting'::public.ai_session_status
    else 'online'::public.ai_session_status
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
  set status = case
        when v_claim.awaiting_user_input then 'waiting'::public.ai_session_status
        else 'busy'::public.ai_session_status
      end,
      current_task_id = p_task_id,
      last_seen_at = greatest(last_seen_at, clock_timestamp())
  where workspace_id = p_workspace_id and id = p_session_id;

  v_response := jsonb_build_object('task', public._task_payload(p_task_id));
  return v_response;
end;
$$;

grant select (
  id, workspace_id, parent_task_id, root_task_id,
  title, description, acceptance_criteria, status, priority, position,
  assigned_session_id, claimed_by_session_id, claimed_at, lease_expires_at,
  awaiting_user_input,
  required_capabilities, external_source, external_task_ref,
  external_conversation_ref, progress_note, progress_percent_estimate,
  result_summary, result_json, created_by_type, created_by_id,
  created_at, updated_at, completed_at
) on public.tasks to authenticated;

do $$
begin
  if exists (
    select 1 from pg_publication
    where pubname = 'supabase_realtime' and puballtables
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'UNSAFE_REALTIME_PUBLICATION',
      detail = 'supabase_realtime must not be FOR ALL TABLES because private task and answer columns exist';
  end if;
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'tasks'
    ) then
      alter publication supabase_realtime drop table public.tasks;
    end if;
    alter publication supabase_realtime add table public.tasks (
      id, workspace_id, parent_task_id, root_task_id,
      title, description, acceptance_criteria, status, priority, position,
      assigned_session_id, claimed_by_session_id, claimed_at, lease_expires_at,
      awaiting_user_input,
      required_capabilities, external_source, external_task_ref,
      external_conversation_ref, progress_note, progress_percent_estimate,
      result_summary, result_json, created_by_type, created_by_id,
      created_at, updated_at, completed_at
    );
  end if;
end;
$$;

revoke all on function public._valid_task_user_input_questions(jsonb)
from public, anon, authenticated;
revoke all on function public._valid_task_user_input_answers(jsonb, jsonb)
from public, anon, authenticated;
revoke all on function public._task_user_input_public_payload(uuid)
from public, anon, authenticated;
revoke all on function public._cleanup_task_user_input_on_claim_end()
from public, anon, authenticated;
revoke all on function public._preserve_structured_user_input_waiting()
from public, anon, authenticated;
revoke all on function public.register_task_user_input_request(
  uuid, uuid, text, uuid, uuid, text, uuid, text, text, text,
  boolean, jsonb, text, text
) from public, anon, authenticated;
grant execute on function public.register_task_user_input_request(
  uuid, uuid, text, uuid, uuid, text, uuid, text, text, text,
  boolean, jsonb, text, text
) to service_role;
revoke all on function public.answer_task_user_input_request(
  uuid, uuid, uuid, uuid, jsonb, text, text
) from public, anon, authenticated;
grant execute on function public.answer_task_user_input_request(
  uuid, uuid, uuid, uuid, jsonb, text, text
) to service_role;
revoke all on function public.poll_task_user_input_request(
  uuid, uuid, text, uuid, uuid, text, uuid
) from public, anon, authenticated;
grant execute on function public.poll_task_user_input_request(
  uuid, uuid, text, uuid, uuid, text, uuid
) to service_role;
revoke all on function public.heartbeat_claim(
  uuid, uuid, text, uuid, uuid, text, integer, text, text
) from public, anon, authenticated;
grant execute on function public.heartbeat_claim(
  uuid, uuid, text, uuid, uuid, text, integer, text, text
) to service_role;

comment on table public.task_user_input_requests is
  'Structured App Server prompts. Answer payloads are service-only and are cleared when consumed, cancelled, or the task claim ends.';
