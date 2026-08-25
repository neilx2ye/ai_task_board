-- AI Task Board: local change notifications for the SSE realtime stream.
--
-- Hosted Supabase ships its own logical-replication Realtime publication. A
-- plain local PostgreSQL does not, so the init script applies this file after
-- the canonical migrations. Triggers only emit a tiny
-- `{ table, op, workspace_id }` envelope through LISTEN/NOTIFY; the Next.js
-- `/api/realtime` route forwards matching changes to the browser.
--
-- Idempotent: safe to re-apply.

create or replace function public._notify_local_change()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $body$
declare
  v_workspace_id uuid;
begin
  v_workspace_id := coalesce(new.workspace_id, old.workspace_id);
  if v_workspace_id is not null then
    perform pg_notify(
      'atb_realtime',
      json_build_object(
        'table', tg_table_name,
        'op', tg_op,
        'workspace_id', v_workspace_id::text
      )::text
    );
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$body$;

revoke execute on function public._notify_local_change()
from public, anon, authenticated, service_role;

do $triggers$
declare
  v_table text;
begin
  foreach v_table in array array[
    'tasks',
    'task_messages',
    'task_events',
    'session_activities',
    'session_history_syncs',
    'ai_sessions',
    'ai_bridge_directories',
    'artifacts',
    'planning_notes',
    'thread_planning_notes',
    'session_turn_plans',
    'user_thread_view_state'
  ] loop
    if to_regclass('public.' || v_table) is not null
       and not exists (
         select 1
         from pg_trigger t
         join pg_class c on c.oid = t.tgrelid
         join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public'
           and c.relname = v_table
           and t.tgname = 'atb_realtime_change'
       ) then
      execute format(
        'create trigger atb_realtime_change
         after insert or update or delete on public.%I
         for each row execute function public._notify_local_change()',
        v_table
      );
    end if;
  end loop;
end $triggers$;
