import { constants as fsConstants } from "node:fs";
import { createRequire } from "node:module";
import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
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

export const BRIDGE_SYSTEMD_SERVICE = "ai-task-board-bridge.service";
export const LEGACY_BRIDGE_SYSTEMD_SERVICE =
  "ai-task-board-codex-bridge.service";

/** Runtime packages required by the embedded Kimi/Claude runtimes. */
const EMBEDDED_RUNTIME_DEPENDENCIES = [
  "@agentclientprotocol/sdk",
  // Peer dependency of the ACP SDK; copied so the versioned runtime directory
  // resolves `zod/v4` without a global install.
  "zod",
] as const;

/**
 * Resolve one runtime dependency directory. The first base is the staged npm
 * package (npx cache or workspace); the second is the currently installed
 * runtime, which already carries the dependency after its first install, so
 * the self-update path can rebuild node_modules from an npm tarball that
 * deliberately ships no dependencies.
 */
async function runtimeDependencyDirectory(
  packageName: string,
  sourcePackageDirectory: string,
): Promise<string> {
  const bases = [
    path.join(sourcePackageDirectory, "package.json"),
    fileURLToPath(new URL("../package.json", import.meta.url)),
  ];
  for (const base of bases) {
    try {
      const require = createRequire(base);
      let current = path.dirname(require.resolve(packageName));
      while (current !== path.dirname(current)) {
        try {
          const manifest = JSON.parse(
            await readFile(path.join(current, "package.json"), "utf8"),
          ) as { name?: string };
          if (manifest.name === packageName) return current;
        } catch {
          // Keep walking to the package root.
        }
        current = path.dirname(current);
      }
    } catch {
      // Try the next resolution base.
    }
  }
  throw new Error(
    `找不到运行时依赖包目录：${packageName}。请从包含依赖的 npm 包运行 setup。`,
  );
}

type ThreadScope = "cwd" | "all";
type PermissionMode = "safe" | "danger-full-access" | "inherit";
type ApprovalMode = "decline" | "accept" | "accept-session";
type WorkingDirectoryManagement = "web" | "local";

export interface SetupPaths {
  configDirectory: string;
  environmentFile: string;
  unitFile: string;
  runtimeDirectory: string;
  runtimeCli: string;
}

export interface SystemdUnitOptions {
  nodeBinary: string;
  runtimeCli: string;
  workingDirectory: string;
  homeDirectory: string;
  codexHome: string;
  environmentFile: string;
  /** Additional CLI arguments after `run` (e.g. "all" for the unified daemon). */
  runArgs?: string;
}

function xdgDirectory(
  value: string | undefined,
  fallback: string,
): string {
  return value && path.isAbsolute(value) ? path.normalize(value) : fallback;
}

function safeVersionSegment(version: string): string {
  const segment = version.replace(/[^A-Za-z0-9._-]/g, "-");
  if (!segment || segment === "." || segment === "..") {
    throw new Error(`无法使用 npm 包版本 ${JSON.stringify(version)} 作为安装目录`);
  }
  return segment;
}

export function resolveSetupPaths(
  homeDirectory: string,
  packageVersion: string,
  environment: Record<string, string | undefined> = process.env,
): SetupPaths {
  if (!path.isAbsolute(homeDirectory)) {
    throw new Error("用户主目录必须是绝对路径");
  }
  const configHome = xdgDirectory(
    environment.XDG_CONFIG_HOME,
    path.join(homeDirectory, ".config"),
  );
  const dataHome = xdgDirectory(
    environment.XDG_DATA_HOME,
    path.join(homeDirectory, ".local", "share"),
  );
  const configDirectory = path.join(configHome, "ai-task-board");
  const runtimeDirectory = path.join(
    dataHome,
    "ai-task-board",
    "codex-bridge",
    "versions",
    safeVersionSegment(packageVersion),
  );
  return {
    configDirectory,
    environmentFile: path.join(configDirectory, "codex-bridge.env"),
    unitFile: path.join(
      configHome,
      "systemd",
      "user",
      BRIDGE_SYSTEMD_SERVICE,
    ),
    runtimeDirectory,
    runtimeCli: path.join(runtimeDirectory, "dist", "cli.js"),
  };
}

