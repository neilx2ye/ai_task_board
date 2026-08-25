import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";

// 主 turn 启动后保持运行；收到 turn/steer 时在 stderr 留下标记并回执。
const STEER_CODEX = `#!/usr/bin/env node
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-steer" } });
  } else if (message.method === "model/list") {
    send({ id: message.id, result: { data: [], nextCursor: null } });
  } else if (message.method === "thread/list") {
    send({ id: message.id, result: {
      data: [{ id: "thread-steer", cwd: "/workspace/steer", parentThreadId: null }],
      nextCursor: null,
    } });
  } else if (message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: "thread-steer" } } });
  } else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-main", status: "inProgress" } } });
    setTimeout(() => send({ method: "turn/completed", params: {
      threadId: "thread-steer",
      turn: { id: "turn-main", status: "completed", error: null },
    } }), 1500);
  } else if (message.method === "turn/steer") {
    process.stderr.write(
      "STEER_RECEIVED " + message.params.expectedTurnId + "\\n",
    );
    send({ id: message.id, result: { turnId: message.params.expectedTurnId } });
  }
});
`;

// 与 STEER_CODEX 相同，但 turn/steer 总是拒绝：Bridge 应退回普通队列。
const STEER_REJECT_CODEX = `#!/usr/bin/env node
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-steer-reject" } });
  } else if (message.method === "model/list") {
    send({ id: message.id, result: { data: [], nextCursor: null } });
  } else if (message.method === "thread/list") {
    send({ id: message.id, result: {
      data: [{ id: "thread-steer", cwd: "/workspace/steer", parentThreadId: null }],
      nextCursor: null,
    } });
  } else if (message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: "thread-steer" } } });
  } else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-main", status: "inProgress" } } });
    setTimeout(() => send({ method: "turn/completed", params: {
      threadId: "thread-steer",
      turn: { id: "turn-main", status: "completed", error: null },
    } }), 1500);
  } else if (message.method === "turn/steer") {
    process.stderr.write("STEER_REJECTED\\n");
    send({ id: message.id, error: { code: -32000, message: "no active turn" } });
  }
});
`;

function json(response: ServerResponse, data: unknown, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ data }));
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

async function waitUntil(
  predicate: () => boolean,
  diagnostics: () => string,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(diagnostics());
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function stopChild(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Bridge did not stop after SIGTERM")), 5_000),
    ),
  ]);
}

