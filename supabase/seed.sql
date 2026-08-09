-- Development/demo seed. Run this only against a disposable development or
-- test Supabase project. It never creates or modifies auth.users.
--
-- If an Auth user already exists, the demo is attached to that user's oldest
-- workspace. Otherwise an unowned demo workspace is created; create a user
-- before re-running this seed if the sample should be visible in the Web UI.

do $$
declare
  v_user_id uuid;
  v_workspace_id uuid;
  v_connection_id constant uuid := '10000000-0000-4000-8000-000000000001';
  v_root_id constant uuid := '20000000-0000-4000-8000-000000000001';
  v_task_1 constant uuid := '20000000-0000-4000-8000-000000000011';
  v_task_2 constant uuid := '20000000-0000-4000-8000-000000000012';
  v_task_3 constant uuid := '20000000-0000-4000-8000-000000000013';
  v_task_4 constant uuid := '20000000-0000-4000-8000-000000000014';
  v_task_5 constant uuid := '20000000-0000-4000-8000-000000000015';
begin
  select u.id into v_user_id from auth.users u order by u.created_at limit 1;
  -- Preserve the workspace selected by an earlier seed run (including a run
  -- before the first user signed up).
  select c.workspace_id into v_workspace_id
  from public.ai_connections c where c.id = v_connection_id;

  if v_workspace_id is null and v_user_id is not null then
    select wm.workspace_id into v_workspace_id
    from public.workspace_members wm
    where wm.user_id = v_user_id
    order by wm.created_at
    limit 1;
  end if;

  if v_workspace_id is null then
    v_workspace_id := '00000000-0000-4000-8000-000000000001';
    insert into public.workspaces (id, name)
    values (v_workspace_id, 'AI Task Board Demo')
    on conflict (id) do update set name = excluded.name;
  end if;

  if v_user_id is not null then
    insert into public.workspace_members (workspace_id, user_id, role)
    values (v_workspace_id, v_user_id, 'owner')
    on conflict (workspace_id, user_id) do nothing;
  end if;

  insert into public.ai_connections (
    id, workspace_id, name, platform, api_token_hash, created_by_user_id
  ) values (
    v_connection_id, v_workspace_id, 'Demo AI Clients', 'multi-platform',
    encode(extensions.digest('disabled-seed-token:' || v_workspace_id::text, 'sha256'), 'hex'),
    v_user_id
  )
  on conflict (id) do update
  set created_by_user_id = coalesce(
    public.ai_connections.created_by_user_id,
    excluded.created_by_user_id
  );

  insert into public.ai_sessions (
    id, workspace_id, connection_id, name, platform, model,
    external_conversation_ref, capabilities, status, last_seen_at
  ) values
    (
      '11000000-0000-4000-8000-000000000001', v_workspace_id,
      v_connection_id, 'Claude Research', 'claude', 'demo',
      'demo-claude-research', array['research', 'web'], 'offline', now()
    ),
    (
      '11000000-0000-4000-8000-000000000002', v_workspace_id,
      v_connection_id, 'Codex Builder', 'codex', 'demo',
      'demo-codex-builder', array['code', 'files'], 'offline', now()
    ),
    (
      '11000000-0000-4000-8000-000000000003', v_workspace_id,
      v_connection_id, 'ChatGPT Writer', 'chatgpt', 'demo',
      'demo-chatgpt-writer', array['writing'], 'offline', now()
    )
  on conflict (id) do nothing;

  insert into public.tasks (
    id, workspace_id, root_task_id, title, description,
    acceptance_criteria, status, priority, position,
    required_capabilities, created_by_type
  ) values (
    v_root_id, v_workspace_id, v_root_id, '完成竞品研究报告',
    '演示父子任务、依赖、AI 领取、用户问答与结果聚合。',
    '完成五个有顺序依赖的叶子任务，并生成最终报告。',
    'ready', 50, 0, '{}'::text[], 'system'
  ) on conflict (id) do nothing;

  insert into public.tasks (
    id, workspace_id, parent_task_id, root_task_id, title, description,
    status, priority, position, required_capabilities, created_by_type
  ) values
    (
      v_task_1, v_workspace_id, v_root_id, v_root_id,
      '收集竞品名单', '确定需要研究的核心竞品。',
      'ready', 50, 0, array['research'], 'system'
    ),
    (
      v_task_2, v_workspace_id, v_root_id, v_root_id,
      '搜集各竞品资料', '收集公开功能、定位与定价资料。',
      'blocked', 50, 1, array['research', 'web'], 'system'
    ),
    (
      v_task_3, v_workspace_id, v_root_id, v_root_id,
      '对比功能与定价', '整理结构化功能与价格对照。',
      'blocked', 50, 2, '{}'::text[], 'system'
    ),
    (
      v_task_4, v_workspace_id, v_root_id, v_root_id,
      '提炼关键结论', '提炼差异、机会和风险。',
      'blocked', 50, 3, '{}'::text[], 'system'
    ),
    (
      v_task_5, v_workspace_id, v_root_id, v_root_id,
      '生成最终报告', '整合所有结果并生成最终输出。',
      'blocked', 50, 4, array['writing'], 'system'
    )
  on conflict (id) do nothing;

  insert into public.task_dependencies (task_id, depends_on_task_id) values
    (v_task_2, v_task_1),
    (v_task_3, v_task_2),
    (v_task_4, v_task_3),
    (v_task_5, v_task_4)
  on conflict (task_id, depends_on_task_id) do nothing;

  insert into public.task_events (
    workspace_id, task_id, type, actor_type, data
  )
  select
    v_workspace_id, seeded.id, 'demo_seeded', 'system',
    jsonb_build_object('seed', 'supabase/seed.sql')
  from unnest(array[v_root_id, v_task_1, v_task_2, v_task_3, v_task_4, v_task_5]) seeded(id)
  where not exists (
    select 1 from public.task_events existing
    where existing.task_id = seeded.id and existing.type = 'demo_seeded'
  );
end;
$$;
