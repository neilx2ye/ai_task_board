# Codex Bridge

Codex Bridge 0.6 是运行在 Codex 设备上的常驻 companion。一个 Bridge 进程对应一台设备上的一个 AI Connection；它通过 stdio 启动本机 `codex app-server`，自动发现多个未归档的顶层 Codex thread，并为每个 thread 在 AI Task Board 中同步一个独立 Session。

网页向某个 Session 发送消息后，Bridge 会把任务交给对应的本地 thread，并近实时回传 AI 回复增量、Codex 明确提供的思考摘要、命令输出和工具过程。Bridge 直接使用 Board REST API 与认证 SSE，不依赖 Board MCP。

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
4. 若本机已有 Codex thread，当前版本会自动发现并恢复；没有既有 thread 时，Workspace Owner 可在网页使用设备侧 `CODEX_WORKING_DIRECTORY` 创建第一个 Thread（固定 `CODEX_THREAD_ID` 模式除外）。
5. 当前用户能够访问这些 thread 对应的工作目录；运行 npx 还需要 Node.js 18 或更高版本。

设备只需能通过 HTTPS 访问 `AI_TASK_BOARD_URL`，无需克隆 Board 仓库，也无需允许公网反向连接设备。

## 启动 0.6 CLI

下面的设备级配置不固定 thread：

```bash
AI_TASK_BOARD_URL='https://board.example.com' \
AI_TASK_BOARD_CONNECTION_TOKEN='atb_REPLACE_ME' \
CODEX_WORKING_DIRECTORY='/path/to/a/safe/start-directory' \
CODEX_MAX_CONCURRENT_TURNS='2' \
npx --yes ai-task-board-codex-bridge@0.6.0
```

默认 `CODEX_THREAD_SCOPE=cwd`：未设置 `CODEX_THREAD_ID` 时，只发现记录 cwd 与 `CODEX_WORKING_DIRECTORY` **完全相同**的顶层 thread（不会自动包含子目录）。如确需跨项目管理，必须显式设置高风险选项 `CODEX_THREAD_SCOPE=all`。要精确限定一个既有 thread，可设置兼容过滤器；它会覆盖 cwd/all 范围：

```bash
AI_TASK_BOARD_URL='https://board.example.com' \
AI_TASK_BOARD_CONNECTION_TOKEN='atb_REPLACE_ME' \
CODEX_THREAD_ID='REPLACE_WITH_LOCAL_THREAD_ID' \
CODEX_WORKING_DIRECTORY='/path/to/target-repository' \
npx --yes ai-task-board-codex-bridge@0.6.0
```

不要把 Connection Token 写入仓库、截图、日志或命令行参数。长期运行时应由本机 Secret Store 或权限 `0600` 的环境文件注入。Bridge 启动 App Server 时会从子进程环境删除 `AI_TASK_BOARD_CONNECTION_TOKEN`，同时保留 Codex 登录所需的普通环境变量。但同一 OS UID 的进程通常仍可通过进程环境、调试接口或同 UID 文件读取等路径互相影响，这不是令牌的强隔离；强隔离应使用独立 UID 和/或仅代转所需请求的 token proxy。若使用自定义 Codex home，systemd 服务必须看到相同设置。

### 环境变量

