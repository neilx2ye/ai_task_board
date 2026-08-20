import { mkdirSync, statSync } from "node:fs";
import path from "node:path";

import { exactPath, isRecord, parseBoolean, parseInteger, stringValue } from "./utils.js";

const DIRECTORY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_DIRECTORIES = 100;
const MAX_DIRECTORY_NAME_LENGTH = 200;
const MAX_DIRECTORY_PATH_LENGTH = 4_096;

export type ManagedWorkingDirectory = {
  key: string;
  name: string;
  workingDirectory: string;
};

export type ClaudeApprovalMode = "accept" | "decline";
export type ClaudeAgentMode =
  | "default"
  | "plan"
  | "acceptEdits"
  | "bypassPermissions";

export type ClaudeBridgeConfiguration = {
  boardUrl: string;
  connectionToken: string;
  /** Immutable device startup boundary; the effective list may diverge. */
  readonly localWorkingDirectories: readonly ManagedWorkingDirectory[];
  workingDirectories: ManagedWorkingDirectory[];
  includeSessionTitles: boolean;
  allowRemoteThreadTitles: boolean;
  allowRemoteWorkingDirectories: boolean;
  webConfigurationEnabled: boolean;
  /** Runtime switch; when false, workers heartbeat but claim no Web turns. */
  enabled: boolean;
  sessionNamePrefix: string | null;
  capabilities: string[];
  pollIntervalMs: number;
  leaseSeconds: number;
  maxThreads: number;
  /** Startup thread cap before the Web-owned live limit is applied. */
  localMaxThreads: number;
  maxConcurrentTurns: number;
  /** Inert for Claude: mirrors the Web desired value so applied state is exact. */
  historyTurnLimit: number;
  syncIntervalMs: number;
  commandPollIntervalMs: number;
  runtimeLeaseSeconds: number;
  approvalMode: ClaudeApprovalMode;
  agentMode: ClaudeAgentMode;
  claudeBinary: string;
};

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

export function parseWorkingDirectories(
  value: string | undefined,
  fallbackWorkingDirectory: string,
): ManagedWorkingDirectory[] {
  if (!value?.trim()) {
    const workingDirectory = path.resolve(fallbackWorkingDirectory);
    return [
      {
        key: "default",
        name: path.basename(workingDirectory) || workingDirectory,
        workingDirectory,
      },
    ];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("CLAUDE_WORKING_DIRECTORIES 必须是合法 JSON 数组");
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 100) {
    throw new Error("CLAUDE_WORKING_DIRECTORIES 必须包含 1 到 100 个目录");
  }

  const keys = new Set<string>();
  const paths = new Set<string>();
  return parsed.map((candidate, index) => {
    if (!isRecord(candidate)) {
      throw new Error(`CLAUDE_WORKING_DIRECTORIES[${index}] 必须是对象`);
    }
    const unknown = Object.keys(candidate).find(
      (key) => !["key", "name", "path"].includes(key),
    );
    const key = stringValue(candidate.key);
    const configuredPath = stringValue(candidate.path);
    if (unknown || !key || !DIRECTORY_KEY_PATTERN.test(key)) {
      throw new Error(`CLAUDE_WORKING_DIRECTORIES[${index}].key 格式无效`);
    }
    if (!configuredPath || configuredPath.length > 4_096) {
      throw new Error(`CLAUDE_WORKING_DIRECTORIES[${index}].path 格式无效`);
    }
    const workingDirectory = path.resolve(configuredPath);
    const name = stringValue(candidate.name) ?? path.basename(workingDirectory) ?? key;
    if (name.length > 200) {
      throw new Error(`CLAUDE_WORKING_DIRECTORIES[${index}].name 不能超过 200 个字符`);
    }
    if (keys.has(key)) throw new Error(`工作目录 key 重复：${key}`);
    if (paths.has(workingDirectory)) {
      throw new Error(`工作目录路径重复：${workingDirectory}`);
    }
    keys.add(key);
    paths.add(workingDirectory);
    return { key, name, workingDirectory };
  });
}

