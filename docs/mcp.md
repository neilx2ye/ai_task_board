# MCP 接入

AI Task Board 在 `POST /api/mcp` 提供无状态 MCP Streamable HTTP 端点。它和 REST Adapter 共用鉴权、Zod Schema、领域服务与 PostgreSQL RPC，不维护第二套任务状态规则。

当前端点支持：

- `initialize`（使用 SDK 支持的版本协商；当前最新版本为 `2025-11-25`）
- `notifications/initialized`
- `ping`
- `tools/list`
- `tools/call`

每个请求都必须带 AI Connection Bearer Token。服务端返回 `application/json`，不签发 `Mcp-Session-Id`；因此客户端应把每次调用视为独立请求，并在每次请求中重新发送鉴权头。

## 客户端配置

AI Connection Token 属于整个 AI 环境或 MCP 连接，可在全局 MCP 配置中固定；AI Session 属于具体的对话、线程或 Agent 上下文，同一个 Connection 下可以（并且通常会）有多个 Session。因此共享的 MCP 配置只固定令牌，不配置会话头：

```json
{
  "mcpServers": {
    "ai-task-board": {
      "type": "http",
      "url": "http://localhost:3000/api/mcp",
      "headers": {
        "Authorization": "Bearer atb_REPLACE_ME"
      }
    }
  }
}
```

有些 Host 把 `type` 命名为 `streamable-http`。请优先使用 Host 的 Secret/环境变量插值能力，不要把 `atb_...` 明文提交到配置仓库。

每个新对话或 Agent 上下文首次使用时调用 `register_session`，提供该上下文稳定且唯一的 `external_conversation_ref`，并保存 `result.structuredContent.data.session.id`；同一 Connection + `external_conversation_ref` 重连会恢复同一 Session。之后每次工具调用在 `arguments.session_id` 中传该对话自己的 Session ID——除 `register_session` 外，服务端 schema 已公开 `session_id`。写工具还必须为每次逻辑操作发送唯一的 `idempotency_key`；重试同一操作时复用原 Key。

> 例外：`X-AI-Session-ID` 请求头只适合一个独立进程永久绑定一个 Session 的专用 Worker。共享或全局 MCP 环境不要配置它——当请求头与 `arguments.session_id` 同时存在时请求头优先，固定的请求头会覆盖每次调用传入的 `session_id`，导致所有对话被归到同一个 Session。

## 用 JSON-RPC 引导一个会话

以下示例便于在接入 MCP Host 前验证端点。先设置：

```bash
export ATB_MCP_URL='http://localhost:3000/api/mcp'
export ATB_CONNECTION_TOKEN='atb_...'
```

初始化（示例客户端请求仍受支持的 `2025-06-18`，服务端会原样协商；不支持的版本会回退到 SDK 的最新版本）：

```bash
curl --fail-with-body -sS "$ATB_MCP_URL" \
  -H "Authorization: Bearer $ATB_CONNECTION_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  --data '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-06-18",
      "capabilities": {},
      "clientInfo": {"name": "manual-check", "version": "1.0.0"}
    }
  }'
```

注册或恢复一个 AI 会话：

```bash
curl --fail-with-body -sS "$ATB_MCP_URL" \
  -H "Authorization: Bearer $ATB_CONNECTION_TOKEN" \
  -H 'Content-Type: application/json' \
  --data "{
    \"jsonrpc\": \"2.0\",
    \"id\": 2,
    \"method\": \"tools/call\",
    \"params\": {
      \"name\": \"register_session\",
      \"arguments\": {
        \"idempotency_key\": \"mcp/register/$(openssl rand -hex 16)\",
        \"name\": \"Claude Research\",
        \"platform\": \"claude\",
        \"model\": \"claude-sonnet\",
        \"external_conversation_ref\": \"claude-research-main\",
        \"capabilities\": [\"web-research\", \"analysis\"]
      }
    }
  }"
```

会话 ID 位于 `result.structuredContent.data.session.id`。后续示例设置：

```bash
export ATB_SESSION_ID='<result.structuredContent.data.session.id>'
```

查看服务端实际发布的工具 Schema：

```bash
curl --fail-with-body -sS "$ATB_MCP_URL" \
  -H "Authorization: Bearer $ATB_CONNECTION_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":3,"method":"tools/list","params":{}}'
```

读取当前会话的下一项预留任务（不会扫描公共池）：

```bash
curl --fail-with-body -sS "$ATB_MCP_URL" \
  -H "Authorization: Bearer $ATB_CONNECTION_TOKEN" \
  -H 'Content-Type: application/json' \
  --data "{
    \"jsonrpc\": \"2.0\",
    \"id\": 4,
    \"method\": \"tools/call\",
    \"params\": {
      \"name\": \"claim_next_task\",
      \"arguments\": {
        \"session_id\": \"$ATB_SESSION_ID\",
        \"idempotency_key\": \"mcp/claim-next/$(openssl rand -hex 16)\",
        \"lease_seconds\": 900
      }
    }
  }"
```