| 变量 | 必填 | 默认值 | 作用 |
|---|---|---|---|
| `AI_TASK_BOARD_URL` | 是 | — | Board 基地址；结尾 `/` 会被移除 |
| `AI_TASK_BOARD_CONNECTION_TOKEN` | 是 | — | 网页创建的 AI Connection 原始令牌 |
| `CODEX_THREAD_ID` | 否 | 空 | 兼容过滤器；设置后只管理这个既有 thread |
| `CODEX_WORKING_DIRECTORY` | 否 | 当前目录 | 启动 App Server 的目录，也是默认 `cwd` scope 的精确匹配目录 |
| `CODEX_THREAD_SCOPE` | 否 | `cwd` | `cwd` 仅管理 cwd 完全相同的顶层 thread；`all` 跨项目发现，属于高风险显式 opt-in |
| `CODEX_SESSION_NAME` | 否 | `Codex · <cwd basename> · <thread ID 前 8 位>` | Board Session 名称前缀；单 thread 过滤模式下作为完整名称 |
| `CODEX_BRIDGE_INCLUDE_THREAD_TITLES` | 否 | `false` | `true` 才把本地 thread 标题/首条 prompt 预览用于 Session 名称；会增加元数据泄露面 |
| `CODEX_BRIDGE_WEB_CONFIG` | 否 | `false` | `true` 才允许 Web Console 在本机安全上限内动态启停、切换标题及降低数量/并发上限 |
| `CODEX_BRIDGE_ALLOW_REMOTE_THREAD_TITLES` | 否 | `false` | `true` 才允许 Web Console 开启标题上传；本机已设置 `CODEX_BRIDGE_INCLUDE_THREAD_TITLES=true` 时也视为已授权 |
| `CODEX_BRIDGE_ALLOW_HISTORY_SYNC` | 否 | `false` | `true` 才允许 Web Console 开启旧历史同步；授权后仍需网页显式开启 |
| `CODEX_BRIDGE_MAX_HISTORY_TURNS` | 否 | `50` | 每个 thread 可同步的最近完成 turn 本机上限，范围 `1..200` |
| `CODEX_MODEL` | 否 | 空 | thread 未报告模型时使用的 Board 展示标签，不覆盖实际模型 |
| `CODEX_CAPABILITIES` | 否 | `coding,shell,file-edit,multi-thread,app-server` | 用于 Board 任务能力匹配的列表 |
| `CODEX_MAX_THREADS` | 否 | `50` | 最多管理的最近顶层 thread 数，范围 `1..500` |
| `CODEX_MAX_CONCURRENT_TURNS` | 否 | `2` | 整台设备同时运行的 turn 上限，范围 `1..32` |
| `CODEX_BRIDGE_APPROVAL_MODE` | 否 | `decline` | App Server 审批策略：`decline`、`accept` 或 `accept-session` |
| `CODEX_BRIDGE_PERMISSION_MODE` | 否 | `safe` | `safe` 显式使用 `on-request`、用户 reviewer、`workspace-write` 与该 thread cwd；`inherit` 高风险继承既有设置 |
| `CODEX_BINARY` | 否 | `codex` | Codex CLI 可执行文件路径或名称 |
| `AI_TASK_BOARD_POLL_INTERVAL_MS` | 否 | `5000` | SSE 不可用时的初始轮询间隔，范围 `500..60000` 毫秒 |
| `AI_TASK_BOARD_LEASE_SECONDS` | 否 | `900` | 任务租约与续租时长，范围 `60..3600` 秒 |
| `AI_TASK_BOARD_THREAD_SYNC_INTERVAL_MS` | 否 | `60000` | 重新扫描完整 thread 清单的间隔，范围 `10000..600000` 毫秒 |
| `AI_TASK_BOARD_CONFIG_POLL_INTERVAL_MS` | 否 | `10000` | 启用 Web 配置后的期望配置轮询间隔，范围 `1000..600000` 毫秒；运行租约仍独立且至少每 10 秒续租 |

数值变量超出范围或不是整数时会回退到默认值。`CODEX_MAX_THREADS` 只是数量上限，不是安全边界；默认项目边界是 cwd 精确匹配，严格限定一个 thread 时使用 `CODEX_THREAD_ID`。

## Web Console 动态配置

设备显式设置 `CODEX_BRIDGE_WEB_CONFIG=true` 后，Workspace Owner 可以在“AI 连接 → Bridge 设置”调整 Bridge 启停、是否上传 thread 标题、是否同步历史、最大 thread 数、最大并行 turn 数和最近历史 turn 数。Bridge 默认每 10 秒拉取期望版本，应用后回报实际值、本机上限与错误；修改不需要重启 systemd。

网页配置不能扩大本机安全边界：数量与并发会夹紧到 `CODEX_MAX_THREADS`、`CODEX_MAX_CONCURRENT_TURNS`，标题与历史分别必须获得本机授权，历史数量还会夹紧到 `CODEX_BRIDGE_MAX_HISTORY_TURNS`；工作目录、`cwd/all` 范围、固定 thread、Codex 路径、Connection Token、权限模式与审批模式始终只由设备环境决定。网页停用 Bridge 时，进程仍保持在线以接收后续配置，但会先安全停止 worker、释放任务，再提交空的权威 thread 清单并取消后台历史扫描。

