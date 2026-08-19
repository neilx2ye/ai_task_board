import { spawn } from "node:child_process";
import { access, mkdir, readFile, chmod, writeFile, rename } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_BOARD_URL,
  normalizeBoardUrl,
  promptForConnectionBasics,
  TerminalPrompter,
} from "./interactive.js";
import {
  BRIDGE_SYSTEMD_SERVICE,
  installRuntime,
  parseEnvironmentFile,
  renderSystemdUserUnit,
  resolveSetupPaths,
  serializeEnvironmentFile,
  type SetupPaths,
} from "./setup.js";
import {
  parseEnabledKinds,
  UNIFIED_BRIDGE_KINDS,
  type UnifiedBridgeKind,
} from "./supervisor.js";

export const UNIFIED_ENVIRONMENT_FILE = "ai-task-board-bridge.env";

/**
 * One shared device configuration for all four runtimes. The four Bridges are
 * configured in a single pass and read the same environment file; per-Bridge
 * prompts or separate configuration rounds are not needed. Values only fill
 * fields the user has not already configured, and can be overridden through
 * environment variables when automating the install.
 */
const UNIFIED_DEVICE_DEFAULTS: Readonly<Record<string, string>> = {
  // Codex
  CODEX_THREAD_SCOPE: "cwd",
  CODEX_MAX_THREADS: "50",
  CODEX_BRIDGE_PERMISSION_MODE: "safe",
  CODEX_BRIDGE_APPROVAL_MODE: "decline",
  CODEX_BRIDGE_WEB_CONFIG: "true",
  CODEX_BRIDGE_INCLUDE_THREAD_TITLES: "true",
  CODEX_BRIDGE_ALLOW_HISTORY_SYNC: "true",
  CODEX_BRIDGE_ALLOW_REMOTE_WORKING_DIRECTORIES: "true",
  CODEX_BINARY: "codex",
  // Kimi Code
  KIMI_BINARY: "kimi",
  KIMI_BRIDGE_APPROVAL_MODE: "decline",
  KIMI_BRIDGE_INCLUDE_SESSION_TITLES: "true",
  KIMI_BRIDGE_MODE: "auto",
  KIMI_BRIDGE_WEB_CONFIG: "true",
  KIMI_MAX_THREADS: "50",
  KIMI_MAX_CONCURRENT_TURNS: "2",
  KIMI_BRIDGE_ALLOW_WORKING_DIRECTORY_CONFIGURATION: "true",
  // Antigravity
  ANTIGRAVITY_BINARY: "agy",
  ANTIGRAVITY_BRIDGE_APPROVAL_MODE: "decline",
  ANTIGRAVITY_BRIDGE_MODE: "auto",
  ANTIGRAVITY_BRIDGE_SANDBOX: "false",
  ANTIGRAVITY_BRIDGE_WEB_CONFIG: "true",
  ANTIGRAVITY_MAX_THREADS: "50",
  ANTIGRAVITY_MAX_CONCURRENT_TURNS: "2",
  ANTIGRAVITY_BRIDGE_ALLOW_WORKING_DIRECTORY_CONFIGURATION: "true",
  // Claude Code
  CLAUDE_BINARY: "claude-agent-acp",
  CLAUDE_BRIDGE_APPROVAL_MODE: "decline",
  CLAUDE_BRIDGE_INCLUDE_SESSION_TITLES: "true",
  CLAUDE_BRIDGE_MODE: "default",
  CLAUDE_BRIDGE_WEB_CONFIG: "true",
  CLAUDE_MAX_THREADS: "50",
  CLAUDE_MAX_CONCURRENT_TURNS: "2",
  CLAUDE_BRIDGE_ALLOW_WORKING_DIRECTORY_CONFIGURATION: "true",
};

const CLAUDE_CREDENTIAL_ENVIRONMENT = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

/** Anthropic's official ACP adapter installed on demand for Claude Code. */
const CLAUDE_ACP_DEFAULT_PACKAGE = "@agentclientprotocol/claude-agent-acp@0.70.0";

const LEGACY_SERVICES: ReadonlyArray<{
  kind: UnifiedBridgeKind;
  service: string;
  environmentFile: string;
}> = [
  {
    kind: "codex",
    service: "ai-task-board-codex-bridge.service",
    environmentFile: "codex-bridge.env",
  },
  {
    kind: "kimi",
    service: "ai-task-board-kimi-bridge.service",
    environmentFile: "kimi-bridge.env",
  },
  {
    kind: "antigravity",
    service: "ai-task-board-antigravity-bridge.service",
    environmentFile: "antigravity-bridge.env",
  },
  {
    kind: "claude",
    service: "ai-task-board-claude-bridge.service",
    environmentFile: "claude-bridge.env",
  },
];

