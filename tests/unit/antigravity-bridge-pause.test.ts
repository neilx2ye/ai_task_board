import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const BINDING_ID = "binding-1";
const SESSION_ID = "board-session-1";
const TASK_ID = "task-1";
const PAUSE_COMMAND_ID = "cmd-pause-1";

// Fake agy CLI：支持 --version / models（失败以走兼容目录）/ headless prompt。
// prompt 模式写入自己与孙进程（同进程组）的 pid，供测试验证整组强杀。
const FAKE_AGY = `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("1.2.0\\n");
  process.exit(0);
}
if (args[0] === "models") {
  process.exit(1);
}
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
send({ event: "init", init: { conversation_id: "fake-conversation", model: "fake-model" } });
if (process.env.FAKE_AGY_PID_FILE) {
  fs.writeFileSync(process.env.FAKE_AGY_PID_FILE, String(process.pid));
}
if (process.env.FAKE_AGY_GRANDCHILD_PID_FILE) {
  const grandchild = spawn("sleep", ["300"], { stdio: "ignore" });
  fs.writeFileSync(process.env.FAKE_AGY_GRANDCHILD_PID_FILE, String(grandchild.pid));
  grandchild.unref();
}
process.stderr.write("FAKE_AGY_PROMPT_STARTED\\n");
const finish = () => {
  send({ event: "result", result: { conversation_id: "fake-conversation", status: "SUCCESS", response: "fake done" } });
  process.exit(0);
};
if (process.env.FAKE_AGY_HANG === "1") {
  setInterval(() => undefined, 1_000);
} else if (process.env.FAKE_AGY_FINISH_FILE) {
  setInterval(() => {
    if (fs.existsSync(process.env.FAKE_AGY_FINISH_FILE)) finish();
  }, 100);
} else {
  setTimeout(finish, 300);
}
`;

function json(response: ServerResponse, data: unknown, status = 200): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ data }));
}

function errorJson(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ error: { code: "CLAIM_CONFLICT", message } }));
}

async function bodyOf(
  request: AsyncIterable<unknown>,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
    string,
    unknown
  >;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessDeath(pid: number, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`进程 ${pid} 在 ${timeoutMs}ms 内未被杀死`);
}

async function readPid(file: string): Promise<number> {
  const raw = await readFile(file, "utf8");
  const pid = Number(raw.trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`无效 pid 文件 ${file}：${raw}`);
  }
  return pid;
}

type HarnessOptions = {
  hangPrompt: boolean;
  /** prompt 挂起直到 finish 文件出现后才输出 SUCCESS 并退出。 */
  finishOnDemand?: boolean;
  nextTask?: () => Record<string, unknown> | null;
  nextThreadCommand?: () => Record<string, unknown> | null;
  onThreadCommandComplete?: (body: Record<string, unknown>) => void;
  completeTaskStatus?: number;
};

type Harness = {
  child: ChildProcess;
  server: Server;
  temporaryDirectory: string;
  agyPidFile: string;
  grandchildPidFile: string;
  agyFinishFile: string;
  stdout: () => string;
  stderr: () => string;
  counts: {
    claim: number;
    complete: number;
    fail: number;
    release: number;
  };
};

