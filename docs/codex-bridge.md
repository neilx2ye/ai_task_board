# Codex Bridge

Codex Bridge 0.7 是运行在 Codex 设备上的常驻 companion。一个 Bridge 进程对应一台设备上的一个 AI Connection；它通过 stdio 启动本机 `codex app-server`，自动发现一个或多个本机工作目录下未归档的顶层 Codex thread，并为每个 thread 在 AI Task Board 中同步一个独立 Session。

网页向某个 Session 发送消息后，Bridge 会把任务交给对应的本地 thread，并近实时回传 AI 回复增量。思考摘要、命令输出、工具过程和用量不会同步到 Board。Bridge 直接使用 Board REST API 与认证 SSE，不依赖 Board MCP。

## 运行边界

Bridge 必须在保存 Codex 登录、thread 数据和目标工作区的设备上，以拥有这些数据的同一个操作系统用户运行。不要把它放进 Next.js Route Handler、Server Action 或 AI Task Board 服务进程：Board 只负责鉴权、持久化和网页控制面，不应获得设备的 Codex 登录或工作区权限。

```text
浏览器 ── HTTPS ──> AI Task Board / Supabase
                         ▲
                         │ 认证 SSE 唤醒 + REST 任务/活动
                         │
                  一个 systemd Bridge
                         │
                         │ stdio JSONL
                         ▼
                  Codex App Server
                    ├── 顶层 thread A ── 工作区 A
                    ├── 顶层 thread B ── 工作区 B
                    └── 顶层 thread C ── 工作区 C
```

同一设备/Connection 应只运行一个 Bridge。不同 thread 可以并行，但同一个 thread 仍只能有一个活跃写入者；Bridge 管理某个 thread 时，不要让另一个 TUI、IDE 或自动化进程同时向它提交 turn。

## 准备条件

1. Board 已先应用仓库当前的 Session 清单、活动、历史导入、Bridge 配置和 Web Thread 指令 API 与数据库 migration。Bridge 不会把同步 API 的 `404` 回退为旧版逐 Session 注册，版本不匹配会直接启动失败。
2. 在网页“AI 连接”中创建或选择一个 Codex Connection，并保存只显示一次的 `atb_...` Connection Token。
3. 设备已安装兼容的 `codex` CLI，当前系统用户已经登录，且 `codex app-server --stdio` 可以启动。
4. 若本机已有 Codex thread，当前版本会自动发现并恢复；没有既有 thread 时，Workspace Owner 可在网页选择 Bridge 已上报的工作目录并创建第一个 Thread（固定 `CODEX_THREAD_ID` 模式除外）。
5. 当前用户能够访问这些 thread 对应的工作目录；运行 npx 还需要 Node.js 18 或更高版本。

设备只需能通过 HTTPS 访问 `AI_TASK_BOARD_URL`，无需克隆 Board 仓库，也无需允许公网反向连接设备。

## 统一包中的交互式安装

Linux 上推荐直接启动交互式安装器：

```bash
npx --yes ai-task-board-bridge@1.1.0 setup codex
```

`ai-task-board-bridge` 也是 Kimi Bridge 的唯一公开安装包。不带 `codex` 目标时，
安装器会先询问安装 Codex、Kimi，还是两者；选择 `both` 会依次安装两个隔离服务，
并分别索取对应平台的 Connection Token。

不带参数运行且当前终端是 TTY、同时缺少 Board URL 或 Connection Token 时，也会自动
进入相同的 setup。安装器依次确认当前有效 UID、Board 地址、隐藏输入的 Connection
Token、工作目录、Codex 配置目录与可执行文件、Thread 范围和数量、权限/审批模式以及
provider 凭据环境变量、是否允许 Web 配置，最后才写文件和启动服务。新安装默认选择 `cwd`、`safe`、
`decline`；高风险选项仍可在交互中明确选择。

安装目标按当前有效用户计算，而不是按 npm 全局目录的所有者计算。不要使用 `sudo npx`
来代替目标用户运行；否则有效用户是 root，安装器会警告，并且继续后得到的是 root 的
用户服务和 Codex 配置。为另一名 Linux 用户安装时，应登录该用户的 shell 后再次运行
setup。不同用户各自的 systemd user manager 可以拥有同名 unit，但通常应为它们创建
不同的 Board Connection/Token；同一 Connection 同时只能有一个 Bridge 获得运行租约。

