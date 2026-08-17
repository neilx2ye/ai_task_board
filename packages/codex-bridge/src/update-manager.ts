import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";

import { redactHarnessText } from "./activity-sanitizer.js";
import {
  installRuntime,
  renderSystemdUserUnit,
  resolveSetupPaths,
} from "./setup.js";

const BRIDGE_UPDATE_PACKAGE = "ai-task-board-bridge";
const NPM_PACK_TIMEOUT_MS = 120_000;
const COMMAND_TIMEOUT_MS = 60_000;
const SMOKE_TEST_TIMEOUT_MS = 10_000;
/** Non-zero so systemd Restart=on-failure starts the freshly installed version. */
const UPDATE_RESTART_EXIT_CODE = 75;

// Strict semver 2.0.0 with optional prerelease/build metadata. Prerelease is
// ignored when deciding whether the Board's target is newer than the running
// Bridge, so a runtime-suffixed build (e.g. 1.4.0-kimi.1 in a sibling runtime)
// already satisfies a 1.4.0 target and does not update in a loop.
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseSemverBase(
  value: string,
): { major: number; minor: number; patch: number } | null {
  const match = SEMVER_PATTERN.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function isUpdateVersionNewer(
  desired: string,
  current: string,
): boolean {
  const target = parseSemverBase(desired);
  const running = parseSemverBase(current);
  if (!target || !running) return false;
  if (target.major !== running.major) return target.major > running.major;
  if (target.minor !== running.minor) return target.minor > running.minor;
  return target.patch > running.patch;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type CapturedCommand = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

function runCommand(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<CapturedCommand> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolve({ code: null, signal: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut: false });
    });
  });
}

async function runCheckedCommand(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  description: string,
): Promise<string> {
  let result: CapturedCommand;
  try {
    result = await runCommand(command, args, timeoutMs);
  } catch (error) {
    throw new Error(`${description}无法执行：${errorMessage(error)}`);
  }
  if (result.timedOut) {
    throw new Error(
      `${description}超时（>${Math.round(timeoutMs / 1_000)}s）：${command} ${args.join(" ")}`,
    );
  }
  if (result.code !== 0) {
    const outputTail = (result.stderr.trim() || result.stdout.trim()).slice(
      -500,
    );
    throw new Error(
      `${description}失败（${
        result.signal ? `signal ${result.signal}` : `退出码 ${result.code ?? "unknown"}`
      }）${outputTail ? `：${outputTail}` : ""}`,
    );
  }
  return result.stdout;
}

function unquoteSystemdArgument(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length < 2 ||
    !trimmed.startsWith('"') ||
    !trimmed.endsWith('"')
  ) {
    return trimmed.replace(/%%/g, "%");
  }
  let decoded = "";
  for (let index = 1; index < trimmed.length - 1; index += 1) {
    const character = trimmed[index];
    if (character === "\\" && index + 1 < trimmed.length - 1) {
      const next = trimmed[index + 1];
      if (next === "\\" || next === '"') {
        decoded += next;
        index += 1;
        continue;
      }
    }
    if (character === "%" && trimmed[index + 1] === "%") {
      decoded += "%";
      index += 1;
      continue;
    }
    decoded += character;
  }
  return decoded;
}

function splitSystemdCommand(value: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < value.length) {
    while (value[index] === " ") index += 1;
    if (index >= value.length) break;
    if (value[index] !== '"') {
      let end = index;
      while (end < value.length && value[end] !== " ") end += 1;
      tokens.push(value.slice(index, end));
      index = end;
      continue;
    }
    let end = index + 1;
    while (end < value.length) {
      if (value[end] === "\\" && end + 1 < value.length) {
        end += 2;
        continue;
      }
      if (value[end] === '"') break;
      end += 1;
    }
    if (end >= value.length) break;
    tokens.push(value.slice(index, end + 1));
    index = end + 1;
  }
  return tokens;
}

type CurrentUnitSettings = {
  nodeBinary: string;
  workingDirectory: string;
  homeDirectory: string;
  codexHome: string;
  environmentFile: string;
};

