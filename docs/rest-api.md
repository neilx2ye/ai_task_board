# REST API 接入示例

REST API 的基地址是部署后的 Next.js 应用，例如 `http://localhost:3000`。AI 客户端只持有 AI Connection 的原始令牌；服务端由令牌解析连接与 Workspace，任何 AI 请求体都不能提交 `workspace_id`。

Codex 用户通常不需要手写以下循环，可在保存本地 Codex 数据的设备上通过 npx 运行 [Codex Bridge](codex-bridge.md)。一个 Bridge 通过 stdio App Server 管理多个顶层 thread，使用认证 SSE 接收无数据唤醒提示，再调用这些 REST 端点同步 Session、领取任务和回传活动；SSE 不可用时会自适应轮询。Bridge 不依赖 MCP，也不能在 Next.js 服务进程中运行。

以下命令先设置本地变量：

```bash
export ATB_URL='http://localhost:3000'
export ATB_CONNECTION_TOKEN='atb_...'
```

`ATB_CONNECTION_TOKEN` 是 Secret。不要把它写入 shell 历史、源码、截图、日志或提交到仓库；生产环境请使用客户端的 Secret Store。

## 通用协议

所有成功响应使用统一信封：

```json
{
  "data": {}
}
```

所有失败响应只暴露稳定业务错误，不返回 SQL、Supabase 原始错误或内部堆栈：

```json
{
  "error": {
    "code": "TASK_NOT_READY",
    "message": "Task is not ready to be claimed"
  }
}
```

每个修改请求都应发送唯一的 `Idempotency-Key`。同一个 Key 与相同请求可安全重试；Key 相同但请求内容不同返回 HTTP `409` 与 `IDEMPOTENCY_CONFLICT`。建议格式为 `<client>/<operation>/<uuid>`，最长 200 个字符。

控制面有三个有意的例外：Session/Task 心跳仍校验 Key 格式，但属于自然幂等状态刷新，不缓存响应，也不以同 Key 的不同心跳内容触发冲突；`claim-next` 的空结果不缓存，因此同一个 Key 在后续队列出现任务时仍可成功领取；历史导入由运行实例 fence 和稳定 `external_ref` 去重，不读取 `Idempotency-Key`。真实任务领取成功后仍按普通规则保存 24 小时、支持完全重放并检测冲突。

注册后的 AI 命令还必须发送服务端返回的会话 ID：

```http
Authorization: Bearer <connection_token>
X-AI-Session-ID: <session_id>
Idempotency-Key: <unique_key>
Content-Type: application/json
```

领取类命令返回的 `claim_token` 只显示在该次响应中。需要持有它才能回传进度、续租、完成、失败、释放或拆分任务；不要复用已过期租约的旧令牌。

### Bridge 设备配置交换（0.3；历史同步需 0.4+）

Workspace Owner 可通过 `GET` / `PATCH /api/user/connections/:connectionId/bridge-config`
读取和修改期望配置。`PATCH` 需要 `Idempotency-Key`，并提交当前
`expected_version` 以及完整的 `enabled`、`include_thread_titles`、
`max_threads`、`max_concurrent_turns`、`sync_history` 和
`history_turn_limit`；版本落后时返回
`409 VERSION_CONFLICT`，客户端应刷新后让用户重新确认。

Web 触发的 Bridge 自更新（1.5.0+）使用两个额外的用户态端点：
`GET /api/user/bridge-release` 返回 npm 上 `ai-task-board-bridge` 的最新发布版本
（服务端缓存 5 分钟，查询失败时 `latest_version` 为 `null`）；
`POST /api/user/connections/:connectionId/bridge-update` 携带
`Idempotency-Key` 与 `{ "target_version": "x.y.z" }` 设置期望版本
（`null` 取消）。目标版本必须是严格大于当前上报版本的合法 semver 且真实存在于
npm，否则返回 `400 INVALID_REQUEST`；Bridge 需设备 opt-in 才会执行更新。

