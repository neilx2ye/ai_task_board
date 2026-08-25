# AI Task Board

AI Task Board 是面向个人和小团队的 AI 会话任务控制台。ChatGPT、Claude、Codex、Kimi Code、Gemini 或自定义 Agent 在 CLI / APP 中建立上下文并完成推理与工具调用，通过 REST API、可选 MCP 或本机 Bridge 注册会话、接收预留任务并回传 AI 回复；网页端按连接组织会话，可直接发送下一任务并查看回复。

项目的控制面是一个 Next.js 单体应用，正式数据存储是本机 **PostgreSQL**：登录会话、原子 RPC、LISTEN/NOTIFY 实时推送、RLS 与本地附件存储都直接由它提供。不包含 SQLite、Docker Compose、托管 Supabase 或消息队列。可选的 Codex、Kimi、Antigravity 与 Claude Code Bridge 分别在设备上通过本地 App Server / ACP / CLI 管理会话；Next.js 服务本身不运行模型。

## 功能概览

- 会话优先工作台：先确认存活会话及其对话引用，再向指定会话预留任务。
- 任务规划工作台：按「设备 → 项目目录 → Thread」组织规划页；项目级思考笔记按路径跨 Bridge 共享一份，每个 Thread 另有只属于该会话的独立思考笔记，两者数据与界面完全分开。Thread 还可把任务拆成有序 Turn 草稿链，一键派发为依赖链任务——前一个 Turn 完成后下一个自动放行并被 Bridge 领取执行，也可随时追加；从这里新建的 Thread 同样出现在会话与上下文页。
- 项目 Tab 链：会话与规划两页顶部按「项目 → Bridges → Threads → Turns」过滤，同一工作目录跨 Bridge 自动合并为一个项目；Owner 可直接在 Web 新建项目——选定设备后该目录会下发到设备上所有支持托管目录的 Bridge（不存在时由设备自动创建），也可在「管理项目」里隐藏项目（浏览器本地），或删除项目——删除会从看板数据库移除项目记录并停止 Bridge 托管，但不会删除设备上的项目文件。
- 会话目录展示当前任务状态与排队数量，对话面板集中呈现 AI 回复和执行记录；任务完成后 Thread 先显示「待查看」，在侧栏点击打开即转为「已完成」，顶部项目 Tab 同步汇总各项目正在运行与待查看的任务数。
- 每个 Bridge 会把本机 Codex / Kimi Code / Antigravity 的套餐额度或模型配额快照回传看板，AI 连接页的对应卡片直接展示剩余百分比、窗口与重置时间。
- AI 连接页展示每个 Bridge 的当前版本与 npm 最新版；Owner 可单个或批量下发目标版本，运行在 systemd 下的 Bridge 1.5.0+ 会在下次配置交换后自动从 npm 下载、校验完整性并重启到该版本（远程升级默认开启），下载前也可随时在网页取消。
- 父子 Task 统一建模；AI 只能读取分配给自身且依赖已完成的叶子任务，父任务自动聚合状态和进度。
- PostgreSQL RPC 原子处理领取、租约续期、拆分、完成并领取下一项，以及用户问答恢复。
- AI Connection 令牌和领取令牌只保存带 Pepper 的哈希；原始值只在创建/领取时返回。
- REST 和 MCP 共用领域服务、Zod 输入校验与稳定业务错误码。
- Cookie 会话 + RLS 隔离 Workspace，PostgreSQL LISTEN/NOTIFY 经 SSE 驱动页面刷新；网页附件以 multipart 上传到本地私有目录，并通过 60 秒 HMAC 签名 URL 下载。
- 文件预览工作台按「项目 → 文件树 → 预览面板」浏览文件：项目与页面顶部项目 Tab 同源（Bridge 上报的工作目录），本机可访问的目录直接读取，远端设备目录通过 Bridge 1.5.0+ 的 list/read 文件命令回传，惰性加载目录树并预览 Markdown、图片与文本；仅 Workspace Owner 可访问，本机路径限制在 `FILE_EXPLORER_ROOTS` 根目录内，设备侧同样只允许连接白名单内的工作目录，并自动跳过隐藏文件、敏感密钥与 `node_modules` 等目录。
- 可选的设备级 Codex Bridge 通过 stdio App Server 自动发现多个顶层 thread，通过认证 SSE 接收任务唤醒，并只把 AI 回复增量同步到各自的会话对话框；Workspace Owner 还可从网页新建、重命名和删除受管 Thread。
- 独立的 Kimi Bridge 通过 Kimi ACP 发现真实 Kimi Sessions，上报 Kimi 模型与思考强度，并支持网页新建、执行和删除；ACP 不支持可靠改名，因此 Kimi 连接不会展示改名入口。
- 独立的 Antigravity Bridge 通过 Antigravity CLI 官方 headless `stream-json` 接口驱动本机 `agy`，按 Thread 保持真实 conversation 上下文并回传最终回复；不读取 Google 未公开的会话数据库。
- 独立的 Claude Code Bridge 通过 Anthropic 官方 `@agentclientprotocol/claude-agent-acp` 适配器驱动本机 Claude Code Sessions，上报 Claude 模型与思考强度，并支持网页新建、执行、删除和 Goal 模式。