function runCommand(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} 执行失败${
            signal ? `（signal ${signal}）` : `（退出码 ${code ?? "unknown"}）`
          }`,
        ),
      );
    });
  });
}

function captureCommand(
  command: string,
  args: readonly string[],
): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      output += chunk.toString();
    });
    child.once("error", () => resolve(null));
    child.once("exit", (code) => resolve(code === 0 ? output.trim() : null));
  });
}

async function readEnvironment(file: string): Promise<Record<string, string>> {
  try {
    return parseEnvironmentFile(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function atomicWrite(
  destination: string,
  contents: string,
  mode: number,
): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(temporary, contents, { encoding: "utf8", flag: "wx", mode });
    await rename(temporary, destination);
    await chmod(destination, mode);
  } catch (error) {
    try {
      await access(temporary, fsConstants.F_OK);
      await rename(temporary, `${temporary}.failed`);
    } catch {
      // Best effort cleanup.
    }
    throw error;
  }
}

/**
 * Fold the Claude Code ACP adapter into the single setup command: when the
 * Claude runtime is enabled, install Anthropic's adapter into the managed
 * data directory and point CLAUDE_BINARY at it, so `npx ... setup` is still
 * the only command the user has to run. An explicit CLAUDE_BINARY or an
 * already-installed adapter is left untouched.
 */
async function ensureClaudeAcpAdapter(
  environment: Record<string, string | undefined>,
  paths: SetupPaths,
  output: (text: string) => void,
): Promise<void> {
  const configured = environment.CLAUDE_BINARY?.trim();
  if (configured && configured !== "claude-agent-acp") return;

  const adapterRoot = path.join(
    path.dirname(path.dirname(paths.runtimeDirectory)),
    "claude-acp",
  );
  const adapterBinary = path.join(
    adapterRoot,
    "node_modules",
    ".bin",
    "claude-agent-acp",
  );
  try {
    await access(adapterBinary, fsConstants.X_OK);
    environment.CLAUDE_BINARY = adapterBinary;
    return;
  } catch {
    // Not installed yet; install below.
  }

  const packageSpec =
    process.env.CLAUDE_ACP_PACKAGE?.trim() || CLAUDE_ACP_DEFAULT_PACKAGE;
  try {
    await mkdir(adapterRoot, { recursive: true, mode: 0o700 });
    await runCommand("npm", [
      "install",
      "--prefix",
      adapterRoot,
      "--no-save",
      "--omit=dev",
      packageSpec,
    ]);
    await access(adapterBinary, fsConstants.X_OK);
    environment.CLAUDE_BINARY = adapterBinary;
    output(`已安装 Claude Code ACP 适配器：${adapterBinary}\n`);
  } catch (error) {
    output(
      `警告：Claude Code ACP 适配器安装失败（${
        error instanceof Error ? error.message : String(error)
      }），将回退到 PATH 上的 claude-agent-acp。\n`,
    );
  }
}

function enabledKindsFrom(
  value: string | undefined,
): UnifiedBridgeKind[] | null {
  if (!value?.trim()) return null;
  return parseEnabledKinds(value);
}

function mergeEnabledKinds(
  ...lists: readonly (readonly UnifiedBridgeKind[] | null)[]
): UnifiedBridgeKind[] {
  const merged = new Set<UnifiedBridgeKind>();
  for (const list of lists) {
    if (!list) continue;
    for (const kind of list) merged.add(kind);
  }
  if (!merged.size) return [...UNIFIED_BRIDGE_KINDS];
  return UNIFIED_BRIDGE_KINDS.filter((kind) => merged.has(kind));
}

export interface UnifiedSetupOptions {
  packageVersion: string;
  /** Explicit single targets such as `setup codex`; unioned with the install. */
  targets?: readonly UnifiedBridgeKind[];
}

async function prepareEnvironment(
  options: UnifiedSetupOptions,
  interactive: boolean,
): Promise<{
  environment: Record<string, string | undefined>;
  kinds: UnifiedBridgeKind[];
  homeDirectory: string;
}> {
  const identity = userInfo();
  const homeDirectory = path.resolve(
    process.env.HOME?.trim() || identity.homedir,
  );
  const configDirectory = path.join(homeDirectory, ".config", "ai-task-board");
  const unifiedFile = path.join(configDirectory, UNIFIED_ENVIRONMENT_FILE);
  const existing = await readEnvironment(unifiedFile);

  // Absorb the four legacy per-Bridge env files so a re-run on an upgraded
  // device keeps every platform-specific setting without re-asking.
  const merged: Record<string, string> = {};
  for (const legacy of LEGACY_SERVICES) {
    const legacyEnvironment = await readEnvironment(
      path.join(configDirectory, legacy.environmentFile),
    );
    for (const [name, value] of Object.entries(legacyEnvironment)) {
      if (merged[name] === undefined) merged[name] = value;
    }
  }
  for (const [name, value] of Object.entries(existing)) {
    merged[name] = value;
  }
  // Explicit environment values override the saved configuration and persist
  // into the single shared file; Claude API/custom-gateway credentials follow
  // the same passthrough the standalone Claude setup used.
  for (const name of Object.keys(UNIFIED_DEVICE_DEFAULTS)) {
    const value = process.env[name]?.trim();
    if (value) merged[name] = value;
  }
  for (const credential of CLAUDE_CREDENTIAL_ENVIRONMENT) {
    const value = process.env[credential]?.trim();
    if (value) merged[credential] = value;
  }

  const environmentValue = process.env.AI_TASK_BOARD_BRIDGES;
  const existingKinds = enabledKindsFrom(merged.AI_TASK_BOARD_BRIDGES);
  const requestedKinds =
    options.targets && options.targets.length > 0 ? options.targets : null;

  let kinds: UnifiedBridgeKind[];
  if (environmentValue?.trim()) {
    kinds = parseEnabledKinds(environmentValue);
  } else if (interactive) {
    kinds = mergeEnabledKinds(
      existingKinds,
      requestedKinds ?? [...UNIFIED_BRIDGE_KINDS],
    );
  } else {
    kinds = mergeEnabledKinds(
      existingKinds,
      requestedKinds,
      requestedKinds ? null : [...UNIFIED_BRIDGE_KINDS],
    );
  }

  let boardUrl =
    process.env.AI_TASK_BOARD_URL?.trim() ||
    merged.AI_TASK_BOARD_URL?.trim() ||
    DEFAULT_BOARD_URL;
  let connectionToken =
    process.env.AI_TASK_BOARD_CONNECTION_TOKEN?.trim() ||
    merged.AI_TASK_BOARD_CONNECTION_TOKEN?.trim() ||
    undefined;

  if (interactive) {
    const prompt = new TerminalPrompter(process.stdin, process.stdout);
    try {
      const basics = await promptForConnectionBasics(prompt, {
        existing: merged,
        environment: process.env,
      });
      boardUrl = basics.boardUrl;
      connectionToken = basics.connectionToken;
      const defaultHint = kinds.join(",");
      const answer = (
        await prompt.text(
          "要启用的 Bridge 类型（codex、kimi、antigravity、claude 或 all，逗号分隔）",
          { defaultValue: defaultHint, required: false },
        )
      ).trim();
      if (answer) kinds = parseEnabledKinds(answer);
    } finally {
      prompt.close();
    }
  } else if (!connectionToken) {
    throw new Error(
      "缺少 AI_TASK_BOARD_CONNECTION_TOKEN；请提供环境变量，或在交互式终端中运行 setup",
    );
  }

  boardUrl = normalizeBoardUrl(boardUrl);
  const environment: Record<string, string | undefined> = {
    ...UNIFIED_DEVICE_DEFAULTS,
    ...merged,
    AI_TASK_BOARD_URL: boardUrl,
    AI_TASK_BOARD_CONNECTION_TOKEN: connectionToken,
    AI_TASK_BOARD_BRIDGES: kinds.join(","),
    HOME: homeDirectory,
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  };
  if (!environment.CODEX_HOME?.trim()) {
    environment.CODEX_HOME = path.join(homeDirectory, ".codex");
  }
  return { environment, kinds, homeDirectory };
}

export async function runUnifiedSetup(
  options: UnifiedSetupOptions,
  interactive: boolean,
): Promise<void> {
  if (process.platform !== "linux") {
    throw new Error(
      "systemd 安装目前只支持 Linux；其他系统请使用其他进程管理器运行统一 Bridge（run all）",
    );
  }
  if (
    (await captureCommand("systemctl", ["--user", "show-environment"])) === null
  ) {
    throw new Error(
      "无法连接当前用户的 systemd user manager；请在目标用户的登录会话中运行 setup",
    );
  }

  const identity = userInfo();
  const effectiveUid = process.geteuid?.() ?? identity.uid;
  const { environment, kinds, homeDirectory } = await prepareEnvironment(
    options,
    interactive,
  );
  if (effectiveUid === 0) {
    process.stderr.write(
      "警告：当前有效用户是 root，将安装 root 的用户服务并使用 root 的登录配置。\n",
    );
  }

  const paths = resolveSetupPaths(
    homeDirectory,
    options.packageVersion,
    environment,
  );
  const sourcePackageDirectory = fileURLToPath(new URL("../", import.meta.url));
  await installRuntime(sourcePackageDirectory, paths);
  if (kinds.includes("claude")) {
    await ensureClaudeAcpAdapter(environment, paths, (text) =>
      process.stdout.write(text),
    );
  }

  await mkdir(paths.configDirectory, { recursive: true, mode: 0o700 });
  await chmod(paths.configDirectory, 0o700);
  await atomicWrite(
    path.join(paths.configDirectory, UNIFIED_ENVIRONMENT_FILE),
    serializeEnvironmentFile(environment),
    0o600,
  );

  const unit = renderSystemdUserUnit({
    nodeBinary: process.execPath,
    runtimeCli: paths.runtimeCli,
    workingDirectory: homeDirectory,
    homeDirectory,
    codexHome: String(environment.CODEX_HOME),
    environmentFile: path.join(
      paths.configDirectory,
      UNIFIED_ENVIRONMENT_FILE,
    ),
    runArgs: "all",
  });
  await atomicWrite(paths.unitFile, unit, 0o644);

  await runCommand("systemctl", ["--user", "daemon-reload"]);
  await runCommand("systemctl", ["--user", "enable", paths.unitFile]);

  // A unified service replaces the four legacy per-Bridge services.
  const legacyWasActive: string[] = [];
  for (const legacy of LEGACY_SERVICES) {
    const legacyUnitPath = path.join(
      path.dirname(paths.unitFile),
      legacy.service,
    );
    try {
      await access(legacyUnitPath, fsConstants.F_OK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    try {
      const active = await captureCommand("systemctl", [
        "--user",
        "is-active",
        legacy.service,
      ]);
      if (active === "active") legacyWasActive.push(legacy.service);
      await runCommand("systemctl", [
        "--user",
        "disable",
        "--now",
        legacy.service,
      ]);
      process.stdout.write(
        `已停用旧服务 ${legacy.service}，其配置已并入统一设备 Bridge。\n`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        const message =
          error instanceof Error ? error.message : String(error);
        if (!/not loaded|Failed to disable unit/i.test(message)) throw error;
      }
    }
  }

  try {
    await runCommand("systemctl", [
      "--user",
      "restart",
      BRIDGE_SYSTEMD_SERVICE,
    ]);
  } catch (error) {
    await runCommand("systemctl", [
      "--user",
      "disable",
      "--now",
      BRIDGE_SYSTEMD_SERVICE,
    ]).catch(() => undefined);
    for (const service of legacyWasActive) {
      process.stdout.write(`新服务启动失败，正在恢复旧服务 ${service}。\n`);
      await runCommand("systemctl", ["--user", "enable", "--now", service]).catch(
        () => undefined,
      );
    }
    throw error;
  }

  process.stdout.write(`\n统一设备 Bridge 安装完成。\n`);
  process.stdout.write(
    `服务 ${BRIDGE_SYSTEMD_SERVICE} 正以 ${identity.username} (UID ${identity.uid}) 运行，启用类型：${kinds.join("、")}。\n`,
  );
  process.stdout.write(
    `查看状态：systemctl --user status ${BRIDGE_SYSTEMD_SERVICE}\n`,
  );
  process.stdout.write(
    `查看日志：journalctl --user -u ${BRIDGE_SYSTEMD_SERVICE} -f\n`,
  );
  process.stdout.write(
    "再次运行 setup 时 Token 留空即保留现值、输入新值则替换，并可启用新加入的 Bridge 类型。\n",
  );

  const linger = await captureCommand("loginctl", [
    "show-user",
    String(identity.uid),
    "-p",
    "Linger",
    "--value",
  ]);
  if (linger !== "yes") {
    process.stdout.write(
      `提示：若需退出登录后仍运行，请由管理员执行 sudo loginctl enable-linger ${identity.username}\n`,
    );
  }
}