Bridge 使用 Connection Token 调用 `POST /api/ai/config`。每个进程生成一个
`runtime_instance_id`，并为每次报告单调增加 `report_sequence`；
`lease_seconds` 建立运行实例租约，防止同一个 Connection 的两个 Bridge 同时
声称配置已生效。请求同时报告 `applied_version`、实际 `effective`、本机不可越过的
`constraints` 和可选错误，响应返回当前 `configuration.version` 与 `desired`。
配置 DTO 还包含服务端计算的 `runtime.online` 与 `runtime.lease_expires_at`；租约
失效后网页只把 applied 内容当作最后一次上报，不会继续声称设备当前已应用。
旧序号是成功的无操作；另一个尚未过期的实例返回
`409 BRIDGE_INSTANCE_CONFLICT`。优雅退出时，同一实例可发送
`release_runtime: true` 立即释放租约，而不清除网页最后看到的应用状态。

Web 只控制运行时启停、thread 标题上传、历史同步以及 thread/并行 turn 数量。工作目录、
thread 范围或固定 thread、权限与审批模式、URL/令牌、Codex 可执行文件和受保护的本机边界
始终由设备环境决定；服务端也会拒绝突破设备 `constraints` 的 effective 报告。thread
数（`1..500`）与并行 turn 数（`1..32`）由 Web 直接设置整台设备的值，Bridge 的兼容约束
字段会报告该统一范围，不再与本机 `*_MAX_THREADS` / `*_MAX_CONCURRENT_TURNS` 做二次比较。
历史同步还受 `constraints.allow_history_sync` 和 `max_history_turns` 限制；设备必须先以
`CODEX_BRIDGE_ALLOW_HISTORY_SYNC=true` 明确授权。同步内容会进入当前 Workspace，所有成员
都可查看，因此 Web 上的期望开关不能替代设备本机授权。服务端接受的
`history_turn_limit` 为 `1..500`，实际值还会被设备上报的本机上限收紧。
关闭 `sync_history` 或降低 turn 上限只会停止或收窄后续导入，不会删除已经上传到
Workspace 的历史记录。

## 1. 注册 AI 会话

```bash
curl --fail-with-body -sS "$ATB_URL/api/ai/sessions/register" \
  -H "Authorization: Bearer $ATB_CONNECTION_TOKEN" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: demo/register/$(openssl rand -hex 16)" \
  --data '{
    "name": "Claude Research",
    "platform": "claude",
    "model": "claude-sonnet",
    "external_conversation_ref": "claude-research-demo",
    "capabilities": ["web-research", "analysis"]
  }'
```

保存响应 `data.session.id`：

```bash
export ATB_SESSION_ID='<data.session.id>'
```

同一连接与 `external_conversation_ref` 的重复注册会幂等更新同一个 `AISession`。

每个仍处于活动生命周期的会话都应至少每分钟刷新一次存活状态，使 Web Console 可以继续向它预留任务；空闲或正在等待用户回复时也要继续：

```bash
curl --fail-with-body -sS "$ATB_URL/api/ai/sessions/presence" \
  -H "Authorization: Bearer $ATB_CONNECTION_TOKEN" \
  -H "X-AI-Session-ID: $ATB_SESSION_ID" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: demo/presence/$(openssl rand -hex 16)" \
  --data '{}'
```

两分钟没有会话活动时，Web 会把它视为离线并停止接受新预留；执行中任务仍使用后文的领取心跳续租。

专用 Bridge/Worker 可以同时建立可选的认证 SSE 唤醒流：

```bash
curl --no-buffer --fail-with-body -sS \
  "$ATB_URL/api/ai/sessions/wake" \
  -H "Authorization: Bearer $ATB_CONNECTION_TOKEN" \
  -H "X-AI-Session-ID: $ATB_SESSION_ID" \
  -H 'Accept: text/event-stream'
```

服务端只会返回固定的 `ready`、`wake`、`degraded` 或 `reconnect` 事件以及注释保活，不返回任务标题、正文或令牌。收到 `ready`/`wake` 后仍必须调用 `claim-next`；SSE 只是可能重复或遗漏的低延迟提示，数据库 Task 和 REST 原子领取才是权威状态。客户端应保留低频轮询作为断线兜底。

## 2. 读取本会话的下一项预留任务

