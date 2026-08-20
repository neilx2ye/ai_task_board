-- Persist each member's Sessions-page Thread UI state so it survives browser
-- changes and syncs across devices:
--   selected_session_ids: Thread panels currently open, in the user's click order.
--   visible_session_ids:  Threads checked to show in the sidebar (a set).

create table if not exists public.user_thread_view_state (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  selected_session_ids uuid[] not null default '{}'
    check (cardinality(selected_session_ids) <= 1000),
  visible_session_ids uuid[] not null default '{}'
    check (cardinality(visible_session_ids) <= 1000),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

comment on table public.user_thread_view_state is
  'Per-member Thread UI state on the Sessions page (opened panels and sidebar visibility), synced across devices.';

comment on column public.user_thread_view_state.selected_session_ids is
  'Selected AI Session ids in the order the user opened them.';

comment on column public.user_thread_view_state.visible_session_ids is
  'AI Session ids explicitly checked to show in the sidebar; unchecked Threads only appear in the picker dialog.';

drop trigger if exists user_thread_view_state_set_updated_at
  on public.user_thread_view_state;
create trigger user_thread_view_state_set_updated_at
before update on public.user_thread_view_state
for each row execute function public._set_updated_at();

alter table public.user_thread_view_state enable row level security;

drop policy if exists user_thread_view_state_member_select
  on public.user_thread_view_state;
create policy user_thread_view_state_member_select
on public.user_thread_view_state
for select to authenticated
using (public.is_workspace_member(workspace_id));

-- Browser writes stay denied per the security contract; the Next.js server
-- upserts through its service-role client on behalf of the signed-in member.
grant all privileges on table public.user_thread_view_state to service_role;
revoke all on table public.user_thread_view_state
  from public, anon, authenticated;
grant select on table public.user_thread_view_state to authenticated;
