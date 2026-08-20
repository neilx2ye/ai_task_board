import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";

// Turn stays in progress until the Bridge interrupts it; the interrupt then
// ends the turn as "interrupted", mirroring a real Codex App Server.
const PAUSE_CODEX = `#!/usr/bin/env node
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-pause" } });
  } else if (message.method === "model/list") {
    send({ id: message.id, result: { data: [], nextCursor: null } });
  } else if (message.method === "thread/list") {
    send({ id: message.id, result: {
      data: [{ id: "thread-pause", cwd: "/workspace/pause", parentThreadId: null }],
      nextCursor: null,
    } });
  } else if (message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: "thread-pause" } } });
  } else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-pause", status: "inProgress" } } });
    setTimeout(() => process.stderr.write("TURN_STARTED\\n"), 150);
  } else if (message.method === "turn/interrupt") {
    process.stderr.write("INTERRUPT_RECEIVED " + message.params.turnId + "\\n");
    send({ id: message.id, result: {} });
    send({ method: "turn/completed", params: {
      threadId: "thread-pause",
      turn: { id: "turn-pause", status: "interrupted", error: null },
    } });
  }
});
`;

// turn/start stays in flight long enough for the pause command to land while
// the worker is still awaiting the start response.
const PAUSE_DELAYED_CODEX = `#!/usr/bin/env node
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-pause-delayed" } });
  } else if (message.method === "model/list") {
    send({ id: message.id, result: { data: [], nextCursor: null } });
  } else if (message.method === "thread/list") {
    send({ id: message.id, result: {
      data: [{ id: "thread-pause", cwd: "/workspace/pause", parentThreadId: null }],
      nextCursor: null,
    } });
  } else if (message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: "thread-pause" } } });
  } else if (message.method === "turn/start") {
    process.stderr.write("TURN_START_RECEIVED\\n");
    setTimeout(() => send({ id: message.id, result: {
      turn: { id: "turn-pause-delayed", status: "inProgress" },
    } }), 2500);
  } else if (message.method === "turn/interrupt") {
    process.stderr.write("INTERRUPT_RECEIVED " + message.params.turnId + "\\n");
    send({ id: message.id, result: {} });
  }
});
`;

// Turn completes normally shortly after starting; a stale pause command (one
// whose task_id does not match the active claim) must not interrupt it.
const PAUSE_STALE_CODEX = `#!/usr/bin/env node
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-pause-stale" } });
  } else if (message.method === "model/list") {
    send({ id: message.id, result: { data: [], nextCursor: null } });
  } else if (message.method === "thread/list") {
    send({ id: message.id, result: {
      data: [{ id: "thread-pause", cwd: "/workspace/pause", parentThreadId: null }],
      nextCursor: null,
    } });
  } else if (message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: "thread-pause" } } });
  } else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-pause", status: "inProgress" } } });
    setTimeout(() => process.stderr.write("TURN_STARTED\\n"), 150);
    setTimeout(() => send({ method: "turn/completed", params: {
      threadId: "thread-pause",
      turn: { id: "turn-pause", status: "completed", error: null },
    } }), 2500);
  } else if (message.method === "turn/interrupt") {
    process.stderr.write("INTERRUPT_RECEIVED " + message.params.turnId + "\\n");
    send({ id: message.id, result: {} });
  }
});
`;

type PauseCommand = {
  id: string;
  action: "pause";
  name: null;
  external_thread_id: string | null;
  session_id: string | null;
  task_id: string | null;
};

type HarnessState = {
  servePause: boolean;
  failCalls: Array<Record<string, unknown>>;
  completeCalls: Array<Record<string, unknown>>;
  commandCompletions: Array<{
    commandId: string;
    body: Record<string, unknown>;
  }>;
};

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