安装器不会写入模型覆盖。它在 unit 和受保护环境文件中显式固定当前用户的 `HOME` 与
所选 `CODEX_HOME`，再由该环境中的 `codex app-server` 读取用户级登录、
`config.toml`、provider 与默认模型；已经保存在 Thread/Turn 上的模型选择仍可优先于
用户默认值。若 `config.toml` 的自定义 provider 通过 `env_key` 或
`env_http_headers` 引用环境变量（例如 `DEEPSEEK_API_KEY`），安装器会检测变量名并用
隐藏输入确认其值；它只保存用户确认的变量，不会把整个交互 shell 环境复制进服务。

### 前台与自动化兼容模式

下面的设备级配置不固定 thread：

```bash
AI_TASK_BOARD_URL='https://board.example.com' \
AI_TASK_BOARD_CONNECTION_TOKEN='atb_REPLACE_ME' \
CODEX_WORKING_DIRECTORY='/path/to/a/safe/start-directory' \
npx --yes ai-task-board-bridge@1.1.0 run codex
```

> **高风险默认值：** Bridge 默认使用
> `CODEX_BRIDGE_PERMISSION_MODE=danger-full-access`（完全访问、无沙箱）和
> `CODEX_BRIDGE_APPROVAL_MODE=accept`（设备端自动同意）。这让任务在当前 OS
> 用户权限范围内不受沙箱写入或网络限制，并且无需网页逐次确认。只应在工作区、Codex
> 配置和 Connection 使用者都可信时使用；需要限制写入和网络时，请显式设置
> `CODEX_BRIDGE_PERMISSION_MODE=safe`。

这里的高风险默认值只描述原有环境变量运行模式；交互式新安装会明确询问并默认选择
`safe` + `decline`。脚本和容器可继续直接设置环境变量，也可显式运行 `run` 子命令；
非交互输入不会意外进入 setup。

默认 `CODEX_THREAD_SCOPE=cwd`：未设置 `CODEX_THREAD_ID` 时，只发现记录 cwd 与本机目录白名单中任一目录**完全相同**的顶层 thread（不会自动包含子目录）。未设置 `CODEX_WORKING_DIRECTORIES` 时，白名单只有兼容项 `CODEX_WORKING_DIRECTORY`。如确需不受白名单约束地管理跨项目 thread，必须显式设置高风险选项 `CODEX_THREAD_SCOPE=all`。

多目录使用 JSON 数组配置稳定 key、显示名称与本机路径；第一项同时作为 App Server 启动目录和未指定目录的兼容创建目标：

```bash
AI_TASK_BOARD_URL='https://board.example.com' \
AI_TASK_BOARD_CONNECTION_TOKEN='atb_REPLACE_ME' \
CODEX_WORKING_DIRECTORIES='[{"key":"main","name":"Main App","path":"/srv/main"},{"key":"docs","name":"Docs","path":"/srv/docs"}]' \
CODEX_THREAD_SCOPE='cwd' \
npx --yes ai-task-board-bridge@1.1.0 run codex
```

目录 key 只允许字母、数字、点、下划线和连字符，且在同一 Bridge 内必须稳定唯一；数组最多 100 项，路径也不能重复。Board 会按“设备 → 工作目录 → Thread”展示，并只在新建命令中返回选中的 key，由 Bridge 本机把 key 解析为路径。

要精确限定一个既有 thread，可设置兼容过滤器；它会覆盖 cwd/all 范围：

```bash
AI_TASK_BOARD_URL='https://board.example.com' \
AI_TASK_BOARD_CONNECTION_TOKEN='atb_REPLACE_ME' \
CODEX_THREAD_ID='REPLACE_WITH_LOCAL_THREAD_ID' \
CODEX_WORKING_DIRECTORY='/path/to/target-repository' \
npx --yes ai-task-board-bridge@1.1.0 run codex
```

不要把 Connection Token 写入仓库、截图、日志或命令行参数。长期运行时应由本机 Secret Store 或权限 `0600` 的环境文件注入。Bridge 启动 App Server 时会从子进程环境删除 `AI_TASK_BOARD_CONNECTION_TOKEN`，同时保留 Codex 登录所需的普通环境变量。但同一 OS UID 的进程通常仍可通过进程环境、调试接口或同 UID 文件读取等路径互相影响，这不是令牌的强隔离；强隔离应使用独立 UID 和/或仅代转所需请求的 token proxy。若使用自定义 Codex home，systemd 服务必须看到相同设置。

### 环境变量

