import { randomUUID } from "node:crypto";

type JsonObject = Record<string, unknown>;
type Session = { id: string; name: string };
type ClaimedTask = { id: string; title: string; claim_token: string };

const baseUrl = (process.env.AI_TASK_BOARD_URL ?? "http://localhost:3000").replace(
  /\/$/,
  "",
);
const connectionToken = process.env.AI_DEMO_CONNECTION_TOKEN?.trim() ?? "";
const replyTimeoutMs = positiveIntegerEnv("AI_DEMO_REPLY_TIMEOUT_MS", 10 * 60 * 1000);
const pollIntervalMs = positiveIntegerEnv("AI_DEMO_POLL_INTERVAL_MS", 3_000);
const runId = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function objectAt(value: unknown, key: string): JsonObject {
  if (!isObject(value) || !isObject(value[key])) {
    throw new Error(`Expected response data.${key} to be an object`);
  }
  return value[key];
}

function stringAt(value: JsonObject, key: string): string {
  const result = value[key];
  if (typeof result !== "string" || !result) {
    throw new Error(`Expected ${key} to be a non-empty string`);
  }
  return result;
}

function log(message: string): void {
  process.stdout.write(`[demo] ${message}\n`);
}

function key(step: string): string {
  return `session-directed-demo/${runId}/${step}`;
}

async function request(
  path: string,
  options: {
    sessionId?: string;
    method?: "GET" | "POST";
    body?: unknown;
    idempotencyKey?: string;
  } = {},
): Promise<unknown> {
  const headers = new Headers({
    Authorization: `Bearer ${connectionToken}`,
    Accept: "application/json",
  });
  if (options.sessionId) headers.set("X-AI-Session-ID", options.sessionId);
  if (options.idempotencyKey) {
    headers.set("Idempotency-Key", options.idempotencyKey);
  }
  if (options.body !== undefined) headers.set("Content-Type", "application/json");

  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "POST",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const error = isObject(payload) && isObject(payload.error) ? payload.error : {};
    throw new Error(
      `${String(error.code ?? "HTTP_ERROR")} (${response.status}): ${String(
        error.message ?? "Request failed",
      )}`,
    );
  }
  if (!isObject(payload) || !("data" in payload)) {
    throw new Error(`Invalid API envelope from ${path}`);
  }
  return payload.data;
}

function claimedTask(data: unknown, field = "task"): ClaimedTask {
  const task = objectAt(data, field);
  return {
    id: stringAt(task, "id"),
    title: stringAt(task, "title"),
    claim_token: stringAt(task, "claim_token"),
  };
}

async function registerSession(): Promise<Session> {
  const name = `Research conversation ${runId}`;
  const data = await request("/api/ai/sessions/register", {
    body: {
      name,
      platform: "demo-cli",
      model: "deterministic-demo",
      external_conversation_ref: `session-directed-demo:${runId}`,
      capabilities: ["web-research", "analysis", "writing"],
    },
    idempotencyKey: key("register-session"),
  });
  return { id: stringAt(objectAt(data, "session"), "id"), name };
}

async function reportCurrentRoot(session: Session): Promise<ClaimedTask> {
  const data = await request("/api/ai/tasks/report-current", {
    sessionId: session.id,
    idempotencyKey: key("report-current-root"),
    body: {
      title: "完成竞品研究报告",
      description: "任务和上下文已在 CLI 会话中确定，再同步到 Web Console。",
      acceptance_criteria: "包含摘要、对比矩阵、结论与建议。",
      external_source: "demo-cli",
      external_task_ref: `competitor-report:${runId}`,
      external_conversation_ref: `session-directed-demo:${runId}`,
      priority: 80,
      progress_note: "已在当前对话中确认范围，准备拆分执行。",
      progress_percent_estimate: 5,
      required_capabilities: ["web-research", "analysis", "writing"],
    },
  });
  return claimedTask(data);
}

async function claim(session: Session, taskId: string, step: string): Promise<ClaimedTask> {
  return claimedTask(
    await request("/api/ai/tasks/claim", {
      sessionId: session.id,
      idempotencyKey: key(step),
      body: { task_id: taskId, lease_seconds: 900 },
    }),
  );
}