```bash
curl --fail-with-body -sS "$ATB_URL/api/ai/tasks/claim-next" \
  -H "Authorization: Bearer $ATB_CONNECTION_TOKEN" \
  -H "X-AI-Session-ID: $ATB_SESSION_ID" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: demo/claim-next/$(openssl rand -hex 16)" \
  --data '{"lease_seconds": 900}'
```

服务端仅考虑 `assigned_session_id` 等于当前会话、能力匹配且依赖已完成的 `ready` 叶子任务，按优先级降序、创建时间升序原子接收。它不会扫描其他会话或未绑定的任务；没有预留任务时成功响应中的任务值为 `null`，且该空结果不会写入持久幂等表。

`lease_seconds` 可选，范围 `60..3600`，默认 `900`（15 分钟）。心跳和 `complete-and-claim-next` 使用同一范围。

接收已知任务同样要求该任务已明确分配给当前会话：

```bash
curl --fail-with-body -sS "$ATB_URL/api/ai/tasks/claim" \
  -H "Authorization: Bearer $ATB_CONNECTION_TOKEN" \
  -H "X-AI-Session-ID: $ATB_SESSION_ID" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: demo/claim/$(openssl rand -hex 16)" \
  --data "{\"task_id\":\"$ATB_TASK_ID\",\"lease_seconds\":900}"
```

保存返回的 `task.id` 和 `claim_token`：

```bash
export ATB_TASK_ID='<claimed task id>'
export ATB_CLAIM_TOKEN='<claim_token>'
```

## 3. 续租与回传进度

心跳会更新会话最后在线时间，并单调延长当前领取租约。它不会进入 AI 上下文、写入对话时间线、创建 `claim_heartbeat` 事件或保存幂等响应：

```bash
curl --fail-with-body -sS "$ATB_URL/api/ai/sessions/heartbeat" \
  -H "Authorization: Bearer $ATB_CONNECTION_TOKEN" \
  -H "X-AI-Session-ID: $ATB_SESSION_ID" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: demo/heartbeat/$(openssl rand -hex 16)" \
  --data "{
    \"task_id\": \"$ATB_TASK_ID\",
    \"claim_token\": \"$ATB_CLAIM_TOKEN\",
    \"lease_seconds\": 900
  }"
```

回传进度：

```bash
curl --fail-with-body -sS "$ATB_URL/api/ai/tasks/report-progress" \
  -H "Authorization: Bearer $ATB_CONNECTION_TOKEN" \
  -H "X-AI-Session-ID: $ATB_SESSION_ID" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: demo/progress/$(openssl rand -hex 16)" \
  --data "{
    \"task_id\": \"$ATB_TASK_ID\",
    \"claim_token\": \"$ATB_CLAIM_TOKEN\",
    \"progress_note\": \"已验证三个主要信息源\",
    \"progress_percent_estimate\": 60
  }"
```

`progress_percent_estimate` 必须是 `0..100` 的整数或 `null`，只代表 AI 的估计；父任务结构化进度按完成叶子数计算。

### 回传 Harness 会话活动

Harness adapter 可以把 AI 回复追加到 Session 时间线：

```bash
curl --fail-with-body -sS "$ATB_URL/api/ai/sessions/activity" \
  -H "Authorization: Bearer $ATB_CONNECTION_TOKEN" \
  -H "X-AI-Session-ID: $ATB_SESSION_ID" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: bridge/activity/$(openssl rand -hex 16)" \
  --data "{
    \"task_id\": \"$ATB_TASK_ID\",
    \"claim_token\": \"$ATB_CLAIM_TOKEN\",
    \"kind\": \"assistant_message\",
    \"content\": \"已完成检查并修复相关模块。\",
    \"data\": {},
    \"external_ref\": \"codex:<thread>:<task>:item:<provider-item-id>\"
  }"
```

会话记录固定只保存 `assistant_message`。为了兼容旧 Adapter，输入校验仍接受 `reasoning`、`command`、`file_change`、`mcp_tool`、`web_search`、`plan`、`error`、`usage` 和 `status`，但服务端会以 `suppressed: true` 成功忽略这些类型且不访问数据库。`assistant_message.content` 必须非空且最长 100,000 字符；`data` 必须是 JSON object 且编码后不超过 256 KiB。`external_ref` 必填，最长 500 字符。