| 变量 | 必填 | 默认值 | 作用 |
|---|---|---|---|
| `AI_TASK_BOARD_URL` | 是 | — | Board 基地址；结尾 `/` 会被移除 |
| `AI_TASK_BOARD_CONNECTION_TOKEN` | 是 | — | 网页创建的 AI Connection 原始令牌 |
| `CODEX_THREAD_ID` | 否 | 空 | 兼容过滤器；设置后只管理这个既有 thread |
| `CODEX_WORKING_DIRECTORY` | 否 | 当前目录 | 兼容的单工作目录；未设置多目录数组时，也是 App Server 启动、默认创建和 `cwd` scope 精确匹配目录 |
| `CODEX_WORKING_DIRECTORIES` | 否 | 空 | 最多 100 项的 JSON 数组，每项为 `{key,name?,path}`；设置后第一项作为默认目录，`cwd` scope 精确匹配数组内任一目录 |
| `CODEX_THREAD_SCOPE` | 否 | `cwd` | `cwd` 仅管理本机目录白名单中 cwd 完全相同的顶层 thread；`all` 忽略白名单进行跨项目发现，属于高风险显式 opt-in |
| `CODEX_SESSION_NAME` | 否 | `Codex · <cwd basename> · <thread ID 前 8 位>` | Board Session 名称前缀；单 thread 过滤模式下作为完整名称 |
| `CODEX_BRIDGE_INCLUDE_THREAD_TITLES` | 否 | `false` | `true` 才把本地 thread 标题/首条 prompt 预览用于 Session 名称；会增加元数据泄露面 |
| `CODEX_BRIDGE_WEB_CONFIG` | 否 | `false` | `true` 才允许 Web Console 动态启停、切换标题、调整受约束数量，并直接设置设备级并发上限 |
| `CODEX_BRIDGE_ALLOW_REMOTE_THREAD_TITLES` | 否 | `false` | `true` 才允许 Web Console 开启标题上传；本机已设置 `CODEX_BRIDGE_INCLUDE_THREAD_TITLES=true` 时也视为已授权 |
| `CODEX_BRIDGE_ALLOW_HISTORY_SYNC` | 否 | `false` | `true` 才允许 Web Console 开启旧历史同步；授权后仍需网页显式开启 |
| `CODEX_BRIDGE_ALLOW_REMOTE_WORKING_DIRECTORIES` | 否 | `false` | `true` 才允许 Web Console 用项目 key、名称和绝对路径替换运行时目录清单；Bridge 会验证每个路径存在且为目录 |
| `CODEX_BRIDGE_MAX_HISTORY_TURNS` | 否 | `50` | 每个 thread 可同步的最近完成 turn 本机上限，范围 `1..200` |
| `CODEX_MODEL` | 否 | 空 | thread 未报告模型时使用的 Board 展示标签，不覆盖实际模型 |
| `CODEX_CAPABILITIES` | 否 | `coding,shell,file-edit,multi-thread,app-server` | 用于 Board 任务能力匹配的列表 |
| `CODEX_MAX_THREADS` | 否 | `50` | 所有目录合计最多管理的最近顶层 thread 数，范围 `1..500` |
| `CODEX_MAX_CONCURRENT_TURNS` | 否 | `2` | 兼容的启动并发值，范围 `1..32`；启用 Web 配置后由网页值直接替换 |
| `CODEX_BRIDGE_APPROVAL_MODE` | 否 | `accept` | App Server 审批策略；`accept` 自动同意与当前活跃 turn 关联的受支持请求（高风险），也可设为 `decline` 或 `accept-session` |
| `CODEX_BRIDGE_PERMISSION_MODE` | 否 | `danger-full-access` | `danger-full-access` 完全访问且无沙箱（高风险）；`safe` 限制为该 thread cwd 的 `workspace-write` 并关闭网络；`inherit` 不发送覆盖、沿用本机设置，边界不确定时同样属于高风险 |
| `CODEX_HOME` | 否 | 当前用户的 `~/.codex` | Codex 登录、配置与 thread 数据目录；交互安装会显式固定为所选的当前用户目录 |
| `CODEX_BINARY` | 否 | `codex` | Codex CLI 可执行文件路径或名称 |
| `AI_TASK_BOARD_POLL_INTERVAL_MS` | 否 | `5000` | SSE 不可用时的初始轮询间隔，范围 `500..60000` 毫秒 |
| `AI_TASK_BOARD_LEASE_SECONDS` | 否 | `900` | 任务租约与续租时长，范围 `60..3600` 秒 |
| `AI_TASK_BOARD_THREAD_SYNC_INTERVAL_MS` | 否 | `60000` | 重新扫描完整 thread 清单的间隔，范围 `10000..600000` 毫秒 |
| `AI_TASK_BOARD_CONFIG_POLL_INTERVAL_MS` | 否 | `10000` | 启用 Web 配置后的期望配置轮询间隔，范围 `1000..600000` 毫秒；运行租约仍独立且至少每 10 秒续租 |

