-- A ready leaf is executable only when it is reserved for a concrete session.
-- Older deployments could leave public-pool rows in ready after the product
-- moved to session-directed dispatch. Preserve aggregate parents (their ready
-- status is derived from descendants), but move orphan leaves back to the
-- explicit historical/unbound state so the UI and claim semantics agree.

with normalized as (
  update public.tasks task
  set status = 'inbox'
  where task.status = 'ready'
    and task.assigned_session_id is null
    and task.claimed_by_session_id is null
    and not exists (
      select 1
      from public.tasks child
      where child.parent_task_id = task.id
    )
  returning task.workspace_id, task.id
)
insert into public.task_events (
  workspace_id, task_id, type, actor_type, actor_id, data
)
select
  normalized.workspace_id,
  normalized.id,
  'legacy_task_unbound',
  'system',
  null,
  jsonb_build_object('from', 'ready', 'to', 'inbox')
from normalized;
