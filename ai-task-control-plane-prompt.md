# 统一 AI 任务看板开发 Prompt（Supabase 托管版）

你是一名资深产品架构师和全栈工程师。请在当前代码库中设计并实现一个可运行的 Web MVP，产品名称暂定为 **AI Task Board**。

## 一、产品目标

这是一个供个人或小团队使用的统一 AI 任务看板。

用户会同时使用 ChatGPT、Claude、Codex、Gemini 和自定义 Agent。不同 AI 会话通过 REST API 或 MCP 接入看板，用统一方式完成以下动作：

- 把正在外部执行的任务同步到看板。
- 领取一个当前可执行的任务。
- 把复杂任务拆成多个子任务。
- 回传进度、消息、结果和附件。
- 请求用户补充信息。
- 完成当前任务后领取下一项任务。

看板负责保存任务、管理父子关系和依赖、分配可执行任务、同步状态，以及承载用户与 AI 的沟通。AI 的推理、模型调用、工具调用、代码执行和网页操作均发生在外部 AI 会话中。

## 二、范围约束

必须遵守以下约束：

1. 使用 **Supabase 托管服务**，不自建数据库。
2. 不使用 SQLite、Docker Compose、自托管 Supabase 或本地 PostgreSQL 作为正式运行依赖。
3. 保持单体应用，不引入微服务、Redis、消息队列、Temporal 或独立 Worker。
4. 不直接调用任何大模型，不实现 Agent 推理循环或工具执行层。
5. 不抓取 ChatGPT、Claude 等产品的网页会话记录。
6. 不建立独立的 Workflow、Run、Step 或 StepRun 模型。
7. 不先交付静态看板，核心任务领取与回传链路必须真实可运行。

如果当前代码库已有等价技术方案，优先复用；不得为了展示架构而增加无必要组件。

## 三、长短任务的统一模型

系统只有一种核心任务对象：`Task`。

- 短任务是没有子任务的叶子 Task。
- 长任务是包含一个或多个子 Task 的 Task。
- 子任务仍然是普通 Task，也可以继续拆分。
- Task 可以依赖其他 Task。
- AI 只领取当前可执行的叶子 Task。
- 父任务状态和进度由子任务自动聚合。

示例：

```text
完成竞品研究报告
├── 收集竞品名单
├── 搜集各竞品资料
├── 对比功能与定价
├── 提炼关键结论
└── 生成最终报告
```

有顺序要求时，后一项依赖前一项。并行任务不建立彼此依赖。建议把“整合所有结果并生成最终输出”也建成子任务，避免父任务承担隐藏执行逻辑。

## 四、核心流程

### 1. AI 会话注册

用户先在看板中创建一个 AI 接入连接，并取得只显示一次的连接令牌。AI 客户端使用该令牌调用 `register_session`：

1. 传入平台、会话名称、模型、外部会话引用和能力列表。
2. 服务端根据连接与外部会话引用幂等创建或更新 `AISession`。
3. 返回 `session_id`，后续所有 AI 操作都绑定该会话。
4. 同一个连接可以注册多个 AI 会话。

### 2. 同步已在执行的任务

AI 已经在外部开始执行任务时，调用 `report_current_task`：

1. 传入任务标题、说明、外部任务引用和当前进度。
2. 服务端根据连接与外部任务引用幂等创建或更新 Task。
3. Task 进入 `running`，并绑定当前 AISession。
4. 服务端返回任务 ID 和领取凭证，后续更新写入同一任务。

重复上报不得生成重复卡片。

### 3. 用户创建任务，AI 主动领取

1. 用户在看板中新建任务。
2. 没有未完成依赖的叶子任务进入 `ready`。
3. AI 调用 `claim_next_task`。
4. Supabase PostgreSQL 函数在事务中原子选取一个符合条件的任务。
5. 任务绑定该 AISession，并生成领取租约与领取令牌。
6. AI 执行任务并持续回传进度。

### 4. AI 拆分长任务

1. AI 领取一个复杂任务。
2. AI 调用 `create_subtasks`，一次提交全部子任务和依赖关系。
3. 服务端在一个数据库事务中创建全部子任务。
4. 父任务清除领取状态，之后仅作为聚合任务展示。
5. 满足依赖的叶子任务进入 `ready`，其余任务进入 `blocked`。
6. 所有有效子任务完成后，父任务自动完成。

