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

高频控制面操作有两个有意的例外：Session/Task 心跳仍校验 Key 格式，但属于自然幂等状态刷新，不缓存响应，也不以同 Key 的不同心跳内容触发冲突；`claim-next` 的空结果不缓存，因此同一个 Key 在后续队列出现任务时仍可成功领取。真实领取成功后仍按普通规则保存 24 小时、支持完全重放并检测冲突。

注册后的 AI 命令还必须发送服务端返回的会话 ID：

```http
Authorization: Bearer <connection_token>
X-AI-Session-ID: <session_id>
Idempotency-Key: <unique_key>
Content-Type: application/json
```

领取类命令返回的 `claim_token` 只显示在该次响应中。需要持有它才能回传进度、续租、完成、失败、释放或拆分任务；不要复用已过期租约的旧令牌。

### Bridge 设备配置交换（0.3）

Workspace Owner 可通过 `GET` / `PATCH /api/user/connections/:connectionId/bridge-config`
读取和修改期望配置。`PATCH` 需要 `Idempotency-Key`，并提交当前
`expected_version` 以及完整的 `enabled`、`include_thread_titles`、
`max_threads`、`max_concurrent_turns`；版本落后时返回
`409 VERSION_CONFLICT`，客户端应刷新后让用户重新确认。

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

Web 只控制运行时启停、thread 标题上传以及 thread/并行 turn 数量。工作目录、
thread 范围或固定 thread、权限与审批模式、URL/令牌、Codex 可执行文件和本机最大值
始终由设备环境决定；服务端也会拒绝突破本机 `constraints` 的 effective 报告。

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

Harness adapter 可以把 AI 回复、提供方暴露的思考摘要和工具执行过程追加到 Session 时间线：

```bash
curl --fail-with-body -sS "$ATB_URL/api/ai/sessions/activity" \
  -H "Authorization: Bearer $ATB_CONNECTION_TOKEN" \
  -H "X-AI-Session-ID: $ATB_SESSION_ID" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: bridge/activity/$(openssl rand -hex 16)" \
  --data "{
    \"task_id\": \"$ATB_TASK_ID\",
    \"claim_token\": \"$ATB_CLAIM_TOKEN\",
    \"kind\": \"reasoning\",
    \"content\": \"先确认失败测试，再缩小到相关模块。\",
    \"data\": {\"disclosure\": \"provider_summary\"},
    \"external_ref\": \"codex:<thread>:<task>:item:<provider-item-id>\"
  }"
```

支持的 `kind` 为 `assistant_message`、`reasoning`、`command`、`file_change`、`mcp_tool`、`web_search`、`plan`、`error`、`usage` 和 `status`。`assistant_message` 与 `reasoning` 必须有非空 `content`；`content` 最长 100,000 字符，`data` 必须是 JSON object 且编码后不超过 256 KiB。`external_ref` 必填，最长 500 字符。

调用者必须仍持有该 Task 的有效领取令牌。成功写入活动会把 Task 置为 `running`、刷新 Session，并为 `assistant_message` 同步创建一条任务消息。`external_ref` 在 Session 内唯一，应来自稳定的 provider thread/turn/item 标识；同一 item 重试时保持它和业务内容不变，否则返回 `IDEMPOTENCY_CONFLICT`。这里的 `reasoning` 只允许提供方明确输出的可展示摘要，不得上传隐藏的原始 chain-of-thought。

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

- `GET /api/user/sessions/:sessionId` 返回该 Session、相关任务、任务消息、任务事件和 `session_activities`，供会话对话框组合时间线。默认返回最新 100 条结构化活动；可用响应中的 `pagination.activities.oldest_cursor` 作为 `before_activity_id` 继续加载更早记录，`limit` 范围为 `1..200`。活动 ID 和游标均使用十进制字符串，避免 JavaScript 丢失 bigint 精度。
- `POST /api/user/sessions/:sessionId/turns` 接收 `{ "content": "..." }` 和 `Idempotency-Key`。目标 Session 必须仍在线；服务端原子创建定向分配给它的 `ready` Task、用户消息和 `user_message` 活动，并返回 HTTP `201`。

新 Task 的临时名称从消息的第一个非空句生成，最长 80 个 Unicode code point；当前不会额外调用模型命名。Codex Bridge 通常由 SSE 近实时唤醒并领取它，通知不可用时由自适应轮询兜底。若该 thread 的上一轮仍在执行，新 Task 只会排队；0.3 仍没有可靠的运行中 steer、网页 interrupt 或网页审批。

`pagination.legacy` 会分别标记旧任务、消息或事件是否达到兼容读取上限。旧表本身不是完整的 Session 事件流；出现截断标记时，网页会明确提示只展示最近的兼容记录，而 Bridge 接入后的结构化活动仍可持续向前分页。

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