数值变量超出范围或不是整数时会回退到默认值。`CODEX_MAX_THREADS` 只是数量上限，不是安全边界；默认项目边界是 cwd 精确匹配，严格限定一个 thread 时使用 `CODEX_THREAD_ID`。

## Web Console 动态配置

设备显式设置 `CODEX_BRIDGE_WEB_CONFIG=true` 后，Workspace Owner 可以在“AI 连接 → Bridge 设置”调整 Bridge 启停、是否上传 thread 标题、是否同步历史、最大 thread 数、最大并行 turn 数和最近历史 turn 数。最大并行 turn 数在 `1..32` 内由网页直接设置为整台设备的运行上限，不再与本机上限做二次比较。Bridge 0.8 还可管理 1 到 100 个项目工作目录；该能力必须由设备额外设置 `CODEX_BRIDGE_ALLOW_REMOTE_WORKING_DIRECTORIES=true` 才会应用。Bridge 默认每 10 秒拉取期望版本，应用后回报实际值、设备约束与错误；修改不需要重启 systemd。

网页配置默认不能扩大本机目录边界：未开启远程目录授权时，Bridge 会忽略网页目录并继续使用启动时的 `CODEX_WORKING_DIRECTORY` / `CODEX_WORKING_DIRECTORIES`。设备明确授权后，网页可以提交稳定 key、显示名称和本机绝对路径；Bridge 会再次校验格式、重复项、绝对路径及目录存在性，再安全停止已被排除的 worker、更新实际清单并回报结果。这个 opt-in 允许 Workspace Owner 扩大同一 Bridge 进程的 Codex 工作范围，应只授予受信 Owner。`cwd/all` 范围、固定 thread、Codex 路径、Connection Token、权限模式与审批模式仍只由设备环境决定；Thread 数仍会夹紧到本机上限，最大并行 turn 数则由网页在 `1..32` 内统一设置，标题与历史仍各自需要本机授权。网页停用 Bridge 时，进程仍保持在线以接收后续配置，但会先安全停止 worker、释放任务，再提交空的权威 thread 清单并取消后台历史扫描。

## Web Console 管理 Threads

Bridge 0.5 起，Workspace Owner 可以在“AI 会话”的设备菜单中新建、重命名和删除 Codex Thread；Bridge 0.7 起，新建按钮位于具体工作目录节点。新建对话框可以显式选择 Codex 模型和思考强度，也可以让任一设置继续继承设备默认值；选择值随持久化指令交给 Bridge，并作为 App Server 的新 Thread 配置应用。Bridge 启动时会调用 App Server `model/list`，把当前 provider 可见的模型、默认思考强度和支持强度上报给 Board；新建 Thread 和会话输入框都优先使用这份目录，旧版 App Server 或目录读取失败时才显示兼容列表。使用自定义 `model_provider` 时，应同时通过 Codex 的 `model_catalog_json` 描述可选择模型；API 地址、认证环境变量和值始终只留在 Bridge 设备上。操作先作为持久化指令写入 Board，只有持有该 Connection 当前运行租约的 Bridge 才能领取并执行，因此多个进程不会同时修改同一设备。新建命令始终只保存当前设备实际已上报的目录 key，Bridge 再从当前有效清单解析绝对路径；即使 0.8 开启 Web 路径管理，也不能在单条 Thread 命令里绕过清单注入路径。重命名与删除也只能针对当前 Bridge 清单内的受管 Thread。设置了固定 `CODEX_THREAD_ID` 时，新建和删除会被拒绝。

删除只允许空闲且没有已预留任务的 Thread。请求被接受后，Board Session 会立即隐藏并停止接收新任务，再由 Bridge 调用 Codex App Server 的硬删除接口；缺少硬删除方法的兼容 App Server 会退化为归档。看板中的审计与已同步历史仍保留。

## 旧历史同步与隐私边界

历史同步默认关闭。设备必须同时设置 `CODEX_BRIDGE_WEB_CONFIG=true` 和 `CODEX_BRIDGE_ALLOW_HISTORY_SYNC=true`，再由 Workspace Owner 在网页开启；仅设置本机 allow 变量不会自行上传内容。Bridge 使用 App Server 的 `thread/turns/list`（`itemsView=notLoaded`）取得有界 turn 清单，再用 `thread/items/list` 分页读取持久化 item，只扫描普通 CLI / VS Code thread 的最近完成 turn。带有持久化 `clientUserMessageId` 的 turn 来自 Board 实时任务，会整轮跳过，避免与实时回传重复。