// The existing unit keeps every local decision (HOME, CODEX_HOME,
// WorkingDirectory, EnvironmentFile, node binary); only the ExecStart runtime
// path changes to the newly installed version.
function parseCurrentUnit(contents: string): CurrentUnitSettings {
  let nodeBinary: string | undefined;
  let workingDirectory: string | undefined;
  let homeDirectory: string | undefined;
  let codexHome: string | undefined;
  let environmentFile: string | undefined;
  for (const line of contents.split(/\r?\n/)) {
    if (line.startsWith("WorkingDirectory=")) {
      workingDirectory = line
        .slice("WorkingDirectory=".length)
        .replace(/%%/g, "%");
    } else if (line.startsWith("EnvironmentFile=")) {
      environmentFile = line
        .slice("EnvironmentFile=".length)
        .replace(/%%/g, "%");
    } else if (line.startsWith("Environment=")) {
      const assignment = unquoteSystemdArgument(
        line.slice("Environment=".length),
      );
      const separator = assignment.indexOf("=");
      if (separator > 0) {
        const value = assignment.slice(separator + 1);
        if (assignment.slice(0, separator) === "HOME") homeDirectory = value;
        if (assignment.slice(0, separator) === "CODEX_HOME") codexHome = value;
      }
    } else if (line.startsWith("ExecStart=")) {
      const [firstToken] = splitSystemdCommand(line.slice("ExecStart=".length));
      if (firstToken) nodeBinary = unquoteSystemdArgument(firstToken);
    }
  }
  const missing = [
    ["ExecStart 的 node 路径", nodeBinary],
    ["WorkingDirectory", workingDirectory],
    ["Environment HOME", homeDirectory],
    ["Environment CODEX_HOME", codexHome],
    ["EnvironmentFile", environmentFile],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0 || !nodeBinary || !workingDirectory || !homeDirectory || !codexHome || !environmentFile) {
    throw new Error(
      `现有 systemd unit 缺少 ${missing.join("、")}，无法安全重写`,
    );
  }
  return { nodeBinary, workingDirectory, homeDirectory, codexHome, environmentFile };
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

export type DesiredBridgeUpdateOptions = {
  /** Board-provided target npm version; null/missing disables the update. */
  desiredVersion: string | null;
  /** Version constant of the running Bridge. */
  currentVersion: string;
  /** Local opt-in parsed from AI_TASK_BOARD_ALLOW_REMOTE_UPDATE. */
  allowRemoteUpdate: boolean;
  environment?: Record<string, string | undefined>;
  homeDirectory?: string;
  log?: (message: string) => void;
};

let updateInFlight = false;
let failedTargetVersion: string | null = null;
let noticedSkipTarget: string | null = null;

function defaultLog(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * Apply a Board-requested Bridge update after a successful configuration
 * exchange. Returns null when nothing failed; on a failed attempt returns the
 * redacted error text so the caller can report it in the next exchange's
 * `error` field. On success the process exits with code 75 and systemd's
 * Restart=on-failure starts the installed version.
 */
export async function maybeApplyDesiredBridgeUpdate(
  options: DesiredBridgeUpdateOptions,
): Promise<string | null> {
  const log = options.log ?? defaultLog;
  const desired = options.desiredVersion?.trim() || null;
  if (!desired) return null;
  if (!parseSemverBase(desired)) return null;
  if (!isUpdateVersionNewer(desired, options.currentVersion)) return null;

  const environment = options.environment ?? process.env;
  if (!options.allowRemoteUpdate || !environment.INVOCATION_ID?.trim()) {
    if (noticedSkipTarget !== desired) {
      noticedSkipTarget = desired;
      log(
        `看板请求将 Bridge 升级到 ${desired}，但本机未启用自动升级` +
          "（需要 AI_TASK_BOARD_ALLOW_REMOTE_UPDATE=true 且 Bridge 由 systemd 运行）；已跳过，请手动升级",
      );
    }
    return null;
  }
  // A failed target is not retried until the Board changes it or the Bridge
  // process restarts, so a broken release cannot cause a retry storm.
  if (failedTargetVersion === desired) return null;
  if (updateInFlight) return null;
  updateInFlight = true;
  try {
    return await applyDesiredBridgeUpdate(
      desired,
      environment,
      options.homeDirectory ?? userInfo().homedir,
      log,
    );
  } catch (error) {
    // applyDesiredBridgeUpdate already handles every expected step failure;
    // this guard keeps even an unexpected throw (for example a failed
    // mkdtemp) out of the configuration-exchange loop.
    failedTargetVersion = desired;
    const message = redactHarnessText(
      `升级到 Bridge ${desired} 失败：${errorMessage(error)}`,
      2_000,
    );
    log(message);
    return message;
  } finally {
    updateInFlight = false;
  }
}

async function applyDesiredBridgeUpdate(
  desired: string,
  environment: Record<string, string | undefined>,
  homeDirectory: string,
  log: (message: string) => void,
): Promise<string | null> {
  const staging = await mkdtemp(
    path.join(tmpdir(), "ai-task-board-bridge-update-"),
  );
  try {
    log(`开始从 npm registry 下载 Bridge ${desired}（npm 校验 registry integrity）`);
    await runCheckedCommand(
      "npm",
      [
        "pack",
        `${BRIDGE_UPDATE_PACKAGE}@${desired}`,
        "--pack-destination",
        staging,
      ],
      NPM_PACK_TIMEOUT_MS,
      "下载 Bridge 发布包",
    );
    const tarballs = (await readdir(staging)).filter((entry) =>
      entry.endsWith(".tgz"),
    );
    if (tarballs.length !== 1) {
      throw new Error(`npm pack 未产生唯一 tarball（实际 ${tarballs.length} 个）`);
    }
    const extractDirectory = path.join(staging, "extract");
    await mkdir(extractDirectory, { recursive: true });
    await runCheckedCommand(
      "tar",
      ["-xzf", path.join(staging, tarballs[0]), "-C", extractDirectory],
      COMMAND_TIMEOUT_MS,
      "解包 Bridge 发布包",
    );

    const paths = resolveSetupPaths(homeDirectory, desired, environment);
    await installRuntime(path.join(extractDirectory, "package"), paths);

    const smoke = await runCommand(
      process.execPath,
      [paths.runtimeCli, "--version"],
      SMOKE_TEST_TIMEOUT_MS,
    );
    if (smoke.timedOut || smoke.code !== 0 || !smoke.stdout.includes(desired)) {
      const detail = (smoke.stdout.trim() || smoke.stderr.trim()).slice(0, 200);
      throw new Error(
        `Bridge ${desired} 冒烟检查失败（--version ${
          smoke.timedOut ? "超时" : `退出码 ${smoke.code ?? "unknown"}`
        }${detail ? `，输出：${detail}` : ""}）`,
      );
    }

    const currentUnit = parseCurrentUnit(await readFile(paths.unitFile, "utf8"));
    await atomicWrite(
      paths.unitFile,
      renderSystemdUserUnit({
        nodeBinary: currentUnit.nodeBinary,
        runtimeCli: paths.runtimeCli,
        workingDirectory: currentUnit.workingDirectory,
        homeDirectory: currentUnit.homeDirectory,
        codexHome: currentUnit.codexHome,
        environmentFile: currentUnit.environmentFile,
      }),
      0o644,
    );
    await runCheckedCommand(
      "systemctl",
      ["--user", "daemon-reload"],
      COMMAND_TIMEOUT_MS,
      "systemd daemon-reload",
    );
  } catch (error) {
    // The old version keeps running: the unit file is only rewritten after the
    // new runtime is installed and smoke-tested, and staging is always removed.
    failedTargetVersion = desired;
    const message = redactHarnessText(
      `升级到 Bridge ${desired} 失败：${errorMessage(error)}`,
      2_000,
    );
    log(message);
    return message;
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
  log(
    `Bridge ${desired} 已安装并写入 systemd unit；本进程即将退出，将在约 5 秒后由 systemd 重启到新版本`,
  );
  process.exit(UPDATE_RESTART_EXIT_CODE);
  return null;
}
