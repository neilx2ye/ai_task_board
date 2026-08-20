import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { userInfo } from "node:os";
import path from "node:path";
import { createInterface, type Interface as ReadlineInterface } from "node:readline/promises";
import type { ReadStream, WriteStream } from "node:tty";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import type { ClaudeAgentMode, ClaudeApprovalMode } from "./config.js";

const DEFAULT_BOARD_URL = "https://task.neilx.online";

export const CLAUDE_BRIDGE_SYSTEMD_SERVICE =
  "ai-task-board-claude-bridge.service";

export type ClaudeSetupPaths = {
  environmentFile: string;
  unitFile: string;
  runtimeDirectory: string;
  runtimeCli: string;
};

export type ClaudeSystemdUnitOptions = {
  nodeBinary: string;
  runtimeCli: string;
  workingDirectory: string;
  homeDirectory: string;
  environmentFile: string;
};

type Choice<T extends string> = { value: T; label: string };

type WorkingDirectoryManagement = "web" | "local";

function xdgDirectory(value: string | undefined, fallback: string): string {
  return value && path.isAbsolute(value) ? path.normalize(value) : fallback;
}

function safeVersionSegment(version: string): string {
  const segment = version.replace(/[^A-Za-z0-9._-]/g, "-");
  if (!segment || segment === "." || segment === "..") {
    throw new Error(`无法使用版本 ${JSON.stringify(version)} 作为安装目录`);
  }
  return segment;
}

export function resolveSetupPaths(
  homeDirectory: string,
  packageVersion: string,
  environment: Record<string, string | undefined> = process.env,
): ClaudeSetupPaths {
  if (!path.isAbsolute(homeDirectory)) throw new Error("用户主目录必须是绝对路径");
  const configHome = xdgDirectory(
    environment.XDG_CONFIG_HOME,
    path.join(homeDirectory, ".config"),
  );
  const dataHome = xdgDirectory(
    environment.XDG_DATA_HOME,
    path.join(homeDirectory, ".local", "share"),
  );
  const runtimeDirectory = path.join(
    dataHome,
    "ai-task-board",
    "claude-bridge",
    "versions",
    safeVersionSegment(packageVersion),
  );
  return {
    environmentFile: path.join(
      configHome,
      "ai-task-board",
      "claude-bridge.env",
    ),
    unitFile: path.join(
      configHome,
      "systemd",
      "user",
      CLAUDE_BRIDGE_SYSTEMD_SERVICE,
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
  const lines = Object.entries(values)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(`无效的环境变量名：${name}`);
      }
      return `${name}=${quoteEnvironmentValue(value)}`;
    });
  return `${lines.join("\n")}\n`;
}

function decodeEnvironmentValue(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    let decoded = "";
    for (let index = 1; index < value.length - 1; index += 1) {
      if (value[index] === "\\" && index + 1 < value.length - 1) {
        const next = value[index + 1];
        if (next === "\\" || next === '"') {
          decoded += next;
          index += 1;
          continue;
        }
      }
      decoded += value[index];
    }
    return decoded;
  }
  return value;
}

export function parseEnvironmentFile(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (match) values[match[1]] = decodeEnvironmentValue(match[2]);
  }
  return values;
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

export function renderSystemdUserUnit(
  options: ClaudeSystemdUnitOptions,
): string {
  const command = [options.nodeBinary, options.runtimeCli, "run"]
    .map(quoteSystemdArgument)
    .join(" ");
  return `[Unit]
Description=AI Task Board Claude Bridge
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${escapeSystemdPath(options.workingDirectory)}
Environment=${quoteSystemdArgument(`HOME=${options.homeDirectory}`)}
EnvironmentFile=${escapeSystemdPath(options.environmentFile)}
ExecStart=${command}
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=default.target
`;
}

async function atomicWrite(
  destination: string,
  contents: string,
  mode: number,
): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(temporary, contents, {
      encoding: "utf8",
      flag: "wx",
      mode,
    });
    await rename(temporary, destination);
    await chmod(destination, mode);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function packageDirectory(packageName: string): Promise<string> {
  const require = createRequire(import.meta.url);
  let current = path.dirname(require.resolve(packageName));
  while (current !== path.dirname(current)) {
    try {
      const manifest = JSON.parse(
        await readFile(path.join(current, "package.json"), "utf8"),
      ) as { name?: string };
      if (manifest.name === packageName) return current;
    } catch {
      // Continue walking to the package root.
    }
    current = path.dirname(current);
  }
  throw new Error(`找不到依赖包目录：${packageName}`);
}

