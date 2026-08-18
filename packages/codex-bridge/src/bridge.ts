import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  type AppServerIncomingRequest,
  type AppServerModel,
  type AppServerNotification,
  type AppServerThread,
  AppServerRpcError,
  CodexAppServerClient,
} from "./app-server-client.js";
import {
  normalizeCodexQuota,
  quotaError,
  type SyncedQuota,
} from "./account-quota.js";
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
  loadDeviceIdentity,
  type DeviceIdentity,
} from "./device-identity.js";
import {
  listDeviceDirectory,
  readDeviceFilePreview,
  type DeviceFileListResult,
  type DeviceFilePreviewResult,
} from "./device-file-access.js";
import {
  adaptiveIdlePollDelay,
  runSessionWakeListener,
  WakeLatch,
} from "./wake-client.js";
import {
  managedDirectoryForWorkingDirectory,
  type ManagedWorkingDirectory,
  parseRemoteWorkingDirectories,
  parseWorkingDirectories,
  type RemoteWorkingDirectory,
  remoteWorkingDirectories,
  workingDirectoryForThreadCreate,
} from "./working-directories.js";
import { maybeApplyDesiredBridgeUpdate } from "./update-manager.js";

export {
  isExactWorkingDirectory,
  managedDirectoryForWorkingDirectory,
  type ManagedWorkingDirectory,
  parseRemoteWorkingDirectories,
  parseWorkingDirectories,
  type RemoteWorkingDirectory,
  remoteWorkingDirectories,
  workingDirectoryForThreadCreate,
} from "./working-directories.js";

const BRIDGE_VERSION = "1.5.0";
const APP_SERVER_PROTOCOL = "codex-app-server/v1";
const THREAD_SOURCE_KINDS = ["cli", "vscode", "exec", "appServer"];
const DELTA_CHUNK_BYTES = 8_192;
const ACCUMULATED_TEXT_LIMIT = 100_000;
const STREAM_TRUNCATION_MARKER = "\n…[流式输出已截断]";
const MAX_NOTIFICATION_BACKLOG = 256;
const MAX_ACTIVITY_BACKLOG = 64;
const USER_INPUT_POLL_INTERVAL_MS = 1_500;
const MAX_CONCURRENT_TURNS = 32;
const MAX_MODEL_CATALOG_ENTRIES = 500;
const MODEL_CATALOG_PAGE_SIZE = 100;

type ClaimedTask = {
  id: string;
  title: string;
  description: string | null;
  acceptance_criteria: string | null;
  model?: string | null;
  reasoning_effort?: string | null;
  goal_mode?: boolean | null;
  claim_token: string;
};

type TaskImageArtifact = {
  id: string;
  name: string;
  mime_type: string;
  size: number;
};

type TaskDetailsResponse = { artifacts: TaskImageArtifact[] };

type Session = {
  id: string;
  external_conversation_ref?: string | null;
  deletion_requested_at?: string | null;
};

type ClaimResponse = { task: ClaimedTask | null };

export type StructuredUserInputQuestion = {
  id: string;
  header: string;
  question: string;
  options: Array<{ label: string; description: string }> | null;
  isOther: boolean;
  isSecret: boolean;
};

export type StructuredUserInputRequest = {
  turnId: string;
  itemId: string;
  isBlocking: true;
  questions: StructuredUserInputQuestion[];
};

type UserInputPollResponse = {
  request: {
    id: string;
    status: "pending" | "answered" | "consumed" | "cancelled";
    answers: Record<string, string[]> | null;
  };
};

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
type PermissionMode = "danger-full-access" | "safe" | "inherit";
type ThreadScope = "cwd" | "all";

export type EffectiveBridgeConfiguration = {
  enabled: boolean;
  includeThreadTitles: boolean;
  maxThreads: number;
  maxConcurrentTurns: number;
  syncHistory: boolean;
  historyTurnLimit: number;
  workingDirectory: string;
  workingDirectories: ManagedWorkingDirectory[];
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
  /** Missing is normalized to null for compatibility with Boards before 0.8. */
  working_directories: RemoteWorkingDirectory[] | null;
};

export type RemoteBridgeConfigurationConstraints = {
  remote_configuration_enabled: boolean;
  allow_thread_titles: boolean;
  allow_history_sync: boolean;
  allow_working_directory_configuration: boolean;
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
  readonly localWorkingDirectory: string;
  readonly localWorkingDirectories: readonly ManagedWorkingDirectory[];
  workingDirectory: string;
  workingDirectories: ManagedWorkingDirectory[];
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
  allowRemoteWorkingDirectories: boolean;
  localMaxThreads: number;
  localMaxHistoryTurns: number;
  webConfigurationEnabled: boolean;
  allowRemoteUpdate: boolean;
  codexBinary: string;
};