输入非法、依赖不存在或形成循环时，整个请求必须回滚。

### 5. 完成并领取下一任务

AI 优先调用 `complete_task_and_claim_next`：

1. 校验领取令牌和租约。
2. 幂等保存结果、消息和附件引用。
3. 将当前任务标记为 `completed`。
4. 解除后续任务依赖，并重新计算祖先任务状态。
5. 在同一个数据库事务中领取下一项合适任务。
6. 没有可领取任务时返回 `next_task: null`。

选择下一任务时，优先返回同一根任务下的后续任务，以减少上下文切换。

### 6. AI 请求用户输入

1. AI 调用 `request_user_input`，提交一个可直接回答的问题。
2. Task 进入 `waiting_user`，当前领取租约结束。
3. 看板将任务放入“等我回复”列并显示未读状态。
4. 用户在任务详情页回复。
5. 回复写入任务消息流，任务恢复为 `ready`。
6. 原 AISession 作为优先会话保留，用户可以解除指定。

## 五、任务状态

使用以下 Task 状态：

```text
inbox         已创建，尚未准备领取
ready         依赖已满足，可以领取
claimed       已被 AI 会话领取，尚未确认开始
running       AI 正在执行
waiting_user  等待用户回复
blocked       存在未完成依赖或人工阻塞
completed     已完成
failed        执行失败，需要处理
cancelled     已取消
```

状态必须由服务端命令或数据库函数修改。前端不能直接更新 `status`、领取字段、结果字段或依赖关系。

父任务聚合规则：

1. 所有有效直接子任务完成时，父任务为 `completed`。
2. 任一后代任务为 `waiting_user` 时，父任务展示为 `waiting_user`。
3. 任一后代任务为 `claimed` 或 `running` 时，父任务展示为 `running`。
4. 没有运行或等待任务且存在失败任务时，父任务展示为 `failed`。
5. 存在可领取子任务时，父任务展示为 `ready`。
6. 其余未完成情况展示为 `blocked`。
7. 已有子任务的父任务不能再次被领取。

取消父任务时，默认同时取消尚未完成的后代任务。重新打开已完成或失败任务时，任务进入 `ready`，并记录操作事件。

## 六、系统架构

```text
Browser / PWA
  ├── Supabase Auth
  ├── Supabase Realtime
  └── Next.js UI
          │
          ▼
Next.js App Router
  ├── User Route Handlers / Server Actions
  ├── AI REST API
  ├── MCP Adapter
  ├── Domain Services
  └── Supabase Server Client
          │
          ▼
Supabase Hosted Project
  ├── PostgreSQL
  ├── Database Functions / RPC
  ├── Row Level Security
  ├── Realtime
  └── Storage
```

架构要求：

- 浏览器使用 Supabase Auth 登录，并通过 RLS 读取所属 Workspace 数据。
- 浏览器通过 Supabase Realtime 接收任务、消息、事件和会话变化。
- 用户修改操作进入 Next.js Route Handler 或 Server Action。
- AI 会话通过 REST 或 MCP 调用同一套领域服务。
- 多表写入、领取、完成和依赖更新放入 PostgreSQL 函数中原子执行。
- REST Handler、MCP Tool Handler 和 React 组件不得复制状态规则。

MVP 不实现自建 SSE 或 WebSocket 服务。断线重连后重新查询当前状态，Realtime 只承担界面即时刷新。

## 七、Supabase 使用方式

使用 Supabase 的以下能力：

| 能力 | 用途 |
|---|---|
| Auth | Web 用户登录与会话管理 |
| PostgreSQL | 任务、依赖、消息、事件和 AI 会话持久化 |
| Database Functions | 原子领取、完成、拆分和状态聚合 |
| Realtime | 跨浏览器和跨设备更新看板 |
| Storage | 保存任务附件和 AI 产物 |
| RLS | 按 Workspace 隔离数据 |

使用当前的 Publishable Key 与 Secret Key：

```text
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
SUPABASE_SECRET_KEY
AI_TOKEN_PEPPER
NEXT_PUBLIC_APP_URL
```