export async function installRuntime(
  sourceDistDirectory: string,
  destination: string,
  packageVersion: string,
): Promise<void> {
  const sourceCli = path.join(sourceDistDirectory, "cli.js");
  await access(sourceCli, fsConstants.R_OK).catch(() => {
    throw new Error(
      `找不到已构建的 Claude Bridge CLI：${sourceCli}。从源码运行 setup 前请先构建包。`,
    );
  });

  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const staging = `${destination}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  const previous = `${destination}.previous-${process.pid}-${randomBytes(6).toString("hex")}`;
  let movedPrevious = false;
  try {
    await mkdir(staging, { mode: 0o700 });
    await cp(sourceDistDirectory, path.join(staging, "dist"), {
      recursive: true,
    });
    await writeFile(
      path.join(staging, "package.json"),
      `${JSON.stringify(
        {
          name: "ai-task-board-claude-bridge-runtime",
          version: packageVersion,
          private: true,
          type: "module",
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await mkdir(path.join(staging, "node_modules", "@agentclientprotocol"), {
      recursive: true,
    });
    await cp(
      await packageDirectory("@agentclientprotocol/sdk"),
      path.join(staging, "node_modules", "@agentclientprotocol", "sdk"),
      { recursive: true },
    );
    await mkdir(path.join(staging, "node_modules"), { recursive: true });
    await cp(
      await packageDirectory("zod"),
      path.join(staging, "node_modules", "zod"),
      { recursive: true },
    );
    await chmod(path.join(staging, "dist", "cli.js"), 0o755);
    try {
      await stat(destination);
      await rename(destination, previous);
      movedPrevious = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(staging, destination);
    if (movedPrevious) {
      movedPrevious = false;
      await rm(previous, { recursive: true, force: true }).catch(() => {
        process.stderr.write(`旧 Claude Bridge 运行目录保留在：${previous}\n`);
      });
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    if (movedPrevious) {
      await rename(previous, destination).catch(() => undefined);
    }
    throw error;
  }
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
    child.stdout.on("data", (chunk: Buffer | string) => {
      output += String(chunk);
    });
    child.once("error", () => resolve(null));
    child.once("exit", (code) => resolve(code === 0 ? output.trim() : null));
  });
}

function runCommand(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            `${command} ${args.join(" ")} 执行失败（${
              signal ? `signal ${signal}` : `退出码 ${code ?? "unknown"}`
            }）`,
          ),
        );
      }
    });
  });
}