## 技术组成

- Next.js App Router、React、TypeScript、Tailwind CSS
- PostgreSQL + `pg` 驱动
- `ai-task-board-bridge` 统一 npm CLI，内含 Codex App Server、Kimi ACP、Antigravity CLI 与 Claude Code ACP 四套独立运行时
- Zod、TanStack Query
- Vitest、Playwright

## 准备本地 PostgreSQL

1. 安装 PostgreSQL 并准备环境文件：

   ```bash
   sudo apt-get install -y postgresql postgresql-contrib
   npm install
   cp .env.example .env.local
   ```

2. 填写 `.env.local`：

   ```dotenv
   DATABASE_URL=postgresql:///ai_task_board_local?host=/var/run/postgresql
   AI_TOKEN_PEPPER=至少-32-位-且与其他环境不同的随机值
   NEXT_PUBLIC_APP_URL=http://localhost:3000
   ```

   可用 `openssl rand -hex 32` 生成 `AI_TOKEN_PEPPER`。轮换 Pepper 会让现有
   AI Connection 和领取令牌失效，应同时轮换连接。

3. 一条命令建好全部数据库结构。脚本会自动创建目标数据库、补齐本地兼容层
   （角色、`extensions.gen_random_uuid`、最小 `auth`/`storage` schema），按
   文件名顺序应用 [supabase/migrations/](supabase/migrations/) 并把已应用的
   文件名记进 `supabase_migrations.schema_migrations`，重复执行自动跳过：

   ```bash
   npm run db:local
   # 需要演示数据时：
   npm run db:local:seed
   ```

   `supabase/seed.sql` 不创建或伪造 `auth.users`，会把固定 UUID 的演示连接、
   三个离线会话和五步竞品研究任务附加到最早用户的 Workspace。Seed 中的连接
   哈希故意不可登录；要真实接入仍需在 `/connections` 创建连接。不要向生产库
   运行 Seed。

4. 注册入口默认关闭（登录页不显示注册切换）。管理员在服务端创建账号：

   ```bash
   npm run user:create -- you@example.com 'a-strong-password'
   ```

   `auth.users` 的 onboarding 触发器会为新用户创建个人 Workspace。如需开放
   公开注册，把 `ALLOW_SIGNUP=true` 加进环境文件即可。服务端以超级用户连接
   PostgreSQL（等价于原托管 `service_role`），业务鉴权在领域层完成，RLS 保留
   为纵深防御。

## 启动

```bash
npm run dev
```

打开 `http://localhost:3000`。网页用户用本地账号登录；创建 AI Connection 时请立即复制只显示一次的连接令牌。AI 客户端使用它调用 REST 或 MCP，不能自行提交 `workspace_id`。每个仍处于活动生命周期的会话都应至少每分钟发送一次 session heartbeat，空闲或等待用户回复时也不停止；两分钟没有活动的会话不能接收新的 Web 预留任务。

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