导入白名单只有用户的 `userMessage` 与最终 `agentMessage`。`reasoning.summary`、图片、`localImage`/skill 的本机路径、`reasoning.content` 原始推理、命令与输出、diff、MCP 参数/结果和其他工具 item 都不进入上传请求。消息文本仍会经过现有 Secret 尽力脱敏和 UTF-safe 的 50,000 字符上限。历史用户消息会对有权访问该 Workspace 的成员可见。

扫描在独立、可取消且有界的后台循环运行：单个 turn 最多读取 10,000 个原始 item，每轮每个 thread 最多保留 500 条白名单活动；请求批次最多 100 条且不超过 512 KiB。命令、MCP、diff、附件路径与原始推理会在分页读取时直接丢弃，不进入跨页缓存。Bridge 以 `thread.updatedAt` 和有效 turn 上限组成签名，同一进程内签名未变化时只扫描一次；thread、上限变化或进程重启后的重扫依靠稳定的 thread/turn/item 外部引用、原始 turn 时间和 item 顺序保持幂等。`partial` 表示本次有界快照在达到有效 turn 上限前触发了本机安全扫描上限；触顶的 turn 不会部分导入，`local-safety-cap` 也不是可续扫的 App Server cursor。历史读取或上传失败只更新该 Session 的历史同步状态并做有界退避，不会让运行租约、清单同步、worker 或活跃 turn 退出。

Board 中已导入的历史是只追加数据。关闭历史同步或降低最近 turn 上限只会停止后续导入，不会删除此前已经上传的内容；需要清除时应使用 Board 对应的 Workspace / 数据删除流程。

## 会话记录同步边界

实时同步策略是固定的，会话顶部不再提供开关。Bridge 在网页发起的 turn 中只上传 AI 回复，并用 `summary: "none"` 启动 turn；服务端也会无条件忽略实时流里的非 `assistant_message` 活动，防止旧 Bridge 或自定义 Adapter 重新开启过程上传。另行授权的旧历史同步会导入用户消息与最终 AI 回复。Blocking 结构化问题/答案继续使用独立流程，不属于会话活动同步。以前已保存的过程活动不会被反向删除，但会话面板不再展示它们。

未启用 Web 配置时，Bridge 仍会周期性上报本机边界并续租运行实例，但忽略网页期望值；Web 会明确显示“本机禁止 Web 配置”。同一 Connection 的另一个 Bridge 在租约有效时只会待机，不会启动 worker，直到旧实例释放或最长约 30 秒的租约过期。续租长期失败时，持有者会在数据库租约可能失效前主动停止所有 worker。标题可能包含首条 prompt 预览，开启前应确认当前 Workspace 的成员都可以看到这类元数据。

## 审批安全策略

Bridge 没有网页逐次审批通道。默认 `CODEX_BRIDGE_PERMISSION_MODE=danger-full-access` 会在 `thread/start`、`thread/resume` 与 `turn/start` 显式使用 `approvalPolicy=on-request`、`approvalsReviewer=user` 和 `danger-full-access`。此模式不施加沙箱写入或网络限制，Codex 可以访问运行 Bridge 的 OS 用户本来有权访问的资源；它不会突破该用户的操作系统权限，也不等同于 root。默认值是为了让受信环境中的任务不中途卡在沙箱限制上，但属于明确的高风险配置。

需要收紧边界时，显式设置 `CODEX_BRIDGE_PERMISSION_MODE=safe`。`safe` 同样使用 `on-request` 和用户 reviewer，但将 sandbox 固定为 `workspace-write`；最终 turn 的可写根目录只包含该 thread 的绝对 cwd（无 cwd 时使用配置的工作目录），排除 `/tmp` 与 `$TMPDIR` 的隐式可写权限，并关闭网络访问。它主要约束写入和网络，**不保证阻止 Codex 读取同 UID 本来可读的文件**。`inherit` 则不发送任何权限或审批覆盖，完全沿用 thread 与本机 Codex 配置；它可能继承完全访问、额外可写目录或更严格设置，无法确认本机配置时也应视为高风险。

App Server 发起命令、文件变更或权限审批时，默认 `CODEX_BRIDGE_APPROVAL_MODE=accept` 会在设备端立即批准与当前活跃 turn 关联的受支持请求，无需网页确认。无法关联当前活跃 turn 的请求仍会拒绝；blocking `requestUserInput` 继续转交 Web Console，MCP elicitation 仍会拒绝。这个变量**只决定 server-initiated request 的回答**，不会改变沙箱、文件可写范围或网络权限。

