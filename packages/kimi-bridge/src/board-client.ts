import { randomUUID } from "node:crypto";

import type { InventoryModel } from "./acp-client.js";
import type {
  KimiBridgeConfiguration,
  ManagedWorkingDirectory,
} from "./config.js";
import {
  delay,
  errorMessage,
  isRecord,
  redactText,
  stringValue,
} from "./utils.js";

export const KIMI_BRIDGE_CAPABILITY_VERSION = "1.0.0-kimi.1";

export type BoardSession = {
  id: string;
  external_conversation_ref?: string | null;
  deletion_requested_at?: string | null;
};

export type ClaimedTask = {
  id: string;
  title: string;
  description: string | null;
  acceptance_criteria: string | null;
  model?: string | null;
  reasoning_effort?: string | null;
  claim_token: string;
};

export type TaskImageArtifact = {
  id: string;
  name: string;
  mime_type: string;
  size: number;
};

export type ThreadCommand = {
  id: string;
  action: "create" | "rename" | "delete";
  name: string | null;
  directory_key: string | null;
  model?: string | null;
  reasoning_effort?: string | null;
  external_thread_id: string | null;
  attempt_count?: number;
};

export type InventoryThread = {
  external_conversation_ref: string;
  name: string;
  platform: "kimi-code";
  model: string | null;
  working_directory: string;
  directory_key: string;
  capabilities: string[];
  archived: false;
};

export type RemoteConfigurationResponse = {
  configuration: {
    version: number;
  };
};

type BoardRequestOptions = {
  method?: string;
  body?: unknown;
  idempotencyKey?: string;
  sessionId?: string;
  maxAttempts?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
};

function idempotencyKey(operation: string): string {
  return `kimi-bridge/${operation}/${randomUUID()}`;
}

export class BoardClient {
  constructor(
    private readonly configuration: KimiBridgeConfiguration,
    private readonly isStopping: () => boolean,
  ) {}