需要让网页主动排队下一轮 Agent 工作时，使用统一的 `ai-task-board-bridge` npm 包：

```bash
npx --yes ai-task-board-bridge@1.8.8 setup
npx --yes ai-task-board-bridge@1.8.8 run
```

`setup` 与 `run` 是两个统一命令：一个系统用户只需要**一个 Bridge、一个命令、
一个 Token**。`setup` 安装并启动**执行 npx 的当前有效用户**自己的唯一 systemd
用户服务（后台常驻），Codex、Kimi、Antigravity 与 Claude Code 四种运行时在该
服务内并行常驻；`run all` 直接前台运行同一套运行时，`npx` 进程结束后随之下线。
两个命令都可显式指定平台 `codex`、`kimi`、`antigravity`、`claude`
（`setup` 还支持 `both`、`all`），未指定时交互式询问。四种 Bridge 的交互流程完全
一致：只询问 Board
地址（留空使用 `https://task.neilx.online`）与 Connection Token，工作目录、
thread/并发上限、权限与审批策略等四种运行时的配置统一写入**同一份环境文件**
（含 Claude Code），一次配置覆盖全部 Bridge；其余细调也可到「AI 连接 → Bridge
设置」中按平台管理，新安装默认由 Web 端管理目录。**交互式终端里 setup 每次都会
重新询问 Token：留空保留已保存的值，输入新值则替换**；再次运行 setup 会把新加入
的 Bridge 类型并入现有服务，保留已保存的 Token 与配置。统一设备连接在
「Bridge 设置」里按运行时分别管理。不带子命令的旧式调用保持兼容：配置齐全时
前台运行 Codex，缺少配置且处于交互终端时进入 setup。

SSH 命令、CI 脚本等非 TTY 环境读取 `AI_TASK_BOARD_CONNECTION_TOKEN` 或已保存的
Token，直接非交互运行，不再提问；`AI_TASK_BOARD_URL` 未提供时同样使用默认地址，
并显式指定平台：

```bash
AI_TASK_BOARD_URL='https://task.neilx.online' \
AI_TASK_BOARD_CONNECTION_TOKEN='atb_REPLACE_ME' \
npx --yes ai-task-board-bridge@1.8.8 setup codex
```

Codex 的安装器显式固定该用户的 `HOME` / `CODEX_HOME`，因此默认读取这个用户的
Codex 登录、`config.toml`、provider 和模型配置；新安装默认使用
`danger-full-access`（全权限）+ `accept`（审批自动通过）。Kimi、Antigravity 与
Claude Code 运行时已嵌入这个公开包，不需要
再发布或安装第二个 npm 包。前台模式
未显式配置时继续使用 `CODEX_BRIDGE_PERMISSION_MODE=danger-full-access`（完全访问、
无沙箱）和 `CODEX_BRIDGE_APPROVAL_MODE=accept`（设备端自动同意）；需要限制写入与
网络时请显式设置 `CODEX_BRIDGE_PERMISSION_MODE=safe`。

仓库开发者仍可使用 `npm run bridge:codex` 运行同一份源码。非 Linux 或无需 systemd
时，可继续使用环境变量方式交给其他进程管理器。

一个常驻 Bridge 代表一台设备上的一个 AI Connection，并为自动发现的每个未归档顶层 Codex thread 同步独立 Board Session；默认 `CODEX_THREAD_SCOPE=cwd` 精确匹配 `CODEX_WORKING_DIRECTORY`，也可用 `CODEX_WORKING_DIRECTORIES` JSON 白名单同时管理多个目录，并在网页按“设备 → 工作目录 → Thread”展示。Bridge 0.8 起，Owner 可直接在“Bridge 设置”中管理项目名称与本机绝对路径，稳定 key 由看板自动分配并在项目存续期间保持不变；Bridge 会在应用前验证路径确实存在且为目录。总计最多 50 个 thread（可调至 500）；设备级并行 turn 数可直接在 Web 设置为 1 到 32，默认启动值为 5。跨白名单发现必须显式设置高风险的 `CODEX_THREAD_SCOPE=all`；`CODEX_THREAD_ID` 是覆盖范围的单 thread 精确兼容过滤器。Bridge 必须以拥有本地 Codex 登录、会话存储和目标工作树的同一操作系统用户运行，不能放进 Next.js 服务进程。