/**
 * Parse a Board-provided directory list only after the device has explicitly
 * enabled remote directory configuration. Unlike the legacy environment
 * parser, remote paths must already be absolute and must name real
 * directories; resolving a relative path against the Bridge process cwd would
 * silently turn an untrusted value into a different local path. Entries with
 * `create_if_missing: true` are materialized with mkdir -p first.
 */
export function parseRemoteWorkingDirectories(
  value: unknown,
): ManagedWorkingDirectory[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_DIRECTORIES
  ) {
    throw new Error("看板配置 working_directories 必须包含 1 到 100 个目录");
  }

  const keys = new Set<string>();
  const paths = new Set<string>();
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`看板配置 working_directories[${index}] 必须是对象`);
    }
    const unknownField = Object.keys(item).find(
      (field) =>
        ![
          "directory_key",
          "name",
          "working_directory",
          "create_if_missing",
        ].includes(field),
    );
    if (unknownField) {
      throw new Error(
        `看板配置 working_directories[${index}] 包含未知字段 ${unknownField}`,
      );
    }
    if (
      item.create_if_missing !== undefined &&
      typeof item.create_if_missing !== "boolean"
    ) {
      throw new Error(
        `看板配置 working_directories[${index}].create_if_missing 必须是布尔值`,
      );
    }

    const key = stringValue(item.directory_key);
    const name = stringValue(item.name);
    const configuredPath = stringValue(item.working_directory);
    if (!key || !DIRECTORY_KEY_PATTERN.test(key)) {
      throw new Error(
        `看板配置 working_directories[${index}].directory_key 格式无效`,
      );
    }
    if (!name || name.length > MAX_DIRECTORY_NAME_LENGTH) {
      throw new Error(
        `看板配置 working_directories[${index}].name 必须是 1 到 200 个字符`,
      );
    }
    if (
      !configuredPath ||
      configuredPath.length > MAX_DIRECTORY_PATH_LENGTH ||
      !path.isAbsolute(configuredPath)
    ) {
      throw new Error(
        `看板配置 working_directories[${index}].working_directory 必须是绝对路径`,
      );
    }

    const workingDirectory = path.resolve(configuredPath);
    if (workingDirectory.length > MAX_DIRECTORY_PATH_LENGTH) {
      throw new Error(
        `看板配置 working_directories[${index}].working_directory 不能超过 4096 个字符`,
      );
    }
    let isDirectory = false;
    try {
      isDirectory = statSync(workingDirectory).isDirectory();
    } catch {
      // The uniform error below deliberately avoids leaking platform-specific
      // stat details back through the remote configuration status.
    }
    if (!isDirectory && item.create_if_missing === true) {
      // Web project creation authorized this device to materialize the
      // directory; without the flag the check stays fail-closed.
      try {
        mkdirSync(workingDirectory, { recursive: true });
        isDirectory = statSync(workingDirectory).isDirectory();
      } catch {
        // Reported through the same uniform error as a plain stat failure.
      }
    }
    if (!isDirectory) {
      throw new Error(
        `看板配置 working_directories[${index}].working_directory 不存在或不是目录`,
      );
    }
    if (keys.has(key)) {
      throw new Error(`看板配置 working_directories 包含重复 key：${key}`);
    }
    if (paths.has(workingDirectory)) {
      throw new Error(
        `看板配置 working_directories 包含重复路径：${workingDirectory}`,
      );
    }
    keys.add(key);
    paths.add(workingDirectory);
    return { key, name, workingDirectory };
  });
}

function parseApprovalMode(value: string | undefined): ClaudeApprovalMode {
  const mode = value?.trim() || "accept";
  if (mode === "accept" || mode === "decline") return mode;
  throw new Error("CLAUDE_BRIDGE_APPROVAL_MODE 必须是 accept 或 decline");
}

function parseAgentMode(value: string | undefined): ClaudeAgentMode {
  const mode = value?.trim().toLowerCase() || "default";
  if (mode === "default" || mode === "plan") {
    return mode;
  }
  if (mode === "accept-edits" || mode === "acceptedits") {
    return "acceptEdits";
  }
  if (mode === "bypass-permissions" || mode === "bypasspermissions") {
    return "bypassPermissions";
  }
  throw new Error(
    "CLAUDE_BRIDGE_MODE 必须是 default、plan、accept-edits 或 bypass-permissions",
  );
}