## Web Console 管理 Threads

Bridge 0.5 起，Workspace Owner 可以在“AI 会话”的设备菜单中新建、重命名和删除 Codex Thread。操作先作为持久化指令写入 Board，只有持有该 Connection 当前运行租约的 Bridge 才能领取并执行，因此多个进程不会同时修改同一设备。新 Thread 固定使用设备侧 `CODEX_WORKING_DIRECTORY`；网页不能指定其他本机路径。重命名与删除也只能针对当前 Bridge 清单内的受管 Thread。设置了固定 `CODEX_THREAD_ID` 时，新建和删除会被拒绝。

删除只允许空闲且没有已预留任务的 Thread。请求被接受后，Board Session 会立即隐藏并停止接收新任务，再由 Bridge 调用 Codex App Server 的硬删除接口；缺少硬删除方法的兼容 App Server 会退化为归档。看板中的审计与已同步历史仍保留。

## 旧历史同步与隐私边界

历史同步默认关闭。设备必须同时设置 `CODEX_BRIDGE_WEB_CONFIG=true` 和 `CODEX_BRIDGE_ALLOW_HISTORY_SYNC=true`，再由 Workspace Owner 在网页开启；仅设置本机 allow 变量不会自行上传内容。Bridge 使用 App Server 的 `thread/turns/list`（`itemsView=notLoaded`）取得有界 turn 清单，再用 `thread/items/list` 分页读取持久化 item，只扫描普通 CLI / VS Code thread 的最近完成 turn。带有持久化 `clientUserMessageId` 的 turn 来自 Board 实时任务，会整轮跳过，避免与实时回传重复。

导入白名单只有三类：`userMessage` 的纯文本输入、最终 `agentMessage`、以及服务商明确给出的 `reasoning.summary`。图片、`localImage`/skill 的本机路径、`reasoning.content` 原始推理、命令与输出、diff、MCP 参数/结果和其他工具 item 都在设备端丢弃，不进入请求。白名单文本仍会经过现有 Secret 尽力脱敏和 UTF-safe 的 50,000 字符上限。

扫描在独立、可取消且有界的后台循环运行：单个 turn 最多读取 10,000 个原始 item，每轮每个 thread 最多保留 500 条白名单活动；请求批次最多 100 条且不超过 512 KiB。命令、MCP、diff、附件路径与原始推理会在分页读取时直接丢弃，不进入跨页缓存。Bridge 以 `thread.updatedAt` 和有效 turn 上限组成签名，同一进程内签名未变化时只扫描一次；thread、上限变化或进程重启后的重扫依靠稳定的 thread/turn/item 外部引用、原始 turn 时间和 item 顺序保持幂等。`partial` 表示本次有界快照在达到有效 turn 上限前触发了本机安全扫描上限；触顶的 turn 不会部分导入，`local-safety-cap` 也不是可续扫的 App Server cursor。历史读取或上传失败只更新该 Session 的历史同步状态并做有界退避，不会让运行租约、清单同步、worker 或活跃 turn 退出。

Board 中已导入的历史是只追加数据。关闭历史同步或降低最近 turn 上限只会停止后续导入，不会删除此前已经上传的内容；需要清除时应使用 Board 对应的 Workspace / 数据删除流程。

未启用 Web 配置时，Bridge 仍会周期性上报本机边界并续租运行实例，但忽略网页期望值；Web 会明确显示“本机禁止 Web 配置”。同一 Connection 的另一个 Bridge 在租约有效时只会待机，不会启动 worker，直到旧实例释放或最长约 30 秒的租约过期。续租长期失败时，持有者会在数据库租约可能失效前主动停止所有 worker。标题可能包含首条 prompt 预览，开启前应确认当前 Workspace 的成员都可以看到这类元数据。

## 审批安全策略