`SUPABASE_SECRET_KEY` 只能存在于服务端环境，禁止进入浏览器包、日志或仓库。不要在新代码中默认使用旧的 anon 和 service_role 环境变量；只有现有 Supabase 项目尚未迁移时才兼容旧变量，并在 README 中说明。

使用 `@supabase/supabase-js` 与 `@supabase/ssr` 创建独立的浏览器客户端、用户态服务端客户端和管理态服务端客户端。管理态客户端不得复用用户 Cookie。

## 八、数据库模型

使用 Supabase SQL Migration 管理数据库结构，不引入 Prisma 或 Drizzle。生成 TypeScript 数据库类型并在应用中复用。

### 1. workspaces

```text
id
name
created_at
updated_at
```

### 2. workspace_members

```text
workspace_id
user_id
role: owner | member
created_at
```

MVP 可以只支持一个用户和一个 Workspace，但所有业务表必须保留 `workspace_id`。

### 3. ai_connections

表示一个可配置到 AI 客户端中的接入连接。

```text
id
workspace_id
name
platform
api_token_hash
created_by_user_id
last_used_at
created_at
revoked_at
```

连接令牌使用高强度随机值生成，只显示一次。数据库只保存带 Pepper 的哈希值。

### 4. ai_sessions

表示一个具体 AI 会话或 Agent 进程。

```text
id
workspace_id
connection_id
name
platform
model
external_conversation_ref
capabilities text[]
status: online | busy | waiting | offline
current_task_id
last_seen_at
created_at
updated_at
```

同一平台可以存在多个会话。存在外部会话引用时，对 `(connection_id, external_conversation_ref)` 建立唯一约束。

### 5. tasks

```text
id uuid
workspace_id uuid
parent_task_id uuid nullable
root_task_id uuid

title text
description text nullable
acceptance_criteria text nullable
status task_status
priority integer
position integer nullable

assigned_session_id uuid nullable
claimed_by_session_id uuid nullable
claim_token_hash text nullable
claimed_at timestamptz nullable
lease_expires_at timestamptz nullable

required_capabilities text[]
external_source text nullable
external_task_ref text nullable
external_conversation_ref text nullable

progress_note text nullable
progress_percent_estimate integer nullable
result_summary text nullable
result_json jsonb nullable

created_by_type: user | ai | system
created_by_id uuid nullable
created_at timestamptz
updated_at timestamptz
completed_at timestamptz nullable
```

约束要求：

- `progress_percent_estimate` 只能为 0 到 100，且仅作为 AI 估计值展示。
- 父任务结构化进度根据已完成叶子任务数量计算。
- `(workspace_id, external_source, external_task_ref)` 在外部引用非空时唯一。
- `root_task_id` 必须指向当前任务所属根任务。
- 删除任务时不能留下孤立依赖、消息、事件或附件元数据。

### 6. task_dependencies

```text
task_id
depends_on_task_id
created_at
```

建立组合主键，禁止任务依赖自身，禁止形成循环依赖。

### 7. task_messages

```text
id
workspace_id
task_id
sender_type: user | ai | system
sender_id
content
reply_to_message_id nullable
created_at
```

### 8. task_events

```text
id bigint identity
workspace_id
task_id
type
actor_type: user | ai | system
actor_id nullable
data jsonb
created_at
```

TaskEvent 为不可变操作记录。前端使用事件 ID 作为更新游标，禁止修改或覆盖历史事件。

### 9. artifacts

```text
id
workspace_id
task_id
name
mime_type
size
storage_path nullable
external_url nullable
created_by_session_id nullable
created_at
```

文件放入私有 Supabase Storage Bucket，数据库只保存元数据和对象路径。

### 10. idempotency_records

```text
workspace_id
actor_key
idempotency_key
operation
request_hash
response_json
created_at
expires_at
```

对 `(workspace_id, actor_key, idempotency_key)` 建立唯一约束。相同 Key 但请求内容不同，应返回 `IDEMPOTENCY_CONFLICT`。

## 九、索引与约束

至少创建以下索引：

- Task 的 `workspace_id + status + priority + created_at`。
- Task 的 `parent_task_id` 和 `root_task_id`。
- Task 的 `claimed_by_session_id` 和 `lease_expires_at`。
- Dependency 的 `task_id` 与 `depends_on_task_id`。
- Message 和 Event 的 `task_id + created_at`。
- AISession 的 `workspace_id + last_seen_at`。
- 外部任务与外部会话引用的唯一索引。