调用者必须仍持有该 Task 的有效领取令牌。成功写入 AI 回复会把 Task 置为 `running`、刷新 Session，并同步创建一条任务消息。`external_ref` 在 Session 内唯一，应来自稳定的 provider thread/turn/item 标识；同一 item 重试时保持它和业务内容不变，否则返回 `IDEMPOTENCY_CONFLICT`。

### 导入本机 Codex Thread 历史（Bridge 0.4+）

获得本机授权的 Bridge 使用 `POST /api/ai/sessions/history` 导入规范化的历史页。请求仍需
Connection Token 和 `X-AI-Session-ID`，但不依赖 Board Task 或 `claim_token`：

```bash
curl --fail-with-body -sS "$ATB_URL/api/ai/sessions/history" \
  -H "Authorization: Bearer $ATB_CONNECTION_TOKEN" \
  -H "X-AI-Session-ID: $ATB_SESSION_ID" \
  -H 'Content-Type: application/json' \
  --data '{
    "runtime_instance_id": "11111111-1111-4111-8111-111111111111",
    "report_sequence": 1,
    "items": [{
      "external_ref": "codex-history:thread-1:turn-1:item-1",
      "kind": "assistant_message",
      "content": "已完成检查。",
      "occurred_at": "2026-08-10T08:00:00.000Z",
      "source_order": 1,
      "data": {
        "protocol": "codex-app-server/v1",
        "thread_id": "thread-1",
        "turn_id": "turn-1",
        "item_id": "item-1"
      }
    }],
    "sync": {
      "status": "complete",
      "turn_limit": 50,
      "scanned_turns": 1,
      "total_turns": 1,
      "next_cursor": null,
      "error": null
    }
  }'
```

为兼容旧 Bridge，请求 schema 仍允许 `user_message`、`assistant_message` 和 `reasoning`；服务端在写库前固定只保留 `user_message` 与 `assistant_message`。每页最多 100 项，单项 `content` 最长 50,000 字符，单项 `data` 最多 4 KiB，整个
`items` JSON 最多 512 KiB（HTTP body 最多 640 KiB）。`source_order` 是 `0` 到
`Number.MAX_SAFE_INTEGER` 的整数，用来稳定排列同一时间的 item。`items: []` 合法，供没有
可导入内容的 Thread 单独上报状态。

`sync.status` 为 `syncing`、`partial`、`complete` 或 `failed`；`turn_limit` 和
`scanned_turns` 最大 500。`complete` 必须把 `next_cursor` 设为 `null`，`failed` 必须提供
`error`，其他状态不能带错误。`runtime_instance_id` 必须与当前 Bridge 运行租约一致，防止
重复进程交叉写入；同一 runtime 对每次历史请求还必须把 `report_sequence` 在
`1..Number.MAX_SAFE_INTEGER` 内严格递增。较低序号的迟到请求可以补入尚未出现的不可变
activity，但不能回退同步状态；重复序号只有在 `sync` 完全一致时才作为重试成功，否则返回
`IDEMPOTENCY_CONFLICT`。`external_ref` 在 Session 内稳定唯一：完全相同的重放计入
`imported.replayed`，同一引用改变内容会被拒绝。响应同时返回 `imported.inserted` 和当前
`history_sync`；其中 `imported_items` 是数据库中该 Session 现存的历史行数，不会因重放累加。
`partial` 表示本轮受安全扫描上限截断，并不承诺会自动续传；需要更多历史时应调整 Web
期望值与设备本机上限，并检查设备日志。

## 4. 拆分复杂任务

一次提交全部子任务。依赖通过同一批次内唯一的 `client_ref` 表示；未知引用、自依赖或依赖环会让整个事务回滚。

