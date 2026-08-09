# REST API 接入示例

REST API 的基地址是部署后的 Next.js 应用，例如 `http://localhost:3000`。AI 客户端只持有 AI Connection 的原始令牌；服务端由令牌解析连接与 Workspace，任何 AI 请求体都不能提交 `workspace_id`。

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

注册后的 AI 命令还必须发送服务端返回的会话 ID：

```http
Authorization: Bearer <connection_token>
X-AI-Session-ID: <session_id>
Idempotency-Key: <unique_key>
Content-Type: application/json
```

领取类命令返回的 `claim_token` 只显示在该次响应中。需要持有它才能回传进度、续租、完成、失败、释放或拆分任务；不要复用已过期租约的旧令牌。

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

空闲会话应至少每分钟刷新一次存活状态，使 Web Console 可以继续向它预留任务：

```bash
curl --fail-with-body -sS "$ATB_URL/api/ai/sessions/presence" \
  -H "Authorization: Bearer $ATB_CONNECTION_TOKEN" \
  -H "X-AI-Session-ID: $ATB_SESSION_ID" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: demo/presence/$(openssl rand -hex 16)" \
  --data '{}'
```

两分钟没有会话活动时，Web 会把它视为离线并停止接受新预留；执行中任务仍使用后文的领取心跳续租。

## 2. 读取本会话的下一项预留任务

```bash
curl --fail-with-body -sS "$ATB_URL/api/ai/tasks/claim-next" \
  -H "Authorization: Bearer $ATB_CONNECTION_TOKEN" \
  -H "X-AI-Session-ID: $ATB_SESSION_ID" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: demo/claim-next/$(openssl rand -hex 16)" \
  --data '{"lease_seconds": 900}'
```

服务端仅考虑 `assigned_session_id` 等于当前会话、能力匹配且依赖已完成的 `ready` 叶子任务，按优先级降序、创建时间升序原子接收。它不会扫描其他会话或未绑定的任务；没有预留任务时成功响应中的任务值为 `null`。

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

心跳会更新会话最后在线时间，并延长当前领取租约：

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

HTTP `401` 表示连接令牌缺失、无效或已撤销；`400 INVALID_REQUEST` 表示 JSON/Zod 校验失败；`500 INTERNAL_ERROR` 可以使用**同一个**幂等键有限退避重试。