Bridge 通过 REST 与认证 SSE 工作，正常使用不需要 Board MCP。SSE 只推送无任务内容的 `wake` 提示；App Server 的 AI 回复增量会聚合后近实时写入 Board，思考摘要、命令、工具过程和用量不会同步。默认 `danger-full-access` 权限 profile 仍显式使用 `on-request` 和用户 reviewer，但不启用沙箱，不限制该 OS 用户本来可以写入的路径或网络；默认 `accept` 会在设备端立即批准与当前活跃 turn 关联的受支持审批请求，因此无需网页逐次确认。这两个默认值相互独立，但组合后会在当前 OS 用户权限范围内无沙箱执行，属于高风险配置。可将权限模式显式设为 `safe`，把 turn 限制到 `workspace-write`、该 thread cwd、无隐式 tmp 写根且无网络；`inherit` 则完全不发送权限与审批覆盖，沿用 thread 或本机 Codex 设置，可能同样继承完全访问，只有明确了解本机配置时才应使用。审批也可设为 `decline` 或 `accept-session`；审批模式不会改变沙箱。
Bridge 通过 REST 与认证 SSE 工作，正常使用不需要 Board MCP。SSE 只推送无任务内容的 `wake` 提示；App Server 的 AI 回复增量会聚合后近实时写入 Board，思考摘要、命令、工具过程和用量不会同步。默认 `danger-full-access` 权限 profile 仍显式使用 `on-request` 和用户 reviewer，但不启用沙箱，不限制该 OS 用户本来可以写入的路径或网络；默认 `accept` 会在设备端立即批准与当前活跃 turn 关联的受支持审批请求，因此无需网页逐次确认。这两个默认值相互独立，但组合后会在当前 OS 用户权限范围内无沙箱执行，属于高风险配置。权限模式与审批模式如今也可以在「AI 连接 → Bridge 设置」由 Web 调整（仅 Codex 运行时）。可将权限模式显式设为 `safe`，把 turn 限制到 `workspace-write`、该 thread cwd、无隐式 tmp 写根且无网络；`inherit` 则完全不发送权限与审批覆盖，沿用 thread 或本机 Codex 设置，可能同样继承完全访问，只有明确了解本机配置时才应使用。审批也可设为 `decline` 或 `accept-session`；审批模式不会改变沙箱。

Bridge 0.6 会单独把 blocking `requestUserInput` 转成 Web 选择框，保留原 turn 与 claim，提交后原地继续。新连接默认开启 thread 标题上传与 Codex 历史同步（历史只对 Codex 运行时生效），Workspace Owner 可在“AI 连接 → Bridge 设置”调整启停、标题、历史同步及数量/并发上限；Web 是唯一配置入口，不再需要 `CODEX_BRIDGE_WEB_CONFIG`、`*_ALLOW_REMOTE_THREAD_TITLES`、`*_ALLOW_HISTORY_SYNC`、`*_ALLOW_WORKING_DIRECTORY_CONFIGURATION` 等设备端授权开关。最大 thread 数（1..500）与最大并行 turn 数（1..32）都由 Web 直接控制，不再与本机上限做二次比较。历史同步最多上传 500 个最近完成 turn（默认 50）的用户消息与最终 AI 回复；历史用户消息会对有权访问该 Workspace 的成员可见。关闭同步或降低上限不会删除 Board 已导入的只追加历史。Inventory 会同步 thread ID、绝对工作目录和当前模型标签；Bridge 还会通过 App Server `model/list` 上报当前 provider 的可见模型及支持强度，供新建 Thread 和每个 Turn 的输入框动态选择，provider 凭据仍只保留在设备上。Bridge 0.5 起，Workspace Owner 可在“AI 会话”页新建、重命名和删除当前设备清单内的 Thread，也可在“AI 连接”页重命名连接；Bridge 0.7 会在选中的设备目录下新建，旧版仍使用设备默认工作目录，删除只接受没有活跃或已预留任务的 Thread。网页暂停命令会尽力中断运行中 turn（Bridge 在下一个命令轮询周期内请求中断，已完成的 turn 视为成功空操作）。Bridge 1.8.7 起，Codex 运行时会话的对话面板提供「Steer 实时调整」开关：开启后 Thread 忙碌时发送的消息会经 App Server `turn/steer` 实时追加进当前 turn，而不是排队；turn 已结束或交付失败时自动回退为普通排队任务。网页逐次审批仍不支持；不要让 TUI、IDE 与 Bridge 同时写入同一个 thread。Board schema/API 必须先应用仓库当前 migration，Bridge 不提供同步 `404` 的旧版回退。安装、变量、systemd、安全与 at-least-once 限制见上述指南。