会话 ID 通过 `arguments.session_id` 传递，每个对话传自己的 Session ID。`X-AI-Session-ID` 请求头仅适用于永久绑定单一 Session 的专用 Worker；服务端优先使用请求头，固定请求头会覆盖 arguments 中的 `session_id`。

工具成功结果同时提供 MCP 文本内容与结构化数据：

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "result": {
    "content": [
      {"type": "text", "text": "{\"data\":{...}}"}
    ],
    "structuredContent": {
      "data": {}
    }
  }
}
```

## 工具清单

| MCP Tool | REST 对应项 | 关键输入 |
|---|---|---|
| `register_session` | `sessions/register` | `name`、`platform`、`model?`、`external_conversation_ref?`、`capabilities` |
| `report_current_task` | `tasks/report-current` | 标题、外部任务引用、进度与能力 |
| `claim_next_task` | `tasks/claim-next` | 读取当前会话预留队列；`lease_seconds?` |
| `claim_task` | `tasks/claim` | 只能接收明确分配给当前会话的 `task_id`；`lease_seconds?` |
| `get_task` | `GET tasks/:taskId` | `task_id` |
| `create_subtasks` | `tasks/create-subtasks` | `task_id`、`claim_token`、完整 `subtasks` 批次 |
| `report_progress` | `tasks/report-progress` | `task_id`、`claim_token`、进度说明与估计 |
| `post_task_message` | `tasks/messages` | `task_id`、`claim_token`、`content`、`reply_to_message_id?` |
| `request_user_input` | `tasks/request-user-input` | `task_id`、`claim_token`、`question` |
| `heartbeat_session` | `sessions/presence` | 空闲会话存活心跳，无任务字段 |
| `heartbeat` | `sessions/heartbeat` | `task_id`、`claim_token`、`lease_seconds?` |
| `complete_task` | `tasks/complete` | 领取凭证、结果、消息与附件引用 |
| `complete_task_and_claim_next` | 同名 REST 路由 | 完成输入及 `lease_seconds?` |
| `fail_task` | `tasks/fail` | `task_id`、`claim_token`、`reason` |
| `release_task` | `tasks/release` | `task_id`、`claim_token`、`reason?` |
| `get_task_updates` | `GET tasks/:taskId/updates` | `task_id`、`after?`、`limit?` |

完整字段约束由 `tools/list` 返回。除了 `get_task`、`get_task_updates` 之外，所有工具都要求 `idempotency_key`；除了 `register_session` 之外，所有工具都要求 `arguments.session_id`（或专用 Worker 的 `X-AI-Session-ID` 请求头）中存在 AI Session ID。

涉及租约的 `lease_seconds` 范围为 `60..3600`，默认 `900`。MCP 工具只提交附件元数据或外部 URL；浏览器的私有文件上传接口见 [REST API 示例](rest-api.md)。

## 完成并领取下一项

以下是推荐的主循环调用：

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "tools/call",
  "params": {
    "name": "complete_task_and_claim_next",
    "arguments": {
      "session_id": "00000000-0000-4000-8000-000000000000",
      "idempotency_key": "mcp/complete-next/550e8400-e29b-41d4-a716-446655440000",
      "task_id": "00000000-0000-4000-8000-000000000001",
      "claim_token": "claim_REPLACE_ME",
      "result_summary": "资料收集完成",
      "result_json": {"source_count": 12},
      "message": "已记录来源并交接下一项。",
      "artifacts": [],
      "lease_seconds": 900
    }
  }
}
```

`structuredContent.data.next_task` 为同一根任务下、且已经分配给当前会话的后续任务；没有本会话预留项时为 `null`。

## 错误处理

JSON-RPC 协议错误使用标准代码（如 `-32700` Parse error、`-32600` Invalid Request、`-32601` Method not found、`-32602` Unknown tool）。领域/鉴权/校验错误使用 `-32000`，并在 `error.data` 保留与 REST 一致的稳定码：

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "error": {
    "code": -32000,
    "message": "The task lease has expired",
    "data": {
      "code": "LEASE_EXPIRED"
    }
  }
}
```

HTTP 状态也与 REST 语义一致。只对临时网络错误和 HTTP 5xx 做有限退避重试；同一逻辑操作必须复用原 `idempotency_key`。遇到 `LEASE_EXPIRED` 或 `INVALID_CLAIM_TOKEN` 应停止使用旧领取令牌并重新领取。
