-- Atomically bind already-uploaded private image objects to a Web-created turn.
create or replace function public.create_session_turn_with_images(
  p_workspace_id uuid,
  p_user_id uuid,
  p_session_id uuid,
  p_title text,
  p_content text,
  p_priority integer,
  p_images jsonb,
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
  v_image jsonb;
  v_image_ids uuid[] := '{}'::uuid[];
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
     or coalesce(p_priority, 50) not between -1000 and 1000
     or jsonb_typeof(coalesce(p_images, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_images, '[]'::jsonb)) > 4 then
    perform public._raise('INVALID_TASK');
  end if;

  perform public._lock_task_state_exclusive(p_workspace_id);
  perform public._lock_ai_session(p_workspace_id, p_session_id);
  if not exists (
    select 1 from public.ai_sessions session
    join public.ai_connections connection
      on connection.workspace_id = session.workspace_id
     and connection.id = session.connection_id
    where session.workspace_id = p_workspace_id
      and session.id = p_session_id
      and session.inventory_active
      and session.archived_at is null
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

  for v_image in select value from jsonb_array_elements(coalesce(p_images, '[]'::jsonb)) loop
    if nullif(v_image ->> 'id', '') is null
       or nullif(btrim(v_image ->> 'name'), '') is null
       or length(btrim(v_image ->> 'name')) > 500
       or coalesce(v_image ->> 'mime_type', '') not in ('image/png', 'image/jpeg', 'image/webp', 'image/gif')
       or coalesce((v_image ->> 'size')::bigint, -1) < 1
       or coalesce((v_image ->> 'size')::bigint, 0) > 10485760
       or v_image ->> 'storage_path' not like p_workspace_id::text || '/turn-images/' || (v_image ->> 'id') || '-%' then
      perform public._raise('INVALID_TASK');
    end if;
    insert into public.artifacts (
      id, workspace_id, task_id, name, mime_type, size, storage_path
    ) values (
      (v_image ->> 'id')::uuid, p_workspace_id, v_task_id,
      btrim(v_image ->> 'name'), v_image ->> 'mime_type',
      (v_image ->> 'size')::bigint, v_image ->> 'storage_path'
    );
    v_image_ids := array_append(v_image_ids, (v_image ->> 'id')::uuid);
  end loop;

  insert into public.task_messages (
    id, workspace_id, task_id, sender_type, sender_id, content
  ) values (v_message_id, p_workspace_id, v_task_id, 'user', p_user_id, btrim(p_content));

  insert into public.session_activities (
    workspace_id, session_id, task_id, task_message_id, kind, actor_type,
    content, data, external_ref
  ) values (
    p_workspace_id, p_session_id, v_task_id, v_message_id, 'user_message',
    'user', btrim(p_content),
    jsonb_build_object('message_id', v_message_id, 'image_artifact_ids', to_jsonb(v_image_ids)),
    'web:message:' || v_message_id::text
  ) returning id into v_activity_id;

  insert into public.task_events (workspace_id, task_id, type, actor_type, actor_id, data)
  values
    (p_workspace_id, v_task_id, 'task_created', 'user', p_user_id,
     jsonb_build_object('source', 'session_conversation', 'session_id', p_session_id)),
    (p_workspace_id, v_task_id, 'message_posted', 'user', p_user_id,
     jsonb_build_object('message_id', v_message_id, 'activity_id', v_activity_id));

  v_response := jsonb_build_object(
    'task', public._task_payload(v_task_id),
    'message', (select to_jsonb(message) from public.task_messages message where message.id = v_message_id),
    'activity', (select to_jsonb(activity) from public.session_activities activity where activity.id = v_activity_id),
    'artifacts', coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at) from public.artifacts a where a.id = any(v_image_ids)), '[]'::jsonb)
  );
  perform public._idempotency_finish(
    p_workspace_id, 'user:' || p_user_id::text, p_idempotency_key, v_response
  );
  return v_response;
end;
$$;

revoke all on function public.create_session_turn_with_images(
  uuid, uuid, uuid, text, text, integer, jsonb, text, text
) from public, anon, authenticated;
grant execute on function public.create_session_turn_with_images(
  uuid, uuid, uuid, text, text, integer, jsonb, text, text
) to service_role;
