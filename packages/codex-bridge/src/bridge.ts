import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  type AppServerIncomingRequest,
  type AppServerNotification,
  type AppServerThread,
  CodexAppServerClient,
} from "./app-server-client.js";
import {
  type HistoryImportRequest,
  type HistoryImportResponse,
  HistorySynchronizer,
  isInteractiveHistoryThread,
} from "./history-sync.js";
import {
  boundActivityData,
  redactHarnessText,
  sanitizeHarnessValue,
} from "./activity-sanitizer.js";
import {
  isSessionActiveClaimConflict,
  nextClaimAction,
} from "./claim-retry.js";
import {
  adaptiveIdlePollDelay,
  runSessionWakeListener,
  WakeLatch,
} from "./wake-client.js";

const BRIDGE_VERSION = "0.4.0";
const APP_SERVER_PROTOCOL = "codex-app-server/v1";
const THREAD_SOURCE_KINDS = ["cli", "vscode", "exec", "appServer"];
const DELTA_CHUNK_BYTES = 8_192;
const ACCUMULATED_TEXT_LIMIT = 100_000;
const STREAM_TRUNCATION_MARKER = "\n…[流式输出已截断]";
const MAX_NOTIFICATION_BACKLOG = 256;
const MAX_ACTIVITY_BACKLOG = 64;

type ClaimedTask = {
  id: string;
  title: string;
  description: string | null;
  acceptance_criteria: string | null;
  claim_token: string;
};

type Session = {
  id: string;
  external_conversation_ref?: string | null;
};

type ClaimResponse = { task: ClaimedTask | null };

type ThreadRecord = AppServerThread & {
  name?: unknown;
  preview?: unknown;
  cwd?: unknown;
  model?: unknown;
  parentThreadId?: unknown;
  status?: unknown;
};

type ActivityKind =
  | "assistant_message"
  | "reasoning"
  | "command"
  | "file_change"
  | "mcp_tool"
  | "web_search"
  | "plan"
  | "error"
  | "usage"
  | "status";

type Activity = {
  kind: ActivityKind;
  content: string | null;
  data: Record<string, unknown>;
};

type TurnResult = {
  id: string;
  status?: unknown;
  error?: unknown;
};

type ApprovalMode = "decline" | "accept" | "accept-session";
type PermissionMode = "safe" | "inherit";
type ThreadScope = "cwd" | "all";

export type EffectiveBridgeConfiguration = {
  enabled: boolean;
  includeThreadTitles: boolean;
  maxThreads: number;
  maxConcurrentTurns: number;
  syncHistory: boolean;
  historyTurnLimit: number;
};

export type RemoteBridgeConfigurationDesired = {
  enabled: boolean;
  include_thread_titles: boolean;
  max_threads: number;
  max_concurrent_turns: number;
  /** Optional only for compatibility with a Board that has not initialized 0.4 defaults yet. */
  sync_history?: boolean;
  /** Optional only for compatibility with a Board that has not initialized 0.4 defaults yet. */
  history_turn_limit?: number;
};

export type RemoteBridgeConfigurationConstraints = {
  remote_configuration_enabled: boolean;
  allow_thread_titles: boolean;
  allow_history_sync: boolean;
  max_threads: number;
  max_concurrent_turns: number;
  max_history_turns: number;
  thread_scope: ThreadScope;
  working_directory: string;
  fixed_thread: boolean;
  permission_mode: PermissionMode;
  approval_mode: ApprovalMode;
};

export type ResolvedRemoteConfiguration = {
  effective: EffectiveBridgeConfiguration;
  warnings: string[];
};

export type BridgeConfiguration = {
  boardUrl: string;
  connectionToken: string;
  threadIdFilter: string | null;
  workingDirectory: string;
  sessionNamePrefix: string | null;
  model: string | null;
  capabilities: string[];
  pollIntervalMs: number;
  leaseSeconds: number;
  maxThreads: number;
  maxConcurrentTurns: number;
  syncIntervalMs: number;
  configurationPollIntervalMs: number;
  configurationLeaseSeconds: number;
  approvalMode: ApprovalMode;
  permissionMode: PermissionMode;
  threadScope: ThreadScope;
  enabled: boolean;
  includeThreadTitles: boolean;
  syncHistory: boolean;
  historyTurnLimit: number;
  localIncludeThreadTitles: boolean;
  allowRemoteThreadTitles: boolean;
  allowHistorySync: boolean;
  localMaxThreads: number;
  localMaxConcurrentTurns: number;
  localMaxHistoryTurns: number;
  webConfigurationEnabled: boolean;
  codexBinary: string;
};

type RemoteConfigurationResponse = {
  configuration: {
    connection_id: string;
    version: number;
    desired: RemoteBridgeConfigurationDesired;
    applied?: unknown;
    updated_at: string;
  };
};

type RemoteConfigurationStatus = {
  runtime_instance_id: string;
  report_sequence: number;
  lease_seconds: number;
  release_runtime: boolean;
  applied_version: number | null;
  effective: RemoteBridgeConfigurationDesired | null;
  constraints: RemoteBridgeConfigurationConstraints;
  error: string | null;
};

type BoardRequestOptions = {
  method?: string;
  body?: unknown;
  idempotencyKey?: string;
  sessionId?: string;
  /** Total attempts, including the first request. */
  maxAttempts?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
};

type InventoryThread = {
  external_conversation_ref: string;
  name: string;
  platform: "codex";
  model: string | null;
  working_directory: string | null;
  capabilities: string[];
  archived: false;
};

type SyncSessionsResponse = {
  sessions: Session[];
};

type ActivityBuffer = {
  kind: Extract<ActivityKind, "assistant_message" | "reasoning" | "command">;
  turnId: string;
  itemId: string;
  pending: string;
  accumulated: string;
  streamClosed: boolean;
  chunkIndex: number;
  timer: ReturnType<typeof setTimeout> | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,，\s]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = value ? Number(value) : fallback;
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function parseApprovalMode(value: string | undefined): ApprovalMode {
  if (value === "accept" || value === "accept-session") return value;
  return "decline";
}

function parsePermissionMode(value: string | undefined): PermissionMode {
  return value === "inherit" ? "inherit" : "safe";
}

function parseThreadScope(value: string | undefined): ThreadScope {
  return value === "all" ? "all" : "cwd";
}

function parseBoolean(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function appendBoundedPrefix(
  current: string,
  addition: string,
  limit = ACCUMULATED_TEXT_LIMIT,
): string {
  if (current.length >= limit || !addition) return current;
  let end = Math.min(addition.length, limit - current.length);
  if (
    end > 0 &&
    end < addition.length &&
    /[\uD800-\uDBFF]/.test(addition[end - 1] ?? "")
  ) {
    end -= 1;
  }
  return current + addition.slice(0, end);
}

export function acceptBoundedStreamDelta(
  current: string,
  addition: string,
  limit = ACCUMULATED_TEXT_LIMIT,
): { accepted: string; accumulated: string; truncated: boolean } {
  const remaining = Math.max(0, limit - current.length);
  if (addition.length <= remaining) {
    return {
      accepted: addition,
      accumulated: current + addition,
      truncated: false,
    };
  }
  const prefixLimit = Math.max(0, remaining - STREAM_TRUNCATION_MARKER.length);
  const prefix = appendBoundedPrefix("", addition, prefixLimit);
  const marker = STREAM_TRUNCATION_MARKER.slice(
    0,
    Math.max(0, remaining - prefix.length),
  );
  const accepted = prefix + marker;
  return {
    accepted,
    accumulated: current + accepted,
    truncated: true,
  };
}

export function* utf8DeltaChunks(
  value: string,
  maximumBytes = DELTA_CHUNK_BYTES,
): Generator<string> {
  if (!Number.isInteger(maximumBytes) || maximumBytes < 4) {
    throw new Error("maximumBytes must be an integer of at least 4");
  }
  let chunk = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (chunk && bytes + characterBytes > maximumBytes) {
      yield chunk;
      chunk = "";
      bytes = 0;
    }
    chunk += character;
    bytes += characterBytes;
  }
  if (chunk) yield chunk;
}

export function loadConfiguration(
  environment: Record<string, string | undefined> = process.env,
): BridgeConfiguration {
  const boardUrl = (environment.AI_TASK_BOARD_URL?.trim() ?? "").replace(
    /\/+$/,
    "",
  );
  const connectionToken =
    environment.AI_TASK_BOARD_CONNECTION_TOKEN?.trim() ?? "";
  for (const [name, value] of [
    ["AI_TASK_BOARD_URL", boardUrl],
    ["AI_TASK_BOARD_CONNECTION_TOKEN", connectionToken],
  ]) {
    if (!value) throw new Error(`${name} is required`);
  }

  const localMaxThreads = boundedInteger(
    environment.CODEX_MAX_THREADS,
    50,
    1,
    500,
  );
  const localMaxConcurrentTurns = boundedInteger(
    environment.CODEX_MAX_CONCURRENT_TURNS,
    2,
    1,
    32,
  );
  const localMaxHistoryTurns = boundedInteger(
    environment.CODEX_BRIDGE_MAX_HISTORY_TURNS,
    50,
    1,
    200,
  );
  const localIncludeThreadTitles = parseBoolean(
    environment.CODEX_BRIDGE_INCLUDE_THREAD_TITLES,
  );
  const configurationPollIntervalMs = boundedInteger(
    environment.AI_TASK_BOARD_CONFIG_POLL_INTERVAL_MS,
    10_000,
    1_000,
    10 * 60_000,
  );

  return {
    boardUrl,
    connectionToken,
    threadIdFilter: environment.CODEX_THREAD_ID?.trim() || null,
    workingDirectory: path.resolve(
      environment.CODEX_WORKING_DIRECTORY?.trim() || process.cwd(),
    ),
    sessionNamePrefix: environment.CODEX_SESSION_NAME?.trim() || null,
    model: environment.CODEX_MODEL?.trim() || null,
    capabilities: parseList(
      environment.CODEX_CAPABILITIES ||
        "coding,shell,file-edit,multi-thread,app-server",
    ),
    pollIntervalMs: boundedInteger(
      environment.AI_TASK_BOARD_POLL_INTERVAL_MS,
      5_000,
      500,
      60_000,
    ),
    leaseSeconds: boundedInteger(
      environment.AI_TASK_BOARD_LEASE_SECONDS,
      900,
      60,
      3_600,
    ),
    maxThreads: localMaxThreads,
    maxConcurrentTurns: localMaxConcurrentTurns,
    syncIntervalMs: boundedInteger(
      environment.AI_TASK_BOARD_THREAD_SYNC_INTERVAL_MS,
      60_000,
      10_000,
      10 * 60_000,
    ),
    configurationPollIntervalMs,
    configurationLeaseSeconds: Math.max(
      15,
      Math.ceil(Math.min(configurationPollIntervalMs, 10_000) / 1_000) * 3,
    ),
    approvalMode: parseApprovalMode(environment.CODEX_BRIDGE_APPROVAL_MODE),
    permissionMode: parsePermissionMode(
      environment.CODEX_BRIDGE_PERMISSION_MODE,
    ),
    threadScope: parseThreadScope(environment.CODEX_THREAD_SCOPE),
    enabled: true,
    includeThreadTitles: localIncludeThreadTitles,
    syncHistory: false,
    historyTurnLimit: localMaxHistoryTurns,
    localIncludeThreadTitles,
    allowRemoteThreadTitles:
      localIncludeThreadTitles ||
      parseBoolean(environment.CODEX_BRIDGE_ALLOW_REMOTE_THREAD_TITLES),
    allowHistorySync: parseBoolean(
      environment.CODEX_BRIDGE_ALLOW_HISTORY_SYNC,
    ),
    localMaxThreads,
    localMaxConcurrentTurns,
    localMaxHistoryTurns,
    webConfigurationEnabled: parseBoolean(
      environment.CODEX_BRIDGE_WEB_CONFIG,
    ),
    codexBinary: environment.CODEX_BINARY?.trim() || "codex",
  };
}