Bridge 没有网页审批通道。默认 `CODEX_BRIDGE_PERMISSION_MODE=safe` 会在 `thread/resume` 与 `turn/start` 显式覆盖为 `approvalPolicy=on-request`、`approvalsReviewer=user` 和 `workspace-write`；最终 turn 的可写根目录只包含该 thread 的绝对 cwd（无 cwd 时使用配置的工作目录），排除 `/tmp` 与 `$TMPDIR` 的隐式可写权限，并关闭网络访问。这是默认执行边界，避免静默继承旧 thread 的 danger-full-access 或额外可写根。它主要约束写入和网络，**不保证阻止 Codex 读取同 UID 本来可读的文件**。`CODEX_BRIDGE_PERMISSION_MODE=inherit` 不发送这些覆盖并会输出强风险警告。

App Server 发起命令、文件变更、权限、用户输入或 MCP elicitation 请求时，默认 `CODEX_BRIDGE_APPROVAL_MODE=decline` 会安全拒绝；需要审批才能继续的 turn 可能因此失败，并在面板留下状态或错误活动。这个变量**只决定 server-initiated request 的回答**，不会改变沙箱、文件可写范围或网络权限。

`accept` 和 `accept-session` 会在设备端自动批准支持的本地请求，后者可能把批准扩大到整个 Session。它们不是网页确认，属于高风险选项；应只在工作区、Codex 配置和 Connection 使用者都可信时启用。Bridge 启动时会对非默认模式输出警告。

## systemd 常驻运行

npm CLI 不会自动写入或启用 systemd。先用 `command -v npx` 和 `command -v codex` 确认当前用户实际使用的路径，再为拥有 Codex 数据的用户创建 user service。一个设备/Connection 使用一个 unit：

```ini
[Unit]
Description=AI Task Board Codex Bridge
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/path/to/a/safe/start-directory
EnvironmentFile=%h/.config/ai-task-board/codex-bridge.env
ExecStart=/absolute/path/to/npx --yes ai-task-board-codex-bridge@0.6.0
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=default.target
```

环境文件至少包含 `AI_TASK_BOARD_URL` 和 `AI_TASK_BOARD_CONNECTION_TOKEN`。建议同时显式设置 `CODEX_BINARY`、`CODEX_WORKING_DIRECTORY`、`CODEX_THREAD_SCOPE=cwd`、`CODEX_MAX_THREADS`、`CODEX_MAX_CONCURRENT_TURNS`；要在网页调整配置，再显式设置 `CODEX_BRIDGE_WEB_CONFIG=true`，需要网页开启标题时还要设置 `CODEX_BRIDGE_ALLOW_REMOTE_THREAD_TITLES=true`，需要网页开启历史时还要设置 `CODEX_BRIDGE_ALLOW_HISTORY_SYNC=true`，并可用 `CODEX_BRIDGE_MAX_HISTORY_TURNS` 收紧本机上限。也可设置 `CODEX_THREAD_ID` 精确限定。将文件权限设为 `0600`，再执行：

```bash
systemctl --user daemon-reload
systemctl --user enable --now ai-task-board-codex-bridge.service
```

若服务需要在用户退出登录后继续运行，由管理员为该用户启用 lingering。不要为同一设备/Connection 再启动第二个 unit 或手工 Bridge 进程。

## 任务与 thread 如何流转

1. Bridge 启动一个本地 App Server stdio 子进程，并完成 `initialize` / `initialized` 握手。
2. Bridge 先取得设备运行租约并上报本机边界；启用 Web 配置时，再在本机上限内计算并应用网页期望版本。旧实例租约仍有效时，新进程保持待机且不启动 worker。
3. Bridge 分页读取当前用户最近的未归档 Codex thread，忽略子 Agent thread，并应用默认的 cwd 精确范围、显式 `all` 范围或可选的 `CODEX_THREAD_ID` 精确过滤器，再应用有效的 thread 数上限。
4. Bridge 将完整清单同步到 Board。每个本地 thread 的稳定 ID 都映射为一个 Board Session；以后发现的新 thread 会在下一次清单同步加入，离开清单的 worker 会停止。
5. 每个 Session 建立自己的认证 SSE 唤醒流并保持心跳。SSE 只传固定的 `ready` / `wake` 提示，真正的任务仍通过 REST 原子领取；断线时自适应轮询兜底。
6. 每个 thread 一次只执行一张 Task。有效的设备级并发上限限制不同 thread 同时运行的 turn 数，多余工作继续排队。
7. Bridge 调用 `thread/resume` 和 `turn/start`，再消费 App Server 的 JSONL 通知。AI 文本、思考摘要和命令输出 delta 会按约 500 毫秒或 8 KiB 聚合后上传，完成事件也会持久化。
8. 若 App Server 在 turn 中发出 blocking `item/tool/requestUserInput`，Bridge 将结构化问题持久化到 Board 并保持原请求等待；Web 选择框提交后，Bridge 把答案返回该请求，同一个 turn 原地继续。等待期间 Task claim 和心跳均不释放。
9. `turn/completed` 后，最后一条 AI 消息用于完成 Task；错误会把 Task 标记为失败。Bridge 随后继续处理对应 Session 队列。

