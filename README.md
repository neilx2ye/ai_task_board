# AI Task Board

AI Task Board 是面向个人和小团队的 AI 会话任务控制台。ChatGPT、Claude、Codex、Gemini 或自定义 Agent 在 CLI / APP 中建立上下文并完成推理与工具调用，通过 REST API、可选 MCP 或本机 Bridge 注册会话、接收预留任务并回传过程；网页端按连接组织会话，可直接发送下一任务，并查看状态、回复、思考摘要与工具轨迹。

项目的控制面是一个 Next.js 单体应用，正式数据存储只依赖 **Supabase Hosted**：Auth、PostgreSQL/RPC、Realtime、RLS 与私有 Storage。不包含 SQLite、Docker Compose、自托管 Supabase 或消息队列。可选的 Codex Bridge 在设备上通过本地 Codex App Server 管理 thread；Next.js 服务本身不运行模型。

## 功能概览

- 会话优先工作台：先确认存活会话及其对话引用，再向指定会话预留任务。
- 四列会话任务流：已预留、AI 执行中、等我回复、已完成；历史未绑定任务仅作异常修复展示。
- 父子 Task 统一建模；AI 只能读取分配给自身且依赖已完成的叶子任务，父任务自动聚合状态和进度。
- PostgreSQL RPC 原子处理领取、租约续期、拆分、完成并领取下一项，以及用户问答恢复。
- AI Connection 令牌和领取令牌只保存带 Pepper 的哈希；原始值只在创建/领取时返回。
- REST 和 MCP 共用领域服务、Zod 输入校验与稳定业务错误码。
- Supabase Auth/RLS 隔离 Workspace，Realtime 驱动页面刷新；网页附件以 multipart 上传到私有 Bucket，并通过 60 秒签名 URL 下载。
- 可选的设备级 Codex Bridge 通过 stdio App Server 自动发现多个顶层 thread，通过认证 SSE 接收任务唤醒，并把回复增量、思考摘要、命令和工具过程同步到各自的会话对话框。

## 技术组成

- Next.js App Router、React、TypeScript、Tailwind CSS
- `@supabase/supabase-js` 与 `@supabase/ssr`
- `ai-task-board-codex-bridge` 独立 CLI 包与本机 Codex App Server JSONL 协议
- Supabase Hosted PostgreSQL、Auth、Realtime、Storage、RLS
- Zod、TanStack Query
- Vitest、Playwright

## 准备托管 Supabase 项目