`decline` 会拒绝审批请求；`accept-session` 可能把批准扩大到整个 Session。自动批准不是网页确认，属于高风险行为；只应在工作区、Codex 配置和 Connection 使用者都可信时使用。Bridge 以 `accept` 或 `accept-session` 启动时会输出警告。

## systemd 常驻运行

`setup` 会幂等创建或更新以下当前用户文件；设置了绝对路径形式的
`XDG_CONFIG_HOME` / `XDG_DATA_HOME` 时会遵循它们：

- `~/.config/ai-task-board/codex-bridge.env`：权限 `0600`，保存 Token、明确选择的
  安全配置、绝对 `CODEX_BINARY`、当前用户的 `HOME` / `CODEX_HOME` 和安装时的
  `PATH`，以及用户确认传给自定义 Codex provider 的凭据变量。重跑 setup 会保留它不认识的高级变量；若检测到有效的
  `CODEX_WORKING_DIRECTORIES`，会询问是否保留。
- `~/.config/systemd/user/ai-task-board-bridge.service`：当前用户的 user unit。
  unit 故意不包含 `User=`；`systemctl --user` 连接的 user manager 本身就固定了 UID。
- `~/.local/share/ai-task-board/codex-bridge/versions/<version>/`：从当前 npx 包复制的
  固定版本运行文件。服务使用绝对 Node 路径直接启动这里的 `dist/cli.js run`，不依赖
  后续可能被清理的 npx cache，也不会在每次重启时重新下载 npm 包。

写入完成后，安装器执行 `systemctl --user daemon-reload`、`enable` 和 `restart`。
查看状态和日志：

```bash
systemctl --user status ai-task-board-bridge.service
journalctl --user -u ai-task-board-bridge.service -f
```

重新运行同版本的 setup 可更新配置并重启 unit。若服务需要在用户退出登录后继续运行，
安装器会检查 linger 并在未开启时给出提示；`loginctl enable-linger` 仍需由管理员决定和
执行。从旧名称升级时，setup 会停用 `ai-task-board-codex-bridge.service` 后启动新的
`ai-task-board-bridge.service`，若新服务启动失败则恢复旧服务，避免两个 Bridge 并行。
不要为同一设备/Connection 再启动第二个 unit 或手工 Bridge 进程。

## 任务与 thread 如何流转

1. Bridge 启动一个本地 App Server stdio 子进程，并完成 `initialize` / `initialized` 握手。
2. Bridge 先取得设备运行租约并上报设备约束；启用 Web 配置时，再应用网页期望版本。Thread 数、目录和敏感上传能力仍服从本机边界，并行 turn 数直接采用网页的 `1..32` 值。旧实例租约仍有效时，新进程保持待机且不启动 worker。
3. Bridge 分页读取当前用户最近的未归档 Codex thread，忽略子 Agent thread，并应用默认的多目录 cwd 精确白名单、显式 `all` 范围或可选的 `CODEX_THREAD_ID` 精确过滤器，再应用有效的 thread 数上限。
4. Bridge 将目录与 Thread 完整清单原子同步到 Board。每个本地 thread 的稳定 ID 都映射为一个 Board Session，并关联一个稳定目录 key；以后发现的新 thread 会在下一次清单同步加入，离开清单的 worker 会停止。
5. 每个 Session 建立自己的认证 SSE 唤醒流并保持心跳。SSE 只传固定的 `ready` / `wake` 提示，真正的任务仍通过 REST 原子领取；断线时自适应轮询兜底。
6. 每个 thread 一次只执行一张 Task。有效的设备级并发上限限制不同 thread 同时运行的 turn 数，多余工作继续排队。
7. Bridge 调用 `thread/resume` 和 `turn/start`，固定请求 `summary: "none"`，再消费 App Server 的 JSONL 通知。只有 AI 文本 delta 会按约 500 毫秒或 8 KiB 聚合后上传，最终回复也会持久化。
8. Web Console turn 可附带最多 4 张 PNG、JPEG、WebP 或 GIF（单张 10 MiB、合计 20 MiB）。图片保存在私有 `task-artifacts` bucket；Bridge 仅为当前会话已分配或领取的任务获取短期下载地址，校验字节数后以内联 Data URL 作为同一 `turn/start` 的 `image` 输入。Base64 不写入任务、消息或活动记录。
8. 若 App Server 在 turn 中发出 blocking `item/tool/requestUserInput`，Bridge 将结构化问题持久化到 Board 并保持原请求等待；Web 选择框提交后，Bridge 把答案返回该请求，同一个 turn 原地继续。等待期间 Task claim 和心跳均不释放。
9. `turn/completed` 后，最后一条 AI 消息用于完成 Task；错误会把 Task 标记为失败。Bridge 随后继续处理对应 Session 队列。