export async function resolveExecutable(
  executable: string,
  pathValue = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
): Promise<string | null> {
  const candidates = executable.includes("/")
    ? [path.resolve(executable)]
    : pathValue
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

class TerminalPrompter {
  private readline: ReadlineInterface;

  constructor(
    private readonly input: ReadStream,
    private readonly output: WriteStream,
  ) {
    this.readline = createInterface({
      input,
      output,
      terminal: Boolean(input.isTTY && output.isTTY),
    });
  }

  write(value: string): void {
    this.output.write(value);
  }

  async text(
    label: string,
    options: {
      defaultValue?: string;
      required?: boolean;
      validate?: (value: string) => string;
    } = {},
  ): Promise<string> {
    while (true) {
      const hint = options.defaultValue === undefined ? "" : ` [${options.defaultValue}]`;
      const answer = (await this.readline.question(`${label}${hint}: `)).trim();
      const value = answer || options.defaultValue || "";
      if (options.required && !value) {
        this.write("  该项不能为空。\n");
        continue;
      }
      try {
        return options.validate ? options.validate(value) : value;
      } catch (error) {
        this.write(`  ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  }

  async secret(label: string, existing?: string): Promise<string> {
    while (true) {
      const suffix = existing ? "（回车保留现有值）" : "";
      const answer = (await this.readSecretLine(`${label}${suffix}: `)).trim();
      if (answer) return answer;
      if (existing) return existing;
      this.write("  该项不能为空。\n");
    }
  }

  /**
   * Reads one line without echoing the typed characters. readline redraws
   * its current line with an erase-then-rewrite sequence that wipes prompt
   * text written directly to the output, and Node 22 moved its echo hook
   * from `_writeToOutput` to a Symbol, so hooking it neither renders the
   * prompt nor mutes input there. On a TTY we therefore close readline
   * (which restores terminal echo), consume raw bytes ourselves with echo
   * disabled, and recreate readline for the questions that follow; on a
   * pipe there is no echo to suppress and the value is read as a line.
   */
  private async readSecretLine(label: string): Promise<string> {
    if (!this.input.isTTY) {
      return this.readline.question(label);
    }

    this.readline.close();
    const input = this.input;
    const output = this.output;
    const rawBefore = Boolean(input.isRaw);

    try {
      return await new Promise<string>((resolve, reject) => {
        let line = "";
        let settled = false;

        const cleanup = (): void => {
          input.off("data", onData);
          input.off("end", onEnd);
          input.off("error", onError);
        };

        const finish = (error: Error | null, value?: string): void => {
          if (settled) return;
          settled = true;
          cleanup();
          try {
            input.setRawMode?.(rawBefore);
          } catch {
            // Restoring raw mode is best effort on non-TTY backing streams.
          }
          if (error) {
            reject(error);
            return;
          }
          resolve(value ?? line);
        };

        const onData = (chunk: Buffer | string): void => {
          const text =
            typeof chunk === "string" ? chunk : chunk.toString("utf8");
          for (const character of text) {
            if (character === "\r" || character === "\n") {
              output.write("\n");
              finish(null, line);
              return;
            }
            if (character === "\u0003") {
              output.write("^C\n");
              finish(new Error("Aborted with Ctrl+C"));
              return;
            }
            if (character === "\u007f" || character === "\b") {
              if (line.length > 0) {
                line = line.slice(0, -1);
              }
              continue;
            }
            if (character < "\u0020") continue;
            line += character;
          }
        };

        const onEnd = (): void => finish(new Error("输入流已关闭"));
        const onError = (error: Error): void => finish(error);

        input.setRawMode?.(true);
        this.write(label);
        input.on("data", onData);
        input.once("end", onEnd);
        input.once("error", onError);
        input.resume();
      });
    } finally {
      this.readline = createInterface({
        input: this.input,
        output: this.output,
        terminal: Boolean(this.input.isTTY && this.output.isTTY),
      });
    }
  }

  async confirm(label: string, defaultValue: boolean): Promise<boolean> {
    const hint = defaultValue ? "Y/n" : "y/N";
    while (true) {
      const answer = (await this.readline.question(`${label} [${hint}]: `))
        .trim()
        .toLowerCase();
      if (!answer) return defaultValue;
      if (["y", "yes", "是"].includes(answer)) return true;
      if (["n", "no", "否"].includes(answer)) return false;
      this.write("  请输入 y 或 n。\n");
    }
  }

  async choice<T extends string>(
    label: string,
    choices: readonly Choice<T>[],
    defaultValue: T,
  ): Promise<T> {
    this.write(`${label}\n`);
    choices.forEach((choice, index) => {
      this.write(`  ${index + 1}) ${choice.label}\n`);
    });
    const defaultIndex = Math.max(
      0,
      choices.findIndex((choice) => choice.value === defaultValue),
    );
    while (true) {
      const answer = (await this.readline.question(`请选择 [${defaultIndex + 1}]: `)).trim();
      if (!answer) return choices[defaultIndex].value;
      const index = Number(answer) - 1;
      if (Number.isInteger(index) && choices[index]) return choices[index].value;
      this.write(`  请输入 1 到 ${choices.length}。\n`);
    }
  }

  close(): void {
    this.readline.close();
  }
}

function normalizeBoardUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, "");
  const parsed = new URL(normalized);
  if (!(["http:", "https:"] as string[]).includes(parsed.protocol)) {
    throw new Error("Board 地址只支持 http:// 或 https://");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Board 地址不能包含用户名或密码");
  }
  return normalized;
}

function positiveInteger(value: string, maximum: number): string {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`请输入 1 到 ${maximum} 之间的整数`);
  }
  return String(parsed);
}

async function existingEnvironment(file: string): Promise<Record<string, string>> {
  try {
    return parseEnvironmentFile(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
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

// 多目录白名单（CLAUDE_WORKING_DIRECTORIES JSON）中的首个目录，
// 用作 local 模式下 unit 的 WorkingDirectory 与单目录兜底。
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

export interface ClaudeDirectoryManagementResolution {
  directoryManagement: WorkingDirectoryManagement;
  workingDirectory: string;
  preserveMultipleDirectories: boolean;
}

// 非交互安装的目录管理推断：已配置目录变量（单目录或多目录）则按本机固定
// 目录安装，否则默认 Web 端管理；重跑安装时因此延续既有选择。
export function resolveClaudeDirectoryManagement(input: {
  homeDirectory: string;
  configuredDirectory: string | undefined;
  rawMultipleDirectories: string | undefined;
}): ClaudeDirectoryManagementResolution {
  if (input.rawMultipleDirectories) {
    const firstDirectory = firstConfiguredWorkingDirectory(
      input.rawMultipleDirectories,
    );
    if (!firstDirectory) {
      throw new Error("CLAUDE_WORKING_DIRECTORIES 无法解析");
    }
    return {
      directoryManagement: "local",
      workingDirectory: firstDirectory,
      preserveMultipleDirectories: true,
    };
  }
  if (input.configuredDirectory) {
    return {
      directoryManagement: "local",
      workingDirectory: path.resolve(input.configuredDirectory),
      preserveMultipleDirectories: false,
    };
  }
  // Web 模式下 unit 的 WorkingDirectory 以用户主目录兜底；
  // Bridge 不再把它当作受管项目目录。
  return {
    directoryManagement: "web",
    workingDirectory: input.homeDirectory,
    preserveMultipleDirectories: false,
  };
}

interface ClaudeEnvironmentInput {
  existing: Record<string, string>;
  boardUrl: string;
  connectionToken: string;
  directoryManagement: WorkingDirectoryManagement;
  workingDirectory: string;
  preserveMultipleDirectories: boolean;
  rawMultipleDirectories: string | undefined;
  agentMode: ClaudeAgentMode;
  approvalMode: ClaudeApprovalMode;
  includeTitles: boolean;
  maxThreads: string;
  maxConcurrentTurns: string;
  webConfiguration: boolean;
  claudeBinary: string;
  pathValue: string;
}

export function buildClaudeInstallEnvironment(
  input: ClaudeEnvironmentInput,
): Record<string, string | undefined> {
  const installed: Record<string, string | undefined> = {
    ...input.existing,
    AI_TASK_BOARD_URL: input.boardUrl,
    AI_TASK_BOARD_CONNECTION_TOKEN: input.connectionToken,
    CLAUDE_BINARY: input.claudeBinary,
    CLAUDE_BRIDGE_APPROVAL_MODE: input.approvalMode,
    CLAUDE_BRIDGE_INCLUDE_SESSION_TITLES: String(input.includeTitles),
    CLAUDE_BRIDGE_MODE: input.agentMode,
    CLAUDE_BRIDGE_WEB_CONFIG: input.webConfiguration ? "true" : "false",
    CLAUDE_MAX_CONCURRENT_TURNS: input.maxConcurrentTurns,
    CLAUDE_MAX_THREADS: input.maxThreads,
    PATH: input.pathValue,
  };
  // Claude 订阅用户由 `claude login` 在本机凭据库完成认证；API / 自定义网关
  // 用户则需要把这些凭据随服务环境持久化。三者都存在时按 Claude SDK 的优先
  // 级透传，不做改写。
  for (const credential of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ] as const) {
    const value = process.env[credential]?.trim();
    if (value) installed[credential] = value;
  }
  if (input.directoryManagement === "web") {
    // Web 端管理目录需要同时放开远程目录授权，并移除本机固定目录配置
    installed.CLAUDE_BRIDGE_ALLOW_WORKING_DIRECTORY_CONFIGURATION = "true";
    delete installed.CLAUDE_WORKING_DIRECTORY;
    delete installed.CLAUDE_WORKING_DIRECTORIES;
  } else {
    installed.CLAUDE_WORKING_DIRECTORY = input.workingDirectory;
    if (input.preserveMultipleDirectories && input.rawMultipleDirectories) {
      installed.CLAUDE_WORKING_DIRECTORIES = input.rawMultipleDirectories;
    } else {
      delete installed.CLAUDE_WORKING_DIRECTORIES;
    }
  }
  return installed;
}

interface ClaudeInstallArtifacts {
  paths: ClaudeSetupPaths;
  environment: Record<string, string | undefined>;
  unitOptions: ClaudeSystemdUnitOptions;
  packageVersion: string;
}

async function installClaudeBridgeService(
  artifacts: ClaudeInstallArtifacts,
  output: (text: string) => void,
): Promise<void> {
  const sourceDistDirectory = path.dirname(fileURLToPath(import.meta.url));
  await installRuntime(
    sourceDistDirectory,
    artifacts.paths.runtimeDirectory,
    artifacts.packageVersion,
  );
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
  await runCommand("systemctl", [
    "--user",
    "enable",
    "--now",
    CLAUDE_BRIDGE_SYSTEMD_SERVICE,
  ]);
  output(
    `\nClaude Bridge 已启动。查看状态：systemctl --user status ${CLAUDE_BRIDGE_SYSTEMD_SERVICE}\n`,
  );
}

export async function runInteractiveSetup(options: {
  packageVersion: string;
}): Promise<void> {
  if (process.platform !== "linux") {
    throw new Error("交互式 systemd 安装目前只支持 Linux");
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "setup 需要交互式终端；非交互安装请提供 AI_TASK_BOARD_CONNECTION_TOKEN 环境变量",
    );
  }
  if ((await captureCommand("systemctl", ["--user", "show-environment"])) === null) {
    throw new Error("无法连接当前用户的 systemd user manager");
  }

  const identity = userInfo();
  const homeDirectory = path.resolve(identity.homedir);
  const paths = resolveSetupPaths(
    homeDirectory,
    options.packageVersion,
    process.env,
  );
  const existing = await existingEnvironment(paths.environmentFile);
  const prompt = new TerminalPrompter(process.stdin, process.stdout);
  try {
    prompt.write("\nAI Task Board Claude Bridge 交互式安装\n\n");
    prompt.write(
      `运行身份：${identity.username} (UID ${process.geteuid?.() ?? identity.uid})\n`,
    );
    // 与 Codex / Antigravity 完全一致的最少问题：Board 地址（留空使用默认）
    // 与 Connection Token；其余配置默认由 Web 端管理。
    const boardUrl = await prompt.text("Board 地址（留空使用默认）", {
      defaultValue:
        process.env.AI_TASK_BOARD_URL?.trim() ||
        existing.AI_TASK_BOARD_URL?.trim() ||
        DEFAULT_BOARD_URL,
      required: false,
      validate: normalizeBoardUrl,
    });
    const token = await prompt.secret(
      "Connection Token（输入内容不会回显）",
      process.env.AI_TASK_BOARD_CONNECTION_TOKEN?.trim() ||
        existing.AI_TASK_BOARD_CONNECTION_TOKEN?.trim() ||
        undefined,
    );
    process.env.AI_TASK_BOARD_URL = boardUrl;
    process.env.AI_TASK_BOARD_CONNECTION_TOKEN = token;

    prompt.write(`\n环境文件：${paths.environmentFile} (0600)\n`);
    prompt.write(`systemd unit：${paths.unitFile}\n`);
    prompt.write("其余配置（工作目录、并发上限、权限/审批等）由 Web 端管理。\n\n");
    if (!(await prompt.confirm("写入配置并启动 Claude Bridge", true))) {
      prompt.write("已取消，未修改任何文件。\n");
      return;
    }

    await runClaudeNonInteractiveSetup(options);
  } finally {
    prompt.close();
  }
}

export async function runClaudeNonInteractiveSetup(options: {
  packageVersion: string;
}): Promise<void> {
  if (process.platform !== "linux") {
    throw new Error(
      "systemd 安装目前只支持 Linux；其他系统请使用其他进程管理器运行 Bridge",
    );
  }
  if (
    (await captureCommand("systemctl", ["--user", "show-environment"])) === null
  ) {
    throw new Error("无法连接当前用户的 systemd user manager");
  }

  const identity = userInfo();
  const homeDirectory = path.resolve(identity.homedir);
  const paths = resolveSetupPaths(
    homeDirectory,
    options.packageVersion,
    process.env,
  );
  const existing = await existingEnvironment(paths.environmentFile);

  const boardUrlValue = configuredValue(
    existing,
    process.env,
    "AI_TASK_BOARD_URL",
  );
  const boardUrl = normalizeBoardUrl(boardUrlValue ?? DEFAULT_BOARD_URL);
  const token = configuredValue(
    existing,
    process.env,
    "AI_TASK_BOARD_CONNECTION_TOKEN",
  );
  if (!token) {
    throw new Error(
      "缺少 AI_TASK_BOARD_CONNECTION_TOKEN；非交互安装需要 Claude Code Connection Token",
    );
  }

  // 未提供目录变量时默认 Web 端管理；提供了则按本机固定目录安装
  const rawMultipleDirectories = configuredValue(
    existing,
    process.env,
    "CLAUDE_WORKING_DIRECTORIES",
  );
  const {
    directoryManagement,
    workingDirectory,
    preserveMultipleDirectories,
  } = resolveClaudeDirectoryManagement({
    homeDirectory,
    configuredDirectory: configuredValue(
      existing,
      process.env,
      "CLAUDE_WORKING_DIRECTORY",
    ),
    rawMultipleDirectories,
  });
  if (
    directoryManagement === "local" &&
    !(await stat(workingDirectory).catch(() => null))?.isDirectory()
  ) {
    throw new Error(`工作目录不存在或不是目录：${workingDirectory}`);
  }

  const requestedBinary =
    configuredValue(existing, process.env, "CLAUDE_BINARY") ??
    "claude-agent-acp";
  const claudeBinary = await resolveExecutable(requestedBinary);
  if (!claudeBinary) {
    throw new Error(
      `找不到 Claude Code ACP 适配器：${requestedBinary}。` +
        "请先运行 npm install -g @agentclientprotocol/claude-agent-acp",
    );
  }
  const claudeVersion = await captureCommand(claudeBinary, ["--version"]);
  if (!claudeVersion) {
    throw new Error("claude-agent-acp --version 执行失败");
  }

  const hasApiCredentials = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ].some((name) => process.env[name]?.trim());
  const claudeCli = await resolveExecutable("claude");
  if (!hasApiCredentials && !claudeCli) {
    process.stderr.write(
      "提示：未检测到 claude CLI 或 Anthropic 凭据环境变量。订阅用户请先运行" +
        " claude login；API 用户请在环境文件中配置 ANTHROPIC_API_KEY。\n",
    );
  }

  const maxThreads = positiveInteger(
    configuredValue(existing, process.env, "CLAUDE_MAX_THREADS") ?? "50",
    500,
  );
  const maxConcurrentTurns = positiveInteger(
    configuredValue(existing, process.env, "CLAUDE_MAX_CONCURRENT_TURNS") ?? "5",
    32,
  );
  const configuredMode =
    configuredValue(existing, process.env, "CLAUDE_BRIDGE_MODE") ?? "default";
  const agentMode = validChoice<ClaudeAgentMode>(
    configuredMode === "accept-edits"
      ? "acceptEdits"
      : configuredMode === "bypass-permissions"
        ? "bypassPermissions"
        : configuredMode,
    ["default", "plan", "acceptEdits", "bypassPermissions"],
    "default",
  );
  const approvalMode = validChoice<ClaudeApprovalMode>(
    configuredValue(existing, process.env, "CLAUDE_BRIDGE_APPROVAL_MODE"),
    ["decline", "accept"],
    "accept",
  );
  const configuredTitles = configuredValue(
    existing,
    process.env,
    "CLAUDE_BRIDGE_INCLUDE_SESSION_TITLES",
  );
  const includeTitles =
    configuredTitles === undefined ? true : configuredTitles === "true";
  const webConfiguration =
    directoryManagement === "web" ||
    configuredValue(existing, process.env, "CLAUDE_BRIDGE_WEB_CONFIG") === "true";

  await installClaudeBridgeService(
    {
      paths,
      environment: buildClaudeInstallEnvironment({
        existing,
        boardUrl,
        connectionToken: token,
        directoryManagement,
        workingDirectory,
        preserveMultipleDirectories,
        rawMultipleDirectories,
        agentMode,
        approvalMode,
        includeTitles,
        maxThreads,
        maxConcurrentTurns,
        webConfiguration,
        claudeBinary,
        pathValue: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      }),
      unitOptions: {
        nodeBinary: process.execPath,
        runtimeCli: paths.runtimeCli,
        workingDirectory,
        homeDirectory,
        environmentFile: paths.environmentFile,
      },
      packageVersion: options.packageVersion,
    },
    (text) => process.stdout.write(text),
  );
}