describe("Codex Bridge session steer mode", () => {
  let child: ChildProcess | null = null;
  let temporaryDirectory: string | null = null;
  let server: Server | null = null;
  const wakeResponses = new Set<ServerResponse>();

  afterEach(async () => {
    await stopChild(child);
    child = null;
    for (const response of wakeResponses) response.end();
    wakeResponses.clear();
    if (server) {
      const runningServer = server;
      await new Promise<void>((resolve, reject) =>
        runningServer.close((error) => (error ? reject(error) : resolve())),
      );
      server = null;
    }
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
    temporaryDirectory = null;
  });

  async function startHarness(options: {
    codexScript: string;
    serveSteerTask: boolean;
  }): Promise<{
    state: {
      completeCalls: Array<Record<string, unknown>>;
      releaseCalls: Array<Record<string, unknown>>;
    };
    output: { stdout: string; stderr: string };
  }> {
    const state = {
      completeCalls: [] as Array<Record<string, unknown>>,
      releaseCalls: [] as Array<Record<string, unknown>>,
    };
    let mainClaimed = false;
    let steerClaimed = false;
    server = createServer(async (request, response) => {
      const pathname = new URL(request.url ?? "/", "http://board.test").pathname;
      if (pathname === "/api/ai/config") {
        response.writeHead(404, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "legacy Board" } }));
        return;
      }
      if (pathname === "/api/ai/sessions/wake") {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(": connected\n\n");
        wakeResponses.add(response);
        response.on("close", () => wakeResponses.delete(response));
        return;
      }
      if (pathname === "/api/ai/sessions/sync") {
        await bodyOf(request);
        json(response, {
          sessions: [{
            id: "session-steer",
            external_conversation_ref: "thread-steer",
          }],
        });
        return;
      }
      if (pathname === "/api/ai/tasks/claim-next") {
        await bodyOf(request);
        if (!mainClaimed) {
          mainClaimed = true;
          json(response, {
            task: {
              id: "task-main",
              title: "主任务",
              description: "运行中的 turn",
              acceptance_criteria: null,
              claim_token: "claim-main",
            },
          });
        } else {
          json(response, { task: null });
        }
        return;
      }
      if (pathname === "/api/ai/tasks/claim-steer") {
        await bodyOf(request);
        if (options.serveSteerTask && !steerClaimed) {
          steerClaimed = true;
          json(response, {
            task: {
              id: "task-steer",
              title: "把输出改成表格",
              description: "把输出改成表格",
              acceptance_criteria: null,
              steer: true,
              claim_token: "claim-steer",
            },
          });
        } else {
          json(response, { task: null });
        }
        return;
      }
      if (pathname === "/api/ai/tasks/complete") {
        state.completeCalls.push(await bodyOf(request));
        json(response, {});
        return;
      }
      if (pathname === "/api/ai/tasks/release") {
        state.releaseCalls.push(await bodyOf(request));
        json(response, {});
        return;
      }
      if (pathname === "/api/ai/tasks/task-main") {
        json(response, { artifacts: [] });
        return;
      }
      if (request.method !== "GET") await bodyOf(request);
      json(response, {});
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test port");

    temporaryDirectory = await mkdtemp(path.join(tmpdir(), "atb-bridge-steer-"));
    const fakeCodex = path.join(temporaryDirectory, "fake-steer-codex.cjs");
    await writeFile(fakeCodex, options.codexScript, "utf8");
    await chmod(fakeCodex, 0o755);

    child = spawn(
      path.resolve("node_modules/.bin/tsx"),
      [path.resolve("packages/codex-bridge/src/cli.ts")],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AI_TASK_BOARD_URL: `http://127.0.0.1:${address.port}`,
          AI_TASK_BOARD_CONNECTION_TOKEN: "atb_steer_token",
          CODEX_BINARY: fakeCodex,
          CODEX_THREAD_ID: "",
          CODEX_THREAD_SCOPE: "all",
          AI_TASK_BOARD_POLL_INTERVAL_MS: "500",
          AI_TASK_BOARD_CONFIG_POLL_INTERVAL_MS: "1000",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const output = { stdout: "", stderr: "" };
    child.stdout?.on("data", (chunk) => {
      output.stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      output.stderr += chunk.toString();
    });
    return { state, output };
  }

  it("steers the active turn and completes the steer task", async () => {
    const { state, output } = await startHarness({
      codexScript: STEER_CODEX,
      serveSteerTask: true,
    });

    await waitUntil(
      () =>
        state.completeCalls.some(
          (call) => call.task_id === "task-steer",
        ),
      () =>
        `steer task was not completed\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
    );

    expect(output.stderr).toContain("STEER_RECEIVED turn-main");
    expect(state.releaseCalls).toEqual([]);
    expect(state.completeCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          task_id: "task-steer",
          result_summary: "已实时调整正在运行的 Turn",
        }),
      ]),
    );
    await waitUntil(
      () =>
        state.completeCalls.some((call) => call.task_id === "task-main"),
      () =>
        `main task was not completed\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
    );
  }, 20_000);

  it("releases the steer task back to the normal queue when steering is rejected", async () => {
    const { state, output } = await startHarness({
      codexScript: STEER_REJECT_CODEX,
      serveSteerTask: true,
    });

    await waitUntil(
      () => state.releaseCalls.length > 0,
      () =>
        `steer task was not released\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
    );

    expect(output.stderr).toContain("Steer 未送达");
    expect(state.releaseCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ task_id: "task-steer" }),
      ]),
    );
    expect(
      state.completeCalls.filter((call) => call.task_id === "task-steer"),
    ).toEqual([]);
  }, 20_000);
});