async function startBridge(options: HarnessOptions): Promise<Harness> {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "atb-antigravity-pause-"),
  );
  const workingDirectory = path.join(temporaryDirectory, "work");
  const stateDirectory = path.join(temporaryDirectory, "state");
  await mkdir(workingDirectory, { recursive: true });
  await mkdir(stateDirectory, { recursive: true });

  const registryFile = path.join(temporaryDirectory, "registry.json");
  const now = new Date().toISOString();
  await writeFile(
    registryFile,
    JSON.stringify({
      version: 1,
      bindings: {
        [BINDING_ID]: {
          conversationId: null,
          directoryKey: "work",
          workingDirectory,
          name: "Test Thread",
          model: null,
          createdAt: now,
          updatedAt: now,
        },
      },
    }),
    "utf8",
  );

  const fakeAgy = path.join(temporaryDirectory, "fake-agy.cjs");
  await writeFile(fakeAgy, FAKE_AGY, "utf8");
  await chmod(fakeAgy, 0o755);

  const agyPidFile = path.join(temporaryDirectory, "agy.pid");
  const grandchildPidFile = path.join(temporaryDirectory, "grandchild.pid");
  const agyFinishFile = path.join(temporaryDirectory, "agy.finish");
  const counts = { claim: 0, complete: 0, fail: 0, release: 0 };

  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://board.test").pathname;
    if (pathname === "/api/ai/config") {
      await bodyOf(request);
      json(response, {
        configuration: {
          connection_id: "conn-1",
          version: 1,
          desired: {
            enabled: true,
            include_thread_titles: true,
            max_threads: 10,
            max_concurrent_turns: 2,
            sync_history: false,
            history_turn_limit: 50,
            working_directories: [
              {
                directory_key: "work",
                name: "Work",
                working_directory: workingDirectory,
              },
            ],
          },
          desired_bridge_version: null,
          applied: null,
          updated_at: now,
        },
      });
      return;
    }
    if (pathname === "/api/ai/sessions/sync") {
      await bodyOf(request);
      json(response, {
        sessions: [
          { id: SESSION_ID, external_conversation_ref: BINDING_ID },
        ],
      });
      return;
    }
    if (pathname === "/api/ai/thread-commands/claim") {
      await bodyOf(request);
      json(response, { command: options.nextThreadCommand?.() ?? null });
      return;
    }
    const threadCommandComplete = pathname.match(
      /^\/api\/ai\/thread-commands\/[^/]+\/complete$/,
    );
    if (threadCommandComplete) {
      const body = await bodyOf(request);
      options.onThreadCommandComplete?.(body);
      json(response, {});
      return;
    }
    if (pathname === "/api/ai/file-commands/claim") {
      await bodyOf(request);
      json(response, { command: null });
      return;
    }
    if (pathname === "/api/ai/sessions/presence") {
      await bodyOf(request);
      json(response, {
        session: { id: SESSION_ID, external_conversation_ref: BINDING_ID },
      });
      return;
    }
    if (pathname === "/api/ai/tasks/claim-next") {
      counts.claim += 1;
      await bodyOf(request);
      json(response, { task: options.nextTask?.() ?? null });
      return;
    }
    if (pathname === "/api/ai/tasks/complete") {
      counts.complete += 1;
      await bodyOf(request);
      if (options.completeTaskStatus && options.completeTaskStatus !== 200) {
        errorJson(response, options.completeTaskStatus, "claim 已被清除");
        return;
      }
      json(response, {});
      return;
    }
    if (pathname === "/api/ai/tasks/fail") {
      counts.fail += 1;
      await bodyOf(request);
      json(response, {});
      return;
    }
    if (pathname === "/api/ai/tasks/release") {
      counts.release += 1;
      await bodyOf(request);
      json(response, {});
      return;
    }
    if (request.method !== "GET") await bodyOf(request);
    json(response, pathname.startsWith("/api/ai/tasks/") ? { artifacts: [] } : {});
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");

  const child = spawn(
    path.resolve("node_modules/.bin/tsx"),
    [path.resolve("packages/antigravity-bridge/src/cli.ts")],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AI_TASK_BOARD_URL: `http://127.0.0.1:${address.port}`,
        AI_TASK_BOARD_CONNECTION_TOKEN: "atb_test_connection_token",
        ANTIGRAVITY_BINARY: fakeAgy,
        ANTIGRAVITY_REGISTRY_FILE: registryFile,
        ANTIGRAVITY_STATE_DIR: stateDirectory,
        ANTIGRAVITY_WORKING_DIRECTORIES: JSON.stringify([
          { key: "work", name: "Work", path: workingDirectory },
        ]),
        AI_TASK_BOARD_POLL_INTERVAL_MS: "500",
        AI_TASK_BOARD_CONFIG_POLL_INTERVAL_MS: "1000",
        AI_TASK_BOARD_THREAD_SYNC_INTERVAL_MS: "10000",
        FAKE_AGY_PID_FILE: agyPidFile,
        FAKE_AGY_GRANDCHILD_PID_FILE: grandchildPidFile,
        FAKE_AGY_HANG: options.hangPrompt ? "1" : "0",
        ...(options.finishOnDemand
          ? { FAKE_AGY_FINISH_FILE: agyFinishFile }
          : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  return {
    child,
    server,
    temporaryDirectory,
    agyPidFile,
    grandchildPidFile,
    agyFinishFile,
    stdout: () => stdout,
    stderr: () => stderr,
    counts,
  };
}

async function stopBridge(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Bridge did not stop after SIGTERM")),
        8_000,
      ),
    ),
  ]);
}

