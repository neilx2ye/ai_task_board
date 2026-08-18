import { mkdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  exactPath,
  isRecord,
  parseBoolean,
  parseInteger,
  stringValue,
} from "./utils.js";

const DIRECTORY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_DIRECTORIES = 100;
const MAX_DIRECTORY_NAME_LENGTH = 200;
const MAX_DIRECTORY_PATH_LENGTH = 4_096;
const DURATION_PATTERN = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/;

export type ManagedWorkingDirectory = {
  key: string;
  name: string;
  workingDirectory: string;
};

export type AntigravityApprovalMode = "accept" | "decline";
export type AntigravityAgentMode = "default" | "accept-edits" | "plan" | "auto";

export type AntigravityBridgeConfiguration = {
  boardUrl: string;
  connectionToken: string;
  /** Immutable device startup boundary; the effective list may diverge. */
  readonly localWorkingDirectories: readonly ManagedWorkingDirectory[];
  workingDirectories: ManagedWorkingDirectory[];
  includeSessionTitles: boolean;
  allowRemoteWorkingDirectories: boolean;
  webConfigurationEnabled: boolean;
  /** Runtime switch; when false, workers heartbeat but claim no Web turns. */
  enabled: boolean;
  sessionNamePrefix: string | null;
  capabilities: string[];
  pollIntervalMs: number;
  leaseSeconds: number;
  /** Applied thread cap; Web may lower it but never exceed `localMaxThreads`. */
  maxThreads: number;
  /** Device-wide ceiling parsed from ANTIGRAVITY_MAX_THREADS. */
  localMaxThreads: number;
  maxConcurrentTurns: number;
  /** Inert for Antigravity: mirrors the Web desired value for exact status. */
  historyTurnLimit: number;
  syncIntervalMs: number;
  commandPollIntervalMs: number;
  runtimeLeaseSeconds: number;
  approvalMode: AntigravityApprovalMode;
  agentMode: AntigravityAgentMode;
  sandbox: boolean;
  agyBinary: string;
  stateDir: string;
  codeAssistBaseUrl: string;
  registryFile: string;
  printTimeoutMs: number;
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
    throw new Error("ANTIGRAVITY_WORKING_DIRECTORIES 必须是合法 JSON 数组");
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 100) {
    throw new Error("ANTIGRAVITY_WORKING_DIRECTORIES 必须包含 1 到 100 个目录");
  }

  const keys = new Set<string>();
  const paths = new Set<string>();
  return parsed.map((candidate, index) => {
    if (!isRecord(candidate)) {
      throw new Error(`ANTIGRAVITY_WORKING_DIRECTORIES[${index}] 必须是对象`);
    }
    const unknown = Object.keys(candidate).find(
      (key) => !["key", "name", "path"].includes(key),
    );
    const key = stringValue(candidate.key);
    const configuredPath = stringValue(candidate.path);
    if (unknown || !key || !DIRECTORY_KEY_PATTERN.test(key)) {
      throw new Error(`ANTIGRAVITY_WORKING_DIRECTORIES[${index}].key 格式无效`);
    }
    if (!configuredPath || configuredPath.length > 4_096) {
      throw new Error(`ANTIGRAVITY_WORKING_DIRECTORIES[${index}].path 格式无效`);
    }
    const workingDirectory = path.resolve(configuredPath);
    const name =
      stringValue(candidate.name) ?? path.basename(workingDirectory) ?? key;
    if (name.length > 200) {
      throw new Error(
        `ANTIGRAVITY_WORKING_DIRECTORIES[${index}].name 不能超过 200 个字符`,
      );
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

function parseApprovalMode(
  value: string | undefined,
): AntigravityApprovalMode {
  const mode = value?.trim() || "accept";
  if (mode === "accept" || mode === "decline") return mode;
  throw new Error("ANTIGRAVITY_BRIDGE_APPROVAL_MODE 必须是 accept 或 decline");
}

function parseAgentMode(value: string | undefined): AntigravityAgentMode {
  const mode = value?.trim() || "auto";
  if (["default", "accept-edits", "plan", "auto"].includes(mode)) {
    return mode as AntigravityAgentMode;
  }
  throw new Error(
    "ANTIGRAVITY_BRIDGE_MODE 必须是 default、accept-edits、plan 或 auto",
  );
}

function parseDurationMs(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const match = DURATION_PATTERN.exec(value.trim());
  if (!match) {
    throw new Error(
      "ANTIGRAVITY_PRINT_TIMEOUT 必须是 Go 时长格式，例如 5m、90s 或 1h",
    );
  }
  const amount = Number(match[1]);
  const unit = match[2] as "ms" | "s" | "m" | "h";
  const multiplier = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[unit];
  const milliseconds = Math.round(amount * multiplier);
  if (milliseconds < 30_000 || milliseconds > 3_600_000) {
    throw new Error("ANTIGRAVITY_PRINT_TIMEOUT 必须在 30 秒到 1 小时之间");
  }
  return milliseconds;
}

function xdgDirectory(
  value: string | undefined,
  fallback: string,
): string {
  return value && path.isAbsolute(value) ? path.normalize(value) : fallback;
}

export function defaultRegistryFile(
  homeDirectory: string,
  environment: Record<string, string | undefined> = process.env,
): string {
  const dataHome = xdgDirectory(
    environment.XDG_DATA_HOME,
    path.join(homeDirectory, ".local", "share"),
  );
  return path.join(
    dataHome,
    "ai-task-board",
    "antigravity-bridge",
    "registry.json",
  );
}

export function loadConfiguration(
  environment: Record<string, string | undefined> = process.env,
): AntigravityBridgeConfiguration {
  const boardUrl = (
    environment.AI_TASK_BOARD_URL?.trim() ?? ""
  ).replace(/\/+$/, "");
  const connectionToken =
    environment.AI_TASK_BOARD_CONNECTION_TOKEN?.trim() ?? "";
  if (!boardUrl) throw new Error("AI_TASK_BOARD_URL is required");
  if (!connectionToken) {
    throw new Error("AI_TASK_BOARD_CONNECTION_TOKEN is required");
  }
  const url = new URL(boardUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("AI_TASK_BOARD_URL 必须使用 http 或 https");
  }

  const fallbackWorkingDirectory = path.resolve(
    environment.ANTIGRAVITY_WORKING_DIRECTORY?.trim() || process.cwd(),
  );
  const localWorkingDirectories = parseWorkingDirectories(
    environment.ANTIGRAVITY_WORKING_DIRECTORIES,
    fallbackWorkingDirectory,
  );
  const localMaxThreads = parseInteger(
    environment.ANTIGRAVITY_MAX_THREADS,
    50,
    1,
    500,
  );
  const leaseSeconds = parseInteger(
    environment.AI_TASK_BOARD_LEASE_SECONDS,
    900,
    60,
    3_600,
  );
  const configuredTimeout = parseDurationMs(
    environment.ANTIGRAVITY_PRINT_TIMEOUT,
  );
  // agy headless exits on its own timeout, so keep that ceiling comfortably
  // below the Board lease when the user did not pick an explicit value.
  const printTimeoutMs =
    configuredTimeout ?? Math.max(60_000, leaseSeconds * 1_000 - 30_000);

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
    includeSessionTitles: true,
    allowRemoteWorkingDirectories: parseBoolean(
      environment.ANTIGRAVITY_BRIDGE_ALLOW_WORKING_DIRECTORY_CONFIGURATION,
    ),
    webConfigurationEnabled: parseBoolean(
      environment.ANTIGRAVITY_BRIDGE_WEB_CONFIG,
    ),
    enabled: true,
    sessionNamePrefix: environment.ANTIGRAVITY_SESSION_NAME?.trim() || null,
    capabilities: parseList(
      environment.ANTIGRAVITY_CAPABILITIES ||
        "coding,shell,file-edit,multi-thread,antigravity-cli",
    ),
    pollIntervalMs: parseInteger(
      environment.AI_TASK_BOARD_POLL_INTERVAL_MS,
      5_000,
      500,
      60_000,
    ),
    leaseSeconds,
    maxThreads: localMaxThreads,
    localMaxThreads,
    maxConcurrentTurns: parseInteger(
      environment.ANTIGRAVITY_MAX_CONCURRENT_TURNS,
      2,
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
    approvalMode: parseApprovalMode(
      environment.ANTIGRAVITY_BRIDGE_APPROVAL_MODE,
    ),
    agentMode: parseAgentMode(environment.ANTIGRAVITY_BRIDGE_MODE),
    sandbox: parseBoolean(environment.ANTIGRAVITY_BRIDGE_SANDBOX),
    agyBinary: environment.ANTIGRAVITY_BINARY?.trim() || "agy",
    stateDir: path.resolve(
      environment.ANTIGRAVITY_STATE_DIR?.trim() ||
        path.join(os.homedir(), ".gemini", "antigravity-cli"),
    ),
    codeAssistBaseUrl:
      environment.AGY_CODE_ASSIST_BASE_URL?.trim() ||
      "https://daily-cloudcode-pa.googleapis.com/v1internal",
    registryFile: environment.ANTIGRAVITY_REGISTRY_FILE?.trim()
      ? path.resolve(environment.ANTIGRAVITY_REGISTRY_FILE.trim())
      : defaultRegistryFile(
          environment.HOME || process.env.HOME || process.cwd(),
          environment,
        ),
    printTimeoutMs,
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
    throw new Error("目标工作目录不在 Antigravity Bridge 的本机白名单中");
  }
  return directory.workingDirectory;
}