function assertSingleLine(value: string, description: string): void {
  if (/[\0\r\n]/.test(value)) {
    throw new Error(`${description} 不能包含换行符或 NUL`);
  }
}

function quoteEnvironmentValue(value: string): string {
  assertSingleLine(value, "环境变量值");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function serializeEnvironmentFile(
  values: Record<string, string | undefined>,
): string {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(values).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (value === undefined) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`无效的环境变量名：${name}`);
    }
    lines.push(`${name}=${quoteEnvironmentValue(value)}`);
  }
  return `${lines.join("\n")}\n`;
}

function decodeEnvironmentValue(rawValue: string): string {
  const value = rawValue.trim();
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    let decoded = "";
    for (let index = 1; index < value.length - 1; index += 1) {
      const character = value[index];
      if (character === "\\" && index + 1 < value.length - 1) {
        const next = value[index + 1];
        if (next === "\\" || next === '"') {
          decoded += next;
          index += 1;
          continue;
        }
      }
      decoded += character;
    }
    return decoded;
  }
  let decoded = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\\" && index + 1 < value.length) {
      index += 1;
    }
    decoded += value[index];
  }
  return decoded;
}

export function parseEnvironmentFile(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match) continue;
    values[match[1]] = decodeEnvironmentValue(match[2]);
  }
  return values;
}

function stripTomlComment(line: string): string {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === '"' && character === "\\" && !escaped) {
      escaped = true;
      continue;
    }
    if (character === quote && !escaped) {
      quote = null;
    } else if (!quote && (character === '"' || character === "'")) {
      quote = character;
    } else if (!quote && character === "#") {
      return line.slice(0, index);
    }
    escaped = false;
  }
  return line;
}

function addEnvironmentName(names: Set<string>, value: string | undefined): void {
  if (value && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) names.add(value);
}

export function discoverCodexProviderEnvironmentVariables(
  configToml: string,
): string[] {
  const names = new Set<string>();
  const uncommentedLines = configToml.split(/\r?\n/).map(stripTomlComment);
  let inEnvironmentHeadersTable = false;

  for (const line of uncommentedLines) {
    const section = /^\s*\[\s*([^\]]+)\s*\]\s*$/.exec(line);
    if (section) {
      const sectionName = section[1].trim();
      inEnvironmentHeadersTable =
        sectionName.startsWith("model_providers.") &&
        sectionName.endsWith(".env_http_headers");
      continue;
    }

    const envKey = /^\s*env_key\s*=\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/.exec(
      line,
    );
    addEnvironmentName(names, envKey?.[1]);
    if (inEnvironmentHeadersTable) {
      const headerValue = /^\s*(?:[A-Za-z0-9_-]+|["'][^"']+["'])\s*=\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/.exec(
        line,
      );
      addEnvironmentName(names, headerValue?.[1]);
    }
  }

  const uncommented = uncommentedLines.join("\n");
  for (const block of uncommented.matchAll(/\benv_http_headers\s*=\s*\{([^}]*)\}/gs)) {
    for (const entry of block[1].matchAll(
      /=\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g,
    )) {
      addEnvironmentName(names, entry[1]);
    }
  }
  return [...names].sort();
}

function quoteSystemdArgument(value: string): string {
  assertSingleLine(value, "systemd unit 值");
  return `"${value
    .replace(/%/g, "%%")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')}"`;
}

function escapeSystemdPath(value: string): string {
  assertSingleLine(value, "systemd 路径");
  if (!path.isAbsolute(value)) throw new Error(`systemd 路径必须是绝对路径：${value}`);
  // `WorkingDirectory=` and `EnvironmentFile=` accept the rest of the line as
  // a single bare path. systemd does not decode `\x20` in these settings, so
  // literal spaces must be preserved rather than escaped. Only `%` needs
  // doubling here, because systemd would otherwise treat it as a specifier.
  return value.replace(/%/g, "%%");
}