async function waitForCondition(
  check: () => boolean,
  description: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待超时：${description}`);
}

describe("Antigravity Bridge Web 暂停指令", () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    if (harness) {
      await stopBridge(harness.child).catch(() => undefined);
      await new Promise<void>((resolve) =>
        harness!.server.close(() => resolve()),
      );
      await rm(harness.temporaryDirectory, { recursive: true, force: true });
      harness = null;
    }
  });

  it(
    "pause 中断运行中的 prompt：杀掉 agy 进程组，不上报 fail，指令成功完成",
    async () => {
      let claimed = false;
      let pauseDelivered = false;
      let commandCompleted: Record<string, unknown> | null = null;
      harness = await startBridge({
        hangPrompt: true,
        nextTask: () => {
          if (claimed) return null;
          claimed = true;
          return {
            id: TASK_ID,
            title: "Hang task",
            description: "Run until paused",
            acceptance_criteria: null,
            model: null,
            reasoning_effort: null,
            claim_token: "claim-1",
          };
        },
        nextThreadCommand: () => {
          // 只有等 agy prompt 真正启动后才下发 pause 指令。
          const pidFile = harness?.agyPidFile;
          if (pauseDelivered || !pidFile || !existsSync(pidFile)) return null;
          pauseDelivered = true;
          return {
            id: PAUSE_COMMAND_ID,
            action: "pause",
            name: null,
            session_id: SESSION_ID,
            task_id: TASK_ID,
            directory_key: null,
            external_thread_id: BINDING_ID,
            attempt_count: 1,
          };
        },
        onThreadCommandComplete: (body) => {
          commandCompleted = body;
        },
      });

      await waitForCondition(
        () => commandCompleted !== null && harness!.stdout().includes("已暂停"),
        "pause 指令完成且任务本地暂停",
      );
      const agyPid = await readPid(harness.agyPidFile);
      const grandchildPid = await readPid(harness.grandchildPidFile);
      await waitForProcessDeath(agyPid);
      await waitForProcessDeath(grandchildPid);

      expect(commandCompleted).toMatchObject({
        succeeded: true,
        external_thread_id: BINDING_ID,
      });
      // 任务已在看板侧 paused：bridge 绝不能 fail/complete/release。
      expect(harness.counts.fail).toBe(0);
      expect(harness.counts.complete).toBe(0);
      expect(harness.counts.release).toBe(0);
    },
    30_000,
  );

  it(
    "pause 指令 task_id 不匹配（过期重放）：不杀当前 prompt，任务正常完成",
    async () => {
      let claimed = false;
      let pauseDelivered = false;
      let commandCompleted: Record<string, unknown> | null = null;
      harness = await startBridge({
        hangPrompt: false,
        finishOnDemand: true,
        nextTask: () => {
          if (claimed) return null;
          claimed = true;
          return {
            id: TASK_ID,
            title: "Surviving task",
            description: "Must survive a stale pause command",
            acceptance_criteria: null,
            model: null,
            reasoning_effort: null,
            claim_token: "claim-1",
          };
        },
        nextThreadCommand: () => {
          // 等 prompt 启动后下发针对“上一个任务”的过期 pause 指令。
          const pidFile = harness?.agyPidFile;
          if (pauseDelivered || !pidFile || !existsSync(pidFile)) return null;
          pauseDelivered = true;
          return {
            id: PAUSE_COMMAND_ID,
            action: "pause",
            name: null,
            session_id: SESSION_ID,
            task_id: "task-already-paused-earlier",
            directory_key: null,
            external_thread_id: BINDING_ID,
            attempt_count: 2,
          };
        },
        onThreadCommandComplete: (body) => {
          commandCompleted = body;
        },
      });

      await waitForCondition(
        () => commandCompleted !== null,
        "过期 pause 指令成功完成",
      );
      const agyPid = await readPid(harness.agyPidFile);
      const grandchildPid = await readPid(harness.grandchildPidFile);
      // 若发生误杀（SIGTERM + 3s 后 SIGKILL），这段宽限后进程必然已退出。
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(commandCompleted).toMatchObject({ succeeded: true });
      expect(processAlive(agyPid)).toBe(true);
      expect(processAlive(grandchildPid)).toBe(true);

      // prompt 正常结束后任务应照常 complete，而不是被 fail。
      await writeFile(harness.agyFinishFile, "finish", "utf8");
      await waitForCondition(
        () => harness!.counts.complete === 1,
        "任务正常 complete",
      );
      expect(harness.counts.fail).toBe(0);
      expect(harness.counts.release).toBe(0);
    },
    30_000,
  );

  it(
    "旧版 Board 的 pause（task_id 为 null）仍无条件中断当前 prompt",
    async () => {
      let claimed = false;
      let pauseDelivered = false;
      let commandCompleted: Record<string, unknown> | null = null;
      harness = await startBridge({
        hangPrompt: true,
        nextTask: () => {
          if (claimed) return null;
          claimed = true;
          return {
            id: TASK_ID,
            title: "Legacy pause task",
            description: "Run until paused by a legacy command",
            acceptance_criteria: null,
            model: null,
            reasoning_effort: null,
            claim_token: "claim-1",
          };
        },
        nextThreadCommand: () => {
          const pidFile = harness?.agyPidFile;
          if (pauseDelivered || !pidFile || !existsSync(pidFile)) return null;
          pauseDelivered = true;
          return {
            id: PAUSE_COMMAND_ID,
            action: "pause",
            name: null,
            session_id: SESSION_ID,
            task_id: null,
            directory_key: null,
            external_thread_id: BINDING_ID,
            attempt_count: 1,
          };
        },
        onThreadCommandComplete: (body) => {
          commandCompleted = body;
        },
      });

      await waitForCondition(
        () => commandCompleted !== null && harness!.stdout().includes("已暂停"),
        "legacy pause 指令完成且任务本地暂停",
      );
      const agyPid = await readPid(harness.agyPidFile);
      await waitForProcessDeath(agyPid);

      expect(commandCompleted).toMatchObject({ succeeded: true });
      expect(harness.counts.fail).toBe(0);
      expect(harness.counts.complete).toBe(0);
    },
    30_000,
  );

  it(
    "pause 空闲或未知 session：成功 no-op（幂等）",
    async () => {
      const completed: Array<Record<string, unknown>> = [];
      let delivered = 0;
      harness = await startBridge({
        hangPrompt: true,
        nextTask: () => null,
        nextThreadCommand: () => {
          delivered += 1;
          if (delivered === 1) {
            return {
              id: PAUSE_COMMAND_ID,
              action: "pause",
              name: null,
              session_id: SESSION_ID,
              task_id: TASK_ID,
              directory_key: null,
              external_thread_id: BINDING_ID,
              attempt_count: 1,
            };
          }
          if (delivered === 2) {
            return {
              id: "cmd-pause-unknown",
              action: "pause",
              name: null,
              session_id: "session-does-not-exist",
              task_id: null,
              directory_key: null,
              external_thread_id: null,
              attempt_count: 2,
            };
          }
          return null;
        },
        onThreadCommandComplete: (body) => {
          completed.push(body);
        },
      });

      await waitForCondition(
        () => completed.length === 2,
        "两条 pause 指令都成功完成",
      );
      expect(completed[0]).toMatchObject({
        succeeded: true,
        external_thread_id: BINDING_ID,
      });
      expect(completed[1]).toMatchObject({
        succeeded: true,
        external_thread_id: null,
      });
      expect(existsSync(harness.agyPidFile)).toBe(false);
      expect(harness.counts.fail).toBe(0);
      expect(harness.counts.complete).toBe(0);
      expect(harness.counts.release).toBe(0);
    },
    30_000,
  );

  it(
    "prompt 完成恰遇 claim 被清除（409）：不重试、不上报 fail，worker 继续认领",
    async () => {
      let claimed = false;
      harness = await startBridge({
        hangPrompt: false,
        completeTaskStatus: 409,
        nextTask: () => {
          if (claimed) return null;
          claimed = true;
          return {
            id: TASK_ID,
            title: "Racing task",
            description: "Complete while the claim is gone",
            acceptance_criteria: null,
            model: null,
            reasoning_effort: null,
            claim_token: "claim-1",
          };
        },
      });

      await waitForCondition(
        () => harness!.counts.complete === 1 && harness!.counts.claim >= 2,
        "complete 409 后 worker 继续认领",
      );
      expect(harness.counts.fail).toBe(0);
      expect(harness.counts.release).toBe(0);
      expect(harness.stderr()).toContain("claim 已被看板清除");
    },
    30_000,
  );

  it(
    "回归：stop() 仍然中断运行中的 prompt（杀掉 agy 进程组）",
    async () => {
      let claimed = false;
      harness = await startBridge({
        hangPrompt: true,
        nextTask: () => {
          if (claimed) return null;
          claimed = true;
          return {
            id: TASK_ID,
            title: "Stop task",
            description: "Run until the bridge stops",
            acceptance_criteria: null,
            model: null,
            reasoning_effort: null,
            claim_token: "claim-1",
          };
        },
      });

      await waitForCondition(
        () => existsSync(harness!.agyPidFile),
        "agy prompt 已启动",
      );
      const agyPid = await readPid(harness.agyPidFile);
      const grandchildPid = await readPid(harness.grandchildPidFile);

      await stopBridge(harness.child);
      await waitForProcessDeath(agyPid);
      await waitForProcessDeath(grandchildPid);
      // 停止语义不变：运行中的 claim 被释放而不是 fail。
      expect(harness.counts.release).toBe(1);
      expect(harness.counts.fail).toBe(0);
    },
    30_000,
  );
});