为所有外键明确设置删除策略。任务历史默认不做物理删除，用户删除操作优先转为 `cancelled`。

## 十、领取与租约

`claim_next_task` 必须由 PostgreSQL 函数实现，并满足以下条件：

1. 只选择 `ready` 的叶子任务，或租约已经过期的可恢复任务。
2. 任务所有依赖均为 `completed`。
3. 指定了 AISession 时，只允许对应会话领取。
4. 任务能力要求必须是会话能力的子集。
5. 一个 AISession 默认同时只持有一个有效任务。
6. 按优先级降序、创建时间升序选择任务。
7. 使用 `FOR UPDATE SKIP LOCKED` 保证并发领取安全。

领取后生成随机 `claim_token`，只向调用方返回原始值，数据库保存哈希值。任务记录：

```text
claimed_by_session_id
claimed_at
lease_expires_at
claim_token_hash
```

默认租约时长通过配置管理，例如 15 分钟。AI 调用 `heartbeat` 延长租约。旧领取令牌、过期租约和错误 AISession 均不能更新或完成任务。

MVP 不需要定时 Worker。领取函数可以直接接管已过期任务；看板加载和用户手动释放时也可以触发过期租约清理。

## 十一、数据库函数与领域服务

以下多行或多表操作必须实现为 SQL Migration 中的 PostgreSQL 函数，并通过 Supabase RPC 调用：

```text
register_ai_session
report_current_task
claim_next_task
create_subtasks
heartbeat_claim
request_user_input
complete_task_and_claim_next
```

以下操作可以使用较小的 RPC 或服务端领域方法，但仍必须复用统一状态校验：

```text
report_progress
post_task_message
reply_to_task
complete_task
fail_task
release_task
cancel_task
reopen_task
```

数据库函数要求：

- 多表操作全部在单个事务中完成。
- 明确设置 `search_path`，避免不安全的对象解析。
- 对函数执行权限进行显式授权，不依赖默认公开权限。
- 每个状态变化都插入 TaskEvent。
- 每个修改命令都支持幂等键。
- 完成、失败、取消、拆分后重新计算祖先任务状态。
- 依赖环检测使用递归查询，并在写入前拒绝非法结构。

Next.js 中建立领域服务层，负责鉴权、参数校验、令牌哈希、错误映射和调用 RPC。不要把 SQL 事务逻辑拆回多个 HTTP 请求。

## 十二、AI 接入接口

### REST API

至少提供以下接口：

```text
POST   /api/ai/sessions/register
POST   /api/ai/sessions/heartbeat

POST   /api/ai/tasks/report-current
POST   /api/ai/tasks/claim-next
POST   /api/ai/tasks/claim
POST   /api/ai/tasks/create-subtasks
POST   /api/ai/tasks/report-progress
POST   /api/ai/tasks/request-user-input
POST   /api/ai/tasks/complete
POST   /api/ai/tasks/complete-and-claim-next
POST   /api/ai/tasks/fail
POST   /api/ai/tasks/release
POST   /api/ai/tasks/messages
GET    /api/ai/tasks/:taskId
GET    /api/ai/tasks/:taskId/updates
```

AI 请求使用：

```text
Authorization: Bearer <connection_token>
X-AI-Session-ID: <session_id>
Idempotency-Key: <unique_key>
```

服务端根据连接令牌解析 Workspace，不接受 AI 客户端自行指定 `workspace_id`。`session_id` 必须属于该连接和 Workspace。

### MCP 工具

MCP 仅作为同一领域服务的传输适配器，至少提供：

```text
register_session
report_current_task
claim_next_task
claim_task
get_task
create_subtasks
report_progress
post_task_message
request_user_input
heartbeat
complete_task
complete_task_and_claim_next
fail_task
release_task
get_task_updates
```

REST 与 MCP 必须返回一致的数据结构、状态码语义和业务错误。

稳定错误代码至少包括：