export function renderSystemdUserUnit(options: SystemdUnitOptions): string {
  const command = [
    options.nodeBinary,
    options.runtimeCli,
    "run",
    ...(options.runArgs ? [options.runArgs] : []),
  ]
    .map(quoteSystemdArgument)
    .join(" ");
  return `[Unit]
Description=AI Task Board Bridge
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${escapeSystemdPath(options.workingDirectory)}
Environment=${quoteSystemdArgument(`HOME=${options.homeDirectory}`)}
Environment=${quoteSystemdArgument(`CODEX_HOME=${options.codexHome}`)}
EnvironmentFile=${escapeSystemdPath(options.environmentFile)}
ExecStart=${command}
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=default.target
`;
}

async function pathIsDirectory(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

function expandPath(
  value: string,
  homeDirectory: string,
  workingDirectory: string,
): string {
  const expanded =
    value === "~"
      ? homeDirectory
      : value.startsWith("~/")
        ? path.join(homeDirectory, value.slice(2))
        : value;
  return path.resolve(workingDirectory, expanded);
}

export async function resolveExecutable(
  value: string,
  options: {
    cwd: string;
    homeDirectory: string;
    pathValue?: string;
  },
): Promise<string | null> {
  const executable = value.trim();
  if (!executable) return null;
  const candidates = executable.includes("/")
    ? [expandPath(executable, options.homeDirectory, options.cwd)]
    : (options.pathValue ?? "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((directory) => path.join(directory, executable));
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      if (!(await stat(candidate)).isDirectory()) return path.resolve(candidate);
    } catch {
      // Try the next PATH entry.
    }
  }
  return null;
}

