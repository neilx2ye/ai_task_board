-- Thread planning notes are session-scoped and deliberately separate from
-- project-scoped planning_notes: one free-form note per Thread, never shared
-- across Bridges or merged by working-directory path.

create table if not exists public.thread_planning_notes (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  session_id uuid not null,
  content text not null default '' check (length(content) <= 100000),
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, session_id),
  constraint thread_planning_notes_session_fk
    foreign key (workspace_id, session_id)
    references public.ai_sessions(workspace_id, id) on delete cascade
);

comment on table public.thread_planning_notes is
  'One free-form planning note per Thread (AI Session), independent of the project-level planning_notes table.';

drop trigger if exists thread_planning_notes_set_updated_at
  on public.thread_planning_notes;
create trigger thread_planning_notes_set_updated_at
before update on public.thread_planning_notes
for each row execute function public._set_updated_at();

alter table public.thread_planning_notes enable row level security;
drop policy if exists thread_planning_notes_member_select
  on public.thread_planning_notes;
create policy thread_planning_notes_member_select
on public.thread_planning_notes
for select to authenticated
using (public.is_workspace_member(workspace_id));

grant all privileges on table public.thread_planning_notes to service_role;
revoke all on table public.thread_planning_notes
  from public, anon, authenticated;
grant select on table public.thread_planning_notes to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'thread_planning_notes'
     ) then
    alter publication supabase_realtime
      add table public.thread_planning_notes;
  end if;
end;
$$;