export function effectiveBridgeConfiguration(
  configuration: BridgeConfiguration,
): EffectiveBridgeConfiguration {
  return {
    enabled: configuration.enabled,
    includeThreadTitles: configuration.includeThreadTitles,
    maxThreads: configuration.maxThreads,
    maxConcurrentTurns: configuration.maxConcurrentTurns,
    syncHistory: configuration.syncHistory,
    historyTurnLimit: configuration.historyTurnLimit,
  };
}

export function bridgeConfigurationConstraints(
  configuration: BridgeConfiguration,
): RemoteBridgeConfigurationConstraints {
  return {
    remote_configuration_enabled: configuration.webConfigurationEnabled,
    allow_thread_titles: configuration.allowRemoteThreadTitles,
    allow_history_sync: configuration.allowHistorySync,
    max_threads: configuration.localMaxThreads,
    max_concurrent_turns: configuration.localMaxConcurrentTurns,
    max_history_turns: configuration.localMaxHistoryTurns,
    thread_scope: configuration.threadScope,
    working_directory: configuration.workingDirectory,
    fixed_thread: configuration.threadIdFilter !== null,
    permission_mode: configuration.permissionMode,
    approval_mode: configuration.approvalMode,
  };
}

function clampedRemoteInteger(
  value: number,
  maximum: number,
  field: string,
  warnings: string[],
): number {
  if (!Number.isInteger(value)) {
    throw new Error(`看板配置 ${field} 必须是整数`);
  }
  const clamped = Math.min(maximum, Math.max(1, value));
  if (clamped !== value) {
    warnings.push(
      `${field}=${value} 超出设备允许范围，已限制为 ${clamped}`,
    );
  }
  return clamped;
}