### Kimi Bridge

先在「AI 连接」中新建平台为 **Kimi Code** 的独立连接，再在已经登录 Kimi Code 的设备上运行：

```bash
npx --yes ai-task-board-bridge@1.8.8 setup kimi
```

前台或自动化部署可使用环境变量：

```bash
AI_TASK_BOARD_URL='https://task.neilx.online' \
AI_TASK_BOARD_CONNECTION_TOKEN='atb_REPLACE_ME' \
KIMI_WORKING_DIRECTORY='/absolute/path/to/project' \
KIMI_BRIDGE_MODE='auto' \
KIMI_BRIDGE_APPROVAL_MODE='accept' \
npx --yes ai-task-board-bridge@1.8.8 run kimi
```

Kimi Bridge 启动独立的 `kimi acp` 子进程，Board 令牌不会传入该子进程。它按精确 cwd 白名单同步 Kimi Sessions，并从 ACP 配置项动态上报当前可用模型、默认模型和思考强度。Web 可创建和删除真实 Kimi Session，也可为新 Session 或下一 Turn 选择 Kimi 模型；Kimi Code 0.34 的 ACP 没有可靠改名方法，因此网页会隐藏 Kimi Thread 的改名入口。完整变量、安全策略和 systemd 说明见 [Kimi Bridge 包文档](packages/kimi-bridge/README.md)。

### Antigravity Bridge

先在「AI 连接」中新建平台为 **Antigravity** 的独立连接，再在已登录 Antigravity CLI
的设备上运行（需要 `agy` 1.1.8+，可执行 `agy update` 升级）：

```bash
npx --yes ai-task-board-bridge@1.8.8 setup antigravity
```

前台或自动化部署可使用环境变量：

```bash
AI_TASK_BOARD_URL='https://task.neilx.online' \
AI_TASK_BOARD_CONNECTION_TOKEN='atb_REPLACE_ME' \
ANTIGRAVITY_WORKING_DIRECTORY='/absolute/path/to/project' \
ANTIGRAVITY_BRIDGE_MODE='auto' \
ANTIGRAVITY_BRIDGE_APPROVAL_MODE='accept' \
npx --yes ai-task-board-bridge@1.8.8 run antigravity
```

Antigravity Bridge 只使用 Google 官方文档化的 `agy -p --output-format stream-json`
接口：它按精确 cwd 白名单管理本地 Thread 绑定，首个任务创建真实 conversation，后续
Turn 通过 `--conversation` 续接同一上下文，并从 `agy models` 动态上报模型与
low/medium/high 思考强度；Board 令牌不会传入 `agy` 子进程。Web 可新建和删除
Thread。agy headless 没有公开的改名与历史读取接口，因此网页会隐藏 Antigravity Thread
改名入口、删除只移除 Bridge 绑定（保留本机会话文件），也不会导入 TUI 中既有会话。
Web 会话上传的图片（PNG/JPEG/WebP/GIF，单张 10 MiB、合计 20 MiB）会被下载到 Thread
工作目录下的临时 `.ai-task-board` 目录，并在 prompt 中按绝对路径要求 agy 读取，任务
结束后即删除；含图 turn 需要 agy 1.1.11+。
`ANTIGRAVITY_BRIDGE_APPROVAL_MODE=accept` 会传入
`--dangerously-skip-permissions`，自动批准全部工具调用，属于高风险配置；可用
`ANTIGRAVITY_BRIDGE_SANDBOX=true` 额外启用 agy 终端沙箱。完整变量、安全策略和
systemd 说明见 [Antigravity Bridge 包文档](packages/antigravity-bridge/README.md)。

