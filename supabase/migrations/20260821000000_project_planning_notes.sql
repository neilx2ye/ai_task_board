-- Project planning notes become project-scoped instead of per-Bridge:
-- one note per working-directory path, shared by every Bridge with access.
-- project_ref mirrors the client project id (path:<cwd> / unassigned).

alter table public.planning_notes
  add column if not exists project_ref text;

update public.planning_notes note
set project_ref = mapped.project_ref
from (
  select
    candidate.ctid as row_id,
    case
      when candidate.directory_ref = 'unassigned' then 'unassigned'
      when candidate.directory_ref like 'path:%' then candidate.directory_ref
      when directory.working_directory is not null
        then 'path:' || directory.working_directory
      else
        'connection:' || candidate.connection_id::text ||
        ':' || candidate.directory_ref
    end as project_ref
  from public.planning_notes candidate
  left join public.ai_bridge_directories directory
    on directory.workspace_id = candidate.workspace_id
   and directory.connection_id = candidate.connection_id
   and 'configured:' || directory.directory_key = candidate.directory_ref
) mapped
where note.ctid = mapped.row_id;

-- Multiple Bridges may have written separate notes for the same project
-- path; keep the most recently updated one.
delete from public.planning_notes note
using public.planning_notes keeper
where note.workspace_id = keeper.workspace_id
  and note.project_ref = keeper.project_ref
  and (
    note.updated_at < keeper.updated_at
    or (note.updated_at = keeper.updated_at and note.ctid < keeper.ctid)
  );

alter table public.planning_notes
  alter column project_ref set not null;

alter table public.planning_notes
  drop constraint planning_notes_connection_id_fkey;
alter table public.planning_notes
  drop constraint planning_notes_pkey;

alter table public.planning_notes
  drop column connection_id;
alter table public.planning_notes
  drop column directory_ref;

alter table public.planning_notes
  add constraint planning_notes_project_ref_check
  check (length(btrim(project_ref)) between 1 and 1000);
alter table public.planning_notes
  add constraint planning_notes_pkey
  primary key (workspace_id, project_ref);

comment on table public.planning_notes is
  'One free-form planning note per project (working-directory path), shared by every Bridge with access to that path. project_ref mirrors the client project id (path:<cwd> / unassigned).';