```bash
curl --fail-with-body -sS "$ATB_URL/api/ai/tasks/create-subtasks" \
  -H "Authorization: Bearer $ATB_CONNECTION_TOKEN" \
  -H "X-AI-Session-ID: $ATB_SESSION_ID" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: demo/create-subtasks/$(openssl rand -hex 16)" \
  --data "{
    \"task_id\": \"$ATB_TASK_ID\",
    \"claim_token\": \"$ATB_CLAIM_TOKEN\",
    \"subtasks\": [
      {
        \"client_ref\": \"collect\",
        \"title\": \"收集竞品名单\",
        \"priority\": 50,
        \"position\": 0,
        \"required_capabilities\": [\"web-research\"],
        \"depends_on\": []
      },
      {
        \"client_ref\": \"compare\",
        \"title\": \"对比功能与定价\",
        \"priority\": 40,
        \"position\": 1,
        \"required_capabilities\": [\"analysis\"],
        \"depends_on\": [\"collect\"]
      }
    ]
  }"
```

成功后父任务清除领取状态，满足依赖的叶子任务进入 `ready`，其他子任务进入 `blocked`。AI 创建的子任务默认继承当前会话，不会掉入公共池。

## 5. 消息与用户问答

AI 写入任务消息：

```bash
curl --fail-with-body -sS "$ATB_URL/api/ai/tasks/messages" \
  -H "Authorization: Bearer $ATB_CONNECTION_TOKEN" \
  -H "X-AI-Session-ID: $ATB_SESSION_ID" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: demo/message/$(openssl rand -hex 16)" \
  --data "{
    \"task_id\": \"$ATB_TASK_ID\",
    \"claim_token\": \"$ATB_CLAIM_TOKEN\",
    \"content\": \"已找到定价页和产品文档。\"
  }"
```

向用户提出一个可直接回答的问题：

```bash
curl --fail-with-body -sS "$ATB_URL/api/ai/tasks/request-user-input" \
  -H "Authorization: Bearer $ATB_CONNECTION_TOKEN" \
  -H "X-AI-Session-ID: $ATB_SESSION_ID" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: demo/request-user-input/$(openssl rand -hex 16)" \
  --data "{
    \"task_id\": \"$ATB_TASK_ID\",
    \"claim_token\": \"$ATB_CLAIM_TOKEN\",
    \"question\": \"最终报告更偏向高管摘要还是详细功能矩阵？\"
  }"
```

任务进入 `waiting_user` 并结束当前租约。用户在任务详情页回复后，任务恢复为 `ready`；它仍只属于原会话，该会话必须重新接收并取得新的 `claim_token`。

### Codex Bridge 结构化问题（保留原 turn）

Bridge 0.6 对 App Server 的 blocking `item/tool/requestUserInput` 使用专用流程，不调用上面的旧文字提问接口：

1. `POST /api/ai/tasks/user-input-requests` 持久化问题、把任务标记为 `awaiting_user_input=true`，但任务仍保持 `running`、原 `claim_token` 和租约。
2. Web Console 在任务详情或 Thread 对话面板显示单选/文本/敏感输入控件，通过 `POST /api/user/tasks/:taskId/input-requests/:requestId/answer` 提交。
3. Bridge 通过 `POST /api/ai/tasks/user-input-requests/:requestId/poll` 等待答案，并把协议要求的 `answers` 返回给仍处于等待中的同一个 App Server 请求。

答案值不写入公开任务消息；敏感回答不会出现在 Web 查询或 Realtime 载荷中。任务结束、取消、释放或 claim 更换时，服务端会清除保存的答案。Bridge 等待期间仍须续租 claim。

## 6. 完成、失败或释放

推荐在完成时原子领取下一项任务：

```bash
curl --fail-with-body -sS "$ATB_URL/api/ai/tasks/complete-and-claim-next" \
  -H "Authorization: Bearer $ATB_CONNECTION_TOKEN" \
  -H "X-AI-Session-ID: $ATB_SESSION_ID" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: demo/complete-next/$(openssl rand -hex 16)" \
  --data "{
    \"task_id\": \"$ATB_TASK_ID\",
    \"claim_token\": \"$ATB_CLAIM_TOKEN\",
    \"result_summary\": \"已完成竞品名单，包含 8 家公司。\",
    \"result_json\": {\"competitor_count\": 8},
    \"message\": \"名单和筛选依据已回传。\",
    \"artifacts\": []
  }"
```

