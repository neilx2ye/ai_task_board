import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Exit code a runtime uses after staging an update; the supervisor restarts the whole unified service. */
const UPDATE_RESTART_EXIT_CODE = 75;
const START_BACKOFF_MIN_MS = 1_000;
const START_BACKOFF_MAX_MS = 30_000;
const STABLE_UPTIME_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;

export const UNIFIED_BRIDGE_KINDS = [
  "codex",
  "kimi",
  "antigravity",
  "claude",
] as const;

export type UnifiedBridgeKind = (typeof UNIFIED_BRIDGE_KINDS)[number];

export function parseEnabledKinds(
  value: string | undefined,
): UnifiedBridgeKind[] {
  const raw = value?.trim();
  if (!raw) return [...UNIFIED_BRIDGE_KINDS];
  const requested = raw
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((entry) => entry.trim().toLowerCase());
  if (requested.includes("all")) return [...UNIFIED_BRIDGE_KINDS];
  const kinds = requested.filter((entry): entry is UnifiedBridgeKind =>
    (UNIFIED_BRIDGE_KINDS as readonly string[]).includes(entry),
  );
  if (!kinds.length) {
    throw new Error(
      `AI_TASK_BOARD_BRIDGES 只包含未知类型：${raw}。可选值：codex、kimi、antigravity、claude、all`,
    );
  }
  return [...new Set(kinds)];
}

function cliPath(): string {
  return fileURLToPath(new URL("./cli.js", import.meta.url));
}

type ManagedChild = {
  kind: UnifiedBridgeKind;
  process: ChildProcess | null;
  restarts: number;
  startedAt: number;
};

/**
 * One daemon per OS user: run every enabled Bridge runtime as a child process
 * sharing a single connection token. The first enabled kind is the update
 * leader; the others skip npm self-update and restart together with the
 * systemd service.
 */
export async function runUnifiedSupervisor(
  options: {
    environment?: Record<string, string | undefined>;
  } = {},
): Promise<void> {
  const environment = options.environment ?? process.env;
  const kinds = parseEnabledKinds(environment.AI_TASK_BOARD_BRIDGES);
  const children = new Map<UnifiedBridgeKind, ManagedChild>();
  let stopping = false;
  let updateRequested = false;

  const log = (message: string): void => {
    process.stderr.write(`[ai-task-board-bridge] ${message}\n`);
  };

  const stopChildren = (signal: NodeJS.Signals): Promise<void> =>
    Promise.all(
      [...children.values()].map(
        (child) =>
          new Promise<void>((resolve) => {
            const managed = child.process;
            if (!managed || managed.exitCode !== null) {
              resolve();
              return;
            }
            const timer = setTimeout(() => {
              managed.kill("SIGKILL");
              resolve();
            }, STOP_TIMEOUT_MS);
            managed.once("exit", () => {
              clearTimeout(timer);
              resolve();
            });
            managed.kill(signal);
          }),
      ),
    ).then(() => undefined);

  const startChild = (kind: UnifiedBridgeKind): void => {
    if (stopping) return;
    const managed = children.get(kind);
    if (!managed) return;
    const leader = kinds[0];
    const childEnvironment = {
      ...environment,
      AI_TASK_BOARD_BRIDGE_SUPERVISED: "1",
      AI_TASK_BOARD_BRIDGE_UPDATE_ROLE: kind === leader ? "leader" : "follower",
      AI_TASK_BOARD_BRIDGE_UPDATE_LEADER: leader,
    } as unknown as NodeJS.ProcessEnv;
    log(`启动 ${kind} 运行时${kind === leader ? "（升级 leader）" : ""}。`);
    const child = spawn(process.execPath, [cliPath(), "run", kind], {
      cwd: process.cwd(),
      env: childEnvironment,
      stdio: "inherit",
    });
    managed.process = child;
    managed.startedAt = Date.now();

    child.once("error", (error) => {
      log(`${kind} 运行时启动失败：${String(error)}`);
      managed.process = null;
      scheduleRestart(kind);
    });
    child.once("exit", (code, signal) => {
      if (managed.process !== child) return;
      managed.process = null;
      if (stopping) return;
      const uptime = Date.now() - managed.startedAt;
      if (uptime >= STABLE_UPTIME_MS) managed.restarts = 0;
      if (code === UPDATE_RESTART_EXIT_CODE) {
        updateRequested = true;
        log(`${kind} 运行时已完成升级准备，正在重启统一服务。`);
        void shutdownForUpdate();
        return;
      }
      log(
        `${kind} 运行时退出（code=${code ?? "unknown"}，signal=${signal ?? "none"}），稍后重启。`,
      );
      scheduleRestart(kind);
    });
  };

  const scheduleRestart = (kind: UnifiedBridgeKind): void => {
    if (stopping) return;
    const managed = children.get(kind);
    if (!managed) return;
    const delay = Math.min(
      START_BACKOFF_MAX_MS,
      START_BACKOFF_MIN_MS * 2 ** managed.restarts,
    );
    managed.restarts += 1;
    const timer = setTimeout(() => startChild(kind), delay);
    timer.unref?.();
  };

  const shutdownForUpdate = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await stopChildren("SIGTERM");
    process.exit(UPDATE_RESTART_EXIT_CODE);
  };

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log(`收到 ${signal}，正在停止全部 Bridge 运行时。`);
    await stopChildren("SIGTERM");
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  log(
    `统一设备 Bridge 已启动，启用类型：${kinds.join("、")}；` +
      `升级 leader：${kinds[0]}。`,
  );
  for (const kind of kinds) {
    children.set(kind, { kind, process: null, restarts: 0, startedAt: 0 });
    startChild(kind);
  }

  // Keep the supervisor alive as the single lifecycle owner. Individual
  // runtimes restart independently; the service stops only via signal or a
  // successful update.
  setInterval(() => {
    if (stopping) return;
    const running = [...children.values()].some((child) => child.process);
    if (running || updateRequested) return;
    log("所有运行时均已退出且无待更新任务；supervisor 继续等待重启。");
  }, 10_000);

  await new Promise<never>(() => {
    // The interval and child process handles keep this daemon alive.
  });
}