### Claude Code Bridge

先在「AI 连接」中新建平台为 **Claude Code** 的独立连接（或使用统一设备连接），
再在已登录 Claude Code 的设备上运行统一安装命令；启用 Claude Code 时 setup 会把
Anthropic 官方的 ACP 适配器自动安装到用户数据目录并配置 `CLAUDE_BINARY`，
不需要单独安装：

```bash
npx --yes ai-task-board-bridge@1.8.8 setup claude
```

订阅用户请先用同一系统用户运行 `claude login`；API / 自定义网关用户请设置
`ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN` 或 `CLAUDE_CODE_OAUTH_TOKEN`。前台
或自动化部署可使用环境变量：

```bash
AI_TASK_BOARD_URL='https://task.neilx.online' \
AI_TASK_BOARD_CONNECTION_TOKEN='atb_REPLACE_ME' \
CLAUDE_WORKING_DIRECTORY='/absolute/path/to/project' \
CLAUDE_BRIDGE_MODE='default' \
CLAUDE_BRIDGE_APPROVAL_MODE='accept' \
npx --yes ai-task-board-bridge@1.8.8 run claude
```

Claude Code Bridge 启动独立的 `claude-agent-acp` 子进程，Board 令牌不会传入该子
进程。它按精确 cwd 白名单同步 Claude Code Sessions，并从 ACP 会话配置项动态上报
可用模型与思考强度。Web 可新建、执行和删除真实 Session，也可开启 Goal 模式
（映射到 Claude Code 原生的 `/goal` 会话目标）；Claude ACP 没有可靠的改名接口，
因此网页会隐藏 Claude Code Thread 的改名入口。Claude 订阅与 API 用量没有公开的
本地额度接口，因此 Claude Code 连接不回报额度快照。
`CLAUDE_BRIDGE_MODE=bypass-permissions` 与
`CLAUDE_BRIDGE_APPROVAL_MODE=accept` 会扩大自动执行范围，属于高风险配置，请只在
可信工作区显式开启。完整变量、安全策略和 systemd 说明见
[Claude Code Bridge 包文档](packages/claude-code-bridge/README.md)。

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

可选：若仍想针对托管 Supabase 跑同一套 RPC 集成测试，连接一个**独立的
Supabase 测试项目**并先应用相同迁移，再只在当前 shell 注入测试变量：

```bash
TEST_SUPABASE_URL=https://TEST_PROJECT_REF.supabase.co \
TEST_SUPABASE_PUBLISHABLE_KEY=sb_publishable_... \
TEST_SUPABASE_SECRET_KEY=sb_secret_... \
RUN_HOSTED_INTEGRATION_TESTS=1 \
npm test -- tests/integration
```

集成测试默认跳过，只有显式设置 `RUN_HOSTED_INTEGRATION_TESTS=1` 才运行；它们绝不回退到开发或生产变量。套件会临时创建 Workspace、Auth 用户、连接、会话和任务，验证定向接收、租约、依赖并发完成、聚合父任务完成/重开、事务拆分、外部引用去重、用户回复及跨 Workspace RLS，结束时清理测试夹具。禁止传入生产项目凭据。

端到端测试默认启动本地 Next.js，并需要 `.env.local` 指向本地测试数据库：

```bash
npx playwright install chromium
npm run test:e2e
```