```text
TASK_NOT_FOUND
TASK_NOT_READY
TASK_ALREADY_CLAIMED
LEASE_EXPIRED
INVALID_CLAIM_TOKEN
DEPENDENCY_CYCLE
SESSION_NOT_AUTHORIZED
CAPABILITY_MISMATCH
INVALID_STATE_TRANSITION
IDEMPOTENCY_CONFLICT
```

所有输入使用 Zod 校验。不要把 Supabase 原始错误、SQL 内容或内部堆栈直接返回给 AI 客户端。

## 十三、Web 界面

主看板使用五列：

```text
收件箱 / 待整理
可领取
AI 执行中
等我回复
已完成
```

`blocked`、`failed` 和 `cancelled` 通过筛选器和状态标识展示，不单独占固定列。

每张任务卡片显示：

- 标题和当前状态。
- 所属根任务或父任务。
- 当前 AI 会话及平台。
- 子任务完成数，例如 `3 / 7`。
- 优先级和最后更新时间。
- 等待用户的问题或失败原因。

任务详情页包含：

1. 任务说明和验收条件。
2. 父任务、子任务和直接依赖。
3. 当前领取会话、租约和最后心跳。
4. 用户与 AI 的消息流。
5. 进度记录和事件时间线。
6. 结果摘要、结构化结果和附件。
7. 用户操作区。

用户操作至少包括：

- 新建和编辑任务。
- 调整优先级。
- 创建子任务与依赖。
- 指定或解除 AI 会话。
- 回复 AI 的问题。
- 取消、重新打开或释放任务。
- 创建、撤销和轮换 AI 接入连接。

提供 AI 会话视图，显示会话名称、平台、模型、当前任务、最后心跳、状态和能力标签。

MVP 不需要可视化 DAG 编辑器。父子任务和依赖使用树形列表与简单选择器表达即可。

## 十四、实时同步

前端使用 Supabase Realtime 的数据库变更订阅，监听：

```text
tasks
task_messages
task_events
ai_sessions
artifacts
```

订阅必须按当前 Workspace 过滤，并受 RLS 约束。前端收到变化后更新或失效本地查询缓存。

连接中断后：

1. 自动重新订阅。
2. 重新获取当前看板数据。
3. 根据最新 TaskEvent ID 补拉遗漏事件。
4. 保留低频轮询作为降级方案。

不要为此再实现独立 SSE 服务。

## 十五、身份、RLS 与文件安全

Web 用户使用 Supabase Auth 登录。使用 `@supabase/ssr` 处理 Next.js 服务端会话，不使用已废弃的 Auth Helpers。

所有暴露给 Data API 的业务表都必须启用 RLS。策略要求：

- 用户只能读取自己所属 Workspace 的数据。
- owner 可以创建和管理 AI Connection。
- 浏览器不能直接修改任务领取字段或关键状态字段。
- AI Connection 令牌只能通过 Next.js 服务端校验。
- Secret Key 只能用于受控服务端路径，并在调用前完成 Workspace 和 Session 校验。
- 管理态 Supabase Client 与用户态 Client 分离。
- 日志不得包含完整连接令牌、领取令牌、Secret Key、Cookie 或附件内容。

Supabase Storage 使用私有 Bucket，例如 `task-artifacts`。对象路径采用：

```text
<workspace_id>/<task_id>/<uuid>-<safe_filename>
```

上传、下载和删除通过 Storage API 完成。下载使用短期签名 URL。禁止直接修改 `storage` schema 元数据来代替文件操作。

## 十六、技术栈与目录

采用以下技术栈：

- Next.js App Router + TypeScript。
- Tailwind CSS + shadcn/ui。
- Supabase Auth、PostgreSQL、Realtime 和 Storage。
- `@supabase/supabase-js` 与 `@supabase/ssr`。
- Zod。
- TanStack Query，或当前仓库已有的等价查询缓存方案。
- Vitest 和 Playwright。

建议目录：

```text
app/
  board/
  tasks/[taskId]/
  sessions/
  connections/
  api/ai/
  api/mcp/

lib/
  supabase/client.ts
  supabase/server.ts
  supabase/admin.ts
  domain/tasks.ts
  domain/sessions.ts
  domain/messages.ts
  auth/ai-token.ts
  validation/

supabase/
  migrations/
  seed.sql

tests/
  unit/
  integration/
  e2e/
```