只完成当前任务使用 `/api/ai/tasks/complete`，请求体相同。附件引用可随完成命令原子写入：

```json
{
  "name": "competitor-report.pdf",
  "mime_type": "application/pdf",
  "size": 48213,
  "storage_path": "<workspace_id>/<task_id>/<uuid>-competitor-report.pdf"
}
```

AI 不应自行猜测私有对象路径或直接写 `storage` schema。AI REST API 不接收二进制文件，外部 AI 最直接的方式是随完成命令提交 HTTPS `external_url`。

登录用户可从任务详情页上传私有附件，也可以在同源浏览器代码中调用 multipart 接口：

```js
const form = new FormData();
form.set("file", fileInput.files[0]);

const response = await fetch(`/api/user/tasks/${taskId}/artifacts`, {
  method: "POST",
  credentials: "same-origin",
  headers: { "Idempotency-Key": crypto.randomUUID() },
  body: form,
});
```

不要手动设置 multipart `Content-Type`，浏览器需要加入 boundary。字段名必须是 `file`，单文件最大 50 MiB；服务端校验用户 Workspace、清理文件名、生成确定性对象路径并通过 RPC 写元数据。成功返回 HTTP `201` 与 `{ "data": <ArtifactRow> }`。相同幂等键和相同文件可安全重试；同 Key 改变文件则返回 `IDEMPOTENCY_CONFLICT`。读取私有对象时，`GET /api/user/artifacts/:artifactId/download` 返回 60 秒签名 URL。

失败任务：

```bash
curl --fail-with-body -sS "$ATB_URL/api/ai/tasks/fail" \
  -H "Authorization: Bearer $ATB_CONNECTION_TOKEN" \
  -H "X-AI-Session-ID: $ATB_SESSION_ID" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: demo/fail/$(openssl rand -hex 16)" \
  --data "{
    \"task_id\": \"$ATB_TASK_ID\",
    \"claim_token\": \"$ATB_CLAIM_TOKEN\",
    \"reason\": \"上游资料不可访问\"
  }"
```

主动释放：

```bash
curl --fail-with-body -sS "$ATB_URL/api/ai/tasks/release" \
  -H "Authorization: Bearer $ATB_CONNECTION_TOKEN" \
  -H "X-AI-Session-ID: $ATB_SESSION_ID" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: demo/release/$(openssl rand -hex 16)" \
  --data "{
    \"task_id\": \"$ATB_TASK_ID\",
    \"claim_token\": \"$ATB_CLAIM_TOKEN\",
    \"reason\": \"交给具备分析能力的会话\"
  }"
```

## 7. 同步已经在外部执行的任务

`external_task_ref` 在连接/Workspace 对应的外部来源内用于去重。重复上报更新同一张卡片，不会生成重复 Task。

```bash
curl --fail-with-body -sS "$ATB_URL/api/ai/tasks/report-current" \
  -H "Authorization: Bearer $ATB_CONNECTION_TOKEN" \
  -H "X-AI-Session-ID: $ATB_SESSION_ID" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: demo/report-current/$(openssl rand -hex 16)" \
  --data '{
    "title": "整理已经开始的访谈笔记",
    "description": "任务在外部会话中先于看板创建",
    "external_task_ref": "interview-notes-2026-08",
    "external_source": "claude",
    "external_conversation_ref": "claude-research-demo",
    "priority": 20,
    "progress_note": "已整理 3 / 10 份",
    "progress_percent_estimate": 30,
    "required_capabilities": ["analysis"]
  }'
```

## 8. 查询任务与增量更新

任务详情：

```bash
curl --fail-with-body -sS "$ATB_URL/api/ai/tasks/$ATB_TASK_ID" \
  -H "Authorization: Bearer $ATB_CONNECTION_TOKEN" \
  -H "X-AI-Session-ID: $ATB_SESSION_ID"
```

使用不可变 TaskEvent ID 作为游标补拉遗漏变化：

```bash
curl --fail-with-body -sS \
  "$ATB_URL/api/ai/tasks/$ATB_TASK_ID/updates?after=0&limit=100" \
  -H "Authorization: Bearer $ATB_CONNECTION_TOKEN" \
  -H "X-AI-Session-ID: $ATB_SESSION_ID"
```