type RemoteConfigurationResponse = {
  configuration: {
    connection_id: string;
    version: number;
    desired: RemoteBridgeConfigurationDesired;
    /** Board-requested npm package version; null when absent or not a string. */
    desired_bridge_version: string | null;
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
  directory_key: string | null;
  capabilities: string[];
  archived: false;
};

type InventoryDirectory = {
  directory_key: string;
  name: string;
  working_directory: string;
};

type InventoryModelReasoningEffort = {
  reasoning_effort: string;
  description: string | null;
};

type InventoryModel = {
  id: string;
  model: string;
  display_name: string;
  description: string | null;
  default_reasoning_effort: string | null;
  supported_reasoning_efforts: InventoryModelReasoningEffort[];
  input_modalities: string[];
  is_default: boolean;
};

type SyncSessionsResponse = {
  sessions: Session[];
};

type ThreadCommand = {
  id: string;
  action: "create" | "rename" | "delete";
  name: string | null;
  directory_key: string | null;
  model?: string | null;
  reasoning_effort?: string | null;
  external_thread_id: string | null;
  attempt_count?: number;
};

type ThreadCommandResponse = {
  command: ThreadCommand | null;
};

type FileCommand = {
  id: string;
  action: "list" | "read";
  path: string;
  attempt_count?: number;
};

type FileCommandResponse = {
  command: FileCommand | null;
};

type CreatedThreadIdsResponse = {
  thread_ids?: string[];
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

function boundedCatalogString(
  value: unknown,
  maximumLength: number,
): string | null {
  const parsed = stringValue(value);
  return parsed && parsed.length <= maximumLength ? parsed : null;
}

function inventoryModel(
  value: AppServerModel,
  allowDefault: boolean,
): InventoryModel | null {
  if (!isRecord(value)) return null;
  const model = boundedCatalogString(value.model, 200);
  const id = boundedCatalogString(value.id, 200) ?? model;
  if (!id || !model) return null;

  const efforts: InventoryModelReasoningEffort[] = [];
  const seenEfforts = new Set<string>();
  if (Array.isArray(value.supportedReasoningEfforts)) {
    for (const candidate of value.supportedReasoningEfforts.slice(0, 20)) {
      if (!isRecord(candidate)) continue;
      const reasoningEffort = boundedCatalogString(
        candidate.reasoningEffort,
        100,
      );
      if (!reasoningEffort || seenEfforts.has(reasoningEffort)) continue;
      seenEfforts.add(reasoningEffort);
      efforts.push({
        reasoning_effort: reasoningEffort,
        description:
          typeof candidate.description === "string"
            ? candidate.description.trim().slice(0, 2_000) || null
            : null,
      });
    }
  }

  const inputModalities = Array.isArray(value.inputModalities)
    ? [
        ...new Set(
          value.inputModalities
            .slice(0, 20)
            .map((modality) => boundedCatalogString(modality, 100))
            .filter((modality): modality is string => Boolean(modality)),
        ),
      ]
    : [];
  const defaultEffort = boundedCatalogString(
    value.defaultReasoningEffort,
    100,
  );

  return {
    id,
    model,
    display_name:
      boundedCatalogString(value.displayName, 200) ?? model,
    description:
      typeof value.description === "string"
        ? value.description.trim().slice(0, 2_000) || null
        : null,
    default_reasoning_effort: defaultEffort,
    supported_reasoning_efforts: efforts,
    input_modalities: inputModalities,
    is_default: allowDefault && value.isDefault === true,
  };
}

export function parseStructuredUserInputRequest(
  value: unknown,
): StructuredUserInputRequest {
  if (!isRecord(value)) throw new Error("结构化问题参数无效");
  const turnId = stringValue(value.turnId);
  const itemId = stringValue(value.itemId);
  if (!turnId || !itemId || value.isBlocking !== true) {
    throw new Error("结构化问题缺少 blocking turn/item 标识");
  }
  if (!Array.isArray(value.questions) || value.questions.length < 1 || value.questions.length > 3) {
    throw new Error("结构化问题数量必须为 1 到 3");
  }
  const ids = new Set<string>();
  const questions = value.questions.map((candidate): StructuredUserInputQuestion => {
    if (!isRecord(candidate)) throw new Error("结构化问题格式无效");
    const id = stringValue(candidate.id);
    const header = stringValue(candidate.header);
    const question = stringValue(candidate.question);
    if (!id || id.length > 200 || ids.has(id) || !header || !question) {
      throw new Error("结构化问题字段无效或 id 重复");
    }
    ids.add(id);
    let options: StructuredUserInputQuestion["options"] = null;
    if (candidate.options !== null && candidate.options !== undefined) {
      if (
        !Array.isArray(candidate.options) ||
        candidate.options.length < 1 ||
        candidate.options.length > 20
      ) {
        throw new Error("结构化问题选项无效");
      }
      const labels = new Set<string>();
      options = candidate.options.map((option) => {
        if (!isRecord(option)) throw new Error("结构化问题选项格式无效");
        const label = stringValue(option.label);
        if (!label || label.length > 500 || labels.has(label)) {
          throw new Error("结构化问题选项标签无效或重复");
        }
        if (typeof option.description !== "string" || option.description.length > 2_000) {
          throw new Error("结构化问题选项说明无效");
        }
        labels.add(label);
        return { label, description: option.description };
      });
    }
    return {
      id,
      header: header.slice(0, 100),
      question: question.slice(0, 10_000),
      options,
      isOther: candidate.isOther === true,
      isSecret: candidate.isSecret === true,
    };
  });
  return { turnId, itemId, isBlocking: true, questions };
}

export function parseStructuredUserInputAnswers(
  value: unknown,
  questions: readonly StructuredUserInputQuestion[],
): Record<string, { answers: string[] }> {
  if (!isRecord(value)) throw new Error("Web Console 回答格式无效");
  const result: Record<string, { answers: string[] }> = {};
  for (const question of questions) {
    const candidate = value[question.id];
    if (
      !Array.isArray(candidate) ||
      candidate.length !== 1 ||
      typeof candidate[0] !== "string" ||
      !candidate[0].trim()
    ) {
      throw new Error(`Web Console 未返回问题 ${question.id} 的有效答案`);
    }
    result[question.id] = { answers: [candidate[0]] };
  }
  if (Object.keys(value).length !== questions.length) {
    throw new Error("Web Console 回答包含未知问题");
  }
  return result;
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
  const mode = value?.trim();
  if (!mode || mode === "accept") return "accept";
  if (mode === "decline" || mode === "accept-session") return mode;
  throw new Error(
    "CODEX_BRIDGE_APPROVAL_MODE must be accept, decline, or accept-session",
  );
}

function parsePermissionMode(value: string | undefined): PermissionMode {
  const mode = value?.trim();
  if (!mode || mode === "danger-full-access") {
    return "danger-full-access";
  }
  if (mode === "safe" || mode === "inherit") return mode;
  throw new Error(
    "CODEX_BRIDGE_PERMISSION_MODE must be danger-full-access, safe, or inherit",
  );
}

function threadPermissionOverrides(
  mode: PermissionMode,
  cwd: string,
): Record<string, unknown> {
  if (mode === "inherit") return {};
  return {
    cwd,
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: mode === "safe" ? "workspace-write" : "danger-full-access",
  };
}

function turnPermissionOverrides(
  mode: PermissionMode,
  cwd: string,
): Record<string, unknown> {
  if (mode === "inherit") return {};
  return {
    cwd,
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandboxPolicy:
      mode === "safe"
        ? {
            type: "workspaceWrite",
            writableRoots: [cwd],
            networkAccess: false,
            excludeTmpdirEnvVar: true,
            excludeSlashTmp: true,
          }
        : { type: "dangerFullAccess" },
  };
}

function parseThreadScope(value: string | undefined): ThreadScope {
  return value === "all" ? "all" : "cwd";
}

function parseBoolean(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

function copyWorkingDirectories(
  directories: readonly ManagedWorkingDirectory[],
): ManagedWorkingDirectory[] {
  return directories.map((directory) => ({ ...directory }));
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
  const startupMaxConcurrentTurns = boundedInteger(
    environment.CODEX_MAX_CONCURRENT_TURNS,
    2,
    1,
    MAX_CONCURRENT_TURNS,
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
  const legacyWorkingDirectory = path.resolve(
    environment.CODEX_WORKING_DIRECTORY?.trim() || process.cwd(),
  );
  const localWorkingDirectories = parseWorkingDirectories(
    environment.CODEX_WORKING_DIRECTORIES,
    legacyWorkingDirectory,
  );
  const localWorkingDirectory =
    localWorkingDirectories[0]?.workingDirectory ?? legacyWorkingDirectory;

  return {
    boardUrl,
    connectionToken,
    threadIdFilter: environment.CODEX_THREAD_ID?.trim() || null,
    // The local list is an immutable device startup boundary. The effective
    // list begins as a copy and may later be replaced by an explicitly gated
    // Web configuration without losing the local fallback.
    localWorkingDirectory,
    localWorkingDirectories: copyWorkingDirectories(localWorkingDirectories),
    workingDirectory: localWorkingDirectory,
    workingDirectories: copyWorkingDirectories(localWorkingDirectories),
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
    maxConcurrentTurns: startupMaxConcurrentTurns,
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
    allowRemoteWorkingDirectories: parseBoolean(
      environment.CODEX_BRIDGE_ALLOW_REMOTE_WORKING_DIRECTORIES,
    ),
    localMaxThreads,
    localMaxHistoryTurns,
    webConfigurationEnabled: parseBoolean(
      environment.CODEX_BRIDGE_WEB_CONFIG,
    ),
    allowRemoteUpdate: parseBoolean(
      environment.AI_TASK_BOARD_ALLOW_REMOTE_UPDATE,
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
    workingDirectory: configuration.workingDirectory,
    workingDirectories: copyWorkingDirectories(
      configuration.workingDirectories,
    ),
  };
}

export function bridgeConfigurationConstraints(
  configuration: BridgeConfiguration,
): RemoteBridgeConfigurationConstraints {
  return {
    remote_configuration_enabled: configuration.webConfigurationEnabled,
    allow_thread_titles: configuration.allowRemoteThreadTitles,
    allow_history_sync: configuration.allowHistorySync,
    allow_working_directory_configuration:
      configuration.allowRemoteWorkingDirectories,
    max_threads: configuration.localMaxThreads,
    // Kept in the compatibility envelope for older Boards/Bridges. Unlike
    // the other local constraints, concurrency is now owned by the Web
    // setting across the full supported product range.
    max_concurrent_turns: MAX_CONCURRENT_TURNS,
    max_history_turns: configuration.localMaxHistoryTurns,
    thread_scope: configuration.threadScope,
    working_directory: configuration.localWorkingDirectory,
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
  let workingDirectories = copyWorkingDirectories(
    configuration.localWorkingDirectories,
  );
  if (
    desired.working_directories !== null &&
    desired.working_directories !== undefined
  ) {
    if (configuration.allowRemoteWorkingDirectories) {
      workingDirectories = parseRemoteWorkingDirectories(
        desired.working_directories,
      );
    } else {
      warnings.push(
        "看板请求配置工作目录，但设备未启用 CODEX_BRIDGE_ALLOW_REMOTE_WORKING_DIRECTORIES；继续使用本机启动目录",
      );
    }
  }
  const workingDirectory =
    workingDirectories[0]?.workingDirectory ??
    configuration.localWorkingDirectory;
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
        MAX_CONCURRENT_TURNS,
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
      workingDirectory,
      workingDirectories,
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

function isSessionNotAuthorizedError(error: unknown): boolean {
  return (
    errorStatus(error) === 403 &&
    (error as { code?: string } | null)?.code === "SESSION_NOT_AUTHORIZED"
  );
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
    // Effective reports always carry the concrete non-empty list, even when
    // the Board desired value was null and the local startup list won.
    working_directories: remoteWorkingDirectories(
      effective.workingDirectories,
    ),
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
        working_directories:
          desired.working_directories === undefined
            ? null
            : (desired.working_directories as RemoteWorkingDirectory[] | null),
      },
      desired_bridge_version: stringValue(configuration.desired_bridge_version),
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
  const workingDirectory = threadCwd(thread);
  const directory = managedDirectoryForWorkingDirectory(
    workingDirectory,
    configuration.workingDirectories,
  );
  return {
    external_conversation_ref: thread.id,
    name: sessionName(thread, configuration),
    platform: "codex",
    model: stringValue(thread.model) ?? configuration.model,
    working_directory: workingDirectory,
    directory_key: directory?.key ?? null,
    capabilities: configuration.capabilities,
    archived: false,
  };
}

class BoardClient {
  private readonly deviceIdentity: DeviceIdentity;

  constructor(
    private readonly configuration: BridgeConfiguration,
    private readonly isStopping: () => boolean,
    deviceIdentity?: DeviceIdentity,
  ) {
    this.deviceIdentity = deviceIdentity ?? loadDeviceIdentity();
  }

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

  async downloadTaskImage(
    artifact: TaskImageArtifact,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const location = await this.request<{ url: string }>(
      `/api/ai/artifacts/${artifact.id}/download`,
      { sessionId, signal, maxAttempts: 3 },
    );
    const response = await fetch(location.url, { signal });
    if (!response.ok) throw new Error(`图片下载失败：HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength !== artifact.size || bytes.byteLength > 10 * 1024 * 1024) {
      throw new Error(`图片大小校验失败：${artifact.name}`);
    }
    return `data:${artifact.mime_type};base64,${bytes.toString("base64")}`;
  }

  async syncSessions(
    threads: ThreadRecord[],
    modelCatalog: readonly InventoryModel[] | undefined,
    quota: SyncedQuota | undefined,
    signal?: AbortSignal,
  ): Promise<Map<string, Session>> {
    const body = {
      bridge_version: BRIDGE_VERSION,
      device_id: this.deviceIdentity.deviceId,
      device_label: this.deviceIdentity.deviceLabel,
      ...(quota === undefined ? {} : { quota }),
      ...(modelCatalog === undefined
        ? {}
        : { model_catalog: modelCatalog }),
      directories: this.configuration.workingDirectories.map(
        (directory): InventoryDirectory => ({
          directory_key: directory.key,
          name: directory.name,
          working_directory: directory.workingDirectory,
        }),
      ),
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

  async claimThreadCommand(
    runtimeInstanceId: string,
    signal?: AbortSignal,
  ): Promise<ThreadCommand | null> {
    const result = await this.request<ThreadCommandResponse>(
      "/api/ai/thread-commands/claim",
      {
        method: "POST",
        maxAttempts: 1,
        timeoutMs: 5_000,
        signal,
        body: {
          runtime_instance_id: runtimeInstanceId,
          lease_seconds: 60,
        },
      },
    );
    return result.command;
  }

  async listCreatedThreadIds(signal?: AbortSignal): Promise<string[]> {
    const result = await this.request<CreatedThreadIdsResponse>(
      "/api/ai/thread-commands/created",
      {
        method: "GET",
        maxAttempts: 1,
        timeoutMs: 5_000,
        signal,
      },
    );
    return Array.isArray(result.thread_ids)
      ? result.thread_ids.filter(
          (threadId): threadId is string =>
            typeof threadId === "string" && threadId.length > 0,
        )
      : [];
  }

  async completeThreadCommand(
    runtimeInstanceId: string,
    commandId: string,
    result:
      | { succeeded: true; externalThreadId: string | null }
      | { succeeded: false; error: string },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.request<ThreadCommandResponse>(
      `/api/ai/thread-commands/${commandId}/complete`,
      {
        method: "POST",
        signal,
        body: {
          runtime_instance_id: runtimeInstanceId,
          succeeded: result.succeeded,
          external_thread_id:
            result.succeeded ? result.externalThreadId : null,
          error: result.succeeded ? null : result.error,
        },
      },
    );
  }

  async claimFileCommand(
    runtimeInstanceId: string,
    signal?: AbortSignal,
  ): Promise<FileCommand | null> {
    const result = await this.request<FileCommandResponse>(
      "/api/ai/file-commands/claim",
      {
        method: "POST",
        maxAttempts: 1,
        timeoutMs: 5_000,
        signal,
        body: {
          runtime_instance_id: runtimeInstanceId,
          lease_seconds: 60,
        },
      },
    );
    return result.command;
  }

  async completeFileCommand(
    runtimeInstanceId: string,
    commandId: string,
    result:
      | {
          succeeded: true;
          result: DeviceFileListResult | DeviceFilePreviewResult;
        }
      | { succeeded: false; error: string },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.request<FileCommandResponse>(
      `/api/ai/file-commands/${commandId}/complete`,
      {
        method: "POST",
        signal,
        body: {
          runtime_instance_id: runtimeInstanceId,
          succeeded: result.succeeded,
          result: result.succeeded ? result.result : null,
          error: result.succeeded ? null : result.error,
        },
      },
    );
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
      const visibleSummary =
        summary.trim() ||
        (bufferedText && bufferedText.trim().length > 0 ? bufferedText : null);
      // A reasoning item is only useful to the Board when Codex exposed a
      // readable summary. Never manufacture a placeholder (or fall back to
      // raw `item.content`) because that both clutters history and could blur
      // the disclosure boundary.
      if (!visibleSummary) return null;
      return {
        kind: "reasoning",
        content: redactHarnessText(
          visibleSummary,
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
    private session: Session,
    private readonly configuration: BridgeConfiguration,
    private readonly board: BoardClient,
    private readonly appServer: CodexAppServerClient,
    private readonly limiter: TurnLimiter,
    private readonly onFatal: (error: Error) => void,
  ) {}

  updateSession(session: Session): void {
    if (session.id !== this.session.id) {
      throw new Error(`Thread ${this.thread.id} received a different Session id`);
    }
    this.session = session;
  }

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
        requestTurnId &&
        (requestTurnId === this.activeTurnId ||
          (this.awaitingTurnStart && this.activeTurnId === null)),
    );
    if (this.activeClaim) {
      this.trackBackgroundBoardOperation(
        this.reportActivity(
          `request:${String(request.id)}`,
          {
          kind: "status",
          content:
            request.method === "item/tool/requestUserInput"
              ? "Codex 正在等待 Web Console 的结构化回答"
              : this.configuration.approvalMode === "decline"
              ? "Codex 请求本地审批；Bridge 已按设备策略拒绝"
              : "Codex 请求本地审批；Bridge 已按设备策略处理",
          data: {
            protocol: APP_SERVER_PROTOCOL,
            phase:
              request.method === "item/tool/requestUserInput"
                ? "waiting_user_input"
                : "completed",
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
        return this.handleStructuredUserInput(
          request,
          params,
          correlatedActiveTurn,
        );
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

  private async handleStructuredUserInput(
    request: AppServerIncomingRequest,
    params: Record<string, unknown>,
    correlatedActiveTurn: boolean,
  ): Promise<{ answers: Record<string, { answers: string[] }> }> {
    if (!correlatedActiveTurn || !this.activeClaim) {
      throw new Error(
        "Codex 结构化问题未关联到当前活动 turn，Bridge 无法安全转交",
      );
    }
    const prompt = parseStructuredUserInputRequest(params);
    const task = this.activeClaim;
    const requestId = randomUUID();
    const externalRequestId = String(request.id);

    await this.board.request("/api/ai/tasks/user-input-requests", {
      method: "POST",
      sessionId: this.session.id,
      idempotencyKey: idempotencyKey(`user-input-register/${externalRequestId}`),
      signal: this.stopController.signal,
      body: {
        task_id: task.id,
        claim_token: task.claim_token,
        request_id: requestId,
        external_request_id: externalRequestId,
        turn_id: prompt.turnId,
        item_id: prompt.itemId,
        is_blocking: true,
        questions: prompt.questions,
      },
    });

    process.stdout.write(
      `等待 Web 回答 [${shortThreadTitle(this.thread)}]：${prompt.questions
        .map((question) => question.header)
        .join(" / ")}\n`,
    );
    while (!this.stopController.signal.aborted) {
      const response = await this.board.request<UserInputPollResponse>(
        `/api/ai/tasks/user-input-requests/${requestId}/poll`,
        {
          method: "POST",
          sessionId: this.session.id,
          signal: this.stopController.signal,
          body: {
            task_id: task.id,
            claim_token: task.claim_token,
            request_id: requestId,
          },
        },
      );
      if (response.request.status === "answered") {
        const answers = parseStructuredUserInputAnswers(
          response.request.answers,
          prompt.questions,
        );
        this.trackBackgroundBoardOperation(
          this.reportActivity(
            `request:${externalRequestId}:answered`,
            {
              kind: "status",
              content: "Web Console 已提交结构化回答；原 turn 继续执行",
              data: {
                protocol: APP_SERVER_PROTOCOL,
                phase: "answered",
                request_method: request.method,
                request_id: externalRequestId,
                question_count: prompt.questions.length,
                turn_continues: true,
              },
            },
            { maxAttempts: 1 },
          ),
          `结构化回答审计 ${externalRequestId}`,
        );
        return { answers };
      }
      if (response.request.status !== "pending") {
        throw new Error(
          `Web Console 结构化回答已${
            response.request.status === "cancelled" ? "取消" : "失效"
          }`,
        );
      }
      await delay(USER_INPUT_POLL_INTERVAL_MS, this.stopController.signal);
    }
    throw this.stopController.signal.reason ?? new Error("Codex Bridge 已停止");
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
    const model = stringValue(task.model);
    const reasoningEffort = stringValue(task.reasoning_effort);
    await this.trackMutatingRequest(
      this.appServer.threadResume(
        {
          threadId: this.thread.id,
          excludeTurns: true,
          ...threadPermissionOverrides(
            this.configuration.permissionMode,
            workspaceRoot,
          ),
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
    const taskDetails = await this.board
      .request<TaskDetailsResponse>(`/api/ai/tasks/${task.id}`, {
        sessionId: this.session.id,
        signal: this.stopController.signal,
        maxAttempts: 3,
      })
      .catch((error: unknown) => {
        if ((error as { status?: number }).status === 404) return { artifacts: [] };
        throw error;
      });
    const imageArtifacts = (taskDetails.artifacts ?? []).filter((artifact) =>
      ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
        artifact.mime_type,
      ),
    );
    const imageInputs = await Promise.all(
      imageArtifacts.map(async (artifact) => ({
        type: "image",
        url: await this.board.downloadTaskImage(
          artifact,
          this.session.id,
          this.stopController.signal,
        ),
      })),
    );
    const goalMode = task.goal_mode === true;
    if (goalMode && text.length > 4_000) {
      throw new Error("Goal 目标不能超过 4000 个字符");
    }
    if (goalMode) {
      await this.trackMutatingRequest(
        this.appServer.threadGoalSet(
          { threadId: this.thread.id, objective: text },
          { timeoutMs: 0 },
        ),
      );
    } else if (task.goal_mode === false) {
      await this.trackMutatingRequest(
        this.appServer.threadGoalClear(
          { threadId: this.thread.id },
          { timeoutMs: 0 },
        ),
      );
    }
    if (this.stopping) throw new Error("Codex Bridge 正在停止");
    this.awaitingTurnStart = true;
    this.preStartNotifications.length = 0;
    let started: Awaited<ReturnType<CodexAppServerClient["turnStart"]>>;
    try {
      started = await this.trackMutatingRequest(
        this.appServer.turnStart(
          {
            threadId: this.thread.id,
            clientUserMessageId: task.id,
            input: [{ type: "text", text, text_elements: [] }, ...imageInputs],
            ...(model ? { model } : {}),
            ...(reasoningEffort ? { effort: reasoningEffort } : {}),
            // The Board persists AI replies only, so do not ask Codex to produce
            // a reasoning summary that would be discarded.
            summary: "none",
            ...turnPermissionOverrides(
              this.configuration.permissionMode,
              workspaceRoot,
            ),
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
    if (activity.kind !== "assistant_message") return;
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

  private async heartbeatSession(): Promise<void> {
    const response = await this.board.request<{ session?: Session }>(
      "/api/ai/sessions/presence",
      {
        method: "POST",
        sessionId: this.session.id,
        idempotencyKey: idempotencyKey("session-heartbeat"),
        signal: this.stopController.signal,
        body: {},
      },
    );
    if (response.session) this.updateSession(response.session);
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
  private managedThreadIds = new Set<string>();
  private readonly historySynchronizer: HistorySynchronizer;
  private historySyncPromise: Promise<void> | null = null;
  private historyConfigurationReady = false;
  private stopping = false;
  private fatalError: Error | null = null;
  private stopPromise: Promise<void> | null = null;
  private appliedConfigurationVersion: number | null = null;
  private configurationError: string | null = null;
  private updateError: string | null = null;
  private effectiveConfigurationKnown = true;
  private readonly runtimeInstanceId = randomUUID();
  private reportSequence = 0;
  private runtimeLeaseClaimed = false;
  private leaseRenewalPromise: Promise<void> | null = null;
  private leaseSafetyDeadlineMs: number | null = null;
  private latestSuccessfulReportSequence = 0;
  private legacyConfigurationCompatibility = false;
  private inventoryReady = false;
  private modelCatalog: InventoryModel[] | undefined;
  private quota: SyncedQuota | undefined;

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
    } else if (this.configuration.permissionMode === "danger-full-access") {
      process.stderr.write(
        "高风险警告：CODEX_BRIDGE_PERMISSION_MODE=danger-full-access 不使用 Codex 沙箱，thread 可访问本机用户有权访问的文件与网络\n",
      );
    }
    if (!this.configuration.threadIdFilter && this.configuration.threadScope === "all") {
      process.stderr.write(
        "高风险警告：CODEX_THREAD_SCOPE=all 会管理当前系统用户的跨项目顶层 Codex threads\n",
      );
    }
    await this.discoverModelCatalog();
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
      if (this.inventoryReady) {
        try {
          const inventoryChanged = await this.processThreadCommands();
          if (inventoryChanged && !this.stopping) {
            await this.syncWorkers();
            nextInventorySyncAt = Date.now() + this.configuration.syncIntervalMs;
          }
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
            `处理 Web Thread 管理指令失败：${errorMessage(error)}\n`,
          );
        }
      }
      if (this.inventoryReady) {
        try {
          await this.processFileCommands();
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
            `处理 Web 文件浏览指令失败：${errorMessage(error)}\n`,
          );
        }
      }
      if (this.stopping) break;
      const untilInventorySync = Math.max(1_000, nextInventorySyncAt - Date.now());
      const sleepMilliseconds = Math.min(
        this.configuration.configurationPollIntervalMs,
        untilInventorySync,
      );
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
      error: this.statusError(),
    };
  }

  private statusError(): string | null {
    const combined = [this.configurationError, this.updateError]
      .filter(Boolean)
      .join("；");
    return combined ? redactHarnessText(combined, 2_000) : null;
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
    if (!releaseRuntime && !this.stopping) {
      // A successful exchange may carry the Board's desired Bridge version.
      // A failed update never throws; the error is reported in the next
      // exchange's error field, and a successful one exits the process so
      // systemd restarts it on the new version.
      const updateError = await maybeApplyDesiredBridgeUpdate({
        desiredVersion: response.configuration.desired_bridge_version,
        currentVersion: BRIDGE_VERSION,
        allowRemoteUpdate: this.configuration.allowRemoteUpdate,
      });
      if (updateError) this.updateError = updateError;
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

      const previousEffective = effectiveBridgeConfiguration(this.configuration);
      const previousEffectiveKnown = this.effectiveConfigurationKnown;
      let resolved: ReturnType<typeof resolveRemoteConfiguration>;
      try {
        resolved = resolveRemoteConfiguration(
          this.configuration,
          remote.desired,
        );
      } catch (error) {
        // Validation failures happen before any effective state is mutated.
        // Keep reporting the last concrete state/version, but surface the
        // rejected version to the Board so Web does not wait indefinitely.
        this.configurationError =
          `应用 version=${remote.version} 失败：${errorMessage(error)}`;
        process.stderr.write(`${this.configurationError}\n`);
        await this
          .exchangeRemoteConfiguration()
          .catch(() => undefined);
        throw error;
      }
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
      this.configuration.workingDirectory =
        resolved.effective.workingDirectory;
      this.configuration.workingDirectories = copyWorkingDirectories(
        resolved.effective.workingDirectories,
      );
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
          this.configuration.workingDirectory =
            previousEffective.workingDirectory;
          this.configuration.workingDirectories = copyWorkingDirectories(
            previousEffective.workingDirectories,
          );
          this.limiter.resize(previousEffective.maxConcurrentTurns);
          this.effectiveConfigurationKnown = previousEffectiveKnown;
          this.historyConfigurationReady =
            previousEffectiveKnown && this.appliedConfigurationVersion !== null;
        } else {
          // Directory scope is safe to restore even if worker retirement or
          // inventory publication made partial progress. The version remains
          // unapplied and the next reconcile retries from the previous
          // effective allowlist instead of leaking a failed remote directory
          // change into thread creation or later inventory scans.
          this.configuration.workingDirectory =
            previousEffective.workingDirectory;
          this.configuration.workingDirectories = copyWorkingDirectories(
            previousEffective.workingDirectories,
          );
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
        }，${this.configuration.workingDirectories.length} 个工作目录，最多 ${this.configuration.maxThreads} 个 thread / ${this.configuration.maxConcurrentTurns} 个并行 turn\n`,
      );

      response = await this.exchangeRemoteConfiguration();
      this.historyConfigurationReady = true;
      this.historySynchronizer.configurationChanged();
    }
    return reconciled;
  }

  private async refreshAccountQuota(): Promise<void> {
    try {
      const quota = normalizeCodexQuota(
        await this.appServer.accountRateLimitsRead({ timeoutMs: 10_000 }),
      );
      if (!this.stopping) this.quota = quota;
    } catch (error) {
      const message = errorMessage(error);
      if (
        error instanceof AppServerRpcError &&
        (error.code === -32601 ||
          message.toLowerCase().includes("authentication required"))
      ) {
        this.quota = {
          provider: "codex",
          status: "unavailable",
          message:
            error.code === -32601
              ? "当前 Codex 版本不支持 account/rateLimits/read"
              : "当前登录方式不提供账户套餐额度",
          account: null,
          plan: null,
          fetched_at: new Date().toISOString(),
          buckets: [],
          credits: null,
        };
        return;
      }
      process.stderr.write(
        `读取 Codex 账户额度失败：${message}\n`,
      );
      this.quota = quotaError(new Date(), message);
    }
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
      this.modelCatalog,
      this.quota,
      this.stopController.signal,
    );
    if (this.stopping) return;
    void this.refreshAccountQuota();
    this.managedThreadIds = visibleThreadIds;
    this.historySynchronizer.updateTargets(
      threads.flatMap((thread) => {
        const session = sessions.get(thread.id);
        return session &&
          !session.deletion_requested_at &&
          isInteractiveHistoryThread(thread)
          ? [{
              thread,
              sessionId: session.id,
            }]
          : [];
      }),
    );

    for (const thread of threads) {
      const session = sessions.get(thread.id);
      if (!session) {
        process.stderr.write(`看板未返回 thread ${thread.id} 对应的 Session\n`);
        continue;
      }
      const existingWorker = this.workers.get(thread.id);
      if (session.deletion_requested_at) {
        existingWorker?.updateSession(session);
        if (!existingWorker) {
          process.stdout.write(
            `Thread ${thread.id} 正在等待 Web 删除指令，暂不启动 worker\n`,
          );
        }
        continue;
      }
      if (existingWorker) {
        existingWorker.updateSession(session);
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
          if (isSessionNotAuthorizedError(error)) {
            process.stderr.write(
              `Thread ${thread.id} 已被看板停用；保留 Bridge 运行以完成待处理管理指令\n`,
            );
          } else if (isPersistentClientError(error)) {
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
    this.inventoryReady = true;
  }

  private async discoverModelCatalog(): Promise<void> {
    const models: InventoryModel[] = [];
    const seenModels = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    let defaultClaimed = false;

    try {
      do {
        const response = await this.appServer.modelList(
          {
            cursor,
            limit: MODEL_CATALOG_PAGE_SIZE,
            includeHidden: false,
          },
          { signal: this.stopController.signal, timeoutMs: 5_000 },
        );
        if (!Array.isArray(response.data)) {
          throw new Error("model/list 未返回模型数组");
        }
        for (const candidate of response.data) {
          const normalized = inventoryModel(candidate, !defaultClaimed);
          if (!normalized || seenModels.has(normalized.model)) continue;
          if (normalized.is_default) defaultClaimed = true;
          seenModels.add(normalized.model);
          models.push(normalized);
          if (models.length >= MAX_MODEL_CATALOG_ENTRIES) break;
        }
        if (models.length >= MAX_MODEL_CATALOG_ENTRIES) break;

        const nextCursor = stringValue(response.nextCursor);
        if (!nextCursor) break;
        if (seenCursors.has(nextCursor)) {
          throw new Error("model/list 返回了重复分页游标");
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      } while (!this.stopping);

      this.modelCatalog = models;
      process.stdout.write(
        `已从 Codex App Server 读取 ${models.length} 个可用模型\n`,
      );
    } catch (error) {
      if (this.stopping) return;
      process.stderr.write(
        `读取 Codex 模型目录失败，Web 将使用已有目录或兼容列表：${errorMessage(error)}\n`,
      );
    }
  }

  private async processThreadCommands(): Promise<boolean> {
    let inventoryChanged = false;
    for (let processed = 0; processed < 10 && !this.stopping; processed += 1) {
      const command = await this.board.claimThreadCommand(
        this.runtimeInstanceId,
        this.stopController.signal,
      );
      if (!command) break;

      try {
        const externalThreadId = await this.executeThreadCommand(command);
        await this.board.completeThreadCommand(
          this.runtimeInstanceId,
          command.id,
          { succeeded: true, externalThreadId },
          this.stopController.signal,
        );
        inventoryChanged = true;
        process.stdout.write(
          `Web Thread 指令已完成：${command.action} (${externalThreadId ?? command.id})\n`,
        );
      } catch (error) {
        if (this.stopping) throw error;
        const message = redactHarnessText(errorMessage(error), 2_000);
        await this.board.completeThreadCommand(
          this.runtimeInstanceId,
          command.id,
          { succeeded: false, error: message },
          this.stopController.signal,
        );
        process.stderr.write(
          `Web Thread 指令 ${command.action} 失败：${message}\n`,
        );
      }
    }
    return inventoryChanged;
  }

  private async executeThreadCommand(
    command: ThreadCommand,
  ): Promise<string | null> {
    if (command.action === "create") {
      if (!this.configuration.enabled) {
        throw new Error("Bridge 已暂停，无法新建 Thread");
      }
      if (this.configuration.threadIdFilter) {
        throw new Error("固定 Thread 模式不支持从 Web 新建 Thread");
      }
      if (this.managedThreadIds.size >= this.configuration.maxThreads) {
        throw new Error("已达到 Bridge 的 Thread 数量上限");
      }
      const name = stringValue(command.name);
      if (!name) throw new Error("新建 Thread 指令缺少名称");
      const cwd = workingDirectoryForThreadCreate(
        command.directory_key,
        this.configuration.workingDirectories,
        this.configuration.workingDirectory,
      );
      const model = stringValue(command.model);
      const reasoningEffort = stringValue(command.reasoning_effort);
      const response = await this.appServer.threadStart({
        cwd,
        ...(model ? { model } : {}),
        ...(reasoningEffort
          ? { config: { model_reasoning_effort: reasoningEffort } }
          : {}),
        ...threadPermissionOverrides(this.configuration.permissionMode, cwd),
      });
      const threadId = stringValue(response.thread?.id);
      if (!threadId) throw new Error("Codex App Server 未返回新 Thread ID");
      try {
        await this.appServer.threadSetName({ threadId, name });
      } catch (error) {
        // Thread creation already committed locally. Completing the command is
        // safer than retrying thread/start and producing a duplicate; the Board
        // keeps the requested display name even on older App Server versions.
        process.stderr.write(
          `新 Thread 已创建，但本机名称同步失败：${errorMessage(error)}\n`,
        );
      }
      this.managedThreadIds.add(threadId);
      return threadId;
    }

    const threadId = stringValue(command.external_thread_id);
    const worker = threadId ? this.workers.get(threadId) : null;
    if (!threadId) throw new Error("Thread 指令缺少目标 ID");
    const managed = this.managedThreadIds.has(threadId);

    if (command.action === "rename") {
      if (!managed) {
        throw new Error("目标 Thread 不在当前 Bridge 的受管清单中");
      }
      const name = stringValue(command.name);
      if (!name) throw new Error("Thread 改名指令缺少名称");
      const model = stringValue(command.model);
      const reasoningEffort = stringValue(command.reasoning_effort);
      if (model || reasoningEffort) {
        const workspaceRoot = path.resolve(
          threadCwd(worker?.thread ?? { id: threadId }) ??
            this.configuration.workingDirectory,
        );
        const resumed = await this.appServer.threadResume({
          threadId,
          excludeTurns: true,
          ...(model ? { model } : {}),
          ...(reasoningEffort
            ? { config: { model_reasoning_effort: reasoningEffort } }
            : {}),
          ...threadPermissionOverrides(
            this.configuration.permissionMode,
            workspaceRoot,
          ),
        });
        const effectiveModel = stringValue(resumed.model);
        const effectiveReasoningEffort = stringValue(
          resumed.reasoningEffort,
        );
        if (model && effectiveModel !== model) {
          throw new Error(
            `Codex 未应用请求的模型 ${model}（实际：${effectiveModel ?? "未返回"}）`,
          );
        }
        if (
          reasoningEffort &&
          effectiveReasoningEffort !== reasoningEffort
        ) {
          throw new Error(
            `Codex 未应用请求的思考强度 ${reasoningEffort}（实际：${effectiveReasoningEffort ?? "未返回"}）`,
          );
        }
      }
      await this.appServer.threadSetName({ threadId, name });
      return threadId;
    }

    if (this.configuration.threadIdFilter) {
      throw new Error("固定 Thread 模式不支持从 Web 删除 Thread");
    }
    // A delete may be reclaimed after the previous Bridge deleted the local
    // Thread but crashed before acknowledging the command. Absence from the
    // freshly synced managed inventory makes that replay a successful no-op.
    if (!managed && (command.attempt_count ?? 1) > 1) return threadId;
    if (!managed) {
      throw new Error("目标 Thread 不在当前 Bridge 的受管清单中");
    }
    if (worker?.retirementBlocked) {
      throw new WorkerRetirementDeferredError(
        "Thread 正在启动或执行 turn，暂时不能删除",
      );
    }
    if (worker) {
      await stopWorkersForRetirement(
        [{ threadId, worker }],
        "用户从 Web Console 删除了 Codex Thread",
      );
      this.workers.delete(threadId);
    }
    try {
      await this.appServer.threadDelete({ threadId });
    } catch (error) {
      if (!(error instanceof AppServerRpcError) || error.code !== -32601) {
        throw error;
      }
      // Older compatible Codex builds expose archive but not hard delete.
      await this.appServer.threadArchive({ threadId });
    }
    this.managedThreadIds.delete(threadId);
    return threadId;
  }

  private async processFileCommands(): Promise<void> {
    for (let processed = 0; processed < 10 && !this.stopping; processed += 1) {
      const command = await this.board.claimFileCommand(
        this.runtimeInstanceId,
        this.stopController.signal,
      );
      if (!command) break;

      try {
        const result = await this.executeFileCommand(command);
        await this.board.completeFileCommand(
          this.runtimeInstanceId,
          command.id,
          { succeeded: true, result },
          this.stopController.signal,
        );
      } catch (error) {
        if (this.stopping) throw error;
        const message = redactHarnessText(errorMessage(error), 2_000);
        await this.board.completeFileCommand(
          this.runtimeInstanceId,
          command.id,
          { succeeded: false, error: message },
          this.stopController.signal,
        );
        process.stderr.write(
          `Web 文件指令 ${command.action} 失败：${message}\n`,
        );
      }
    }
  }

  private async executeFileCommand(
    command: FileCommand,
  ): Promise<DeviceFileListResult | DeviceFilePreviewResult> {
    if (command.action === "list") {
      return listDeviceDirectory(
        this.configuration.workingDirectories,
        command.path,
      );
    }
    return readDeviceFilePreview(
      this.configuration.workingDirectories,
      command.path,
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
        if (!this.shouldManageThread(thread)) continue;
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

    // App Server deliberately hides a Thread with no Turns from thread/list.
    // Successful Web creates are persisted locally and remain readable by id,
    // so merge those exact records into the authoritative inventory until the
    // first Turn makes them naturally discoverable.
    const discoveredIds = new Set(threads.map((thread) => thread.id));
    const createdThreadIds = await this.board.listCreatedThreadIds(
      this.stopController.signal,
    );
    const recovered = await Promise.all(
      createdThreadIds
        .filter((threadId) => !discoveredIds.has(threadId))
        .map(async (threadId): Promise<ThreadRecord | null> => {
          try {
            const response = await this.appServer.threadRead({
              threadId,
              includeTurns: false,
            });
            const thread = response.thread as ThreadRecord;
            return this.shouldManageThread(thread) ? thread : null;
          } catch {
            // A locally deleted/archived create can outlive its audit command.
            return null;
          }
        }),
    );
    const combined = [
      ...threads,
      ...recovered.filter((thread): thread is ThreadRecord => thread !== null),
    ];
    combined.sort((left, right) => {
      const leftRecency = left.updatedAt ?? left.createdAt ?? 0;
      const rightRecency = right.updatedAt ?? right.createdAt ?? 0;
      return rightRecency - leftRecency;
    });
    return combined.slice(0, this.configuration.maxThreads);
  }

  private shouldManageThread(thread: ThreadRecord): boolean {
    if (
      this.configuration.threadIdFilter &&
      thread.id !== this.configuration.threadIdFilter
    ) {
      return false;
    }
    if (stringValue(thread.parentThreadId)) return false;
    if (
      !this.configuration.threadIdFilter &&
      this.configuration.threadScope === "cwd"
    ) {
      const cwd = threadCwd(thread);
      return Boolean(
        cwd &&
          managedDirectoryForWorkingDirectory(
            cwd,
            this.configuration.workingDirectories,
          ),
      );
    }
    return true;
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
    // The App Server process is launched before any remote desired version is
    // fetched. Keep its process cwd tied to the immutable local startup value;
    // thread/start and every safe turn still receive the effective cwd
    // explicitly.
    cwd: configuration.localWorkingDirectory,
    unsetEnv: ["AI_TASK_BOARD_CONNECTION_TOKEN"],
    clientInfo: {
      name: "ai_task_board_bridge",
      title: "AI Task Board Bridge",
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
