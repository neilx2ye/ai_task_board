# 迁移文件清单

这里是数据库结构和 RPC 的唯一事实来源，按文件名时间顺序依次应用。**不要重命名、删除或调整顺序**：托管项目的 `supabase_migrations.schema_migrations` 按文件名记账，改动会让下一次 `supabase db push` / `db pull` 产生冲突或重复应用。

托管项目用 `npx supabase db push` 应用；本地 PostgreSQL 用一条命令即可：

```bash
DATABASE_URL=postgresql:///ai_task_board_local npm run db:local
```

脚本会自动先应用 [supabase/local/bootstrap.sql](../local/bootstrap.sql)（提供 anon/authenticated/service_role 角色、`extensions.gen_random_uuid`、最小 `auth` 与 `storage` 兼容层），再按序应用以下全部文件，并把已应用的文件名记进 `supabase_migrations.schema_migrations`，重复执行会自动跳过。

| 迁移文件 | 作用 |
| --- | --- |
| `20260808000000_initial_schema.sql` | 核心表结构：workspace、连接、会话、任务树、依赖、消息、事件、附件、幂等记录；无环校验触发器与 Auth 用户 onboarding |
| `20260808000100_core_functions.sql` | 事务型领域 RPC：领取/租约/拆分/完成/幂等/聚合等核心业务函数 |
| `20260808000200_rls_storage.sql` | RLS 策略与显式权限、Realtime 发布、私有 `task-artifacts` 桶及对象策略 |
| `20260808000300_session_directed_dispatch.sql` | 面向会话的有向派发与原子领取契约 |
| `20260809141451_session_conversation_bridge.sql` | 会话活动时间线、Web 对话 RPC 与 Bridge 唤醒支持 |
| `20260809141643_session_activity_fk_indexes.sql` | 会话活动流复合外键索引 |
| `20260809150155_heartbeat_idempotency_maintenance.sql` | 心跳与持久幂等记录分离、pg_cron 定时清理 |
| `20260810100000_bridge_v2_thread_inventory.sql` | Bridge V2 设备/线程清单、活动栅栏与有效在线状态 |
| `20260810130000_bridge_remote_configuration.sql` | Owner 管理的期望 Bridge 配置 + 设备上报的运行时实际状态 |
| `20260810170000_codex_history_sync.sql` | 有界 Codex 历史导入与 Bridge 0.4 配置 |
| `20260810180000_web_thread_management.sql` | Web 管理 Codex Thread（新建/重命名/删除） |
| `20260811120000_structured_user_input.sql` | 结构化用户问答：把 request_user_input 持久化并回传答案 |
| `20260811130000_session_process_detail_sync.sql` | 会话进程细节同步开关 |
| `20260811140000_bridge_working_directories.sql` | Bridge 本机工作目录白名单与设备标识 |
| `20260811150000_web_managed_working_directories.sql` | Owner 管理的期望工作目录（含设备侧授权） |
| `20260811160000_normalize_legacy_unassigned_tasks.sql` | 规范化遗留的未分配任务状态 |
| `20260812100000_bridge_full_access_default.sql` | Bridge 显式全访问执行档位 |
| `20260812130000_session_turn_images.sql` | 会话 Turn 原子绑定已上传的私有图片 |
| `20260813110000_thread_model_settings.sql` | Thread 级模型与思考强度设置 |
| `20260813134500_existing_thread_settings.sql` | 已有 Thread 的管理命令携带模型设置 |
| `20260813143000_turn_model_settings.sql` | Turn 级模型设置（排队期间保持稳定） |
| `20260813170000_dynamic_model_catalog.sql` | 按连接缓存 Codex 模型目录 |
| `20260815120000_planning_workspace.sql` | 规划工作台：项目目录笔记与 Thread Turn 计划链 |
| `20260815150000_turn_goal_mode.sql` | Turn 的 Goal 模式标记 |
| `20260816120000_web_create_working_directories.sql` | 受管工作目录的可选 create_if_missing 标记 |
| `20260817120000_connection_quota.sql` | 连接级供应商配额快照 |
| `20260818000000_bridge_device_identity.sql` | Bridge 设备身份缓存（设备 id + 主机名） |
| `20260819000000_bridge_desired_version.sql` | 期望 Bridge 版本与 Web 触发的自更新 |
| `20260820000000_device_file_browsing.sql` | 设备文件浏览：Owner 请求的 list/read 命令队列 |
| `20260821000000_project_planning_notes.sql` | 项目级规划笔记（按路径跨 Bridge 共享） |
| `20260822000000_thread_planning_notes.sql` | Thread 级独立思考笔记 |
| `20260823000000_unified_device_bridge.sql` | 统一设备 Bridge：一个连接托管四套运行时 |
| `20260824000000_thread_completion_unviewed.sql` | Thread 完成/未查看状态 |
| `20260825000000_unified_device_bridge_fixes.sql` | 统一设备 Bridge 的修正迁移 |
| `20260826000000_scope_session_history_settings_by_platform.sql` | 会话历史同步设置按平台隔离修正 |
| `20260827000000_web_owned_bridge_limits.sql` | Web 成为线程/并发上限的唯一 Owner |
| `20260828000000_user_thread_view_state.sql` | 用户 Thread 界面状态（跨设备同步） |
| `20260828120000_web_owned_runtime_safety_modes.sql` | Web 拥有 Codex 运行时安全模式 |
| `20260829000000_bridge_version_by_platform.sql` | 按平台记录 Bridge 能力版本 |
| `20260830000000_task_paused_status.sql` | 任务暂停/恢复 |
| `20260831000000_session_steer_mode.sql` | Session Steer 实时调整模式 |
