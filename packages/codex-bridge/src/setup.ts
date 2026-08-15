import { constants as fsConstants } from "node:fs";
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
import { createInterface, type Interface as ReadlineInterface } from "node:readline/promises";
import type { ReadStream, WriteStream } from "node:tty";
import { fileURLToPath } from "node:url";

export const BRIDGE_SYSTEMD_SERVICE = "ai-task-board-bridge.service";
export const LEGACY_BRIDGE_SYSTEMD_SERVICE =
  "ai-task-board-codex-bridge.service";

type ThreadScope = "cwd" | "all";
type PermissionMode = "safe" | "danger-full-access" | "inherit";
type ApprovalMode = "decline" | "accept" | "accept-session";

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
}

interface Choice<T extends string> {
  value: T;
  label: string;
}

interface ReadlineWithOutputOverride extends ReadlineInterface {
  _writeToOutput?: (value: string) => void;
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
  const command = [options.nodeBinary, options.runtimeCli, "run"]
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
Restart=on-failure
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

function normalizeBoardUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("请输入完整的 http:// 或 https:// 地址");
  }
  if (!(["http:", "https:"] as string[]).includes(parsed.protocol)) {
    throw new Error("Board 地址只支持 http:// 或 https://");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Board 地址不能包含用户名或密码");
  }
  return normalized;
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