网页在某个 thread 正忙时发送的新消息会创建下一张排队 Task。当前版本不会把它可靠地 steer 到当前 turn。

### 面板可见内容

| App Server 事件 | 面板活动 |
|---|---|
| `item/agentMessage/delta`、agent message 完成 | AI 回复增量与最终消息 |

回复使用稳定的 thread/turn/item/chunk 外部引用去重。HTTP 5xx、限流或临时网络错误会退避重试。常见 Token、Authorization、API key、password 和 secret 形式会做尽力脱敏，过长内容会被截断；这不是完整的数据防泄漏系统，仍应限制 Codex 可读 Secret，并评估把 AI 回复同步到共享 Board 的边界。Inventory 必然上传 thread ID、绝对 `working_directory`、当前模型标签，以及 `model/list` 返回的可见模型名称与能力元数据给该 Workspace 的成员；provider API 地址、Token 和认证环境变量不会上传。只有本机直接开启标题，或同时允许 Web 配置与远程标题并由网页开启时，才额外把 thread 标题/首条 prompt 预览用于 Session 名称。

## 思考与工具边界

Bridge 不请求或同步 reasoning summary，也不保存、展示模型隐藏的原始 chain-of-thought。命令、文件变更、工具调用、计划和用量仅留在本机 Codex 执行环境，不会进入 Board 会话记录。

## MCP 是否必需

不必需。Bridge 通过 REST 注册 Session、领取任务和回传活动，通过 SSE 接收唤醒；它不会为了正常运行而安装或调用 AI Task Board MCP。

Board MCP 仍可供其他 AI Host 主动操作任务，也可以作为 Codex 自己的可选工具配置。若某个 Codex thread 调用了已配置的 MCP 工具，该调用过程不会同步到会话记录；MCP 端点本身不能替代常驻 Bridge，也不能反向唤醒已退出的模型。

## 心跳、停止与恢复

- 每个受管 Session 空闲时每 45 秒发送在线心跳；执行时每 45 秒续租 Task。两分钟没有活动后网页会把 Session 视为离线。
- SSE 每 15 秒收到注释保活，连接会周期性重建以重新验证 Token；即使 SSE 丢失，持久 Task 仍可由最长约 60 秒的兜底轮询发现。
- 心跳不进入 Codex thread，不消耗模型 Token，也不写对话或高频任务事件。
- 收到 `SIGINT` / `SIGTERM` 时，Bridge 会请求 App Server 中断活跃 turn，并尽力释放已领取 Task；这只是本机关闭路径的尽力行为，不是可靠的网页远程 interrupt。
- 断电、强杀或完全断网时无法及时释放，Task 会在租约过期后恢复。重启后 Bridge 会重新扫描 thread 清单并恢复各 Session worker。

## 当前限制