async function complete(
  session: Session,
  task: ClaimedTask,
  index: number,
): Promise<void> {
  await request("/api/ai/tasks/complete", {
    sessionId: session.id,
    idempotencyKey: key(`complete-${index + 1}`),
    body: {
      task_id: task.id,
      claim_token: task.claim_token,
      result_summary: `会话内步骤 ${index + 1} 已完成。`,
      result_json: { demo_run_id: runId, step: index + 1 },
      message: `继续沿用 ${session.name} 的上下文执行。`,
      artifacts: [],
    },
  });
  log(`完成「${task.title}」`);
}

async function getTask(session: Session, taskId: string): Promise<JsonObject> {
  const data = await request(`/api/ai/tasks/${encodeURIComponent(taskId)}`, {
    method: "GET",
    sessionId: session.id,
  });
  if (!isObject(data)) throw new Error("Expected task details object");
  return data;
}

async function waitForUserReply(session: Session, taskId: string): Promise<void> {
  const deadline = Date.now() + replyTimeoutMs;
  while (Date.now() < deadline) {
    const task = objectAt(await getTask(session, taskId), "task");
    if (task.status === "ready") return;
    if (task.status !== "waiting_user") {
      throw new Error(`Expected waiting_user/ready, received ${String(task.status)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`Timed out waiting for a user reply to task ${taskId}`);
}

async function main(): Promise<void> {
  if (!connectionToken) throw new Error("AI_DEMO_CONNECTION_TOKEN is required");
  log(`目标应用：${baseUrl}`);
  log("注册一个已有上下文的 CLI 会话");

  const session = await registerSession();
  const root = await reportCurrentRoot(session);
  log(`CLI 当前任务已同步：${root.title}`);

  const split = await request("/api/ai/tasks/create-subtasks", {
    sessionId: session.id,
    idempotencyKey: key("create-subtasks"),
    body: {
      task_id: root.id,
      claim_token: root.claim_token,
      subtasks: [
        ["collect", "收集竞品名单", "web-research"],
        ["materials", "搜集各竞品资料", "web-research"],
        ["compare", "对比功能与定价", "analysis"],
        ["insights", "提炼关键结论", "analysis"],
        ["report", "生成最终报告", "writing"],
      ].map(([client_ref, title, capability], index) => ({
        client_ref,
        title,
        priority: 100 - index,
        position: index,
        required_capabilities: [capability],
        depends_on: index === 0 ? [] : [["collect", "materials", "compare", "insights"][index - 1]],
      })),
    },
  });
  const subtasks = isObject(split) && Array.isArray(split.subtasks)
    ? split.subtasks.filter(isObject)
    : [];
  if (subtasks.length !== 5) throw new Error("Expected five subtasks");
  log("五个子任务都已留在原会话的定向队列中");

  for (let index = 0; index < 4; index += 1) {
    const task = await claim(session, stringAt(subtasks[index], "id"), `claim-${index + 1}`);
    await complete(session, task, index);
  }

  const finalTaskId = stringAt(subtasks[4], "id");
  const finalBeforeQuestion = await claim(session, finalTaskId, "claim-final");
  await request("/api/ai/tasks/request-user-input", {
    sessionId: session.id,
    idempotencyKey: key("request-user-input"),
    body: {
      task_id: finalTaskId,
      claim_token: finalBeforeQuestion.claim_token,
      question: "最终报告更偏向高管摘要，还是详细功能矩阵？",
    },
  });
  log(`等待用户回复：${baseUrl}/tasks/${finalTaskId}`);
  await waitForUserReply(session, finalTaskId);

  const finalTask = await claim(session, finalTaskId, "reclaim-final");
  await request("/api/ai/tasks/complete", {
    sessionId: session.id,
    idempotencyKey: key("complete-final"),
    body: {
      task_id: finalTask.id,
      claim_token: finalTask.claim_token,
      result_summary: "竞品研究报告已按用户偏好完成。",
      result_json: { demo_run_id: runId },
      message: "最终报告已完成。",
      artifacts: [],
    },
  });

  const completedRoot = objectAt(await getTask(session, root.id), "task");
  if (completedRoot.status !== "completed") {
    throw new Error(`Expected completed root, received ${String(completedRoot.status)}`);
  }
  log(`演示完成：一个上下文会话完成 5 / 5，打开 ${baseUrl}/tasks/${root.id}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`[demo] 失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
