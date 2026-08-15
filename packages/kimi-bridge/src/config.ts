import path from "node:path";

import { exactPath, isRecord, parseBoolean, parseInteger, stringValue } from "./utils.js";

const DIRECTORY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export type ManagedWorkingDirectory = {
  key: string;
  name: string;
  workingDirectory: string;
};

export type KimiApprovalMode = "accept" | "decline";
export type KimiAgentMode = "default" | "plan" | "auto" | "yolo";

export type KimiBridgeConfiguration = {
  boardUrl: string;
  connectionToken: string;
  workingDirectories: ManagedWorkingDirectory[];
  includeSessionTitles: boolean;
  sessionNamePrefix: string | null;
  capabilities: string[];
  pollIntervalMs: number;
  leaseSeconds: number;
  maxThreads: number;
  maxConcurrentTurns: number;
  syncIntervalMs: number;
  commandPollIntervalMs: number;
  runtimeLeaseSeconds: number;
  approvalMode: KimiApprovalMode;
  agentMode: KimiAgentMode;
  kimiBinary: string;
  kimiWebServerUrl: string | null;
  kimiWebServerToken: string | null;
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
    throw new Error("KIMI_WORKING_DIRECTORIES 必须是合法 JSON 数组");
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 100) {
    throw new Error("KIMI_WORKING_DIRECTORIES 必须包含 1 到 100 个目录");
  }

  const keys = new Set<string>();
  const paths = new Set<string>();
  return parsed.map((candidate, index) => {
    if (!isRecord(candidate)) {
      throw new Error(`KIMI_WORKING_DIRECTORIES[${index}] 必须是对象`);
    }
    const unknown = Object.keys(candidate).find(
      (key) => !["key", "name", "path"].includes(key),
    );
    const key = stringValue(candidate.key);
    const configuredPath = stringValue(candidate.path);
    if (unknown || !key || !DIRECTORY_KEY_PATTERN.test(key)) {
      throw new Error(`KIMI_WORKING_DIRECTORIES[${index}].key 格式无效`);
    }
    if (!configuredPath || configuredPath.length > 4_096) {
      throw new Error(`KIMI_WORKING_DIRECTORIES[${index}].path 格式无效`);
    }
    const workingDirectory = path.resolve(configuredPath);
    const name = stringValue(candidate.name) ?? path.basename(workingDirectory) ?? key;
    if (name.length > 200) {
      throw new Error(`KIMI_WORKING_DIRECTORIES[${index}].name 不能超过 200 个字符`);
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

function parseApprovalMode(value: string | undefined): KimiApprovalMode {
  const mode = value?.trim() || "accept";
  if (mode === "accept" || mode === "decline") return mode;
  throw new Error("KIMI_BRIDGE_APPROVAL_MODE 必须是 accept 或 decline");
}

function parseAgentMode(value: string | undefined): KimiAgentMode {
  const mode = value?.trim() || "auto";
  if (["default", "plan", "auto", "yolo"].includes(mode)) {
    return mode as KimiAgentMode;
  }
  throw new Error("KIMI_BRIDGE_MODE 必须是 default、plan、auto 或 yolo");
}

export function loadConfiguration(
  environment: Record<string, string | undefined> = process.env,
): KimiBridgeConfiguration {
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
    environment.KIMI_WORKING_DIRECTORY?.trim() || process.cwd(),
  );
  return {
    boardUrl,
    connectionToken,
    workingDirectories: parseWorkingDirectories(
      environment.KIMI_WORKING_DIRECTORIES,
      fallbackWorkingDirectory,
    ),
    includeSessionTitles: parseBoolean(
      environment.KIMI_BRIDGE_INCLUDE_SESSION_TITLES,
    ),
    sessionNamePrefix: environment.KIMI_SESSION_NAME?.trim() || null,
    capabilities: parseList(
      environment.KIMI_CAPABILITIES || "coding,shell,file-edit,multi-thread,acp",
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
    maxThreads: parseInteger(environment.KIMI_MAX_THREADS, 50, 1, 500),
    maxConcurrentTurns: parseInteger(
      environment.KIMI_MAX_CONCURRENT_TURNS,
      2,
      1,
      32,
    ),
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
    approvalMode: parseApprovalMode(environment.KIMI_BRIDGE_APPROVAL_MODE),
    agentMode: parseAgentMode(environment.KIMI_BRIDGE_MODE),
    kimiBinary: environment.KIMI_BINARY?.trim() || "kimi",
    kimiWebServerUrl: environment.KIMI_WEB_SERVER_URL?.trim() || null,
    kimiWebServerToken: environment.KIMI_WEB_SERVER_TOKEN?.trim() || null,
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
    throw new Error("目标工作目录不在 Kimi Bridge 的本机白名单中");
  }
  return directory.workingDirectory;
}