  async request<T>(
    pathname: string,
    options: BoardRequestOptions = {},
  ): Promise<T> {
    const method = options.method ?? "GET";
    const maxAttempts = options.maxAttempts ?? Number.POSITIVE_INFINITY;
    if (
      maxAttempts !== Number.POSITIVE_INFINITY &&
      (!Number.isInteger(maxAttempts) || maxAttempts < 1)
    ) {
      throw new Error("maxAttempts 必须是正整数");
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (options.signal?.aborted) throw options.signal.reason;
      if (attempt > 1 && this.isStopping()) throw lastError;
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(new Error("看板请求超时")),
        options.timeoutMs ?? 30_000,
      );
      const abort = () => controller.abort(options.signal?.reason);
      options.signal?.addEventListener("abort", abort, { once: true });
      try {
        const response = await fetch(
          `${this.configuration.boardUrl}${pathname}`,
          {
            method,
            signal: controller.signal,
            headers: {
              Authorization: `Bearer ${this.configuration.connectionToken}`,
              ...(options.sessionId
                ? { "X-AI-Session-ID": options.sessionId }
                : {}),
              ...(options.body === undefined
                ? {}
                : { "Content-Type": "application/json" }),
              ...(options.idempotencyKey
                ? { "Idempotency-Key": options.idempotencyKey }
                : {}),
            },
            body:
              options.body === undefined
                ? undefined
                : JSON.stringify(options.body),
          },
        );
        const payload = (await response.json().catch(() => null)) as
          | { data?: T; error?: { code?: string; message?: string } }
          | null;
        if (!response.ok) {
          const error = new Error(
            payload?.error?.message || `HTTP ${response.status}`,
          ) as Error & { status?: number; code?: string };
          error.status = response.status;
          error.code = payload?.error?.code;
          throw error;
        }
        return (payload?.data ?? payload) as T;
      } catch (error) {
        lastError = error;
        if (options.signal?.aborted) throw options.signal.reason;
        const status = (error as { status?: number }).status;
        const retryable =
          status === undefined || status === 408 || status === 429 || status >= 500;
        if (!retryable || this.isStopping() || attempt >= maxAttempts) throw error;
        if (attempt === 4 || (attempt > 4 && attempt % 10 === 1)) {
          process.stderr.write(`看板请求暂时失败，继续重试 ${pathname}\n`);
        }
        await delay(
          Math.min(250 * 2 ** Math.min(attempt - 1, 6), 10_000),
          options.signal,
        );
      } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
      }
    }
    throw lastError;
  }

  async syncSessions(
    threads: readonly InventoryThread[],
    directories: readonly ManagedWorkingDirectory[],
    modelCatalog: readonly InventoryModel[],
    signal?: AbortSignal,
  ): Promise<Map<string, BoardSession>> {
    const response = await this.request<{ sessions: BoardSession[] }>(
      "/api/ai/sessions/sync",
      {
        method: "POST",
        maxAttempts: 1,
        signal,
        idempotencyKey: idempotencyKey("sync-sessions"),
        body: {
          bridge_version: KIMI_BRIDGE_CAPABILITY_VERSION,
          model_catalog: modelCatalog,
          directories: directories.map((directory) => ({
            directory_key: directory.key,
            name: directory.name,
            working_directory: directory.workingDirectory,
          })),
          threads,
        },
      },
    );
    return new Map(
      response.sessions.flatMap((session) =>
        session.external_conversation_ref
          ? [[session.external_conversation_ref, session] as const]
          : [],
      ),
    );
  }

  async exchangeConfiguration(
    body: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = 5_000,
  ): Promise<RemoteConfigurationResponse> {
    const response = await this.request<unknown>("/api/ai/config", {
      method: "POST",
      body,
      signal,
      timeoutMs,
      maxAttempts: 1,
    });
    if (!isRecord(response) || !isRecord(response.configuration)) {
      throw new Error("看板配置响应缺少 configuration");
    }
    const version = response.configuration.version;
    if (!Number.isInteger(version) || Number(version) < 1) {
      throw new Error("看板配置响应包含无效 version");
    }
    return { configuration: { version: Number(version) } };
  }

  async claimThreadCommand(
    runtimeInstanceId: string,
    signal?: AbortSignal,
  ): Promise<ThreadCommand | null> {
    const response = await this.request<{ command: ThreadCommand | null }>(
      "/api/ai/thread-commands/claim",
      {
        method: "POST",
        body: { runtime_instance_id: runtimeInstanceId, lease_seconds: 60 },
        signal,
        timeoutMs: 5_000,
        maxAttempts: 1,
      },
    );
    return response.command;
  }

  async completeThreadCommand(
    runtimeInstanceId: string,
    commandId: string,
    result:
      | { succeeded: true; externalThreadId: string | null }
      | { succeeded: false; error: string },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.request(`/api/ai/thread-commands/${commandId}/complete`, {
      method: "POST",
      signal,
      body: {
        runtime_instance_id: runtimeInstanceId,
        succeeded: result.succeeded,
        external_thread_id: result.succeeded ? result.externalThreadId : null,
        error: result.succeeded ? null : result.error,
      },
    });
  }

  async claimTask(
    sessionId: string,
    leaseSeconds: number,
    signal: AbortSignal,
  ): Promise<ClaimedTask | null> {
    const response = await this.request<{ task: ClaimedTask | null }>(
      "/api/ai/tasks/claim-next",
      {
        method: "POST",
        sessionId,
        signal,
        idempotencyKey: idempotencyKey("claim-next"),
        body: { lease_seconds: leaseSeconds },
      },
    );
    return response.task;
  }

  async taskArtifacts(
    sessionId: string,
    taskId: string,
    signal: AbortSignal,
  ): Promise<TaskImageArtifact[]> {
    const response = await this.request<{ artifacts?: TaskImageArtifact[] }>(
      `/api/ai/tasks/${taskId}`,
      { sessionId, signal, maxAttempts: 3 },
    ).catch((error: unknown) => {
      if ((error as { status?: number }).status === 404) return { artifacts: [] };
      throw error;
    });
    return response.artifacts ?? [];
  }

  async downloadImage(
    sessionId: string,
    artifact: TaskImageArtifact,
    signal: AbortSignal,
  ): Promise<{ data: string; mimeType: string }> {
    const location = await this.request<{ url: string }>(
      `/api/ai/artifacts/${artifact.id}/download`,
      { sessionId, signal, maxAttempts: 3 },
    );
    const response = await fetch(location.url, { signal });
    if (!response.ok) throw new Error(`图片下载失败：HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (
      bytes.byteLength !== artifact.size ||
      bytes.byteLength > 10 * 1024 * 1024
    ) {
      throw new Error(`图片大小校验失败：${artifact.name}`);
    }
    return { data: bytes.toString("base64"), mimeType: artifact.mime_type };
  }

  reportProgress(
    sessionId: string,
    task: ClaimedTask,
    signal: AbortSignal,
  ): Promise<unknown> {
    return this.request("/api/ai/tasks/report-progress", {
      method: "POST",
      sessionId,
      signal,
      idempotencyKey: idempotencyKey("started"),
      body: {
        task_id: task.id,
        claim_token: task.claim_token,
        progress_note: "Kimi Code ACP 已接收任务，正在执行",
        progress_percent_estimate: 5,
      },
    });
  }

  reportAssistantMessage(
    sessionId: string,
    externalThreadId: string,
    task: ClaimedTask,
    content: string,
    data: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    return this.request("/api/ai/sessions/activity", {
      method: "POST",
      sessionId,
      signal,
      idempotencyKey: idempotencyKey("activity"),
      body: {
        task_id: task.id,
        claim_token: task.claim_token,
        external_ref: `kimi:${externalThreadId}:${task.id}:assistant`,
        kind: "assistant_message",
        content: redactText(content),
        data,
      },
    });
  }

  completeTask(
    sessionId: string,
    task: ClaimedTask,
    resultSummary: string,
    resultJson: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    return this.request("/api/ai/tasks/complete", {
      method: "POST",
      sessionId,
      signal,
      idempotencyKey: idempotencyKey("complete"),
      body: {
        task_id: task.id,
        claim_token: task.claim_token,
        result_summary: redactText(resultSummary),
        result_json: resultJson,
        message: null,
        artifacts: [],
      },
    });
  }

  failTask(
    sessionId: string,
    task: ClaimedTask,
    reason: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.request("/api/ai/tasks/fail", {
      method: "POST",
      sessionId,
      signal,
      idempotencyKey: idempotencyKey("fail"),
      maxAttempts: 3,
      body: {
        task_id: task.id,
        claim_token: task.claim_token,
        reason: redactText(reason, 10_000),
        result_json: null,
      },
    });
  }

  releaseTask(
    sessionId: string,
    task: ClaimedTask,
    reason: string,
  ): Promise<unknown> {
    return this.request("/api/ai/tasks/release", {
      method: "POST",
      sessionId,
      idempotencyKey: idempotencyKey("release"),
      maxAttempts: 1,
      timeoutMs: 5_000,
      body: {
        task_id: task.id,
        claim_token: task.claim_token,
        reason: redactText(reason, 2_000),
      },
    });
  }

  async heartbeatPresence(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<BoardSession | null> {
    const response = await this.request<{ session?: BoardSession }>(
      "/api/ai/sessions/presence",
      {
        method: "POST",
        sessionId,
        signal,
        idempotencyKey: idempotencyKey("session-heartbeat"),
        body: {},
      },
    );
    return response.session ?? null;
  }

  heartbeatClaim(
    sessionId: string,
    task: ClaimedTask,
    leaseSeconds: number,
    signal: AbortSignal,
  ): Promise<unknown> {
    return this.request("/api/ai/sessions/heartbeat", {
      method: "POST",
      sessionId,
      signal,
      idempotencyKey: idempotencyKey("claim-heartbeat"),
      body: {
        task_id: task.id,
        claim_token: task.claim_token,
        lease_seconds: leaseSeconds,
      },
    });
  }
}

export function actionableBoardError(error: unknown): Error {
  const status = (error as { status?: number } | null)?.status;
  const detail = redactText(errorMessage(error), 2_000);
  if (status === 401 || status === 403) {
    return new Error(
      `看板认证失败（HTTP ${status}）：请检查 AI_TASK_BOARD_CONNECTION_TOKEN。 ${detail}`,
      { cause: error },
    );
  }
  if (status === 409) {
    return new Error(
      `同一 AI Connection 已有另一个 Bridge 持有运行租约。 ${detail}`,
      { cause: error },
    );
  }
  return new Error(
    `看板拒绝 Kimi Bridge 请求（HTTP ${status ?? "unknown"}）：${detail}`,
    { cause: error },
  );
}

export function commandError(error: unknown): string {
  return redactText(errorMessage(error), 2_000);
}

export function commandString(value: unknown): string | null {
  return stringValue(value);
}