async function readExistingEnvironment(
  environmentFile: string,
): Promise<Record<string, string>> {
  try {
    return parseEnvironmentFile(await readFile(environmentFile, "utf8"));
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
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function installRuntime(
  sourcePackageDirectory: string,
  paths: SetupPaths,
): Promise<void> {
  const sourceCli = path.join(sourcePackageDirectory, "dist", "cli.js");
  try {
    await access(sourceCli, fsConstants.R_OK);
  } catch {
    throw new Error(
      `找不到已构建的 Bridge CLI：${sourceCli}。从源码运行 setup 前请先构建 npm 包。`,
    );
  }

  let runtimeExists = false;
  try {
    const runtimeStat = await stat(paths.runtimeDirectory);
    if (!runtimeStat.isDirectory()) {
      throw new Error(`Bridge 运行路径已存在且不是目录：${paths.runtimeDirectory}`);
    }
    runtimeExists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await mkdir(path.dirname(paths.runtimeDirectory), {
    recursive: true,
    mode: 0o700,
  });
  const staging = `${paths.runtimeDirectory}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  const previous = `${paths.runtimeDirectory}.previous-${process.pid}-${randomBytes(6).toString("hex")}`;
  let movedPrevious = false;
  try {
    await mkdir(staging, { mode: 0o700 });
    await cp(path.join(sourcePackageDirectory, "dist"), path.join(staging, "dist"), {
      recursive: true,
      force: true,
    });
    await copyFile(
      path.join(sourcePackageDirectory, "package.json"),
      path.join(staging, "package.json"),
    );
    for (const dependency of EMBEDDED_RUNTIME_DEPENDENCIES) {
      const dependencySource = await runtimeDependencyDirectory(
        dependency,
        sourcePackageDirectory,
      );
      const dependencyDestination = path.join(
        staging,
        "node_modules",
        ...dependency.split("/"),
      );
      await mkdir(path.dirname(dependencyDestination), {
        recursive: true,
        mode: 0o700,
      });
      await cp(dependencySource, dependencyDestination, {
        recursive: true,
        force: true,
      });
    }
    try {
      await copyFile(
        path.join(sourcePackageDirectory, "README.md"),
        path.join(staging, "README.md"),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await chmod(path.join(staging, "dist", "cli.js"), 0o755);
    if (runtimeExists) {
      await rename(paths.runtimeDirectory, previous);
      movedPrevious = true;
    }
    await rename(staging, paths.runtimeDirectory);
    if (movedPrevious) {
      movedPrevious = false;
      await rm(previous, { recursive: true, force: true }).catch(() => {
        process.stderr.write(`旧 Bridge 运行目录保留在：${previous}\n`);
      });
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    if (movedPrevious) {
      try {
        await rename(previous, paths.runtimeDirectory);
        movedPrevious = false;
      } catch {
        // Keep the previous directory in place for manual recovery.
      }
    }
    throw error;
  } finally {
    if (movedPrevious) {
      // A failed restore is intentionally retained rather than deleted.
      process.stderr.write(`旧 Bridge 运行目录保留在：${previous}\n`);
    }
  }
}

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

function configuredValue(
  existing: Record<string, string>,
  environment: Record<string, string | undefined>,
  name: string,
): string | undefined {
  return environment[name]?.trim() || existing[name]?.trim() || undefined;
}

function validChoice<T extends string>(
  value: string | undefined,
  choices: readonly T[],
  fallback: T,
): T {
  return value && (choices as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function validIntegerInRange(
  value: string | undefined,
  fallback: string,
  minimum: number,
  maximum: number,
): string {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`请输入 ${minimum} 到 ${maximum} 的整数`);
  }
  return String(parsed);
}

function firstConfiguredWorkingDirectory(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const first = parsed[0] as { path?: unknown } | undefined;
    return typeof first?.path === "string" && path.isAbsolute(first.path)
      ? path.normalize(first.path)
      : null;
  } catch {
    return null;
  }
}

async function ownerUid(candidate: string): Promise<number | null> {
  try {
    return (await stat(candidate)).uid;
  } catch {
    return null;
  }
}

export interface InteractiveSetupOptions {
  packageVersion: string;
}

interface CodexEnvironmentInput {
  existing: Record<string, string>;
  providerEnvironment: Record<string, string>;
  boardUrl: string;
  connectionToken: string;
  directoryManagement: WorkingDirectoryManagement;
  workingDirectory: string;
  preserveMultipleDirectories: boolean;
  rawMultipleDirectories: string | undefined;
  threadScope: ThreadScope;
  maxThreads: string;
  permissionMode: PermissionMode;
  approvalMode: ApprovalMode;
  webConfiguration: boolean;
  allowRemoteWorkingDirectories: boolean;
  codexBinary: string;
  codexHome: string;
  homeDirectory: string;
  pathValue: string;
}

export function buildCodexInstallEnvironment(
  input: CodexEnvironmentInput,
): Record<string, string | undefined> {
  const installed: Record<string, string | undefined> = {
    ...input.existing,
    ...input.providerEnvironment,
    AI_TASK_BOARD_URL: input.boardUrl,
    AI_TASK_BOARD_CONNECTION_TOKEN: input.connectionToken,
    CODEX_THREAD_SCOPE: input.threadScope,
    CODEX_MAX_THREADS: input.maxThreads,
    CODEX_MAX_CONCURRENT_TURNS:
      input.existing.CODEX_MAX_CONCURRENT_TURNS?.trim() || "5",
    CODEX_BRIDGE_INCLUDE_THREAD_TITLES:
      input.existing.CODEX_BRIDGE_INCLUDE_THREAD_TITLES?.trim() || "true",
    CODEX_BRIDGE_ALLOW_HISTORY_SYNC:
      input.existing.CODEX_BRIDGE_ALLOW_HISTORY_SYNC?.trim() || "true",
    CODEX_BRIDGE_PERMISSION_MODE: input.permissionMode,
    CODEX_BRIDGE_APPROVAL_MODE: input.approvalMode,
    CODEX_BRIDGE_WEB_CONFIG: input.webConfiguration ? "true" : "false",
    CODEX_BRIDGE_ALLOW_REMOTE_WORKING_DIRECTORIES:
      input.allowRemoteWorkingDirectories ? "true" : "false",
    CODEX_BINARY: input.codexBinary,
    CODEX_HOME: input.codexHome,
    HOME: input.homeDirectory,
    PATH: input.pathValue,
  };
  if (input.directoryManagement === "web") {
    delete installed.CODEX_WORKING_DIRECTORY;
    delete installed.CODEX_WORKING_DIRECTORIES;
  } else {
    installed.CODEX_WORKING_DIRECTORY = input.workingDirectory;
    if (input.preserveMultipleDirectories && input.rawMultipleDirectories) {
      installed.CODEX_WORKING_DIRECTORIES = input.rawMultipleDirectories;
    } else {
      delete installed.CODEX_WORKING_DIRECTORIES;
    }
  }
  return installed;
}

interface CodexInstallArtifacts {
  paths: SetupPaths;
  environment: Record<string, string | undefined>;
  unitOptions: SystemdUnitOptions;
  identity: { username: string; uid: number };
}

async function installCodexBridgeService(
  artifacts: CodexInstallArtifacts,
  output: (text: string) => void,
): Promise<void> {
  const sourcePackageDirectory = fileURLToPath(new URL("../", import.meta.url));
  await installRuntime(sourcePackageDirectory, artifacts.paths);
  await mkdir(artifacts.paths.configDirectory, {
    recursive: true,
    mode: 0o700,
  });
  await chmod(artifacts.paths.configDirectory, 0o700);
  await atomicWrite(
    artifacts.paths.environmentFile,
    serializeEnvironmentFile(artifacts.environment),
    0o600,
  );
  await atomicWrite(
    artifacts.paths.unitFile,
    renderSystemdUserUnit(artifacts.unitOptions),
    0o644,
  );

  await runCommand("systemctl", ["--user", "daemon-reload"]);
  await runCommand("systemctl", ["--user", "enable", artifacts.paths.unitFile]);

  const legacyUnitPath = path.join(
    path.dirname(artifacts.paths.unitFile),
    LEGACY_BRIDGE_SYSTEMD_SERVICE,
  );
  let legacyWasActive = false;
  let legacyWasEnabled = false;
  try {
    await access(legacyUnitPath, fsConstants.F_OK);
    legacyWasActive =
      (await captureCommand("systemctl", [
        "--user",
        "is-active",
        LEGACY_BRIDGE_SYSTEMD_SERVICE,
      ])) === "active";
    legacyWasEnabled =
      (await captureCommand("systemctl", [
        "--user",
        "is-enabled",
        LEGACY_BRIDGE_SYSTEMD_SERVICE,
      ])) === "enabled";
    output(
      `检测到旧服务 ${LEGACY_BRIDGE_SYSTEMD_SERVICE}，正在停用以避免重复运行。\n`,
    );
    await runCommand("systemctl", [
      "--user",
      "disable",
      "--now",
      LEGACY_BRIDGE_SYSTEMD_SERVICE,
    ]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
    if (legacyWasActive) {
      output("新服务启动失败，正在恢复旧服务。\n");
      await runCommand("systemctl", [
        "--user",
        "enable",
        "--now",
        LEGACY_BRIDGE_SYSTEMD_SERVICE,
      ]).catch(() => undefined);
    } else if (legacyWasEnabled) {
      await runCommand("systemctl", [
        "--user",
        "enable",
        LEGACY_BRIDGE_SYSTEMD_SERVICE,
      ]).catch(() => undefined);
    }
    throw error;
  }

  output("\n安装完成。\n");
  output(
    `服务 ${BRIDGE_SYSTEMD_SERVICE} 正以 ${artifacts.identity.username} (UID ${artifacts.identity.uid}) 运行。\n`,
  );
  output(`查看状态：systemctl --user status ${BRIDGE_SYSTEMD_SERVICE}\n`);
  output(`查看日志：journalctl --user -u ${BRIDGE_SYSTEMD_SERVICE} -f\n`);
  output(
    "安装器未设置模型覆盖；默认模型由这个用户的 Codex 配置和目标 Thread 决定。\n",
  );

  const linger = await captureCommand("loginctl", [
    "show-user",
    String(artifacts.identity.uid),
    "-p",
    "Linger",
    "--value",
  ]);
  if (linger !== "yes") {
    output(
      `提示：若需退出登录后仍运行，请由管理员执行 sudo loginctl enable-linger ${artifacts.identity.username}\n`,
    );
  }
}

export async function runNonInteractiveSetup(
  options: InteractiveSetupOptions,
): Promise<void> {
  if (process.platform !== "linux") {
    throw new Error(
      "systemd 安装目前只支持 Linux；其他系统请使用其他进程管理器运行 Bridge",
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
  const homeDirectory = path.resolve(identity.homedir);
  if (effectiveUid === 0) {
    process.stderr.write(
      "警告：当前有效用户是 root，将安装 root 的用户服务并使用 root 的 Codex 配置。\n",
    );
  }
  const environment = process.env;
  const paths = resolveSetupPaths(
    homeDirectory,
    options.packageVersion,
    environment,
  );
  const existing = await readExistingEnvironment(paths.environmentFile);

  const boardUrlValue = configuredValue(
    existing,
    environment,
    "AI_TASK_BOARD_URL",
  );
  const boardUrl = normalizeBoardUrl(boardUrlValue ?? DEFAULT_BOARD_URL);
  const connectionToken = configuredValue(
    existing,
    environment,
    "AI_TASK_BOARD_CONNECTION_TOKEN",
  );
  if (!connectionToken) {
    throw new Error(
      "缺少 AI_TASK_BOARD_CONNECTION_TOKEN；非交互安装需要 Connection Token",
    );
  }

  const rawMultipleDirectories = configuredValue(
    existing,
    environment,
    "CODEX_WORKING_DIRECTORIES",
  );
  let directoryManagement: WorkingDirectoryManagement = "web";
  let preserveMultipleDirectories = false;
  let workingDirectory = homeDirectory;
  if (rawMultipleDirectories) {
    const firstDirectory = firstConfiguredWorkingDirectory(
      rawMultipleDirectories,
    );
    if (!firstDirectory) {
      throw new Error("CODEX_WORKING_DIRECTORIES 无法解析");
    }
    directoryManagement = "local";
    preserveMultipleDirectories = true;
    workingDirectory = firstDirectory;
  } else {
    const configuredDirectory = configuredValue(
      existing,
      environment,
      "CODEX_WORKING_DIRECTORY",
    );
    if (configuredDirectory) {
      directoryManagement = "local";
      workingDirectory = expandPath(
        configuredDirectory,
        homeDirectory,
        process.cwd(),
      );
    }
  }
  if (
    directoryManagement === "local" &&
    !(await pathIsDirectory(workingDirectory))
  ) {
    throw new Error(`工作目录不存在或不是目录：${workingDirectory}`);
  }

  const codexHome = expandPath(
    configuredValue(existing, environment, "CODEX_HOME") ??
      path.join(homeDirectory, ".codex"),
    homeDirectory,
    process.cwd(),
  );
  const codexHomeUid = await ownerUid(codexHome);
  if (codexHomeUid !== null && codexHomeUid !== effectiveUid) {
    throw new Error(
      `Codex 配置目录属于 UID ${codexHomeUid}，不是当前 UID ${effectiveUid}`,
    );
  }

  const pathValue = environment.PATH || "/usr/local/bin:/usr/bin:/bin";
  const codexBinaryInput =
    configuredValue(existing, environment, "CODEX_BINARY") ?? "codex";
  const codexBinary = await resolveExecutable(codexBinaryInput, {
    cwd: process.cwd(),
    homeDirectory,
    pathValue,
  });
  if (!codexBinary) {
    throw new Error(
      `找不到可执行的 Codex CLI：${codexBinaryInput}。请先以 ${identity.username} 安装 Codex。`,
    );
  }

  const providerEnvironment: Record<string, string> = {};
  try {
    const providerNames = discoverCodexProviderEnvironmentVariables(
      await readFile(path.join(codexHome, "config.toml"), "utf8"),
    );
    for (const name of providerNames) {
      const value = environment[name] ?? existing[name];
      if (value !== undefined) providerEnvironment[name] = value;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      process.stderr.write(
        `提示：无法检查 ${path.join(codexHome, "config.toml")} 中的 provider 环境变量。\n`,
      );
    }
  }

  const threadScope = validChoice(
    configuredValue(existing, environment, "CODEX_THREAD_SCOPE"),
    ["cwd", "all"],
    "cwd",
  );
  const maxThreads = validIntegerInRange(
    configuredValue(existing, environment, "CODEX_MAX_THREADS") ?? "50",
    "50",
    1,
    500,
  );
  const permissionMode = validChoice(
    configuredValue(existing, environment, "CODEX_BRIDGE_PERMISSION_MODE"),
    ["safe", "danger-full-access", "inherit"],
    "danger-full-access",
  );
  const approvalMode = validChoice(
    configuredValue(existing, environment, "CODEX_BRIDGE_APPROVAL_MODE"),
    ["decline", "accept", "accept-session"],
    "accept",
  );
  const webConfiguration =
    directoryManagement === "web" ||
    configuredValue(existing, environment, "CODEX_BRIDGE_WEB_CONFIG") ===
      "true";
  const allowRemoteWorkingDirectories =
    directoryManagement === "web" ||
    configuredValue(
      existing,
      environment,
      "CODEX_BRIDGE_ALLOW_REMOTE_WORKING_DIRECTORIES",
    ) === "true";

  const installedEnvironment = buildCodexInstallEnvironment({
    existing,
    providerEnvironment,
    boardUrl,
    connectionToken,
    directoryManagement,
    workingDirectory,
    preserveMultipleDirectories,
    rawMultipleDirectories,
    threadScope,
    maxThreads,
    permissionMode,
    approvalMode,
    webConfiguration,
    allowRemoteWorkingDirectories,
    codexBinary,
    codexHome,
    homeDirectory,
    pathValue,
  });

  await installCodexBridgeService(
    {
      paths,
      environment: installedEnvironment,
      unitOptions: {
        nodeBinary: process.execPath,
        runtimeCli: paths.runtimeCli,
        workingDirectory,
        homeDirectory,
        codexHome,
        environmentFile: paths.environmentFile,
      },
      identity: { username: identity.username, uid: effectiveUid },
    },
    (text) => process.stdout.write(text),
  );
}

export async function runInteractiveSetup(
  options: InteractiveSetupOptions,
): Promise<void> {
  if (process.platform !== "linux") {
    throw new Error("交互式 systemd 安装目前只支持 Linux");
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "setup 需要交互式终端；非交互安装请提供 AI_TASK_BOARD_CONNECTION_TOKEN 环境变量",
    );
  }

  if ((await captureCommand("systemctl", ["--user", "show-environment"])) === null) {
    throw new Error(
      "无法连接当前用户的 systemd user manager；请在目标用户的登录会话中运行 setup",
    );
  }

  const identity = userInfo();
  const effectiveUid = process.geteuid?.() ?? identity.uid;
  const homeDirectory = path.resolve(identity.homedir);
  const environment = process.env;
  const paths = resolveSetupPaths(homeDirectory, options.packageVersion, environment);
  const existing = await readExistingEnvironment(paths.environmentFile);
  const prompt = new TerminalPrompter(process.stdin, process.stdout);

  try {
    prompt.write("\nAI Task Board Codex Bridge 交互式安装\n\n");
    prompt.write(
      `运行身份：${identity.username} (UID ${effectiveUid})\n用户目录：${homeDirectory}\n`,
    );
    prompt.write(
      "将安装为该 UID 的 systemd 用户服务；unit 不会写入 User=，也不会使用 sudo。\n\n",
    );
    if (
      environment.HOME &&
      path.resolve(environment.HOME) !== homeDirectory
    ) {
      prompt.write(
        `提示：环境中的 HOME=${environment.HOME} 与当前 UID 的主目录不同；安装器将使用 ${homeDirectory}。\n\n`,
      );
    }

    if (effectiveUid === 0) {
      prompt.write(
        "警告：当前有效用户是 root，继续会安装 root 的用户服务并使用 root 的 Codex 配置。\n",
      );
      if (!(await prompt.confirm("确认以 root 身份继续", false))) {
        prompt.write("已取消，未修改任何文件。\n");
        return;
      }
    }

    // 四套 Bridge 的交互流程统一只问最少的问题：Board 地址（留空使用默认）
    // 与 Connection Token。工作目录、数量/并发上限、权限与审批策略等
    // 其余配置默认交给 Web 端管理。
    const basics = await promptForConnectionBasics(prompt, {
      existing,
      environment,
    });
    environment.AI_TASK_BOARD_URL = basics.boardUrl;
    environment.AI_TASK_BOARD_CONNECTION_TOKEN = basics.connectionToken;

    prompt.write(`\n环境文件：${paths.environmentFile} (0600)\n`);
    prompt.write(`systemd unit：${paths.unitFile}\n`);
    prompt.write("其余配置（工作目录、并发上限、权限/审批等）由 Web 端管理。\n\n");
    if (!(await prompt.confirm("安装并立即启动 systemd 用户服务", true))) {
      prompt.write("已取消，未修改任何文件。\n");
      return;
    }

    await runNonInteractiveSetup(options);
  } finally {
    prompt.close();
  }
}