describe("Codex Bridge Web pause command", () => {
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
    serveTask: boolean;
    pauseCommand: PauseCommand;
    armPauseWhenStderrIncludes: string | null;
  }): Promise<{ state: HarnessState; output: { stdout: string; stderr: string } }> {
    const state: HarnessState = {
      servePause: false,
      failCalls: [],
      completeCalls: [],
      commandCompletions: [],
    };
    let claimed = false;
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
            id: "session-pause",
            external_conversation_ref: "thread-pause",
          }],
        });
        return;
      }
      if (pathname === "/api/ai/tasks/claim-next") {
        await bodyOf(request);
        if (options.serveTask && !claimed) {
          claimed = true;
          json(response, {
            task: {
              id: "task-pause",
              title: "Pause me",
              description: "Run until the Web pauses it",
              acceptance_criteria: null,
              claim_token: "claim-pause",
            },
          });
        } else {
          json(response, { task: null });
        }
        return;
      }
      if (pathname === "/api/ai/thread-commands/claim") {
        await bodyOf(request);
        if (state.servePause) {
          state.servePause = false;
          json(response, { command: options.pauseCommand });
        } else {
          json(response, { command: null });
        }
        return;
      }
      const completion = pathname.match(
        /^\/api\/ai\/thread-commands\/([^/]+)\/complete$/,
      );
      if (completion) {
        state.commandCompletions.push({
          commandId: completion[1],
          body: await bodyOf(request),
        });
        json(response, { command: { id: completion[1] } });
        return;
      }
      if (pathname === "/api/ai/tasks/fail") {
        state.failCalls.push(await bodyOf(request));
        json(response, {});
        return;
      }
      if (pathname === "/api/ai/tasks/complete") {
        state.completeCalls.push(await bodyOf(request));
        json(response, {});
        return;
      }
      if (request.method !== "GET") await bodyOf(request);
      json(response, {});
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test port");

    temporaryDirectory = await mkdtemp(path.join(tmpdir(), "atb-bridge-pause-"));
    const fakeCodex = path.join(temporaryDirectory, "fake-pause-codex.cjs");
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
          AI_TASK_BOARD_CONNECTION_TOKEN: "atb_pause_token",
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
    let armed = false;
    child.stdout?.on("data", (chunk) => {
      output.stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      output.stderr += chunk.toString();
      if (
        !armed &&
        options.armPauseWhenStderrIncludes &&
        output.stderr.includes(options.armPauseWhenStderrIncludes)
      ) {
        armed = true;
        state.servePause = true;
      }
    });
    if (!options.armPauseWhenStderrIncludes) state.servePause = true;
    return { state, output };
  }

  it.each([
    {
      scenario: "resolved by external_thread_id",
      command: {
        id: "11111111-1111-4111-8111-111111111111",
        action: "pause" as const,
        name: null,
        external_thread_id: "thread-pause",
        session_id: "session-pause",
        task_id: "task-pause",
      },
    },
    {
      scenario: "falling back to the board session id when external_thread_id is null",
      command: {
        id: "22222222-2222-4222-8222-222222222222",
        action: "pause" as const,
        name: null,
        external_thread_id: null,
        session_id: "session-pause",
        task_id: "task-pause",
      },
    },
  ])(
    "interrupts a running turn without failing the task ($scenario)",
    async ({ command }) => {
      const { state, output } = await startHarness({
        codexScript: PAUSE_CODEX,
        serveTask: true,
        pauseCommand: command,
        armPauseWhenStderrIncludes: "TURN_STARTED",
      });

      await waitUntil(
        () =>
          state.commandCompletions.length > 0 &&
          output.stderr.includes("INTERRUPT_RECEIVED turn-pause") &&
          output.stdout.includes("任务已暂停"),
        () =>
          `pause was not processed\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
      );

      expect(state.commandCompletions).toEqual([
        {
          commandId: command.id,
          body: expect.objectContaining({
            succeeded: true,
            external_thread_id: "thread-pause",
            error: null,
          }),
        },
      ]);
      expect(state.failCalls).toEqual([]);
      expect(state.completeCalls).toEqual([]);
    },
    20_000,
  );

  it("completes as a successful no-op when no turn is active", async () => {
    const command: PauseCommand = {
      id: "33333333-3333-4333-8333-333333333333",
      action: "pause",
      name: null,
      external_thread_id: "thread-pause",
      session_id: "session-pause",
      task_id: null,
    };
    const { state, output } = await startHarness({
      codexScript: PAUSE_CODEX,
      serveTask: false,
      pauseCommand: command,
      armPauseWhenStderrIncludes: null,
    });

    await waitUntil(
      () => state.commandCompletions.length > 0,
      () =>
        `idle pause was not completed\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
    );

    expect(state.commandCompletions).toEqual([
      {
        commandId: command.id,
        body: expect.objectContaining({
          succeeded: true,
          external_thread_id: "thread-pause",
          error: null,
        }),
      },
    ]);
    expect(output.stderr).not.toContain("INTERRUPT_RECEIVED");
    expect(state.failCalls).toEqual([]);
    expect(state.completeCalls).toEqual([]);
  }, 20_000);

  it("interrupts right after turn/start when the pause lands mid-flight", async () => {
    const command: PauseCommand = {
      id: "44444444-4444-4444-8444-444444444444",
      action: "pause",
      name: null,
      external_thread_id: "thread-pause",
      session_id: "session-pause",
      task_id: "task-pause",
    };
    const { state, output } = await startHarness({
      codexScript: PAUSE_DELAYED_CODEX,
      serveTask: true,
      pauseCommand: command,
      armPauseWhenStderrIncludes: "TURN_START_RECEIVED",
    });

    await waitUntil(
      () =>
        state.commandCompletions.length > 0 &&
        output.stderr.includes("INTERRUPT_RECEIVED turn-pause-delayed") &&
        output.stdout.includes("任务已暂停"),
      () =>
        `mid-flight pause was not processed\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
      15_000,
    );

    expect(state.commandCompletions).toEqual([
      {
        commandId: command.id,
        body: expect.objectContaining({
          succeeded: true,
          external_thread_id: "thread-pause",
          error: null,
        }),
      },
    ]);
    expect(state.failCalls).toEqual([]);
    expect(state.completeCalls).toEqual([]);
  }, 25_000);

  it("ignores a stale pause whose task_id matches no active claim", async () => {
    const command: PauseCommand = {
      id: "55555555-5555-4555-8555-555555555555",
      action: "pause",
      name: null,
      external_thread_id: "thread-pause",
      session_id: "session-pause",
      task_id: "task-stale-other",
    };
    const { state, output } = await startHarness({
      codexScript: PAUSE_STALE_CODEX,
      serveTask: true,
      pauseCommand: command,
      armPauseWhenStderrIncludes: "TURN_STARTED",
    });

    await waitUntil(
      () =>
        state.commandCompletions.length > 0 && state.completeCalls.length > 0,
      () =>
        `stale pause was not processed\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
      15_000,
    );

    // The running turn is not the paused task: it must finish untouched.
    expect(output.stderr).not.toContain("INTERRUPT_RECEIVED");
    expect(state.completeCalls).toEqual([
      expect.objectContaining({ task_id: "task-pause" }),
    ]);
    expect(state.commandCompletions).toEqual([
      {
        commandId: command.id,
        body: expect.objectContaining({
          succeeded: true,
          external_thread_id: "thread-pause",
          error: null,
        }),
      },
    ]);
    expect(state.failCalls).toEqual([]);
  }, 25_000);
});