网页在某个 thread 正忙时发送的新消息会创建下一张排队 Task。当前版本不会把它可靠地 steer 到当前 turn。

### 面板可见活动

| App Server 事件 | 面板活动 |
|---|---|
| `item/agentMessage/delta`、agent message 完成 | AI 回复增量与最终消息 |
| `item/reasoning/summaryTextDelta`、reasoning 完成 | Codex 提供的思考摘要增量与完成内容 |
| command started/output delta/completed | 命令、流式输出、状态、退出码和耗时 |
| file change started/completed | 文件变更状态与结构化摘要 |
| MCP、dynamic tool、协作 Agent 工具 | 工具名、状态与脱敏后的结构化结果 |
| web search、plan、usage、error | 搜索、计划、用量与错误活动 |

活动使用稳定的 thread/turn/item/chunk 外部引用去重。HTTP 5xx、限流或临时网络错误会退避重试。常见 Token、Authorization、API key、password 和 secret 形式会做尽力脱敏，过长内容会被截断；这不是完整的数据防泄漏系统，仍应限制 Codex 可读 Secret，并评估把本机输出同步到共享 Board 的边界。Inventory 必然上传 thread ID、绝对 `working_directory` 和模型标签给该 Workspace 的成员；只有本机直接开启标题，或同时允许 Web 配置与远程标题并由网页开启时，才额外把 thread 标题/首条 prompt 预览用于 Session 名称。

## 思考展示边界

面板只显示 App Server 明确提供的 reasoning summary 和 summary delta，并标记为“思考摘要”。Bridge 不请求、保存或展示模型隐藏的原始 chain-of-thought。命令、文件变更、工具调用和计划是独立的可审计过程，也不等于完整内部推理。

## MCP 是否必需

不必需。Bridge 通过 REST 注册 Session、领取任务和回传活动，通过 SSE 接收唤醒；它不会为了正常运行而安装或调用 AI Task Board MCP。

Board MCP 仍可供其他 AI Host 主动操作任务，也可以作为 Codex 自己的可选工具配置。若某个 Codex thread 调用了已配置的 MCP 工具，Bridge 只负责转发 App Server 暴露的工具过程；MCP 端点本身不能替代常驻 Bridge，也不能反向唤醒已退出的模型。

## 心跳、停止与恢复

- 每个受管 Session 空闲时每 45 秒发送在线心跳；执行时每 45 秒续租 Task。两分钟没有活动后网页会把 Session 视为离线。
- SSE 每 15 秒收到注释保活，连接会周期性重建以重新验证 Token；即使 SSE 丢失，持久 Task 仍可由最长约 60 秒的兜底轮询发现。
- 心跳不进入 Codex thread，不消耗模型 Token，也不写对话或高频任务事件。
- 收到 `SIGINT` / `SIGTERM` 时，Bridge 会请求 App Server 中断活跃 turn，并尽力释放已领取 Task；这只是本机关闭路径的尽力行为，不是可靠的网页远程 interrupt。
- 断电、强杀或完全断网时无法及时释放，Task 会在租约过期后恢复。重启后 Bridge 会重新扫描 thread 清单并恢复各 Session worker。

## 当前限制