无测试账号时只验证登录启动页。要运行创建任务、刷新持久化、双浏览器 Realtime、
Connection 令牌只显示一次/撤销失效、私有附件上传/签名下载，以及“五步拆分 →
依赖逐项领取 → 跨浏览器问答 → 根任务 5/5 完成”的完整纵向用例，请为**测试库
用户**注入：

```bash
E2E_USER_EMAIL='e2e-user@example.com' \
E2E_USER_PASSWORD='test-only-password' \
npm run test:e2e
```

这些用例会创建唯一命名的任务、会话和连接，不执行跨用例或跨 Workspace 的批量
删除。请只连接可丢弃的测试库并定期重置测试数据，绝不要把 E2E 凭据指向生产
环境。

若被测应用已部署：

```bash
PLAYWRIGHT_BASE_URL=https://preview.example.com npm run test:e2e
```

## 部署

自托管部署（systemd + Caddy + 本地 PostgreSQL）见
[deploy/README.md](deploy/README.md)。要点：

1. 创建生产库并应用迁移（`DATABASE_URL` 指向 `ai_task_board`，不运行 Seed）。
2. 在 `/etc/ai-task-board.env` 配置 `DATABASE_URL`、`AI_TOKEN_PEPPER`、
   `NEXT_PUBLIC_APP_URL`、`LOCAL_STORAGE_DIR` 与 `FILE_EXPLORER_ROOTS`。
3. 将 `NEXT_PUBLIC_APP_URL` 设为最终 HTTPS 域名，Caddy 负责 TLS。
4. 部署后执行一次注册/登录、心跳会话、定向预留/完成任务和签名附件下载的
   冒烟测试。

生产 Secret 只进入服务端环境文件。不得把 `AI_TOKEN_PEPPER`、连接令牌、领取
令牌、Cookie 或附件正文输出到构建日志、应用日志或错误响应。

## 数据与状态规则

系统只有 `Task`：无子任务的是叶子任务，有子任务的是聚合任务。`claim_next_task` 使用 `FOR UPDATE SKIP LOCKED`，但只读取 `assigned_session_id` 等于当前会话、能力匹配且依赖已完成的 `ready` 叶子任务，不扫描公共任务池。CLI / APP 已经开始的任务通过 `report_current_task` 直接绑定到当前会话。接收任务会产生短期租约和一次性领取令牌；过期租约、旧令牌或其他会话不能更新任务。用户可在任务详情页暂停 `ready`/`claimed`/`running` 的叶子任务：`paused` 任务保留指派会话但不会被认领；暂停运行中任务会立即清理领取并尽力中断设备上的 turn；恢复时按依赖检查回到 `ready`/`blocked`，仍由原会话重新领取执行。

父任务按后代状态聚合：`waiting_user` 优先，其次 `running/claimed`、`failed`、`ready`、`blocked`，最后 `paused`；直接有效子任务全部完成后父任务完成。结构化进度按已完成叶子数计算，AI 上报百分比仅作估计展示。业务状态变更在服务端/RPC 执行，并以只追加方式写入 `task_events`；高频心跳只刷新在线时间或租约，不制造审计噪音。受控的 Workspace 物理清理仍会通过外键级联删除其历史数据。

## 当前限制

