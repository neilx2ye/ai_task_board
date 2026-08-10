-- Cover the composite task and message foreign keys used when parent rows are
-- deleted. The timeline cursor indexes serve different leading-column access
-- patterns and do not satisfy PostgreSQL's foreign-key lookup path.

create index if not exists session_activities_workspace_task_idx
  on public.session_activities (workspace_id, task_id)
  where task_id is not null;

create index if not exists session_activities_workspace_message_idx
  on public.session_activities (workspace_id, task_message_id)
  where task_message_id is not null;