- **Web 配置目前是设备级六项。** 0.4 动态控制整体启停、标题上传、历史同步、最大 thread 数、并行 turn 数和最近历史 turn 数；Session 名称前缀与逐个 thread 的 allow/deny 仍由设备配置或后续版本处理，网页侧栏隐藏某个 Session 也不会停止其本地 worker。
- **历史同步是限量白名单，不是完整原始日志镜像。** 只补录最近完成 turn 的用户纯文本、最终回复和服务商思考摘要；工具过程、附件、本机路径与原始推理不会补录。扩大 turn 上限后会从最近历史重新幂等扫描；关闭或降低上限不会反向删除已导入内容。
- **没有可靠的运行中 steer。** 忙碌时的新网页消息排到下一张 Task，当前 turn 完成后才执行。
- **没有网页审批。** 默认安全拒绝 App Server 审批；可选自动批准是设备端静态策略，不是用户逐次确认。
- **没有可靠的网页 interrupt。** 网页状态或取消操作不能保证立即终止本地命令；停止 systemd 服务只会走尽力的 App Server interrupt。
- **只转换协议级结构化问题。** blocking `item/tool/requestUserInput` 会自动显示 Web 选择框并保留原 turn；普通 AI 文本里的疑问句不会自动暂停，网页普通消息仍会成为下一张 Task。
- **默认 cwd scope 不是令牌强隔离。** 默认只选 cwd 完全相同的 thread，能避免静默暴露其他项目的最近 thread；但同 UID 的 Codex/TUI/Bridge 仍共享用户级数据与进程权限。更强边界需要 `CODEX_THREAD_ID`、独立 UID 和/或 token proxy；`CODEX_THREAD_SCOPE=all` 会显式扩大到跨项目 thread。
- **同一 thread 仍是单写入者。** 不要同时从 Bridge、TUI、IDE 或另一自动化进程提交 turn；不同 thread 才能安全并行。
- **本机 App Server 是受信协议边界。** Bridge 会把单个活动流累计限制在 100,000 个 code unit 并分成至多约 8 KiB 的上传块，但当前 stdio JSONL reader 在解析前仍会缓冲完整单行 frame；不要把不受信任的程序伪装成 `CODEX_BINARY`。
- **执行语义是 at-least-once。** 如果本地 turn 已产生副作用，但进程在完成 Task 或写下 durable checkpoint 前崩溃，租约恢复后可能再次提交。事件幂等只能去重已上传活动，不能撤销发布、付款、删除等外部副作用；不可逆操作必须使用 Harness 自身幂等键或人工确认。
- **npm 包不负责进程托管。** npx 只安装并启动 CLI；systemd、launchd 或其他管理器负责开机启动、日志和失败重启。

## 常见故障

- 启动时报 `AI_TASK_BOARD_URL is required` 或 `AI_TASK_BOARD_CONNECTION_TOKEN is required`：确认两个必填变量位于 systemd 实际读取的环境文件中。
- `codex app-server` 启动失败：用同一 OS 用户检查 `CODEX_BINARY`、Codex 登录和自定义 Codex home；systemd 的 PATH 通常比交互式 shell 更短。
- 找不到任何 thread：确认当前用户确实拥有本地 Codex 数据，且默认 scope 下 thread 记录的 cwd 与 `CODEX_WORKING_DIRECTORY` 完全相同；若设置了 `CODEX_THREAD_ID`，检查 ID 是否正确且对应未归档的顶层 thread。
- 同步、结构化问题或配置 API 返回 `404`：先升级 Board 数据库 migration 与 API；0.6 Bridge 不会为 thread 同步或同 turn 问答回退到旧版接口。只有未启用 Web 配置时，缺少配置端点才会降级为继续使用本地配置。
- Session 在线但没有任务：确认网页消息发到了该 thread 对应的 Session，依赖已经完成，且 `CODEX_CAPABILITIES` 满足任务要求。
- turn 因审批失败：这是默认 `decline` 策略的预期结果。优先收紧任务或预先配置安全权限；不要为了绕过错误盲目开启自动批准。
- 活动不是逐字符更新：Bridge 会聚合 delta，网页还依赖网络、持久化和 Realtime 失效通知；“近实时”不保证固定毫秒延迟。
- 出现重复或写入冲突：确认同一设备/Connection 只有一个 Bridge，并停止向相同 thread 写入的其他 TUI、IDE 或自动化进程。

协议层详情见 [REST API 接入示例](rest-api.md)；可选 MCP 接入见 [MCP 接入](mcp.md)；本地协议能力见 [Codex App Server 官方文档](https://developers.openai.com/codex/app-server/)。