- MVP 面向个人或小团队，没有组织计费、复杂角色、自定义工作流或 DAG 可视化编辑器。
- Next.js 控制面不内置模型或通用 Agent 执行环境；Codex、Kimi、Antigravity 与 Claude Code Bridge 都是设备/Connection 级的可选 companion，其他 Harness 仍需自行接入 REST/MCP 或实现对应 adapter。
- 浏览器实时刷新由 LISTEN/NOTIFY → SSE 驱动，服务端只下发 `{ table }`，前端按表做粗粒度失效；断线重连后全量重拉，并以 TanStack Query 轮询兜底。Bridge 则使用独立的认证 SSE 唤醒端点，SSE 只发送固定空事件，任务内容仍从 REST 领取。
- Codex Bridge 只会近实时回传 AI 回复，不同步思考、命令、工具或用量；运行中 steering 由 Bridge 1.8.7+ 支持（对话面板「Steer 实时调整」开关，仅 Codex 运行时，turn 结束时自动回退为排队任务），网页审批与远程进程中断仍不受支持。SSE 不可用时会自适应轮询，最长约 60 秒发现新任务。
- Bridge 会从 App Server 子进程环境删除 Board Connection Token，但同一 OS UID 并不是令牌强隔离；强隔离需使用独立 UID 和/或 token proxy。默认 `danger-full-access` + `accept` 会无沙箱执行并自动同意关联当前活跃 turn 的受支持审批，属于高风险配置；需要限制写入和网络时应显式选择 `safe`，而 `inherit` 的实际边界取决于 thread 与本机 Codex 设置。
- Bridge 目前是 at-least-once 执行；若本地 turn 已执行但在完成 Task 前崩溃，租约恢复后可能重复提交该 turn，不可逆工具操作仍需自身幂等或人工确认。
- 会话对话框显示 Board 任务消息、Bridge 近实时 AI 回复，以及经设备和网页双重授权后补录的最近 Codex 用户消息与最终回复；这不是完整原始日志镜像。历史导入只追加，关闭或降低同步上限不会删除既有内容；`partial` 只表示本次快照触发本机安全扫描上限。Web Thread 管理只对 Workspace Owner 和 Bridge 0.5+ 开放；固定 `CODEX_THREAD_ID` 模式不允许网页新建或删除，删除也只接受没有活跃或已预留任务的 Thread。
- Board 服务没有通用任务 Worker；Next.js 启动时挂一个进程内定时器，仅定时清理已过期的幂等记录与废弃会话。原目标会话可原子恢复自己的过期租约，用户也可显式释放后改派。仅打开页面不会修改租约，卡片可能一直显示旧接收信息，直到下一次接收/释放命令。
- 附件仅保存私有 Storage 对象与元数据，外部 URL 的安全性由创建方负责。
- 附件上传采用“先写 Storage、再提交数据库元数据”的补偿式流程；客户端不得把同一个幂等键并发用于不同文件。进程在两步之间异常退出时可能留下未引用对象，生产项目应定期审计 Bucket。
- 任务详情聚合全部后代的消息、事件和附件，并计算递归叶子进度；“层级与依赖”区域目前只列直接父子关系，不提供完整多级树可视化。
- `heartbeat_ai_session` 只刷新空闲会话状态，`heartbeat_claim` 只刷新在线时间与执行中租约；两者不写任务事件或持久幂等响应，也不会进入 AI 上下文。Web 只允许向两分钟内有心跳的会话预留新任务。
- Storage 对象策略以 Workspace 成员为边界，同一 Workspace 成员可更新或删除该 Workspace 的附件；MVP 未建模“仅上传者可修改”。
- 测试和开发需使用独立本地 PostgreSQL 数据库；仓库不提供 Docker Compose，也不依赖托管 Supabase。

## 目录

```text
app/                  Next.js 页面、Route Handler 与 MCP Adapter
lib/                  PostgreSQL 数据访问、领域服务、鉴权与校验
supabase/migrations/  数据库结构、RLS、Storage Policy 与原子 RPC
supabase/local/       本地 PostgreSQL 兼容层与实时通知触发器
supabase/seed.sql      可选开发 Seed
docs/                 REST、MCP 与演示说明
scripts/demo.ts        单会话上下文可执行演示
packages/codex-bridge/ 可通过 npx 运行的统一 Bridge npm 包与 Codex 运行时
packages/kimi-bridge/  嵌入统一 npm 包的私有 Kimi ACP 运行时
packages/antigravity-bridge/ 嵌入统一 npm 包的私有 Antigravity CLI 运行时
packages/claude-code-bridge/ 嵌入统一 npm 包的私有 Claude Code ACP 运行时
scripts/codex-bridge.ts 仓库开发环境的 Bridge 兼容入口
tests/                 Vitest 单元/集成测试与 Playwright E2E
```