核心业务逻辑放在领域服务和数据库函数中。React 组件、Route Handler 和 MCP Tool Handler 只负责界面、鉴权、参数转换和结果展示。

## 十七、部署与开发环境

生产环境由两部分组成：

```text
Next.js 应用托管平台
Supabase Hosted Project
```

不创建 `docker-compose.yml`，不要求本地运行 Supabase。开发环境默认直接连接一个 Supabase 开发项目。

数据库迁移放在 `supabase/migrations`，支持通过 Supabase CLI 连接托管项目后执行。README 需要说明：

1. 创建开发用 Supabase 项目。
2. 配置 Publishable Key 和 Secret Key。
3. 应用 SQL Migration 与 Seed。
4. 创建私有 Storage Bucket。
5. 启动 Next.js。
6. 部署应用并配置生产环境变量。

测试应使用独立 Supabase 测试项目，不得对生产项目运行清理型测试。

## 十八、演示与验收流程

准备三个模拟 AI 会话：

```text
Claude Research
Codex Builder
ChatGPT Writer
```

完整演示必须覆盖：

1. 用户创建根任务“完成竞品研究报告”。
2. Claude Research 领取根任务，并创建五个有顺序依赖的子任务。
3. Claude 完成第一项，通过 `complete_task_and_claim_next` 取得第二项。
4. Codex Builder 领取后续可执行任务，且不会与其他会话重复领取。
5. ChatGPT Writer 在最终报告前请求用户输入，用户从另一个浏览器回复。
6. ChatGPT Writer 获取回复并完成最终子任务。
7. 根任务自动显示 `5 / 5`、已完成、全部消息、附件和事件记录。

另行演示一个 AI 会话调用 `report_current_task`，把已经在外部执行的零散任务同步到看板；重复调用不会生成重复任务。

## 十九、测试要求

### 单元测试

- 状态转换规则。
- 父任务聚合状态。
- 多层叶子任务进度计算。
- 能力匹配和任务排序。
- AI 连接令牌与领取令牌哈希校验。
- 错误代码映射和 Zod 校验。

### 集成测试

- 两个会话并发领取时，同一任务只返回一次。
- 租约续期、过期接管和旧令牌拒绝。
- `create_subtasks` 全量成功或全量回滚。
- `complete_task_and_claim_next` 保持事务一致性。
- 外部任务引用和幂等键去重。
- 用户回复后任务恢复为可领取状态。
- RLS 阻止跨 Workspace 读取。

### 端到端测试

- 创建、拆分、逐项领取、等待用户、回复和最终完成。
- 页面刷新后任务状态保持。
- 两个浏览器窗口通过 Realtime 同步。
- AI Connection 创建、令牌只显示一次、撤销后请求失效。
- 私有附件上传和授权下载。

## 二十、交付物

最终交付包含：

- 可运行的完整代码。
- Supabase SQL Migration、RLS Policy、Database Function 和 Seed。
- `.env.example`。
- README，包含启动、测试、迁移和部署说明。
- REST API 请求示例。
- MCP 客户端配置示例。
- 三个模拟 AI 会话的演示脚本。
- 自动化测试和当前已知限制。

不要交付 Docker Compose、SQLite 配置、自托管 Supabase 配置或无法运行的占位实现。

## 二十一、实施顺序

按以下顺序完成：

1. 检查当前仓库，确认可复用依赖并记录必要假设。
2. 建立 Supabase Migration、RLS、Storage Policy 和 Seed。
3. 实现领取、租约、拆分、依赖和父任务聚合 RPC。
4. 实现用户端与 AI 端领域服务及 REST API。
5. 在同一领域服务上实现 MCP Adapter。
6. 实现看板、任务详情、消息、附件和 AI 会话页面。
7. 接入 Realtime，补齐测试、README 和演示脚本。

优先完成一条真实可运行的纵向链路：用户建任务 → AI 领取 → AI 完成 → 看板实时更新。之后再补充长任务拆分、用户问答和附件。

完成后输出：

1. 实现结果。
2. 关键数据模型和状态规则。
3. 新增或修改的主要文件。
4. 本地启动和 Supabase 配置命令。
5. REST 与 MCP 接入方式。
6. 测试结果。
7. 当前明确存在的限制。