把响应的 `data.next_cursor` 持久化到客户端，下次作为 `after`。`limit` 范围是 `1..500`。

## 9. Web 会话对话接口

这两个接口供已登录网页使用，以 Supabase Auth Cookie 鉴权，不接受 AI Connection Token：

- `GET /api/user/sessions/:sessionId` 返回该 Session、相关任务、任务消息、任务事件和 `session_activities`，供会话对话框组合时间线。默认返回最新 100 条结构化活动；用响应中的 opaque `pagination.activities.oldest_cursor` 作为 `before_activity_cursor` 继续加载更早记录，`limit` 范围为 `1..200`。旧 `before_activity_id` 只在滚动升级窗口内兼容，新客户端不得依赖。
- `POST /api/user/sessions/:sessionId/turns` 接收 `{ "content": "..." }` 和 `Idempotency-Key`。目标 Session 必须仍在线；服务端原子创建定向分配给它的 `ready` Task、用户消息和 `user_message` 活动，并返回 HTTP `201`。

会话顶部不再提供过程详情开关；同步策略固定为只保留 AI 回复。结构化问题使用独立请求流，仍会正常显示和回答。

新 Task 的临时名称从消息的第一个非空句生成，最长 80 个 Unicode code point；当前不会额外调用模型命名。Codex Bridge 通常由 SSE 近实时唤醒并领取它，通知不可用时由自适应轮询兜底。若该 thread 的上一轮仍在执行，新 Task 只会排队；0.3 仍没有可靠的运行中 steer、网页 interrupt 或网页审批。

`pagination.legacy` 会分别标记旧任务、消息或事件是否达到兼容读取上限。旧表本身不是完整的 Session 事件流；出现截断标记时，网页会明确提示只展示最近的兼容记录，而 Bridge 接入后的结构化活动仍可持续向前分页。

每条 activity 还包含真实事件时间 `occurred_at`、以字符串无损编码的 bigint
`source_order`，以及 `source: "live" | "codex_history"`。客户端必须按
`occurred_at/source_order/id` 排序，不能再按插入时间或把 bigint 转成 JavaScript number。
顶层 `history_sync` 在尚无记录时为 `null`；否则包含状态、turn 上限、已扫描/总 turn 数、
当前历史行数、续传游标、错误和起止/更新时间。该接口按 Workspace 成员权限读取，所以
新导入的 AI 回复对当前 Workspace 的所有成员可见。

## 稳定错误码

| 错误码 | HTTP | 处理建议 |
|---|---:|---|
| `TASK_NOT_FOUND` | 404 | 停止重试并刷新任务引用 |
| `TASK_NOT_READY` | 409 | 重新查询依赖或等待任务恢复 |
| `TASK_ALREADY_CLAIMED` | 409 | 不要执行该任务，刷新当前会话状态 |
| `LEASE_EXPIRED` | 409 | 停止使用旧令牌，重新领取 |
| `INVALID_CLAIM_TOKEN` | 403 | 丢弃令牌并重新领取，不要记录令牌 |
| `DEPENDENCY_CYCLE` | 409 | 修正整批依赖后用新幂等键重试 |
| `SESSION_NOT_AUTHORIZED` | 403 | 检查连接、会话 ID 与任务定向指派 |
| `CAPABILITY_MISMATCH` | 409 | 由用户明确改派到满足能力的存活会话 |
| `INVALID_STATE_TRANSITION` | 409 | 刷新当前状态后决定下一命令 |
| `IDEMPOTENCY_CONFLICT` | 409 | 不要复用 Key；核对第一次请求 |
| `VERSION_CONFLICT` | 409 | 刷新 Bridge 配置版本并让 Owner 重新确认修改 |
| `BRIDGE_INSTANCE_CONFLICT` | 409 | 停止重复 Bridge；等待旧实例退出或租约到期 |

HTTP `401` 表示连接令牌缺失、无效或已撤销；`400 INVALID_REQUEST` 表示 JSON/Zod 校验失败；`500 INTERNAL_ERROR` 可以使用**同一个**幂等键有限退避重试。
