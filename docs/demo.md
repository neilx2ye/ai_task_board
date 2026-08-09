# 单会话上下文演示

这个演示体现当前的核心工作流：任务先在 CLI / APP 的 AI 会话里建立上下文，再同步到 Web Console。Web 负责观察、回复和向存活会话预留后续工作，不创建公共任务池。

演示会完成以下链路：

1. 注册一个带稳定 `external_conversation_ref` 的 CLI 会话。
2. 通过 `report_current_task` 同步已经开始的“竞品研究报告”，并自动绑定到该会话。
3. 在同一会话中拆分五个串行子任务；所有子任务默认留在原会话的定向队列。
4. 依次接收并完成前四项。
5. 最后一项向用户提问，等待用户在 Web 详情页回复，再由原会话继续完成。
6. 验证根任务聚合为 `completed`（5 / 5）。

## 准备

1. 启动应用并登录。
2. 在 `/connections` 创建一个 AI Connection，立即复制只显示一次的令牌。
3. 不需要先在 Web 新建根任务；脚本会模拟 CLI 中已经开始的任务并同步它。

## 运行

```bash
AI_TASK_BOARD_URL=http://localhost:3000 \
AI_DEMO_CONNECTION_TOKEN='<connection_token>' \
npm run demo
```

脚本等待用户回复时，会打印最终子任务的详情 URL。在另一个已登录浏览器打开该 URL，回复问题；脚本检测到任务回到原会话的预留队列后会继续执行。默认最多等待 10 分钟，可调整：

```bash
AI_DEMO_REPLY_TIMEOUT_MS=900000 \
AI_DEMO_POLL_INTERVAL_MS=3000 \
AI_TASK_BOARD_URL=http://localhost:3000 \
AI_DEMO_CONNECTION_TOKEN='<connection_token>' \
npm run demo
```

脚本不会打印 Connection Token 或领取令牌。不要把真实令牌写进仓库或共享的 shell 历史。

## 验收

- `/sessions` 只显示一个上下文会话，执行过程中为忙碌或等待用户。
- `/board` 中的任务卡片都绑定到该会话，没有未指定会话的新任务。
- 用户问题、回复、五个子任务和最终结果都能在根任务详情中看到。
- 相同会话在用户回复后继续处理，不发生跨会话抢占。