export function resolveRemoteConfiguration(
  configuration: BridgeConfiguration,
  desired: RemoteBridgeConfigurationDesired,
): ResolvedRemoteConfiguration {
  if (typeof desired.enabled !== "boolean") {
    throw new Error("看板配置 enabled 必须是布尔值");
  }
  if (typeof desired.include_thread_titles !== "boolean") {
    throw new Error("看板配置 include_thread_titles 必须是布尔值");
  }
  const warnings: string[] = [];
  const includeThreadTitles =
    desired.include_thread_titles && configuration.allowRemoteThreadTitles;
  if (desired.include_thread_titles && !includeThreadTitles) {
    warnings.push(
      "看板请求上传 thread 标题，但设备未启用 CODEX_BRIDGE_ALLOW_REMOTE_THREAD_TITLES",
    );
  }
  if (
    desired.sync_history !== undefined &&
    typeof desired.sync_history !== "boolean"
  ) {
    throw new Error("看板配置 sync_history 必须是布尔值");
  }
  if (
    desired.history_turn_limit !== undefined &&
    !Number.isInteger(desired.history_turn_limit)
  ) {
    throw new Error("看板配置 history_turn_limit 必须是整数");
  }
  const syncHistory =
    desired.sync_history === true && configuration.allowHistorySync;
  if (desired.sync_history === true && !syncHistory) {
    warnings.push(
      "看板请求同步历史，但设备未启用 CODEX_BRIDGE_ALLOW_HISTORY_SYNC",
    );
  }
  return {
    effective: {
      enabled: desired.enabled,
      includeThreadTitles,
      maxThreads: clampedRemoteInteger(
        desired.max_threads,
        configuration.localMaxThreads,
        "max_threads",
        warnings,
      ),
      maxConcurrentTurns: clampedRemoteInteger(
        desired.max_concurrent_turns,
        configuration.localMaxConcurrentTurns,
        "max_concurrent_turns",
        warnings,
      ),
      syncHistory,
      historyTurnLimit: clampedRemoteInteger(
        desired.history_turn_limit ?? Math.min(50, configuration.localMaxHistoryTurns),
        configuration.localMaxHistoryTurns,
        "history_turn_limit",
        warnings,
      ),
    },
    warnings,
  };
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function idempotencyKey(operation: string): string {
  return `codex-bridge/${operation}/${randomUUID()}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorStatus(error: unknown): number | undefined {
  return (error as { status?: number } | null)?.status;
}

function monotonicMilliseconds(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

function isPersistentClientError(error: unknown): boolean {
  const status = errorStatus(error);
  return status !== undefined &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429;
}

class WorkerRetirementDeferredError extends Error {}
class WorkerRetirementFailureError extends Error {}

export async function stopWorkersForRetirement(
  workers: Array<{
    threadId: string;
    worker: { stop: (reason: string) => Promise<void> };
  }>,
  reason: string,
): Promise<void> {
  const stopped = await Promise.allSettled(
    workers.map(({ worker }) => worker.stop(reason)),
  );
  const failedStops = stopped.flatMap((result, index) =>
    result.status === "rejected"
      ? [{ threadId: workers[index]?.threadId ?? "unknown", reason: result.reason }]
      : [],
  );
  for (const failure of failedStops) {
    process.stderr.write(
      `Thread worker ${failure.threadId} 停止时出错：${errorMessage(failure.reason)}\n`,
    );
  }
  if (failedStops.length > 0) {
    throw new WorkerRetirementFailureError(
      `${failedStops.length} 个已移除 thread worker 未能安全停止；保留本地映射并终止 Bridge`,
      { cause: failedStops[0]?.reason },
    );
  }
}

function actionableBoardError(error: unknown): Error {
  const status = errorStatus(error);
  const detail = redactHarnessText(errorMessage(error), 2_000);
  if (status === 401 || status === 403) {
    return new Error(
      `看板认证失败（HTTP ${status}）：请检查 AI_TASK_BOARD_CONNECTION_TOKEN 及连接权限。${detail ? ` ${detail}` : ""}`,
      { cause: error },
    );
  }
  if (status === 404) {
    return new Error(
      `看板缺少 Bridge 0.4 API（HTTP 404）：请先升级 Board schema/API，再启动 Bridge。${detail ? ` ${detail}` : ""}`,
      { cause: error },
    );
  }
  if (status === 409) {
    return new Error(
      `Bridge 运行实例冲突（HTTP 409）：同一设备连接已有另一个 Bridge 持有配置租约，请只保留一个进程。${detail ? ` ${detail}` : ""}`,
      { cause: error },
    );
  }
  return new Error(
    `看板拒绝 Bridge 请求（HTTP ${status ?? "unknown"}）：请检查 Board API、连接权限与版本。${detail ? ` ${detail}` : ""}`,
    { cause: error },
  );
}

function remoteDesiredFromEffective(
  effective: EffectiveBridgeConfiguration,
): RemoteBridgeConfigurationDesired {
  return {
    enabled: effective.enabled,
    include_thread_titles: effective.includeThreadTitles,
    max_threads: effective.maxThreads,
    max_concurrent_turns: effective.maxConcurrentTurns,
    sync_history: effective.syncHistory,
    history_turn_limit: effective.historyTurnLimit,
  };
}

function parseRemoteConfigurationResponse(
  value: unknown,
): RemoteConfigurationResponse {
  if (!isRecord(value) || !isRecord(value.configuration)) {
    throw new Error("看板配置响应缺少 configuration");
  }
  const configuration = value.configuration;
  if (
    !Number.isInteger(configuration.version) ||
    (configuration.version as number) < 1
  ) {
    throw new Error("看板配置响应 version 无效");
  }
  if (!isRecord(configuration.desired)) {
    throw new Error("看板配置响应缺少 desired");
  }
  const desired = configuration.desired;
  return {
    configuration: {
      connection_id: stringValue(configuration.connection_id) ?? "",
      version: configuration.version as number,
      desired: {
        enabled: desired.enabled as boolean,
        include_thread_titles: desired.include_thread_titles as boolean,
        max_threads: desired.max_threads as number,
        max_concurrent_turns: desired.max_concurrent_turns as number,
        sync_history:
          desired.sync_history === undefined
            ? false
            : (desired.sync_history as boolean),
        history_turn_limit:
          desired.history_turn_limit === undefined
            ? 50
            : (desired.history_turn_limit as number),
      },
      applied: configuration.applied,
      updated_at: stringValue(configuration.updated_at) ?? "",
    },
  };
}

function threadIdFromMessage(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return stringValue(value.threadId) ?? stringValue(value.conversationId);
}

function notificationTurnId(params: Record<string, unknown>): string | null {
  const turn = isRecord(params.turn) ? params.turn : null;
  return stringValue(params.turnId) ?? (turn ? stringValue(turn.id) : null);
}

function threadCwd(thread: ThreadRecord): string | null {
  return stringValue(thread.cwd);
}

export function isExactWorkingDirectory(
  candidate: string,
  configured: string,
): boolean {
  return path.relative(path.resolve(configured), path.resolve(candidate)) === "";
}

function shortThreadTitle(thread: ThreadRecord): string {
  const explicit = stringValue(thread.name);
  const preview = stringValue(thread.preview)?.split(/\r?\n/, 1)[0]?.trim();
  const cwd = threadCwd(thread);
  return (explicit || preview || (cwd ? path.basename(cwd) : null) || thread.id)
    .replace(/\s+/g, " ")
    .slice(0, 120);
}

function privateThreadTitle(thread: ThreadRecord): string {
  const cwd = threadCwd(thread);
  const project = cwd ? path.basename(path.resolve(cwd)) : "thread";
  return `${project || "thread"} · ${thread.id.slice(0, 8)}`;
}

function sessionName(
  thread: ThreadRecord,
  configuration: BridgeConfiguration,
): string {
  const title = configuration.includeThreadTitles
    ? shortThreadTitle(thread)
    : privateThreadTitle(thread);
  if (configuration.sessionNamePrefix) {
    return (configuration.threadIdFilter
      ? configuration.sessionNamePrefix
      : `${configuration.sessionNamePrefix} · ${title}`
    ).slice(0, 200);
  }
  return `Codex · ${title}`.slice(0, 200);
}

function inventoryThread(
  thread: ThreadRecord,
  configuration: BridgeConfiguration,
): InventoryThread {
  return {
    external_conversation_ref: thread.id,
    name: sessionName(thread, configuration),
    platform: "codex",
    model: stringValue(thread.model) ?? configuration.model,
    working_directory: threadCwd(thread),
    capabilities: configuration.capabilities,
    archived: false,
  };
}

class BoardClient {
  constructor(
    private readonly configuration: BridgeConfiguration,
    private readonly isStopping: () => boolean,
  ) {}

  async request<T>(
    pathname: string,
    options: BoardRequestOptions = {},
  ): Promise<T> {
    const method = options.method ?? "GET";
    const maxAttempts = options.maxAttempts ?? Number.POSITIVE_INFINITY;
    if (!Number.isInteger(maxAttempts) && maxAttempts !== Number.POSITIVE_INFINITY) {
      throw new Error("maxAttempts must be a positive integer");
    }
    if (maxAttempts < 1) throw new Error("maxAttempts must be at least 1");
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (options.signal?.aborted) throw options.signal.reason;
      if (attempt > 1 && this.isStopping()) throw lastError;
      const requestController = new AbortController();
      const timeoutMs = options.timeoutMs ?? 30_000;
      const timeout = setTimeout(
        () => requestController.abort(new Error("Board request timed out")),
        timeoutMs,
      );
      const abortRequest = () => requestController.abort(options.signal?.reason);
      options.signal?.addEventListener("abort", abortRequest, { once: true });
      try {
        const response = await fetch(
          `${this.configuration.boardUrl}${pathname}`,
          {
            method,
            signal: requestController.signal,
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
          const message = payload?.error?.message || `HTTP ${response.status}`;
          const error = new Error(message) as Error & {
            status?: number;
            code?: string;
          };
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
        options.signal?.removeEventListener("abort", abortRequest);
      }
    }
    throw lastError;
  }

  async syncSessions(
    threads: ThreadRecord[],
    signal?: AbortSignal,
  ): Promise<Map<string, Session>> {
    const body = {
      bridge_version: BRIDGE_VERSION,
      threads: threads.map((thread) =>
        inventoryThread(thread, this.configuration),
      ),
    };
    const result = await this.request<SyncSessionsResponse>(
      "/api/ai/sessions/sync",
      {
        method: "POST",
        idempotencyKey: idempotencyKey("sync-sessions"),
        maxAttempts: 1,
        signal,
        body,
      },
    );
    return new Map(
      result.sessions.flatMap((session) =>
        session.external_conversation_ref
          ? [[session.external_conversation_ref, session] as const]
          : [],
      ),
    );
  }

  async exchangeConfiguration(
    status: RemoteConfigurationStatus,
    signal?: AbortSignal,
    timeoutMs = 5_000,
  ): Promise<RemoteConfigurationResponse> {
    const result = await this.request<unknown>("/api/ai/config", {
      method: "POST",
      maxAttempts: 1,
      timeoutMs,
      signal,
      body: status,
    });
    return parseRemoteConfigurationResponse(result);
  }

  async importHistory(
    sessionId: string,
    body: HistoryImportRequest,
    signal: AbortSignal,
  ): Promise<HistoryImportResponse> {
    return this.request<HistoryImportResponse>("/api/ai/sessions/history", {
      method: "POST",
      sessionId,
      idempotencyKey: idempotencyKey("sync-history"),
      maxAttempts: 1,
      timeoutMs: 15_000,
      signal,
      body,
    });
  }
}

export class TurnLimiter {
  private active = 0;
  private readonly waiters: Array<{
    resolve: (release: () => void) => void;
    reject: (error: unknown) => void;
    signal: AbortSignal;
  }> = [];

  constructor(private limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("TurnLimiter limit must be a positive integer");
    }
  }

  get capacity(): number {
    return this.limit;
  }

  resize(limit: number): void {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("TurnLimiter limit must be a positive integer");
    }
    this.limit = limit;
    this.drain();
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.releaseFunction());
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        signal.removeEventListener("abort", onAbort);
        reject(signal.reason);
      };
      const waiter = {
        resolve: (release: () => void) => {
          signal.removeEventListener("abort", onAbort);
          resolve(release);
        },
        reject,
        signal,
      };
      this.waiters.push(waiter);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private releaseFunction(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.drain();
    };
  }

  private drain(): void {
    while (this.active < this.limit && this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter || waiter.signal.aborted) continue;
      this.active += 1;
      waiter.resolve(this.releaseFunction());
    }
  }
}

function protocolData(
  phase: "started" | "delta" | "completed",
  turnId: string,
  itemId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    protocol: APP_SERVER_PROTOCOL,
    phase,
    turn_ref: turnId,
    item_ref: itemId,
    ...extra,
  };
}

function itemId(item: Record<string, unknown>): string | null {
  return stringValue(item.id);
}

export function completedItemActivity(
  item: Record<string, unknown>,
  turnId: string,
  bufferedText: string | null,
): Activity | null {
  const id = itemId(item);
  if (!id) return null;
  switch (item.type) {
    case "userMessage":
    case "hookPrompt":
      return null;
    case "agentMessage": {
      const text =
        stringValue(item.text) ??
        (bufferedText && bufferedText.length > 0 ? bufferedText : null) ??
        "（AI 未返回文本）";
      return {
        kind: "assistant_message",
        content: redactHarnessText(text, 100_000),
        data: protocolData("completed", turnId, id, {
          phase_name: item.phase ?? null,
        }),
      };
    }
    case "reasoning": {
      const summary = Array.isArray(item.summary)
        ? item.summary.filter((part): part is string => typeof part === "string").join("\n\n")
        : "";
      return {
        kind: "reasoning",
        content: redactHarnessText(
          summary.trim() ||
            (bufferedText && bufferedText.length > 0 ? bufferedText : null) ||
            "（无可展示的思考摘要）",
          100_000,
        ),
        data: protocolData("completed", turnId, id, {
          disclosure: "provider_summary",
        }),
      };
    }
    case "plan":
      return {
        kind: "plan",
        content: redactHarnessText(
          stringValue(item.text) || "计划已更新",
          100_000,
        ),
        data: protocolData("completed", turnId, id),
      };
    case "commandExecution":
      {
        const completedOutput =
          typeof item.aggregatedOutput === "string" && item.aggregatedOutput.length > 0
            ? item.aggregatedOutput
            : bufferedText;
      return {
        kind: "command",
        content: redactHarnessText(stringValue(item.command) || "命令执行", 100_000),
        data: protocolData(
          "completed",
          turnId,
          id,
          sanitizeHarnessValue({
            cwd: item.cwd,
            source: item.source,
            status: item.status,
            exit_code: item.exitCode,
            duration_ms: item.durationMs,
            output: completedOutput,
          }) as Record<string, unknown>,
        ),
      };
      }
    case "fileChange":
      return {
        kind: "file_change",
        content: `文件变更 ${Array.isArray(item.changes) ? item.changes.length : 0} 项`,
        data: protocolData(
          "completed",
          turnId,
          id,
          sanitizeHarnessValue({ changes: item.changes, status: item.status }) as Record<
            string,
            unknown
          >,
        ),
      };
    case "mcpToolCall":
      return {
        kind: "mcp_tool",
        content: `${stringValue(item.server) || "MCP"} · ${stringValue(item.tool) || "tool"}`,
        data: protocolData(
          "completed",
          turnId,
          id,
          sanitizeHarnessValue({
            status: item.status,
            arguments: item.arguments,
            result: item.result,
            error: item.error,
            duration_ms: item.durationMs,
          }) as Record<string, unknown>,
        ),
      };
    case "dynamicToolCall":
    case "collabAgentToolCall":
    case "subAgentActivity":
      return {
        kind: "mcp_tool",
        content: redactHarnessText(
          stringValue(item.tool) || stringValue(item.kind) || String(item.type),
          100_000,
        ),
        data: protocolData(
          "completed",
          turnId,
          id,
          sanitizeHarnessValue(item) as Record<string, unknown>,
        ),
      };
    case "webSearch":
      return {
        kind: "web_search",
        content: redactHarnessText(
          stringValue(item.query) || stringValue(item.action) || "网页搜索",
          100_000,
        ),
        data: protocolData("completed", turnId, id),
      };
    case "imageView":
    case "imageGeneration":
      return {
        kind: "status",
        content: item.type === "imageView" ? "已查看图片" : "已生成图片",
        data: protocolData(
          "completed",
          turnId,
          id,
          sanitizeHarnessValue(item) as Record<string, unknown>,
        ),
      };
    case "enteredReviewMode":
    case "exitedReviewMode":
    case "contextCompaction":
    case "sleep":
      return {
        kind: "status",
        content: redactHarnessText(
          stringValue(item.review) || String(item.type),
          100_000,
        ),
        data: protocolData("completed", turnId, id),
      };
    default:
      return null;
  }
}

export function startedItemActivity(
  item: Record<string, unknown>,
  turnId: string,
): Activity | null {
  const id = itemId(item);
  if (!id) return null;
  switch (item.type) {
    case "commandExecution":
      return {
        kind: "command",
        content: redactHarnessText(stringValue(item.command) || "正在执行命令"),
        data: protocolData("started", turnId, id, {
          cwd: sanitizeHarnessValue(item.cwd),
          status: item.status,
        }),
      };
    case "fileChange":
      return {
        kind: "file_change",
        content: "正在应用文件变更",
        data: protocolData("started", turnId, id),
      };
    case "mcpToolCall":
    case "dynamicToolCall":
    case "collabAgentToolCall":
      return {
        kind: "mcp_tool",
        content: redactHarnessText(
          [stringValue(item.server), stringValue(item.tool)].filter(Boolean).join(" · ") ||
            "正在调用工具",
        ),
        data: protocolData("started", turnId, id),
      };
    case "webSearch":
      return {
        kind: "web_search",
        content: redactHarnessText(stringValue(item.query) || "正在搜索网页"),
        data: protocolData("started", turnId, id),
      };
    default:
      return null;
  }
}

class SessionWorker {
  private readonly stopController = new AbortController();
  private readonly wakeLatch = new WakeLatch();
  private stopping = false;
  private activeClaim: ClaimedTask | null = null;
  private activeTurnId: string | null = null;
  private lastAssistantMessage = "";
  private realtimeAvailable = false;
  private consecutiveEmptyClaims = 0;
  private eventChain: Promise<void> = Promise.resolve();
  private activityChain: Promise<void> = Promise.resolve();
  private eventError: Error | null = null;
  private queueOverflowError: Error | null = null;
  private notificationBacklog = 0;
  private activityBacklog = 0;
  private readonly turnResults = new Map<string, TurnResult>();
  private readonly turnWaiters = new Map<
    string,
    {
      resolve: (turn: TurnResult) => void;
      reject: (error: unknown) => void;
      cleanup: () => void;
    }
  >();
  private readonly buffers = new Map<string, ActivityBuffer>();
  private readonly preStartNotifications: AppServerNotification[] = [];
  private readonly backgroundBoardOperations = new Set<Promise<void>>();
  private readonly retirementWaiters = new Set<() => void>();
  private awaitingTurnStart = false;
  private mutatingRequestCount = 0;
  private heartbeatInFlightPromise: Promise<void> | null = null;
  private usageSequence = 0;
  private runPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;

  constructor(
    readonly thread: ThreadRecord,
    readonly session: Session,
    private readonly configuration: BridgeConfiguration,
    private readonly board: BoardClient,
    private readonly appServer: CodexAppServerClient,
    private readonly limiter: TurnLimiter,
    private readonly onFatal: (error: Error) => void,
  ) {}

  start(): Promise<void> {
    if (!this.runPromise) this.runPromise = this.run();
    return this.runPromise;
  }

  get retirementBlocked(): boolean {
    return this.mutatingRequestCount > 0;
  }

  async waitForRetirementReady(milliseconds: number): Promise<boolean> {
    if (!this.retirementBlocked) return true;
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
      this.retirementWaiters.add(resolve);
    });
    try {
      return await Promise.race([
        ready.then(() => true),
        delay(milliseconds).then(() => false),
      ]);
    } finally {
      this.retirementWaiters.delete(resolveReady);
    }
  }

  enqueueNotification(notification: AppServerNotification): void {
    if (this.stopping) return;
    const params = isRecord(notification.params) ? notification.params : null;
    if (!params || threadIdFromMessage(params) !== this.thread.id) return;
    const turnId = notificationTurnId(params);
    if (!turnId) return;
    if (this.awaitingTurnStart && !this.activeTurnId) {
      if (this.preStartNotifications.length >= 500) {
        this.preStartNotifications.shift();
      }
      this.preStartNotifications.push(notification);
      return;
    }
    if (!this.activeTurnId || turnId !== this.activeTurnId) return;
    if (this.consumeStreamDelta(notification, params, turnId)) return;
    this.queueNotification(notification);
  }

  private queueNotification(notification: AppServerNotification): void {
    if (this.queueOverflowError) return;
    if (this.notificationBacklog >= MAX_NOTIFICATION_BACKLOG) {
      this.failForQueueOverflow("App Server notification");
      return;
    }
    this.notificationBacklog += 1;
    const queued = this.eventChain.then(() =>
      this.handleNotification(notification),
    );
    this.eventChain = queued
      .catch((error) => {
        this.eventError ??= error instanceof Error ? error : new Error(String(error));
        process.stderr.write(
          `Thread ${this.thread.id} 事件处理失败：${errorMessage(error)}\n`,
        );
      })
      .finally(() => {
        this.notificationBacklog = Math.max(
          0,
          this.notificationBacklog - 1,
        );
      });
  }

  private consumeStreamDelta(
    notification: AppServerNotification,
    params: Record<string, unknown>,
    turnId: string,
  ): boolean {
    let kind: ActivityBuffer["kind"] | null = null;
    switch (notification.method) {
      case "item/agentMessage/delta":
        kind = "assistant_message";
        break;
      case "item/reasoning/summaryTextDelta":
        kind = "reasoning";
        break;
      case "item/commandExecution/outputDelta":
        kind = "command";
        break;
      default:
        return false;
    }
    this.appendDelta(
      turnId,
      stringValue(params.itemId),
      kind,
      typeof params.delta === "string" ? params.delta : "",
    );
    return true;
  }

  private failForQueueOverflow(queueName: string): Error {
    if (this.queueOverflowError) return this.queueOverflowError;
    const error = new Error(
      `${queueName} backlog exceeded its safety limit for thread ${this.thread.id}`,
    );
    this.queueOverflowError = error;
    this.eventError ??= error;
    process.stderr.write(`${error.message}；正在中断本轮并重启 Bridge\n`);
    this.onFatal(error);
    return error;
  }

  async handleServerRequest(request: AppServerIncomingRequest): Promise<unknown> {
    const params = isRecord(request.params) ? request.params : {};
    const requestTurnId = notificationTurnId(params);
    const correlatedActiveTurn = Boolean(
      this.activeClaim &&
        this.activeTurnId &&
        requestTurnId === this.activeTurnId,
    );
    if (this.activeClaim) {
      this.trackBackgroundBoardOperation(
        this.reportActivity(
          `request:${String(request.id)}`,
          {
          kind: "status",
          content:
            this.configuration.approvalMode === "decline"
              ? "Codex 请求本地审批；Bridge 已按安全默认值拒绝"
              : "Codex 请求本地审批；Bridge 已按设备策略处理",
          data: {
            protocol: APP_SERVER_PROTOCOL,
            phase: "completed",
            request_method: request.method,
            request_id: String(request.id),
            approval_mode: this.configuration.approvalMode,
            correlated_active_turn: correlatedActiveTurn,
            request: sanitizeHarnessValue(params),
          },
        },
          { maxAttempts: 1 },
        ),
        `审批审计 ${request.method}`,
      );
    }

    const sessionDecision =
      this.configuration.approvalMode === "accept-session";
    const accepts =
      this.configuration.approvalMode !== "decline" && correlatedActiveTurn;
    switch (request.method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        return {
          decision: accepts
            ? sessionDecision
              ? "acceptForSession"
              : "accept"
            : "decline",
        };
      case "execCommandApproval":
      case "applyPatchApproval":
        return {
          decision: accepts
            ? sessionDecision
              ? "approved_for_session"
              : "approved"
            : { denied: { rejection: "Web Bridge approval is not enabled" } },
        };
      case "item/tool/requestUserInput":
        return { answers: {} };
      case "mcpServer/elicitation/request":
        return { action: "decline", content: null, _meta: null };
      case "item/permissions/requestApproval": {
        if (!accepts) throw new Error("Permission request declined by Bridge policy");
        const requested = isRecord(params.permissions) ? params.permissions : {};
        return {
          permissions: Object.fromEntries(
            Object.entries(requested).filter(([, value]) => value !== null),
          ),
          scope: sessionDecision ? "session" : "turn",
        };
      }
      case "currentTime/read":
        return { currentTimeAt: Math.floor(Date.now() / 1_000) };
      default:
        throw new Error(`Unsupported App Server request: ${request.method}`);
    }
  }

  async stop(reason = "Codex Bridge 已停止"): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const attempt = this.stopWorker(reason);
    this.stopPromise = attempt;
    try {
      await attempt;
    } catch (error) {
      if (this.stopPromise === attempt) this.stopPromise = null;
      throw error;
    }
  }

  private async stopWorker(reason: string): Promise<void> {
    this.stopping = true;
    this.stopController.abort(new Error(reason));
    this.wakeLatch.wake();
    for (const waiter of this.turnWaiters.values()) {
      waiter.cleanup();
      waiter.reject(new Error(reason));
    }
    this.turnWaiters.clear();
    for (const buffer of this.buffers.values()) {
      if (buffer.timer) clearTimeout(buffer.timer);
    }
    if (this.activeTurnId) {
      await this.appServer
        .turnInterrupt(
          { threadId: this.thread.id, turnId: this.activeTurnId },
          { timeoutMs: 5_000 },
        )
        .catch(() => undefined);
    }
    await (this.runPromise ?? Promise.resolve());
  }

  private async run(): Promise<void> {
    let wakeListener: Promise<void> = Promise.resolve();
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    try {
      await this.heartbeatSession();
      if (this.stopping) return;
      wakeListener = runSessionWakeListener({
        endpoint: `${this.configuration.boardUrl}/api/ai/sessions/wake`,
        connectionToken: this.configuration.connectionToken,
        sessionId: this.session.id,
        signal: this.stopController.signal,
        onWake: () => {
          this.consecutiveEmptyClaims = 0;
          this.wakeLatch.wake();
        },
        onAvailabilityChange: (available) => {
          this.realtimeAvailable = available;
          this.consecutiveEmptyClaims = 0;
          this.wakeLatch.wake();
        },
        log: (message) => process.stderr.write(`${message}\n`),
      }).catch((error) => {
        if (!this.stopping) {
          process.stderr.write(
            `Thread ${this.thread.id} 实时唤醒失败，继续轮询：${errorMessage(error)}\n`,
          );
        }
      });

      heartbeatTimer = setInterval(() => {
        if (this.heartbeatInFlightPromise || this.stopping) return;
        const heartbeat = Promise.resolve(
          this.activeClaim
            ? this.heartbeatClaim(this.activeClaim)
            : this.heartbeatSession(),
        )
          .then(() => undefined)
          .catch((error) => {
            if (!this.stopping) {
              process.stderr.write(
                `Thread ${this.thread.id} 心跳失败：${errorMessage(error)}\n`,
              );
            }
          })
          .finally(() => {
            if (this.heartbeatInFlightPromise === heartbeat) {
              this.heartbeatInFlightPromise = null;
            }
          });
        this.heartbeatInFlightPromise = heartbeat;
      }, 45_000);

      while (!this.stopping) await this.runOneIteration();
    } catch (error) {
      if (!this.stopping) throw error;
    } finally {
      this.stopController.abort();
      this.wakeLatch.wake();
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      for (const buffer of this.buffers.values()) {
        if (buffer.timer) clearTimeout(buffer.timer);
      }
      await Promise.allSettled([
        wakeListener,
        this.heartbeatInFlightPromise ?? Promise.resolve(),
      ]);
      await this.eventChain.catch(() => undefined);
      await this.activityChain.catch(() => undefined);
      await this.waitForBackgroundBoardOperations();
      await this.releaseActiveTask("Codex Bridge 已停止");
    }
  }

  private async runOneIteration(): Promise<void> {
    let releasePermit: (() => void) | null = null;
    try {
      releasePermit = await this.limiter.acquire(this.stopController.signal);
      let response: ClaimResponse;
      try {
        response = await this.board.request<ClaimResponse>(
          "/api/ai/tasks/claim-next",
          {
            method: "POST",
            sessionId: this.session.id,
            idempotencyKey: idempotencyKey("claim-next"),
            signal: this.stopController.signal,
            body: { lease_seconds: this.configuration.leaseSeconds },
          },
        );
      } catch (error) {
        if (!isSessionActiveClaimConflict(error)) throw error;
        releasePermit();
        releasePermit = null;
        await this.wakeLatch.wait(
          Math.max(10_000, this.configuration.pollIntervalMs),
          this.stopController.signal,
        );
        return;
      }

      const action = nextClaimAction({
        hasTask: response.task !== null,
        stopping: this.stopping,
      });
      if (action === "stop") {
        if (response.task) {
          this.activeClaim = response.task;
          await this.releaseActiveTask("Codex Bridge 正在停止");
        }
        return;
      }
      if (action === "idle" || !response.task) {
        releasePermit();
        releasePermit = null;
        const waitMs = adaptiveIdlePollDelay({
          baseIntervalMs: this.configuration.pollIntervalMs,
          emptyPolls: this.consecutiveEmptyClaims,
          realtimeAvailable: this.realtimeAvailable,
        });
        this.consecutiveEmptyClaims += 1;
        await this.wakeLatch.wait(waitMs, this.stopController.signal);
        return;
      }

      this.consecutiveEmptyClaims = 0;
      this.activeClaim = response.task;
      process.stdout.write(
        `开始任务 [${shortThreadTitle(this.thread)}]：${response.task.title}\n`,
      );
      try {
        await this.executeTask(response.task);
        process.stdout.write(
          `完成任务 [${shortThreadTitle(this.thread)}]：${response.task.title}\n`,
        );
      } catch (error) {
        if (this.stopping) {
          await this.releaseActiveTask("Codex Bridge 正在停止");
        } else {
          const reason = redactHarnessText(errorMessage(error), 10_000);
          await this.board
            .request("/api/ai/tasks/fail", {
              method: "POST",
              sessionId: this.session.id,
              idempotencyKey: idempotencyKey("fail"),
              signal: this.stopController.signal,
              body: {
                task_id: response.task.id,
                claim_token: response.task.claim_token,
                reason,
                result_json: null,
              },
            })
            .catch(() => undefined);
          process.stderr.write(`任务失败 [${this.thread.id}]：${reason}\n`);
        }
      } finally {
        this.activeClaim = null;
        this.activeTurnId = null;
        this.lastAssistantMessage = "";
        this.eventError = null;
        this.turnResults.clear();
        this.preStartNotifications.length = 0;
        this.awaitingTurnStart = false;
        this.buffers.clear();
      }
    } finally {
      releasePermit?.();
    }
  }

  private async executeTask(task: ClaimedTask): Promise<void> {
    if (this.stopping) throw new Error("Codex Bridge 正在停止");
    await this.board.request("/api/ai/tasks/report-progress", {
      method: "POST",
      sessionId: this.session.id,
      idempotencyKey: idempotencyKey("started"),
      signal: this.stopController.signal,
      body: {
        task_id: task.id,
        claim_token: task.claim_token,
        progress_note: "Codex App Server 已接收任务，正在执行",
        progress_percent_estimate: 5,
      },
    });
    if (this.stopping) throw new Error("Codex Bridge 正在停止");

    const workspaceRoot = path.resolve(
      threadCwd(this.thread) ?? this.configuration.workingDirectory,
    );
    await this.trackMutatingRequest(
      this.appServer.threadResume(
        {
        threadId: this.thread.id,
        excludeTurns: true,
        ...(this.configuration.permissionMode === "safe"
          ? {
              cwd: workspaceRoot,
              approvalPolicy: "on-request",
              approvalsReviewer: "user",
              sandbox: "workspace-write",
            }
          : {}),
        },
        { timeoutMs: 0 },
      ),
    );
    if (this.stopping) throw new Error("Codex Bridge 正在停止");
    const text = [
      task.description?.trim() || task.title,
      task.acceptance_criteria
        ? `\n\n验收条件：\n${task.acceptance_criteria}`
        : "",
    ].join("");
    this.awaitingTurnStart = true;
    this.preStartNotifications.length = 0;
    let started: Awaited<ReturnType<CodexAppServerClient["turnStart"]>>;
    try {
      started = await this.trackMutatingRequest(
        this.appServer.turnStart(
          {
          threadId: this.thread.id,
          clientUserMessageId: task.id,
          input: [{ type: "text", text, text_elements: [] }],
          ...(this.configuration.permissionMode === "safe"
            ? {
                cwd: workspaceRoot,
                approvalPolicy: "on-request",
                approvalsReviewer: "user",
                sandboxPolicy: {
                  type: "workspaceWrite",
                  writableRoots: [workspaceRoot],
                  networkAccess: false,
                  excludeTmpdirEnvVar: true,
                  excludeSlashTmp: true,
                },
              }
            : {}),
          },
          { timeoutMs: 0 },
        ),
      );
    } catch (error) {
      this.awaitingTurnStart = false;
      this.preStartNotifications.length = 0;
      throw error;
    }
    const turnId = stringValue(started.turn.id);
    if (!turnId) throw new Error("Codex App Server 未返回 turn id");
    this.activeTurnId = turnId;
    this.awaitingTurnStart = false;
    const pendingNotifications = this.preStartNotifications.splice(0);
    for (const notification of pendingNotifications) {
      const params = isRecord(notification.params) ? notification.params : null;
      if (params && notificationTurnId(params) === turnId) {
        this.enqueueNotification(notification);
      }
    }
    if (this.stopping || this.stopController.signal.aborted) {
      await this.appServer
        .turnInterrupt(
          { threadId: this.thread.id, turnId },
          { timeoutMs: 5_000 },
        )
        .catch(() => undefined);
      throw this.stopController.signal.reason ?? new Error("Codex Bridge 正在停止");
    }
    const turn = await this.waitForTurn(turnId, this.stopController.signal);
    await this.eventChain;
    await this.flushAllBuffers();
    await this.activityChain;
    if (this.eventError) throw this.eventError;

    const status = stringValue(turn.status);
    if (status !== "completed") {
      const error = isRecord(turn.error)
        ? stringValue(turn.error.message)
        : null;
      throw new Error(error || `Codex turn ${status || "failed"}`);
    }

    await this.board.request("/api/ai/tasks/complete", {
      method: "POST",
      sessionId: this.session.id,
      idempotencyKey: idempotencyKey("complete"),
      signal: this.stopController.signal,
      body: {
        task_id: task.id,
        claim_token: task.claim_token,
        result_summary: redactHarnessText(
          this.lastAssistantMessage || "Codex 已完成本轮任务",
          100_000,
        ),
        result_json: null,
        message: null,
        artifacts: [],
      },
    });
  }

  private waitForTurn(
    turnId: string,
    signal: AbortSignal,
  ): Promise<TurnResult> {
    if (signal.aborted) return Promise.reject(signal.reason);
    const completed = this.turnResults.get(turnId);
    if (completed) {
      this.turnResults.delete(turnId);
      return Promise.resolve(completed);
    }
    return new Promise((resolve, reject) => {
      const cleanup = () => signal.removeEventListener("abort", onAbort);
      const onAbort = () => {
        const waiter = this.turnWaiters.get(turnId);
        if (waiter?.cleanup === cleanup) this.turnWaiters.delete(turnId);
        cleanup();
        reject(signal.reason);
      };
      this.turnWaiters.set(turnId, {
        resolve: (turn) => {
          cleanup();
          resolve(turn);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
        cleanup,
      });
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  private resolveTurn(turn: TurnResult): void {
    if (!this.activeTurnId || turn.id !== this.activeTurnId) return;
    const waiter = this.turnWaiters.get(turn.id);
    if (waiter) {
      this.turnWaiters.delete(turn.id);
      waiter.cleanup();
      waiter.resolve(turn);
    } else {
      this.turnResults.set(turn.id, turn);
    }
  }

  private async handleNotification(
    notification: AppServerNotification,
  ): Promise<void> {
    const params = isRecord(notification.params) ? notification.params : null;
    if (!params || threadIdFromMessage(params) !== this.thread.id) return;
    const turnId = notificationTurnId(params);
    if (!turnId || turnId !== this.activeTurnId) return;

    switch (notification.method) {
      case "item/started": {
        if (!turnId || !isRecord(params.item) || !this.activeClaim) return;
        const activity = startedItemActivity(params.item, turnId);
        const id = itemId(params.item);
        if (activity && id) {
          await this.queueActivity(() =>
            this.reportActivity(
              `turn:${turnId}:item:${id}:started`,
              activity,
            ),
          );
        }
        return;
      }
      case "item/agentMessage/delta":
        if (turnId) {
          this.appendDelta(
            turnId,
            stringValue(params.itemId),
            "assistant_message",
            typeof params.delta === "string" ? params.delta : "",
          );
        }
        return;
      case "item/reasoning/summaryTextDelta":
        if (turnId) {
          this.appendDelta(
            turnId,
            stringValue(params.itemId),
            "reasoning",
            typeof params.delta === "string" ? params.delta : "",
          );
        }
        return;
      case "item/commandExecution/outputDelta":
        if (turnId) {
          this.appendDelta(
            turnId,
            stringValue(params.itemId),
            "command",
            typeof params.delta === "string" ? params.delta : "",
          );
        }
        return;
      case "item/completed": {
        if (!turnId || !isRecord(params.item) || !this.activeClaim) return;
        const id = itemId(params.item);
        if (!id) return;
        await this.flushBuffer(`${turnId}:${id}`);
        const buffer = this.buffers.get(`${turnId}:${id}`);
        const activity = completedItemActivity(
          params.item,
          turnId,
          buffer?.accumulated || null,
        );
        if (params.item.type === "agentMessage") {
          this.lastAssistantMessage =
            stringValue(params.item.text) ||
            stringValue(buffer?.accumulated) ||
            this.lastAssistantMessage;
        }
        if (activity) {
          await this.queueActivity(() =>
            this.reportActivity(
              `turn:${turnId}:item:${id}:completed`,
              activity,
            ),
          );
        }
        this.buffers.delete(`${turnId}:${id}`);
        return;
      }
      case "thread/tokenUsage/updated":
        if (!this.activeClaim) return;
        this.usageSequence += 1;
        await this.queueActivity(() =>
          this.reportActivity(`usage:${this.usageSequence}`, {
            kind: "usage",
            content: null,
            data: {
              protocol: APP_SERVER_PROTOCOL,
              phase: "completed",
              usage: sanitizeHarnessValue(params.tokenUsage ?? params),
            },
          }),
        );
        return;
      case "turn/completed": {
        if (!isRecord(params.turn) || !stringValue(params.turn.id)) return;
        await this.flushAllBuffers();
        await this.activityChain;
        this.resolveTurn(params.turn as TurnResult);
        return;
      }
      case "error": {
        if (!this.activeClaim) return;
        const protocolError = isRecord(params.error) ? params.error : {};
        const codexErrorInfo = isRecord(protocolError.codexErrorInfo)
          ? protocolError.codexErrorInfo
          : null;
        const message =
          stringValue(protocolError.message) || "Codex App Server 错误";
        const errorCode = codexErrorInfo
          ? stringValue(codexErrorInfo.code) ??
            (typeof codexErrorInfo.code === "number"
              ? codexErrorInfo.code
              : null)
          : null;
        await this.queueActivity(() =>
          this.reportActivity(`error:${randomUUID()}`, {
            kind: "error",
            content: redactHarnessText(message, 100_000),
            data: {
              protocol: APP_SERVER_PROTOCOL,
              phase: "completed",
              turn_ref: turnId,
              will_retry: params.willRetry === true,
              error_code: errorCode,
              codex_error_info: sanitizeHarnessValue(codexErrorInfo),
              additional_details: sanitizeHarnessValue(
                protocolError.additionalDetails,
              ),
            },
          }),
        );
        return;
      }
      default:
        return;
    }
  }

  private appendDelta(
    turnId: string,
    itemIdValue: string | null,
    kind: ActivityBuffer["kind"],
    deltaValue: string,
  ): void {
    if (!this.activeClaim || !itemIdValue || !deltaValue) return;
    const key = `${turnId}:${itemIdValue}`;
    const buffer = this.buffers.get(key) ?? {
      kind,
      turnId,
      itemId: itemIdValue,
      pending: "",
      accumulated: "",
      streamClosed: false,
      chunkIndex: 0,
      timer: null,
    };
    if (buffer.streamClosed) return;
    const bounded = acceptBoundedStreamDelta(
      buffer.accumulated,
      deltaValue,
    );
    buffer.accumulated = bounded.accumulated;
    buffer.streamClosed = bounded.truncated;
    this.buffers.set(key, buffer);
    for (const chunk of utf8DeltaChunks(bounded.accepted)) {
      if (
        buffer.pending &&
        Buffer.byteLength(buffer.pending, "utf8") +
          Buffer.byteLength(chunk, "utf8") >
          DELTA_CHUNK_BYTES
      ) {
        void this.flushBuffer(key).catch(() => undefined);
      }
      buffer.pending += chunk;
      if (Buffer.byteLength(buffer.pending, "utf8") >= DELTA_CHUNK_BYTES) {
        void this.flushBuffer(key).catch(() => undefined);
      }
    }
    if (buffer.pending && !buffer.timer) {
      buffer.timer = setTimeout(() => {
        buffer.timer = null;
        void this.flushBuffer(key).catch(() => undefined);
      }, 500);
    }
  }

  private flushBuffer(key: string): Promise<void> {
    const buffer = this.buffers.get(key);
    if (!buffer || !buffer.pending || !this.activeClaim) {
      return Promise.resolve();
    }
    if (buffer.timer) {
      clearTimeout(buffer.timer);
      buffer.timer = null;
    }
    const content = buffer.pending;
    buffer.pending = "";
    const chunkIndex = buffer.chunkIndex;
    buffer.chunkIndex += 1;
    return this.queueActivity(() =>
      this.reportActivity(
        `turn:${buffer.turnId}:item:${buffer.itemId}:delta:${chunkIndex}`,
        {
          kind: buffer.kind,
          content: redactHarnessText(content, 100_000),
          data: protocolData("delta", buffer.turnId, buffer.itemId, {
            chunk_index: chunkIndex,
            disclosure:
              buffer.kind === "reasoning" ? "provider_summary" : undefined,
          }),
        },
      ),
    );
  }

  private async flushAllBuffers(): Promise<void> {
    await Promise.all([...this.buffers.keys()].map((key) => this.flushBuffer(key)));
  }

  private queueActivity(operation: () => Promise<void>): Promise<void> {
    if (this.queueOverflowError) {
      return Promise.reject(this.queueOverflowError);
    }
    if (this.activityBacklog >= MAX_ACTIVITY_BACKLOG) {
      return Promise.reject(this.failForQueueOverflow("Board activity upload"));
    }
    this.activityBacklog += 1;
    const queued = this.activityChain.then(operation);
    this.activityChain = queued
      .catch((error) => {
        this.eventError ??= error instanceof Error ? error : new Error(String(error));
      })
      .finally(() => {
        this.activityBacklog = Math.max(0, this.activityBacklog - 1);
      });
    return queued;
  }

  private async reportActivity(
    externalSuffix: string,
    activity: Activity,
    options: { maxAttempts?: number } = {},
  ): Promise<void> {
    const task = this.activeClaim;
    if (!task) return;
    await this.board.request("/api/ai/sessions/activity", {
      method: "POST",
      sessionId: this.session.id,
      idempotencyKey: idempotencyKey("activity"),
      maxAttempts: options.maxAttempts,
      timeoutMs: options.maxAttempts === 1 ? 5_000 : undefined,
      signal: this.stopController.signal,
      body: {
        task_id: task.id,
        claim_token: task.claim_token,
        external_ref: `codex:${this.thread.id}:${task.id}:${externalSuffix}`,
        kind: activity.kind,
        content: activity.content,
        data: boundActivityData(activity.data),
      },
    });
  }

  private heartbeatSession(): Promise<unknown> {
    return this.board.request("/api/ai/sessions/presence", {
      method: "POST",
      sessionId: this.session.id,
      idempotencyKey: idempotencyKey("session-heartbeat"),
      signal: this.stopController.signal,
      body: {},
    });
  }

  private heartbeatClaim(task: ClaimedTask): Promise<unknown> {
    return this.board.request("/api/ai/sessions/heartbeat", {
      method: "POST",
      sessionId: this.session.id,
      idempotencyKey: idempotencyKey("claim-heartbeat"),
      signal: this.stopController.signal,
      body: {
        task_id: task.id,
        claim_token: task.claim_token,
        lease_seconds: this.configuration.leaseSeconds,
      },
    });
  }

  private async releaseActiveTask(reason: string): Promise<void> {
    if (!this.activeClaim) return;
    const task = this.activeClaim;
    await this.board
      .request("/api/ai/tasks/release", {
        method: "POST",
        sessionId: this.session.id,
        idempotencyKey: idempotencyKey("release"),
        maxAttempts: 1,
        timeoutMs: 5_000,
        body: {
          task_id: task.id,
          claim_token: task.claim_token,
          reason,
        },
      })
      .catch(() => undefined);
    this.activeClaim = null;
  }

  private trackBackgroundBoardOperation(
    operation: Promise<void>,
    description: string,
  ): void {
    const tracked = operation
      .catch((error) => {
        if (!this.stopping) {
          process.stderr.write(
            `Thread ${this.thread.id} ${description}失败：${errorMessage(error)}\n`,
          );
        }
      })
      .finally(() => this.backgroundBoardOperations.delete(tracked));
    this.backgroundBoardOperations.add(tracked);
  }

  private async waitForBackgroundBoardOperations(): Promise<void> {
    while (this.backgroundBoardOperations.size > 0) {
      await Promise.allSettled([...this.backgroundBoardOperations]);
    }
  }

  private async trackMutatingRequest<T>(operation: Promise<T>): Promise<T> {
    this.mutatingRequestCount += 1;
    try {
      return await operation;
    } finally {
      this.mutatingRequestCount -= 1;
      if (this.mutatingRequestCount === 0) {
        for (const resolve of this.retirementWaiters) resolve();
        this.retirementWaiters.clear();
      }
    }
  }
}

class DeviceBridge {
  private readonly stopController = new AbortController();
  private readonly board: BoardClient;
  private readonly limiter: TurnLimiter;
  private readonly workers = new Map<string, SessionWorker>();
  private readonly workerRuns = new Map<string, Promise<void>>();
  private readonly historySynchronizer: HistorySynchronizer;
  private historySyncPromise: Promise<void> | null = null;
  private historyConfigurationReady = false;
  private stopping = false;
  private fatalError: Error | null = null;
  private stopPromise: Promise<void> | null = null;
  private appliedConfigurationVersion: number | null = null;
  private configurationError: string | null = null;
  private effectiveConfigurationKnown = true;
  private readonly runtimeInstanceId = randomUUID();
  private reportSequence = 0;
  private runtimeLeaseClaimed = false;
  private leaseRenewalPromise: Promise<void> | null = null;
  private leaseSafetyDeadlineMs: number | null = null;
  private latestSuccessfulReportSequence = 0;
  private legacyConfigurationCompatibility = false;

  constructor(
    private readonly configuration: BridgeConfiguration,
    private readonly appServer: CodexAppServerClient,
  ) {
    this.board = new BoardClient(configuration, () => this.stopping);
    this.limiter = new TurnLimiter(configuration.maxConcurrentTurns);
    this.historySynchronizer = new HistorySynchronizer({
      appServer,
      runtimeInstanceId: this.runtimeInstanceId,
      configuration: () => ({
        enabled:
          this.historyConfigurationReady &&
          this.configuration.enabled &&
          this.configuration.syncHistory,
        turnLimit: this.configuration.historyTurnLimit,
      }),
      importHistory: (sessionId, request, signal) =>
        this.board.importHistory(sessionId, request, signal),
      log: (message) => process.stderr.write(`${message}\n`),
    });
    appServer.onNotification((notification) => {
      const params = isRecord(notification.params) ? notification.params : null;
      const threadId = threadIdFromMessage(params);
      if (threadId) this.workers.get(threadId)?.enqueueNotification(notification);
    });
    appServer.onError((error) => {
      if (this.stopping) return;
      process.stderr.write(`Codex App Server 已退出：${error.message}\n`);
      this.markFatal(
        new Error(`Codex App Server 意外退出：${error.message}`, {
          cause: error,
        }),
      );
    });
    appServer.setServerRequestHandler((request) => this.handleServerRequest(request));
  }

  async run(): Promise<void> {
    if (this.configuration.approvalMode !== "decline") {
      process.stderr.write(
        `警告：CODEX_BRIDGE_APPROVAL_MODE=${this.configuration.approvalMode} 会自动批准本机操作\n`,
      );
    }
    if (this.configuration.permissionMode === "inherit") {
      process.stderr.write(
        "高风险警告：CODEX_BRIDGE_PERMISSION_MODE=inherit 会沿用 thread 的审批与沙箱设置，可能继承 danger-full-access 或额外可写目录\n",
      );
    }
    if (!this.configuration.threadIdFilter && this.configuration.threadScope === "all") {
      process.stderr.write(
        "高风险警告：CODEX_THREAD_SCOPE=all 会管理当前系统用户的跨项目顶层 Codex threads\n",
      );
    }
    await this.establishRemoteConfigurationLease();
    if (this.stopping) {
      await this.stop();
      if (this.fatalError) throw this.fatalError;
      return;
    }
    this.leaseRenewalPromise = this.runRemoteConfigurationLeaseRenewal();
    this.historySyncPromise = this.historySynchronizer
      .start(this.stopController.signal)
      .catch((error) => {
        if (!this.stopping) {
          process.stderr.write(
            `Codex 历史后台同步器已停止：${errorMessage(error)}\n`,
          );
        }
      });
    let nextInventorySyncAt = 0;
    do {
      let reconciledConfiguration = false;
      if (this.configuration.webConfigurationEnabled) {
        try {
          reconciledConfiguration = await this.reconcileRemoteConfiguration();
        } catch (error) {
          if (this.stopping) break;
          if (error instanceof WorkerRetirementFailureError) {
            this.markFatal(error);
            break;
          }
          if (isPersistentClientError(error)) {
            this.markFatal(actionableBoardError(error));
            break;
          }
          process.stderr.write(
            `同步 Web Bridge 配置失败，继续使用当前有效配置：${errorMessage(error)}\n`,
          );
        }
      }
      if (this.stopping) break;

      const inventoryDue = Date.now() >= nextInventorySyncAt;
      if (reconciledConfiguration) {
        nextInventorySyncAt = Date.now() + this.configuration.syncIntervalMs;
      } else if (inventoryDue) {
        try {
          await this.syncWorkers();
          this.effectiveConfigurationKnown = true;
          nextInventorySyncAt = Date.now() + this.configuration.syncIntervalMs;
        } catch (error) {
          if (this.stopping) break;
          if (error instanceof WorkerRetirementFailureError) {
            this.markFatal(error);
            break;
          }
          if (isPersistentClientError(error)) {
            this.markFatal(actionableBoardError(error));
            break;
          }
          process.stderr.write(`同步 Codex threads 失败：${errorMessage(error)}\n`);
        }
      }
      if (this.stopping) break;
      const untilInventorySync = Math.max(1_000, nextInventorySyncAt - Date.now());
      const sleepMilliseconds = this.configuration.webConfigurationEnabled
        ? Math.min(
            this.configuration.configurationPollIntervalMs,
            untilInventorySync,
          )
        : untilInventorySync;
      try {
        await delay(sleepMilliseconds, this.stopController.signal);
      } catch {
        break;
      }
    } while (!this.stopping);

    await this.stop();
    if (this.fatalError) throw this.fatalError;
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopBridge();
    return this.stopPromise;
  }

  private async stopBridge(): Promise<void> {
    this.stopping = true;
    this.historySynchronizer.stop();
    this.stopController.abort(new Error("Codex Bridge 正在停止"));
    const workerStops = [...this.workers.values()].map((worker) =>
        worker.stop("Codex Bridge 正在停止"),
    );
    await Promise.race([
      Promise.allSettled(workerStops),
      delay(3_000),
    ]);
    await this.appServer.close();
    await Promise.allSettled(workerStops);
    await (this.historySyncPromise ?? Promise.resolve()).catch(() => undefined);
    await (this.leaseRenewalPromise ?? Promise.resolve()).catch(() => undefined);
    await this.releaseRemoteConfigurationLease();
  }

  private configurationLeaseRenewalIntervalMs(): number {
    return Math.min(
      this.configuration.configurationPollIntervalMs,
      Math.max(
        1_000,
        Math.floor((this.configuration.configurationLeaseSeconds * 1_000) / 3),
      ),
    );
  }

  private configurationLeaseRequestTimeoutMs(): number {
    const intervalMs = this.configurationLeaseRenewalIntervalMs();
    return Math.min(5_000, Math.max(500, Math.floor(intervalMs * 0.8)));
  }

  private configurationLeaseSafetyMarginMs(): number {
    return 5_000;
  }

  private leaseSafetyExpired(): boolean {
    return (
      this.leaseSafetyDeadlineMs !== null &&
      monotonicMilliseconds() >= this.leaseSafetyDeadlineMs
    );
  }

  private markLeaseSafetyFatal(lastError?: unknown): void {
    this.markFatal(
      new Error(
        `Bridge 运行租约未能在本地安全期限前续租，已停止所有 worker，避免多个实例同时运行。${
          lastError ? ` ${errorMessage(lastError)}` : ""
        }`,
        lastError === undefined ? undefined : { cause: lastError },
      ),
    );
  }

  private async establishRemoteConfigurationLease(): Promise<void> {
    let attempt = 0;
    while (!this.stopping) {
      attempt += 1;
      try {
        await this.exchangeRemoteConfiguration({ timeoutMs: 5_000 });
        if (!this.leaseSafetyExpired()) return;
      } catch (error) {
        if (this.stopping) return;
        const status = errorStatus(error);
        if (status === 404 && !this.configuration.webConfigurationEnabled) {
          // Board 0.2 compatibility: inventory can run without config support.
          this.legacyConfigurationCompatibility = true;
          return;
        }
        if (status === 409) {
          if (attempt === 1 || attempt % 10 === 0) {
            process.stderr.write(
              "同一连接的旧 Bridge 租约仍有效；本实例保持待机并等待接管\n",
            );
          }
          await delay(
            Math.min(500 * 2 ** Math.min(attempt - 1, 4), 5_000),
            this.stopController.signal,
          ).catch(() => undefined);
          continue;
        }
        if (isPersistentClientError(error)) {
          throw actionableBoardError(error);
        }
        if (attempt === 1 || attempt % 10 === 0) {
          process.stderr.write(
            `尚未取得 Bridge 运行租约，等待后重试：${errorMessage(error)}\n`,
          );
        }
        await delay(
          Math.min(500 * 2 ** Math.min(attempt - 1, 4), 5_000),
          this.stopController.signal,
        ).catch(() => undefined);
      }
    }
  }

  private async runRemoteConfigurationLeaseRenewal(): Promise<void> {
    const intervalMs = this.configurationLeaseRenewalIntervalMs();
    const timeoutMs = this.configurationLeaseRequestTimeoutMs();
    while (!this.stopping) {
      const untilSafetyDeadline =
        this.leaseSafetyDeadlineMs === null
          ? intervalMs
          : Math.max(
              0,
              this.leaseSafetyDeadlineMs - monotonicMilliseconds(),
            );
      if (this.leaseSafetyDeadlineMs !== null && untilSafetyDeadline <= 0) {
        this.markLeaseSafetyFatal();
        return;
      }
      try {
        await delay(
          Math.min(intervalMs, untilSafetyDeadline),
          this.stopController.signal,
        );
      } catch {
        return;
      }
      if (this.stopping) return;
      if (this.leaseSafetyExpired()) {
        this.markLeaseSafetyFatal();
        return;
      }
      try {
        // This loop only renews the runtime fence and reports the latest
        // in-memory status. Desired config is applied by the main reconcile.
        await this.exchangeRemoteConfiguration({ timeoutMs });
      } catch (error) {
        if (this.stopping) return;
        const status = errorStatus(error);
        if (
          status === 404 &&
          !this.configuration.webConfigurationEnabled &&
          this.legacyConfigurationCompatibility &&
          !this.runtimeLeaseClaimed
        ) {
          continue;
        }
        if (isPersistentClientError(error)) {
          this.markFatal(actionableBoardError(error));
          return;
        }
        process.stderr.write(
          `Bridge 运行租约续租失败，将在下一周期重试：${errorMessage(error)}\n`,
        );
        if (this.leaseSafetyExpired()) {
          this.markLeaseSafetyFatal(error);
          return;
        }
      }
    }
  }

  private configurationStatus(
    releaseRuntime = false,
  ): RemoteConfigurationStatus {
    this.reportSequence += 1;
    return {
      runtime_instance_id: this.runtimeInstanceId,
      report_sequence: this.reportSequence,
      lease_seconds: this.configuration.configurationLeaseSeconds,
      release_runtime: releaseRuntime,
      applied_version: this.appliedConfigurationVersion,
      effective: this.effectiveConfigurationKnown
        ? remoteDesiredFromEffective(
            effectiveBridgeConfiguration(this.configuration),
          )
        : null,
      constraints: bridgeConfigurationConstraints(this.configuration),
      error: this.configurationError
        ? redactHarnessText(this.configurationError, 2_000)
        : null,
    };
  }

  private async exchangeRemoteConfiguration(
    options: {
      releaseRuntime?: boolean;
      signal?: AbortSignal;
      timeoutMs?: number;
    } = {},
  ): Promise<RemoteConfigurationResponse> {
    const releaseRuntime = options.releaseRuntime === true;
    const status = this.configurationStatus(releaseRuntime);
    const requestStartedAt = monotonicMilliseconds();
    const response = await this.board.exchangeConfiguration(
      status,
      releaseRuntime
        ? options.signal
        : (options.signal ?? this.stopController.signal),
      options.timeoutMs,
    );
    if (releaseRuntime) {
      this.runtimeLeaseClaimed = false;
      this.leaseSafetyDeadlineMs = null;
    } else if (
      !this.stopping &&
      status.report_sequence > this.latestSuccessfulReportSequence
    ) {
      this.latestSuccessfulReportSequence = status.report_sequence;
      this.runtimeLeaseClaimed = true;
      this.legacyConfigurationCompatibility = false;
      this.leaseSafetyDeadlineMs =
        requestStartedAt +
        this.configuration.configurationLeaseSeconds * 1_000 -
        this.configurationLeaseSafetyMarginMs();
    }
    return response;
  }

  private async releaseRemoteConfigurationLease(): Promise<void> {
    if (!this.runtimeLeaseClaimed) return;
    await this.exchangeRemoteConfiguration({
      releaseRuntime: true,
      signal: undefined,
      timeoutMs: 1_500,
    })
      .then(() => {
        this.runtimeLeaseClaimed = false;
      })
      .catch(() => undefined);
  }

  private async reconcileRemoteConfiguration(): Promise<boolean> {
    let response = await this.exchangeRemoteConfiguration();
    let reconciled = false;

    // A re-report can race a Web edit. Apply a few consecutive versions now;
    // any later version remains unapplied and is picked up by the next poll.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const remote = response.configuration;
      if (remote.version === this.appliedConfigurationVersion) return reconciled;
      if (
        this.appliedConfigurationVersion !== null &&
        remote.version < this.appliedConfigurationVersion
      ) {
        this.configurationError =
          `忽略过期看板配置 version=${remote.version}；设备已应用 version=${this.appliedConfigurationVersion}`;
        process.stderr.write(`${this.configurationError}\n`);
        return reconciled;
      }

      const resolved = resolveRemoteConfiguration(
        this.configuration,
        remote.desired,
      );
      const previousEffective = effectiveBridgeConfiguration(this.configuration);
      const previousEffectiveKnown = this.effectiveConfigurationKnown;
      this.historyConfigurationReady = false;
      this.historySynchronizer.configurationChanged();
      this.configuration.enabled = resolved.effective.enabled;
      this.configuration.includeThreadTitles =
        resolved.effective.includeThreadTitles;
      this.configuration.maxThreads = resolved.effective.maxThreads;
      this.configuration.maxConcurrentTurns =
        resolved.effective.maxConcurrentTurns;
      this.configuration.syncHistory = resolved.effective.syncHistory;
      this.configuration.historyTurnLimit = resolved.effective.historyTurnLimit;
      this.limiter.resize(resolved.effective.maxConcurrentTurns);
      this.configurationError = resolved.warnings.length
        ? resolved.warnings.join("；")
        : null;
      for (const warning of resolved.warnings) {
        process.stderr.write(`Web Bridge 配置警告：${warning}\n`);
      }
      this.effectiveConfigurationKnown = false;

      try {
        // Retire excluded workers before publishing the authoritative inventory.
        await this.syncWorkers();
      } catch (error) {
        if (error instanceof WorkerRetirementDeferredError) {
          // The retirement fence fires before worker-map mutation, so the last
          // effective view is still exact and can be restored safely.
          this.configuration.enabled = previousEffective.enabled;
          this.configuration.includeThreadTitles =
            previousEffective.includeThreadTitles;
          this.configuration.maxThreads = previousEffective.maxThreads;
          this.configuration.maxConcurrentTurns =
            previousEffective.maxConcurrentTurns;
          this.configuration.syncHistory = previousEffective.syncHistory;
          this.configuration.historyTurnLimit = previousEffective.historyTurnLimit;
          this.limiter.resize(previousEffective.maxConcurrentTurns);
          this.effectiveConfigurationKnown = previousEffectiveKnown;
          this.historyConfigurationReady =
            previousEffectiveKnown && this.appliedConfigurationVersion !== null;
        } else {
          // A later failure may happen after workers were stopped. Do not claim
          // a precise effective state until a full reconciliation succeeds.
          this.effectiveConfigurationKnown = false;
        }
        this.configurationError = [
          this.configurationError,
          `应用 version=${remote.version} 失败：${errorMessage(error)}`,
        ]
          .filter(Boolean)
          .join("；");
        await this
          .exchangeRemoteConfiguration()
          .catch(() => undefined);
        throw error;
      }

      this.effectiveConfigurationKnown = true;
      this.appliedConfigurationVersion = remote.version;
      reconciled = true;
      process.stdout.write(
        `已应用 Web Bridge 配置 version=${remote.version}：${
          this.configuration.enabled ? "已启用" : "已停用"
        }，最多 ${this.configuration.maxThreads} 个 thread / ${this.configuration.maxConcurrentTurns} 个并行 turn\n`,
      );

      response = await this.exchangeRemoteConfiguration();
      this.historyConfigurationReady = true;
      this.historySynchronizer.configurationChanged();
    }
    return reconciled;
  }

  private async syncWorkers(): Promise<void> {
    const threads = await this.listThreads();
    const visibleThreadIds = new Set(threads.map((thread) => thread.id));
    const removed: Array<{ threadId: string; worker: SessionWorker }> = [];

    for (const [threadId, worker] of this.workers) {
      if (visibleThreadIds.has(threadId)) continue;
      removed.push({ threadId, worker });
    }
    const blocked = removed.filter(({ worker }) => worker.retirementBlocked);
    if (blocked.length > 0) {
      await Promise.all(
        blocked.map(({ worker }) => worker.waitForRetirementReady(3_000)),
      );
      if (blocked.some(({ worker }) => worker.retirementBlocked)) {
        throw new WorkerRetirementDeferredError(
          `暂缓同步：${blocked.length} 个已移除 thread 仍在等待 App Server 返回 resume/turn-start，避免产生孤儿 turn`,
        );
      }
    }
    if (removed.length > 0) {
      await stopWorkersForRetirement(
        removed,
        "Codex thread 已从设备清单移除",
      );
      for (const { threadId } of removed) this.workers.delete(threadId);
    }

    if (this.stopping) return;
    const sessions = await this.board.syncSessions(
      threads,
      this.stopController.signal,
    );
    if (this.stopping) return;
    this.historySynchronizer.updateTargets(
      threads.flatMap((thread) => {
        const session = sessions.get(thread.id);
        return session && isInteractiveHistoryThread(thread)
          ? [{ thread, sessionId: session.id }]
          : [];
      }),
    );

    for (const thread of threads) {
      if (this.workers.has(thread.id)) continue;
      const session = sessions.get(thread.id);
      if (!session) {
        process.stderr.write(`看板未返回 thread ${thread.id} 对应的 Session\n`);
        continue;
      }
      const worker = new SessionWorker(
        thread,
        session,
        this.configuration,
        this.board,
        this.appServer,
        this.limiter,
        (error) => this.markFatal(error),
      );
      this.workers.set(thread.id, worker);
      const run = worker.start().catch((error) => {
        if (!this.stopping) {
          process.stderr.write(
            `Thread worker ${thread.id} 已退出：${errorMessage(error)}\n`,
          );
          this.workers.delete(thread.id);
          if (isPersistentClientError(error)) {
            this.markFatal(actionableBoardError(error));
          }
        }
      });
      this.workerRuns.set(thread.id, run);
      void run.finally(() => this.workerRuns.delete(thread.id));
      process.stdout.write(
        `已连接 thread：${sessionName(thread, this.configuration)} (${thread.id})\n`,
      );
    }

    process.stdout.write(
      `Codex Bridge 已同步 ${threads.length} 个 thread，最多并行 ${this.configuration.maxConcurrentTurns} 个 turn\n`,
    );
  }

  private async listThreads(): Promise<ThreadRecord[]> {
    if (!this.configuration.enabled) return [];
    const threads: ThreadRecord[] = [];
    let cursor: string | null = null;
    let scanned = 0;
    do {
      const page = await this.appServer.threadList({
        cursor,
        limit: this.configuration.threadIdFilter
          ? 100
          : Math.min(100, this.configuration.maxThreads - threads.length),
        sortKey: "recency_at",
        sortDirection: "desc",
        sourceKinds: THREAD_SOURCE_KINDS,
        archived: false,
      });
      scanned += page.data.length;
      for (const candidate of page.data) {
        const thread = candidate as ThreadRecord;
        if (
          this.configuration.threadIdFilter &&
          thread.id !== this.configuration.threadIdFilter
        ) {
          continue;
        }
        if (stringValue(thread.parentThreadId)) continue;
        if (
          !this.configuration.threadIdFilter &&
          this.configuration.threadScope === "cwd"
        ) {
          const cwd = threadCwd(thread);
          if (
            !cwd ||
            !isExactWorkingDirectory(cwd, this.configuration.workingDirectory)
          ) {
            continue;
          }
        }
        threads.push(thread);
        if (threads.length >= this.configuration.maxThreads) break;
      }
      cursor = page.nextCursor;
    } while (
      cursor &&
      threads.length < this.configuration.maxThreads &&
      scanned < 5_000 &&
      (!this.configuration.threadIdFilter ||
        (threads.length === 0 && scanned < 5_000))
    );

    if (this.configuration.threadIdFilter && threads.length === 0) {
      throw new Error(
        `找不到 CODEX_THREAD_ID=${this.configuration.threadIdFilter}；请确认该 thread 属于当前系统用户`,
      );
    }
    return threads;
  }

  private async handleServerRequest(
    request: AppServerIncomingRequest,
  ): Promise<unknown> {
    const threadId = threadIdFromMessage(request.params);
    const worker = threadId ? this.workers.get(threadId) : null;
    if (!worker) {
      if (request.method === "currentTime/read") {
        return { currentTimeAt: Math.floor(Date.now() / 1_000) };
      }
      throw new Error(
        `App Server request ${request.method} did not match a managed thread`,
      );
    }
    return worker.handleServerRequest(request);
  }

  private markFatal(error: Error): void {
    if (this.stopping) return;
    this.fatalError ??= error;
    void this.stop();
  }
}

async function main(): Promise<void> {
  const configuration = loadConfiguration();
  const appServer = await CodexAppServerClient.connect({
    binary: configuration.codexBinary,
    args: ["app-server", "--stdio"],
    cwd: configuration.workingDirectory,
    unsetEnv: ["AI_TASK_BOARD_CONNECTION_TOKEN"],
    clientInfo: {
      name: "ai_task_board_bridge",
      title: "AI Task Board Codex Bridge",
      version: BRIDGE_VERSION,
    },
    capabilities: { experimentalApi: true, requestAttestation: false },
    onStderr: (text) => process.stderr.write(text),
    onError: (error) =>
      process.stderr.write(`Codex App Server：${error.message}\n`),
  });
  const bridge = new DeviceBridge(configuration, appServer);
  const requestStop = () => void bridge.stop();
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);
  try {
    await bridge.run();
  } finally {
    process.removeListener("SIGINT", requestStop);
    process.removeListener("SIGTERM", requestStop);
    await bridge.stop();
    await appServer.close();
  }
}

export async function runBridgeCli(): Promise<void> {
  await main();
}