- **Web 路径授权是设备级高权限开关。** 0.8 可在网页管理项目清单，但只有设备显式设置 `CODEX_BRIDGE_ALLOW_REMOTE_WORKING_DIRECTORIES=true` 才会应用；授权后受信 Owner 可以把 Bridge 工作范围切换到该 OS 用户可访问的其他目录。Session 名称前缀与逐个 thread 的 allow/deny 仍由设备配置或后续版本处理，网页侧栏隐藏某个 Session 也不会停止其本地 worker。
- **历史同步是限量白名单，不是完整原始日志镜像。** 只补录最近完成 turn 的用户消息与最终 AI 回复；思考、工具过程、附件与本机路径都不会补录。扩大 turn 上限后会从最近历史重新幂等扫描；关闭或降低上限不会反向删除已导入内容。
- **没有可靠的运行中 steer。** 忙碌时的新网页消息排到下一张 Task，当前 turn 完成后才执行。
- **没有网页审批。** 默认 `danger-full-access` 不施加沙箱写入或网络限制，默认 `accept` 会在设备端自动批准与当前活跃 turn 关联的受支持请求；这个高风险组合不是用户逐次确认。可用 `safe` 收紧沙箱，用 `decline` 统一拒绝审批，两者需要分别设置。
- **没有可靠的网页 interrupt。** 网页状态或取消操作不能保证立即终止本地命令；停止 systemd 服务只会走尽力的 App Server interrupt。
- **只转换协议级结构化问题。** blocking `item/tool/requestUserInput` 会自动显示 Web 选择框并保留原 turn；普通 AI 文本里的疑问句不会自动暂停，网页普通消息仍会成为下一张 Task。
- **默认 cwd scope 不是令牌强隔离。** 默认只选 cwd 完全相同的 thread，能避免静默暴露其他项目的最近 thread；但同 UID 的 Codex/TUI/Bridge 仍共享用户级数据与进程权限。更强边界需要 `CODEX_THREAD_ID`、独立 UID 和/或 token proxy；`CODEX_THREAD_SCOPE=all` 会显式扩大到跨项目 thread。
- **同一 thread 仍是单写入者。** 不要同时从 Bridge、TUI、IDE 或另一自动化进程提交 turn；不同 thread 才能安全并行。
- **本机 App Server 是受信协议边界。** Bridge 会把单个活动流累计限制在 100,000 个 code unit 并分成至多约 8 KiB 的上传块，但当前 stdio JSONL reader 在解析前仍会缓冲完整单行 frame；不要把不受信任的程序伪装成 `CODEX_BINARY`。
- **执行语义是 at-least-once。** 如果本地 turn 已产生副作用，但进程在完成 Task 或写下 durable checkpoint 前崩溃，租约恢复后可能再次提交。事件幂等只能去重已上传活动，不能撤销发布、付款、删除等外部副作用；不可逆操作必须使用 Harness 自身幂等键或人工确认。
- **交互式托管目前只覆盖 Linux systemd。** Linux setup 会安装 systemd user service；非 Linux、容器或无 user manager 的环境仍需用环境变量模式交给 launchd 或其他进程管理器。

## 常见故障

- 启动时报 `AI_TASK_BOARD_URL is required` 或 `AI_TASK_BOARD_CONNECTION_TOKEN is required`：确认两个必填变量位于 systemd 实际读取的环境文件中。
- `setup 需要交互式终端`：在真实 TTY 中运行 setup；CI、容器入口和重定向输入应继续使用环境变量与 `run` 子命令。
- `systemctl --user` 无法连接：确认命令是在目标用户的登录会话中执行，且系统提供 systemd user manager；不要通过 `sudo npx` 猜测目标用户。
- `codex app-server` 启动失败：用同一 OS 用户检查 `CODEX_BINARY`、Codex 登录和自定义 Codex home；systemd 的 PATH 通常比交互式 shell 更短。
- 找不到任何 thread：确认当前用户确实拥有本地 Codex 数据，且默认 scope 下 thread 记录的 cwd 与 `CODEX_WORKING_DIRECTORY` 或 `CODEX_WORKING_DIRECTORIES` 中某个路径完全相同；若设置了 `CODEX_THREAD_ID`，检查 ID 是否正确且对应未归档的顶层 thread。
- 同步、结构化问题或配置 API 返回 `404`：先升级 Board 数据库 migration 与 API；0.8 Bridge 不会为目录/thread 同步或同 turn 问答回退到旧版接口。只有未启用 Web 配置时，缺少配置端点才会降级为继续使用本地配置。
- Web 保存项目路径后仍使用默认目录：确认 Board 已应用工作目录相关 migration、设备 Bridge 为 0.8+，并同时设置 `CODEX_BRIDGE_WEB_CONFIG=true` 与 `CODEX_BRIDGE_ALLOW_REMOTE_WORKING_DIRECTORIES=true`；路径必须是设备操作系统上的现有绝对目录，不能填写 Board 服务器路径。
- Session 在线但没有任务：确认网页消息发到了该 thread 对应的 Session，依赖已经完成，且 `CODEX_CAPABILITIES` 满足任务要求。
- turn 因审批失败：检查是否显式设置了 `CODEX_BRIDGE_APPROVAL_MODE=decline`、请求是否无法关联当前活跃 turn，或请求类型是否不支持自动批准；权限模式与审批模式彼此独立，不要通过切换 `safe` / `danger-full-access` 来绕过协议错误。
- 活动不是逐字符更新：Bridge 会聚合 delta，网页还依赖网络、持久化和 Realtime 失效通知；“近实时”不保证固定毫秒延迟。
- 出现重复或写入冲突：确认同一设备/Connection 只有一个 Bridge，并停止向相同 thread 写入的其他 TUI、IDE 或自动化进程。

协议层详情见 [REST API 接入示例](rest-api.md)；可选 MCP 接入见 [MCP 接入](mcp.md)；本地协议能力见 [Codex App Server 官方文档](https://developers.openai.com/codex/app-server/)。