async function installRuntime(
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

class TerminalPrompter {
  private readonly readline: ReadlineWithOutputOverride;
  private readonly originalWriteToOutput?: (value: string) => void;
  private muted = false;

  constructor(
    private readonly input: ReadStream,
    private readonly output: WriteStream,
  ) {
    this.readline = createInterface({
      input,
      output,
      terminal: Boolean(input.isTTY && output.isTTY),
    }) as ReadlineWithOutputOverride;
    this.originalWriteToOutput = this.readline._writeToOutput?.bind(this.readline);
    if (this.originalWriteToOutput) {
      this.readline._writeToOutput = (value: string) => {
        if (!this.muted) this.originalWriteToOutput?.(value);
      };
    }
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
      const defaultHint =
        options.defaultValue === undefined ? "" : ` [${options.defaultValue}]`;
      const answer = (await this.readline.question(`${label}${defaultHint}: `)).trim();
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

  async secret(label: string, existingValue?: string): Promise<string> {
    while (true) {
      const suffix = existingValue ? "（回车保留现有值）" : "";
      this.write(`${label}${suffix}: `);
      this.muted = Boolean(this.input.isTTY && this.output.isTTY);
      let answer: string;
      try {
        answer = (await this.readline.question("")).trim();
      } finally {
        if (this.muted) this.write("\n");
        this.muted = false;
      }
      if (answer) return answer;
      if (existingValue) return existingValue;
      this.write("  该项不能为空。\n");
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
      const answer = (
        await this.readline.question(`请选择 [${defaultIndex + 1}]: `)
      ).trim();
      if (!answer) return choices[defaultIndex].value;
      const index = Number(answer) - 1;
      if (Number.isInteger(index) && choices[index]) return choices[index].value;
      const named = choices.find((choice) => choice.value === answer);
      if (named) return named.value;
      this.write(`  请输入 1 到 ${choices.length}。\n`);
    }
  }

  close(): void {
    this.readline.close();
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

function parseEnvironmentNames(value: string): string[] {
  if (!value || value === "-") return [];
  const names = [...new Set(value.split(/[\s,]+/).filter(Boolean))];
  const invalid = names.find((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
  if (invalid) throw new Error(`无效的环境变量名：${invalid}`);
  return names;
}

const SETUP_MANAGED_ENVIRONMENT_NAMES = new Set([
  "AI_TASK_BOARD_URL",
  "AI_TASK_BOARD_CONNECTION_TOKEN",
  "CODEX_HOME",
  "CODEX_BINARY",
  "HOME",
  "PATH",
]);

function parseProviderEnvironmentNames(value: string): string[] {
  const names = parseEnvironmentNames(value);
  const managed = names.find((name) =>
    SETUP_MANAGED_ENVIRONMENT_NAMES.has(name),
  );
  if (managed) {
    throw new Error(`${managed} 由安装器管理，不能作为 provider 环境变量`);
  }
  return names;
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

export async function runInteractiveSetup(
  options: InteractiveSetupOptions,
): Promise<void> {
  if (process.platform !== "linux") {
    throw new Error("交互式 systemd 安装目前只支持 Linux");
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "setup 需要交互式终端；自动化运行请继续通过环境变量启动 Bridge",
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
    prompt.write("\nAI Task Board Bridge 交互式安装\n\n");
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

    const boardUrl = await prompt.text("Board 地址", {
      defaultValue: configuredValue(existing, environment, "AI_TASK_BOARD_URL"),
      required: true,
      validate: normalizeBoardUrl,
    });
    const connectionToken = await prompt.secret(
      "Connection Token（输入内容不会回显）",
      configuredValue(
        existing,
        environment,
        "AI_TASK_BOARD_CONNECTION_TOKEN",
      ),
    );

    const rawMultipleDirectories = configuredValue(
      existing,
      environment,
      "CODEX_WORKING_DIRECTORIES",
    );
    let preserveMultipleDirectories = false;
    let workingDirectory: string;
    if (rawMultipleDirectories) {
      const firstDirectory = firstConfiguredWorkingDirectory(
        rawMultipleDirectories,
      );
      if (firstDirectory) {
        prompt.write(
          `\n检测到现有多目录配置，首目录为 ${firstDirectory}。\n`,
        );
        preserveMultipleDirectories = await prompt.confirm(
          "保留现有 CODEX_WORKING_DIRECTORIES",
          true,
        );
        workingDirectory = firstDirectory;
      } else {
        prompt.write(
          "\n现有 CODEX_WORKING_DIRECTORIES 无法解析，本次将改为单目录配置。\n",
        );
        workingDirectory = process.cwd();
      }
    } else {
      workingDirectory = process.cwd();
    }
    if (!preserveMultipleDirectories) {
      workingDirectory = await prompt.text("Bridge 工作目录", {
        defaultValue:
          configuredValue(existing, environment, "CODEX_WORKING_DIRECTORY") ??
          workingDirectory,
        required: true,
        validate: (value) => expandPath(value, homeDirectory, process.cwd()),
      });
    }
    if (!(await pathIsDirectory(workingDirectory))) {
      throw new Error(`工作目录不存在或不是目录：${workingDirectory}`);
    }

    const codexHome = await prompt.text("Codex 配置目录", {
      defaultValue:
        configuredValue(existing, environment, "CODEX_HOME") ??
        path.join(homeDirectory, ".codex"),
      required: true,
      validate: (value) => expandPath(value, homeDirectory, process.cwd()),
    });
    const codexHomeUid = await ownerUid(codexHome);
    if (codexHomeUid === null) {
      prompt.write(
        `  提示：${codexHome} 尚不存在；启动服务前请以 ${identity.username} 运行 codex login。\n`,
      );
    } else if (codexHomeUid !== effectiveUid) {
      prompt.write(
        `  警告：Codex 配置目录属于 UID ${codexHomeUid}，不是当前 UID ${effectiveUid}。\n`,
      );
      if (!(await prompt.confirm("仍然使用这个 Codex 配置目录", false))) {
        throw new Error("Codex 配置目录所有者不匹配");
      }
    }

    const pathValue = environment.PATH || "/usr/local/bin:/usr/bin:/bin";
    const existingCodexBinary = configuredValue(
      existing,
      environment,
      "CODEX_BINARY",
    );
    const detectedCodexBinary = await resolveExecutable(
      existingCodexBinary ?? "codex",
      { cwd: process.cwd(), homeDirectory, pathValue },
    );
    const codexBinaryInput = await prompt.text("Codex 可执行文件", {
      defaultValue: detectedCodexBinary ?? existingCodexBinary ?? "codex",
      required: true,
    });
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

    let detectedProviderEnvironmentNames: string[] = [];
    try {
      detectedProviderEnvironmentNames = discoverCodexProviderEnvironmentVariables(
        await readFile(path.join(codexHome, "config.toml"), "utf8"),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        prompt.write(
          `  提示：无法检查 ${path.join(codexHome, "config.toml")} 中的 provider 环境变量。\n`,
        );
      }
    }
    if (detectedProviderEnvironmentNames.length > 0) {
      prompt.write(
        `检测到 Codex provider 引用环境变量：${detectedProviderEnvironmentNames.join(", ")}\n`,
      );
    }
    const providerEnvironmentNames = await prompt.text(
      "传给 Codex provider 的环境变量名（逗号分隔；输入 - 表示无）",
      {
        defaultValue:
          detectedProviderEnvironmentNames.length > 0
            ? detectedProviderEnvironmentNames.join(",")
            : undefined,
        validate: (value) => parseProviderEnvironmentNames(value).join(","),
      },
    );
    const providerEnvironment: Record<string, string> = {};
    for (const name of parseProviderEnvironmentNames(providerEnvironmentNames)) {
      providerEnvironment[name] = await prompt.secret(
        `${name}（输入内容不会回显）`,
        environment[name] ?? existing[name],
      );
    }

    const threadScope = await prompt.choice<ThreadScope>(
      "Thread 范围",
      [
        { value: "cwd", label: "cwd — 仅管理已配置工作目录（推荐）" },
        { value: "all", label: "all — 管理当前用户的跨项目 Thread（高风险）" },
      ],
      validChoice(
        configuredValue(existing, environment, "CODEX_THREAD_SCOPE"),
        ["cwd", "all"],
        "cwd",
      ),
    );
    const maxThreads = await prompt.text("最多管理的 Thread 数", {
      defaultValue:
        configuredValue(existing, environment, "CODEX_MAX_THREADS") ?? "50",
      required: true,
      validate: (value) => {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
          throw new Error("请输入 1 到 500 的整数");
        }
        return String(parsed);
      },
    });
    const permissionMode = await prompt.choice<PermissionMode>(
      "Codex 权限模式",
      [
        {
          value: "safe",
          label: "safe — 仅工作区可写且禁用网络（推荐）",
        },
        {
          value: "danger-full-access",
          label: "danger-full-access — 当前用户权限内完全访问（高风险）",
        },
        {
          value: "inherit",
          label: "inherit — 完全沿用本地 Codex/Thread 配置",
        },
      ],
      validChoice(
        configuredValue(existing, environment, "CODEX_BRIDGE_PERMISSION_MODE"),
        ["safe", "danger-full-access", "inherit"],
        "safe",
      ),
    );
    const approvalMode = await prompt.choice<ApprovalMode>(
      "设备端审批模式",
      [
        { value: "decline", label: "decline — 自动拒绝审批请求（推荐）" },
        { value: "accept", label: "accept — 自动批准当前 Turn（高风险）" },
        {
          value: "accept-session",
          label: "accept-session — 可批准整个 Session（更高风险）",
        },
      ],
      validChoice(
        configuredValue(existing, environment, "CODEX_BRIDGE_APPROVAL_MODE"),
        ["decline", "accept", "accept-session"],
        "decline",
      ),
    );
    const webConfiguration = await prompt.confirm(
      "允许 Board 调整受本机边界限制的运行配置",
      configuredValue(existing, environment, "CODEX_BRIDGE_WEB_CONFIG") ===
        "true",
    );

    prompt.write("\n即将写入：\n");
    prompt.write(`  环境文件：${paths.environmentFile} (0600)\n`);
    prompt.write(`  用户服务：${paths.unitFile}\n`);
    prompt.write(`  Bridge 运行副本：${paths.runtimeDirectory}\n`);
    prompt.write(`  Codex 配置：${codexHome}\n`);
    if (Object.keys(providerEnvironment).length > 0) {
      prompt.write(
        `  Provider 环境变量：${Object.keys(providerEnvironment).join(", ")}（值已隐藏）\n`,
      );
    }
    prompt.write("  Connection Token：[已隐藏]\n\n");
    if (!(await prompt.confirm("安装并立即启动 systemd 用户服务", true))) {
      prompt.write("已取消，未修改任何文件。\n");
      return;
    }

    const sourcePackageDirectory = fileURLToPath(new URL("../", import.meta.url));
    await installRuntime(sourcePackageDirectory, paths);
    await mkdir(paths.configDirectory, { recursive: true, mode: 0o700 });
    await chmod(paths.configDirectory, 0o700);

    const installedEnvironment: Record<string, string | undefined> = {
      ...existing,
      ...providerEnvironment,
      AI_TASK_BOARD_URL: boardUrl,
      AI_TASK_BOARD_CONNECTION_TOKEN: connectionToken,
      CODEX_WORKING_DIRECTORY: workingDirectory,
      CODEX_THREAD_SCOPE: threadScope,
      CODEX_MAX_THREADS: maxThreads,
      CODEX_BRIDGE_PERMISSION_MODE: permissionMode,
      CODEX_BRIDGE_APPROVAL_MODE: approvalMode,
      CODEX_BRIDGE_WEB_CONFIG: webConfiguration ? "true" : "false",
      CODEX_BINARY: codexBinary,
      CODEX_HOME: codexHome,
      HOME: homeDirectory,
      PATH: pathValue,
    };
    if (preserveMultipleDirectories && rawMultipleDirectories) {
      installedEnvironment.CODEX_WORKING_DIRECTORIES = rawMultipleDirectories;
    } else {
      delete installedEnvironment.CODEX_WORKING_DIRECTORIES;
    }
    await atomicWrite(
      paths.environmentFile,
      serializeEnvironmentFile(installedEnvironment),
      0o600,
    );
    await atomicWrite(
      paths.unitFile,
      renderSystemdUserUnit({
        nodeBinary: process.execPath,
        runtimeCli: paths.runtimeCli,
        workingDirectory,
        homeDirectory,
        codexHome,
        environmentFile: paths.environmentFile,
      }),
      0o644,
    );

    await runCommand("systemctl", ["--user", "daemon-reload"]);
    await runCommand("systemctl", ["--user", "enable", paths.unitFile]);

    const legacyUnitPath = path.join(
      path.dirname(paths.unitFile),
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
      prompt.write(
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
        prompt.write("新服务启动失败，正在恢复旧服务。\n");
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

    prompt.write("\n安装完成。\n");
    prompt.write(
      `服务 ${BRIDGE_SYSTEMD_SERVICE} 正以 ${identity.username} (UID ${effectiveUid}) 运行。\n`,
    );
    prompt.write(
      `查看状态：systemctl --user status ${BRIDGE_SYSTEMD_SERVICE}\n`,
    );
    prompt.write(
      `查看日志：journalctl --user -u ${BRIDGE_SYSTEMD_SERVICE} -f\n`,
    );
    prompt.write(
      "安装器未设置模型覆盖；默认模型由这个用户的 Codex 配置和目标 Thread 决定。\n",
    );

    const linger = await captureCommand("loginctl", [
      "show-user",
      String(effectiveUid),
      "-p",
      "Linger",
      "--value",
    ]);
    if (linger !== "yes") {
      prompt.write(
        `提示：若需退出登录后仍运行，请由管理员执行 sudo loginctl enable-linger ${identity.username}\n`,
      );
    }
  } finally {
    prompt.close();
  }
}