1. 在 [Supabase Dashboard](https://supabase.com/dashboard) 新建一个开发项目。请为开发、测试、生产分别使用独立项目。
2. 从项目的 API 设置页复制 Project URL、Publishable Key 和 Secret Key。Secret Key 只配置在服务端，不能使用 `NEXT_PUBLIC_` 前缀。
3. 安装依赖并准备本地环境文件：

   ```bash
   npm install
   cp .env.example .env.local
   ```

4. 填写 `.env.local`：

   ```dotenv
   NEXT_PUBLIC_SUPABASE_URL=https://PROJECT_REF.supabase.co
   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
   SUPABASE_SECRET_KEY=sb_secret_...
   AI_TOKEN_PEPPER=至少-32-位-且与其他环境不同的随机值
   NEXT_PUBLIC_APP_URL=http://localhost:3000
   ```

   可用 `openssl rand -hex 32` 生成 `AI_TOKEN_PEPPER`。轮换 Pepper 会让现有 AI Connection 和领取令牌失效，应同时轮换连接。

5. 登录 Supabase CLI、关联开发项目并先应用迁移：

   ```bash
   npx supabase login
   npx supabase link --project-ref PROJECT_REF
   npx supabase db push
   ```

   `supabase/migrations/` 是数据库结构、枚举、索引、RLS、RPC 和 Storage Policy 的唯一来源。

6. 在 Supabase Auth 中创建开发用户，或从应用 `/login` 注册。迁移安装的 Auth Trigger 会为新用户创建个人 Workspace；RLS 迁移也会为迁移前已有的 Auth 用户补建 Workspace。
7. 若需要预置样例看板，在至少创建一个 Auth 用户之后执行：

   ```bash
   npx supabase db push --include-seed
   ```

   `supabase/seed.sql` 不创建或伪造 `auth.users`，会把固定 UUID 的演示连接、三个离线会话和五步竞品研究任务附加到最早用户的 Workspace。Seed 中的连接哈希故意不可登录；要真实接入仍需在 `/connections` 创建连接。可执行演示会自行从 CLI 会话同步根任务，不复用 Seed。不要向生产项目运行 Seed。
8. 确认 Storage 中存在私有 Bucket `task-artifacts`。迁移会幂等创建并保持它为 private、单文件上限 50 MiB；若项目策略禁止迁移创建 Bucket，可在 Dashboard 的 Storage 页面手动创建同名私有 Bucket，再重新执行迁移。

> 本项目只读取上面的 Publishable/Secret Key 变量，不默认读取旧的 `NEXT_PUBLIC_SUPABASE_ANON_KEY` 或 `SUPABASE_SERVICE_ROLE_KEY`。若从旧 Supabase 项目迁移，请在托管平台中把旧值显式映射到新变量名；绝不要把任何 Secret 写入仓库或浏览器环境。

## 启动

```bash
npm run dev
```

打开 `http://localhost:3000`。网页用户经 Supabase Auth 登录；创建 AI Connection 时请立即复制只显示一次的连接令牌。AI 客户端使用它调用 REST 或 MCP，不能自行提交 `workspace_id`。每个仍处于活动生命周期的会话都应至少每分钟发送一次 session heartbeat，空闲或等待用户回复时也不停止；两分钟没有活动的会话不能接收新的 Web 预留任务。

常用检查：

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## AI 接入

REST 请求至少包含连接令牌；除注册会话外，任务命令还需会话 ID 和唯一幂等键：

```http
Authorization: Bearer <connection_token>
X-AI-Session-ID: <session_id>
Idempotency-Key: <globally_unique_key>
Content-Type: application/json
```

完整的可复制请求见 [REST API 示例](docs/rest-api.md)。MCP 的远程服务配置、工具清单和 JSON-RPC 调用见 [MCP 接入](docs/mcp.md)。两种传输返回相同的业务对象和稳定错误码。

需要让网页主动排队下一轮 Codex 工作时，使用独立的 [Codex Bridge](docs/codex-bridge.md) CLI 包：

```bash
AI_TASK_BOARD_URL=https://board.example.com \
AI_TASK_BOARD_CONNECTION_TOKEN='<connection_token>' \
CODEX_WORKING_DIRECTORY='/path/to/a/safe/start-directory' \
CODEX_MAX_CONCURRENT_TURNS=2 \
npx --yes ai-task-board-codex-bridge@0.4.1
```

仓库开发者仍可使用 `npm run bridge:codex` 运行同一份源码。长期服务应固定明确版本，
并由 systemd、launchd 或其他进程管理器负责重启；npm 包本身不会安装系统服务。

一个常驻 Bridge 代表一台设备上的一个 AI Connection，并为自动发现的每个未归档顶层 Codex thread 同步独立 Board Session；默认 `CODEX_THREAD_SCOPE=cwd` 只管理 cwd 与 `CODEX_WORKING_DIRECTORY` 完全相同的 thread，最多 50 个、最多并行 2 个 turn。跨项目发现必须显式设置高风险的 `CODEX_THREAD_SCOPE=all`；`CODEX_THREAD_ID` 是覆盖范围的单 thread 精确兼容过滤器。Bridge 必须以拥有本地 Codex 登录、会话存储和目标工作树的同一操作系统用户运行，不能放进 Next.js 服务进程。

Bridge 通过 REST 与认证 SSE 工作，正常使用不需要 Board MCP。SSE 只推送无任务内容的 `wake` 提示；App Server 的 AI 文本、可展示思考摘要和命令 delta 会聚合后近实时写入 Board。默认 `safe` 权限 profile 会把 turn 收敛到 `on-request`、用户 reviewer、`workspace-write` 和该 thread cwd（排除隐式 tmp 根并关闭网络）；它主要限制写入/网络，不能阻止读取同 UID 本来可读的文件。默认 `decline` 只负责拒绝 App Server 的 server-request，不能替代沙箱。Session 名称默认不上传 thread 标题/首条 prompt；启用 `CODEX_BRIDGE_WEB_CONFIG=true` 后，可在“AI 连接 → Bridge 设置”调整启停、标题、历史同步及数量/并发上限，但网页值始终受本机上限约束。网页开启标题还要求本机显式允许 `CODEX_BRIDGE_ALLOW_REMOTE_THREAD_TITLES=true` 或已经设置 `CODEX_BRIDGE_INCLUDE_THREAD_TITLES=true`；开启历史还要求 `CODEX_BRIDGE_ALLOW_HISTORY_SYNC=true`，并受默认 50、最大 200 个最近完成 turn 的本机上限约束。历史白名单只含用户纯文本、最终回复与服务商思考摘要，不上传原始推理、命令/diff/MCP 或本机路径字段；关闭同步或降低上限不会删除 Board 已导入的只追加历史。Inventory 仍会同步 thread ID、绝对工作目录和模型标签。当前仍没有可靠的运行中 steer、网页 interrupt 或网页逐次审批；不要让 TUI、IDE 与 Bridge 同时写入同一个 thread。Board schema/API 必须先升级到 0.4，Bridge 不提供同步 `404` 的旧版回退。安装、变量、systemd、安全与 at-least-once 限制见上述指南。

## 单会话上下文演示

演示覆盖“CLI 中先建立任务与上下文 → 同步当前任务 → 同一会话拆分和执行 → 用户在 Web 回复 → 原会话继续完成”：

```bash
AI_TASK_BOARD_URL=http://localhost:3000 \
AI_DEMO_CONNECTION_TOKEN='<connection_token>' \
npm run demo
```

运行前先按照 [演示指南](docs/demo.md) 创建演示用户和 AI Connection。脚本不会读取或打印 Secret Key，也不会清理数据。

## 测试

默认测试包含纯函数单元测试，以及在 PGlite 中完整应用迁移的数据库事务/聚合状态回归；不连接任何托管项目：

```bash
npm test
```

真实托管集成测试必须连接一个**独立的 Supabase 测试项目**。先向该项目应用相同迁移，再只在当前 shell 注入测试变量：

```bash
TEST_SUPABASE_URL=https://TEST_PROJECT_REF.supabase.co \
TEST_SUPABASE_PUBLISHABLE_KEY=sb_publishable_... \
TEST_SUPABASE_SECRET_KEY=sb_secret_... \
RUN_HOSTED_INTEGRATION_TESTS=1 \
npm test -- tests/integration
```

集成测试默认跳过，只有显式设置 `RUN_HOSTED_INTEGRATION_TESTS=1` 才运行；它们绝不回退到开发或生产变量。套件会临时创建 Workspace、Auth 用户、连接、会话和任务，验证定向接收、租约、依赖并发完成、聚合父任务完成/重开、事务拆分、外部引用去重、用户回复及跨 Workspace RLS，结束时清理测试夹具。禁止传入生产项目凭据。

端到端测试默认启动本地 Next.js，并需要 `.env.local` 指向测试项目：

```bash
npx playwright install chromium
npm run test:e2e
```

无测试账号时只验证登录/配置启动页。要运行创建任务、刷新持久化、双浏览器 Realtime、Connection 令牌只显示一次/撤销失效、私有附件上传/签名下载，以及“五步拆分 → 依赖逐项领取 → 跨浏览器问答 → 根任务 5/5 完成”的完整纵向用例，请为**测试项目用户**注入：

```bash
E2E_USER_EMAIL='e2e-user@example.com' \
E2E_USER_PASSWORD='test-only-password' \
npm run test:e2e
```

这些用例会创建唯一命名的任务、会话和连接，不执行跨用例或跨 Workspace 的批量删除。请只连接可丢弃的测试项目并定期重置测试数据，绝不要把 E2E 凭据指向生产环境。

若被测应用已部署：

```bash
PLAYWRIGHT_BASE_URL=https://preview.example.com npm run test:e2e
```

## 部署

1. 创建生产 Supabase Hosted 项目，并使用 CLI 关联该项目后执行 `npx supabase db push`。生产环境通常不运行开发 Seed。
2. 在 Next.js 托管平台配置五个环境变量：`NEXT_PUBLIC_SUPABASE_URL`、`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`、`SUPABASE_SECRET_KEY`、`AI_TOKEN_PEPPER`、`NEXT_PUBLIC_APP_URL`。
3. 将 `NEXT_PUBLIC_APP_URL` 设为最终 HTTPS 域名；同时在 Supabase Auth URL Configuration 中加入站点 URL 与登录回调 URL。
4. 确认 `task-artifacts` 为 private，并检查 RLS/Storage Policy 已启用。
5. 部署 Next.js 应用，执行一次登录、注册并心跳会话、定向预留/完成任务和签名附件下载的冒烟测试。

生产 Secret 只进入托管平台的服务端环境。不得把 `SUPABASE_SECRET_KEY`、连接令牌、领取令牌、Cookie 或附件正文输出到构建日志、应用日志或错误响应。

## 数据与状态规则

系统只有 `Task`：无子任务的是叶子任务，有子任务的是聚合任务。`claim_next_task` 使用 `FOR UPDATE SKIP LOCKED`，但只读取 `assigned_session_id` 等于当前会话、能力匹配且依赖已完成的 `ready` 叶子任务，不扫描公共任务池。CLI / APP 已经开始的任务通过 `report_current_task` 直接绑定到当前会话。接收任务会产生短期租约和一次性领取令牌；过期租约、旧令牌或其他会话不能更新任务。

父任务按后代状态聚合：`waiting_user` 优先，其次 `running/claimed`、`failed`、`ready`、`blocked`；直接有效子任务全部完成后父任务完成。结构化进度按已完成叶子数计算，AI 上报百分比仅作估计展示。业务状态变更在服务端/RPC 执行，并以只追加方式写入 `task_events`；高频心跳只刷新在线时间或租约，不制造审计噪音。受控的 Workspace 物理清理仍会通过外键级联删除其历史数据。

## 当前限制

- MVP 面向个人或小团队，没有组织计费、复杂角色、自定义工作流或 DAG 可视化编辑器。
- Next.js 控制面不内置模型或通用 Agent 执行环境；一个 Codex Bridge 是设备/Connection 级的可选 companion，其他 Harness 仍需自行接入 REST/MCP 或实现对应 adapter。
- 浏览器 Realtime 用于界面失效和重拉；客户端维护最新 `TaskEvent` ID，断线重订阅后按游标补拉遗漏事件并全量重拉，以 30 秒轮询兜底。Bridge 则使用独立的认证 SSE 唤醒端点，SSE 只发送固定空事件，任务内容仍从 REST 领取。
- Codex Bridge 的回复、思考摘要和命令 delta 会近实时回传，但当前没有可靠的运行中 steering、网页审批或远程进程中断；默认审批安全拒绝，SSE 不可用时会自适应轮询，最长约 60 秒发现新任务。
- Bridge 会从 App Server 子进程环境删除 Board Connection Token，但同一 OS UID 并不是令牌强隔离；强隔离需使用独立 UID 和/或 token proxy。`safe` profile 是默认执行边界，不能抵消同 UID 进程本身的读取与调试权限。
- Bridge 目前是 at-least-once 执行；若本地 turn 已执行但在完成 Task 前崩溃，租约恢复后可能重复提交该 turn，不可逆工具操作仍需自身幂等或人工确认。
- 会话对话框可显示 Board 已保存的内容、Bridge 实时活动，以及经设备和网页双重授权后补录的最近 Codex 历史白名单；这不是完整原始日志镜像，`reasoning` 仅代表 Codex 提供的摘要。历史导入只追加，关闭或降低同步上限不会删除既有内容；`partial` 只表示本次快照触发本机安全扫描上限。当前版本只发现既有顶层 thread，尚不从网页创建新 thread。
- Board 服务没有通用任务 Worker；Supabase Cron 仅定时清理已过期的幂等记录。原目标会话可原子恢复自己的过期租约，用户也可显式释放后改派。仅打开页面不会修改租约，卡片可能一直显示旧接收信息，直到下一次接收/释放命令。
- 附件仅保存私有 Storage 对象与元数据，外部 URL 的安全性由创建方负责。
- 附件上传采用“先写 Storage、再提交数据库元数据”的补偿式流程；客户端不得把同一个幂等键并发用于不同文件。进程在两步之间异常退出时可能留下未引用对象，生产项目应定期审计 Bucket。
- 任务详情聚合全部后代的消息、事件和附件，并计算递归叶子进度；“层级与依赖”区域目前只列直接父子关系，不提供完整多级树可视化。
- `heartbeat_ai_session` 只刷新空闲会话状态，`heartbeat_claim` 只刷新在线时间与执行中租约；两者不写任务事件或持久幂等响应，也不会进入 AI 上下文。Web 只允许向两分钟内有心跳的会话预留新任务。
- Storage 对象策略以 Workspace 成员为边界，同一 Workspace 成员可更新或删除该 Workspace 的附件；MVP 未建模“仅上传者可修改”。
- 测试和开发需使用独立托管 Supabase 项目；仓库不提供本地数据库或 Docker Compose。

## 目录

```text
app/                  Next.js 页面、Route Handler 与 MCP Adapter
lib/                  Supabase 客户端、领域服务、鉴权与校验
supabase/migrations/  数据库结构、RLS、Storage Policy 与原子 RPC
supabase/seed.sql      可选开发 Seed
docs/                 REST、MCP 与演示说明
scripts/demo.ts        单会话上下文可执行演示
packages/codex-bridge/ 可通过 npx 运行的独立 Codex Bridge npm 包
scripts/codex-bridge.ts 仓库开发环境的 Bridge 兼容入口
tests/                 Vitest 单元/集成测试与 Playwright E2E
```