export function loadConfiguration(
  environment: Record<string, string | undefined> = process.env,
): ClaudeBridgeConfiguration {
  const boardUrl = (environment.AI_TASK_BOARD_URL?.trim() ?? "").replace(/\/+$/, "");
  const connectionToken = environment.AI_TASK_BOARD_CONNECTION_TOKEN?.trim() ?? "";
  if (!boardUrl) throw new Error("AI_TASK_BOARD_URL is required");
  if (!connectionToken) {
    throw new Error("AI_TASK_BOARD_CONNECTION_TOKEN is required");
  }
  const url = new URL(boardUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("AI_TASK_BOARD_URL 必须使用 http 或 https");
  }

  const fallbackWorkingDirectory = path.resolve(
    environment.CLAUDE_WORKING_DIRECTORY?.trim() || process.cwd(),
  );
  const includeSessionTitles = parseBoolean(
    environment.CLAUDE_BRIDGE_INCLUDE_SESSION_TITLES,
  );
  const localMaxThreads = parseInteger(
    environment.CLAUDE_MAX_THREADS,
    50,
    1,
    500,
  );
  const localWorkingDirectories = parseWorkingDirectories(
    environment.CLAUDE_WORKING_DIRECTORIES,
    fallbackWorkingDirectory,
  );
  return {
    boardUrl,
    connectionToken,
    // The local list is an immutable device startup boundary. The effective
    // list begins as a copy and may later be replaced by an explicitly gated
    // Web configuration without losing the local fallback.
    localWorkingDirectories: localWorkingDirectories.map((directory) => ({
      ...directory,
    })),
    workingDirectories: localWorkingDirectories.map((directory) => ({
      ...directory,
    })),
    includeSessionTitles,
    allowRemoteThreadTitles: true,
    allowRemoteWorkingDirectories: true,
    webConfigurationEnabled: true,
    enabled: true,
    sessionNamePrefix: environment.CLAUDE_SESSION_NAME?.trim() || null,
    capabilities: parseList(
      environment.CLAUDE_CAPABILITIES || "coding,shell,file-edit,multi-thread,acp",
    ),
    pollIntervalMs: parseInteger(
      environment.AI_TASK_BOARD_POLL_INTERVAL_MS,
      5_000,
      500,
      60_000,
    ),
    leaseSeconds: parseInteger(
      environment.AI_TASK_BOARD_LEASE_SECONDS,
      900,
      60,
      3_600,
    ),
    maxThreads: localMaxThreads,
    localMaxThreads,
    maxConcurrentTurns: parseInteger(
      environment.CLAUDE_MAX_CONCURRENT_TURNS,
      5,
      1,
      32,
    ),
    historyTurnLimit: 50,
    syncIntervalMs: parseInteger(
      environment.AI_TASK_BOARD_THREAD_SYNC_INTERVAL_MS,
      60_000,
      10_000,
      600_000,
    ),
    commandPollIntervalMs: parseInteger(
      environment.AI_TASK_BOARD_CONFIG_POLL_INTERVAL_MS,
      5_000,
      1_000,
      600_000,
    ),
    runtimeLeaseSeconds: 30,
    approvalMode: parseApprovalMode(environment.CLAUDE_BRIDGE_APPROVAL_MODE),
    agentMode: parseAgentMode(environment.CLAUDE_BRIDGE_MODE),
    claudeBinary:
      environment.CLAUDE_BINARY?.trim() || "claude-agent-acp",
  };
}

export function directoryForWorkingDirectory(
  cwd: string,
  directories: readonly ManagedWorkingDirectory[],
): ManagedWorkingDirectory | null {
  return (
    directories.find((directory) => exactPath(cwd, directory.workingDirectory)) ??
    null
  );
}

export function workingDirectoryForKey(
  key: string | null,
  directories: readonly ManagedWorkingDirectory[],
): string {
  if (!key) return directories[0]?.workingDirectory ?? process.cwd();
  const directory = directories.find((candidate) => candidate.key === key);
  if (!directory) {
    throw new Error("目标工作目录不在 Claude Bridge 的本机白名单中");
  }
  return directory.workingDirectory;
}
