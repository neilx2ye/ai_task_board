-- AI Task Board: tenant isolation, explicit RPC permissions, Realtime and
-- private Storage policies for Supabase Hosted.

-- Backfill a personal workspace for Auth users that predate the onboarding
-- trigger in the initial migration.
do $$
declare
  v_user record;
  v_workspace_id uuid;
  v_name text;
begin
  for v_user in
    select u.id, u.email, u.raw_user_meta_data
    from auth.users u
    where not exists (
      select 1 from public.workspace_members wm where wm.user_id = u.id
    )
  loop
    v_workspace_id := extensions.gen_random_uuid();
    v_name := coalesce(
      nullif(btrim(v_user.raw_user_meta_data ->> 'full_name'), ''),
      nullif(btrim(v_user.raw_user_meta_data ->> 'name'), ''),
      nullif(split_part(coalesce(v_user.email, ''), '@', 1), ''),
      'My Workspace'
    );
    insert into public.workspaces (id, name)
    values (v_workspace_id, left(v_name || '''s Workspace', 200));
    insert into public.workspace_members (workspace_id, user_id, role)
    values (v_workspace_id, v_user.id, 'owner');
  end loop;
end;
$$;

-- Idempotent fallback that signed-in clients may call if onboarding was
-- temporarily disabled during an Auth import.
create or replace function public.ensure_personal_workspace(p_name text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_user_id uuid := auth.uid();
  v_workspace_id uuid;
  v_workspace public.workspaces%rowtype;
begin
  if v_user_id is null then
    perform public._raise('SESSION_NOT_AUTHORIZED');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('personal-workspace:' || v_user_id::text, 0));

  select w.* into v_workspace
  from public.workspaces w
  join public.workspace_members wm on wm.workspace_id = w.id
  where wm.user_id = v_user_id
  order by w.created_at
  limit 1;
  if found then
    return jsonb_build_object('workspace', to_jsonb(v_workspace));
  end if;

  v_workspace_id := extensions.gen_random_uuid();
  insert into public.workspaces (id, name)
  values (v_workspace_id, coalesce(nullif(btrim(p_name), ''), 'My Workspace'))
  returning * into v_workspace;
  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_workspace_id, v_user_id, 'owner');
  return jsonb_build_object('workspace', to_jsonb(v_workspace));
end;
$$;

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.ai_connections enable row level security;
alter table public.ai_sessions enable row level security;
alter table public.tasks enable row level security;
alter table public.task_dependencies enable row level security;
alter table public.task_messages enable row level security;
alter table public.task_events enable row level security;
alter table public.artifacts enable row level security;
alter table public.idempotency_records enable row level security;

grant usage on schema public to anon, authenticated, service_role;
grant all privileges on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
revoke all on all sequences in schema public from public, anon, authenticated;

drop policy if exists workspaces_member_select on public.workspaces;
create policy workspaces_member_select on public.workspaces
for select to authenticated
using (public.is_workspace_member(id));

drop policy if exists workspace_members_member_select on public.workspace_members;
create policy workspace_members_member_select on public.workspace_members
for select to authenticated
using (public.is_workspace_member(workspace_id));

drop policy if exists ai_connections_owner_select on public.ai_connections;
create policy ai_connections_owner_select on public.ai_connections
for select to authenticated
using (public.is_workspace_owner(workspace_id));

drop policy if exists ai_sessions_member_select on public.ai_sessions;
create policy ai_sessions_member_select on public.ai_sessions
for select to authenticated
using (public.is_workspace_member(workspace_id));

drop policy if exists tasks_member_select on public.tasks;
create policy tasks_member_select on public.tasks
for select to authenticated
using (public.is_workspace_member(workspace_id));

drop policy if exists task_dependencies_member_select on public.task_dependencies;
create policy task_dependencies_member_select on public.task_dependencies
for select to authenticated
using (
  exists (
    select 1 from public.tasks t
    where t.id = task_dependencies.task_id
      and public.is_workspace_member(t.workspace_id)
  )
);

drop policy if exists task_messages_member_select on public.task_messages;
create policy task_messages_member_select on public.task_messages
for select to authenticated
using (public.is_workspace_member(workspace_id));

drop policy if exists task_events_member_select on public.task_events;
create policy task_events_member_select on public.task_events
for select to authenticated
using (public.is_workspace_member(workspace_id));

drop policy if exists artifacts_member_select on public.artifacts;
create policy artifacts_member_select on public.artifacts
for select to authenticated
using (public.is_workspace_member(workspace_id));

-- There is deliberately no browser policy for idempotency_records and no
-- INSERT/UPDATE/DELETE policy for any business table. All writes use RPCs.

revoke all on table public.workspaces from anon, authenticated;
revoke all on table public.workspace_members from anon, authenticated;
revoke all on table public.ai_connections from anon, authenticated;
revoke all on table public.ai_sessions from anon, authenticated;
revoke all on table public.tasks from anon, authenticated;
revoke all on table public.task_dependencies from anon, authenticated;
revoke all on table public.task_messages from anon, authenticated;
revoke all on table public.task_events from anon, authenticated;
revoke all on table public.artifacts from anon, authenticated;
revoke all on table public.idempotency_records from anon, authenticated;

grant select on table public.workspaces to authenticated;
grant select on table public.workspace_members to authenticated;
grant select (
  id, workspace_id, name, platform, created_by_user_id,
  last_used_at, created_at, revoked_at
) on public.ai_connections to authenticated;
grant select on table public.ai_sessions to authenticated;
grant select (
  id, workspace_id, parent_task_id, root_task_id,
  title, description, acceptance_criteria, status, priority, position,
  assigned_session_id, claimed_by_session_id, claimed_at, lease_expires_at,
  required_capabilities, external_source, external_task_ref,
  external_conversation_ref, progress_note, progress_percent_estimate,
  result_summary, result_json, created_by_type, created_by_id,
  created_at, updated_at, completed_at
) on public.tasks to authenticated;
grant select on table public.task_dependencies to authenticated;
grant select on table public.task_messages to authenticated;
grant select on table public.task_events to authenticated;
grant select on table public.artifacts to authenticated;

-- PostgreSQL grants EXECUTE to PUBLIC by default. Remove that implicit surface,
-- then expose only RLS helpers/onboarding to authenticated and domain commands
-- to the trusted server's service_role.
revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function public.is_workspace_member(uuid) to authenticated;
grant execute on function public.is_workspace_owner(uuid) to authenticated;
grant execute on function public.ensure_personal_workspace(text) to authenticated;

grant execute on function public.register_ai_session(
  uuid, uuid, text, text, text, text, text, text[], text, text
) to service_role;
grant execute on function public.report_current_task(
  uuid, uuid, text, uuid, text, text, text, text, text, text, integer,
  text, integer, text[], text, integer, text, text
) to service_role;
grant execute on function public.claim_next_task(
  uuid, uuid, text, uuid, text, integer, text, text
) to service_role;
grant execute on function public.claim_task(
  uuid, uuid, text, uuid, uuid, text, integer, text, text
) to service_role;
grant execute on function public.create_subtasks(
  uuid, uuid, text, uuid, uuid, text, jsonb, text, text
) to service_role;
grant execute on function public.heartbeat_claim(
  uuid, uuid, text, uuid, uuid, text, integer, text, text
) to service_role;
grant execute on function public.heartbeat_ai_session(
  uuid, uuid, text, uuid, text, text
) to service_role;
grant execute on function public.request_user_input(
  uuid, uuid, text, uuid, uuid, text, text, text, text
) to service_role;
grant execute on function public.complete_task_and_claim_next(
  uuid, uuid, text, uuid, uuid, text, text, jsonb, text, jsonb,
  text, integer, text, text
) to service_role;
grant execute on function public.report_progress(
  uuid, uuid, text, uuid, uuid, text, text, integer, text, text
) to service_role;
grant execute on function public.post_task_message(
  uuid, uuid, text, uuid, uuid, text, text, uuid, text, text
) to service_role;
grant execute on function public.complete_task(
  uuid, uuid, text, uuid, uuid, text, text, jsonb, text, jsonb, text, text
) to service_role;
grant execute on function public.fail_task(
  uuid, uuid, text, uuid, uuid, text, text, jsonb, text, text
) to service_role;
grant execute on function public.release_task(
  uuid, uuid, text, uuid, uuid, text, text, text, text
) to service_role;

grant execute on function public.create_user_task(
  uuid, uuid, uuid, text, text, text, integer, integer, uuid, text[], text, text
) to service_role;
grant execute on function public.update_user_task(
  uuid, uuid, uuid, jsonb, text, text
) to service_role;
grant execute on function public.create_user_subtasks(
  uuid, uuid, uuid, jsonb, text, text
) to service_role;
grant execute on function public.post_user_task_message(
  uuid, uuid, uuid, text, uuid, text, text
) to service_role;
grant execute on function public.reply_to_task(
  uuid, uuid, uuid, text, uuid, text, text
) to service_role;
grant execute on function public.release_task_by_user(
  uuid, uuid, uuid, text, text, text
) to service_role;
grant execute on function public.cancel_task(
  uuid, uuid, uuid, text, text, text
) to service_role;
grant execute on function public.reopen_task(
  uuid, uuid, uuid, text, text, text
) to service_role;
grant execute on function public.create_user_artifact(
  uuid, uuid, uuid, uuid, text, text, bigint, text, text, text
) to service_role;
grant execute on function public.create_ai_connection(
  uuid, uuid, uuid, text, text, text, text, text
) to service_role;
grant execute on function public.revoke_ai_connection(
  uuid, uuid, uuid, text, text, text
) to service_role;
grant execute on function public.rotate_ai_connection(
  uuid, uuid, uuid, text, text, text
) to service_role;

-- Realtime publication is idempotently extended for workspace-filtered UI
-- subscriptions. Publish an explicit safe task column list: logical decoding
-- sees table rows below SQL column grants, so relying on the browser SELECT
-- grant alone would not be a sufficient claim-token boundary.
do $$
declare
  v_table text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if exists (
      select 1 from pg_publication
      where pubname = 'supabase_realtime' and puballtables
    ) then
      raise exception using
        errcode = 'P0001',
        message = 'UNSAFE_REALTIME_PUBLICATION',
        detail = 'supabase_realtime must not be FOR ALL TABLES because tasks contains a private claim hash';
    end if;

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
      required_capabilities, external_source, external_task_ref,
      external_conversation_ref, progress_note, progress_percent_estimate,
      result_summary, result_json, created_by_type, created_by_id,
      created_at, updated_at, completed_at
    );

    foreach v_table in array array[
      'task_messages', 'task_events', 'ai_sessions', 'artifacts'
    ] loop
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = v_table
      ) then
        execute format('alter publication supabase_realtime add table public.%I', v_table);
      end if;
    end loop;
  end if;
end;
$$;

-- Storage object names must be `<workspace_uuid>/<task_uuid>/<filename>` and
-- resolve to a task that the signed-in user can read.
create or replace function public.can_access_task_artifact(
  p_object_name text
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_user_id uuid := auth.uid();
  v_parts text[];
  v_workspace_id uuid;
  v_task_id uuid;
begin
  if v_user_id is null then return false; end if;
  v_parts := string_to_array(p_object_name, '/');
  if cardinality(v_parts) <> 3
     or v_parts[1] !~ '^[0-9a-fA-F-]{36}$'
     or v_parts[2] !~ '^[0-9a-fA-F-]{36}$'
     or v_parts[3] !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}-[A-Za-z0-9][A-Za-z0-9._ -]{0,199}$'
     or position('..' in v_parts[3]) > 0 then
    return false;
  end if;
  begin
    v_workspace_id := v_parts[1]::uuid;
    v_task_id := v_parts[2]::uuid;
  exception when invalid_text_representation then
    return false;
  end;
  return public.is_workspace_member(v_workspace_id, v_user_id) and exists (
    select 1 from public.tasks t
    where t.workspace_id = v_workspace_id and t.id = v_task_id
  );
end;
$$;

revoke execute on function public.can_access_task_artifact(text)
from public, anon, authenticated;
grant execute on function public.can_access_task_artifact(text) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit)
values ('task-artifacts', 'task-artifacts', false, 52428800)
on conflict (id) do update
set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists task_artifacts_member_select on storage.objects;
create policy task_artifacts_member_select on storage.objects
for select to authenticated
using (
  bucket_id = 'task-artifacts'
  and public.can_access_task_artifact(name)
);

drop policy if exists task_artifacts_member_insert on storage.objects;
create policy task_artifacts_member_insert on storage.objects
for insert to authenticated
with check (
  bucket_id = 'task-artifacts'
  and public.can_access_task_artifact(name)
);

drop policy if exists task_artifacts_member_update on storage.objects;
create policy task_artifacts_member_update on storage.objects
for update to authenticated
using (
  bucket_id = 'task-artifacts'
  and public.can_access_task_artifact(name)
)
with check (
  bucket_id = 'task-artifacts'
  and public.can_access_task_artifact(name)
);

drop policy if exists task_artifacts_member_delete on storage.objects;
create policy task_artifacts_member_delete on storage.objects
for delete to authenticated
using (
  bucket_id = 'task-artifacts'
  and public.can_access_task_artifact(name)
);

comment on function public.can_access_task_artifact(text) is
  'Validates private task-artifact object paths and workspace membership.';
