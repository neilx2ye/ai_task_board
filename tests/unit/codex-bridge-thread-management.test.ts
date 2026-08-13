import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";

const FAKE_CODEX = `#!/usr/bin/env node
const readline = require("node:readline");
const threads = [{
  id: "thread-existing",
  name: "Existing",
  preview: "Existing",
  cwd: process.cwd(),
  parentThreadId: null,
}];
const emptyThreads = [];
const allThreads = () => [...threads, ...emptyThreads];
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-thread-manager" } });
  } else if (message.method === "model/list") {
    send({ id: message.id, result: { data: [], nextCursor: null } });
  } else if (message.method === "thread/list") {
    send({ id: message.id, result: { data: threads, nextCursor: null } });
  } else if (message.method === "thread/read") {
    const thread = allThreads().find((candidate) => candidate.id === message.params.threadId);
    if (thread) send({ id: message.id, result: { thread } });
    else send({ id: message.id, error: { code: -32602, message: "Thread not found" } });
  } else if (message.method === "thread/resume") {
    const thread = allThreads().find((candidate) => candidate.id === message.params.threadId);
    process.stderr.write("THREAD_RESUME " + JSON.stringify(message.params) + "\\n");
    send({
      id: message.id,
      result: {
        thread,
        cwd: thread?.cwd,
        model: message.params.model ?? "gpt-5.6-sol",
        reasoningEffort:
          message.params.config?.model_reasoning_effort ?? "max",
      },
    });
  } else if (message.method === "thread/start") {
    const thread = {
      id: "thread-created",
      name: null,
      preview: "",
      cwd: message.params.cwd,
      parentThreadId: null,
    };
    // Real Codex persists this record and permits exact thread/read, but keeps
    // a zero-Turn Thread out of thread/list until its first Turn starts.
    emptyThreads.push(thread);
    process.stderr.write("THREAD_START " + JSON.stringify(message.params) + "\\n");
    send({ id: message.id, result: { thread } });
  } else if (message.method === "thread/name/set") {
    const thread = allThreads().find((candidate) => candidate.id === message.params.threadId);
    if (thread) thread.name = message.params.name;
    process.stderr.write("THREAD_RENAME " + JSON.stringify(message.params) + "\\n");
    send({ id: message.id, result: {} });
  } else if (message.method === "thread/delete") {
    for (const collection of [threads, emptyThreads]) {
      const index = collection.findIndex((candidate) => candidate.id === message.params.threadId);
      if (index >= 0) collection.splice(index, 1);
    }
    process.stderr.write("THREAD_DELETE " + JSON.stringify(message.params) + "\\n");
    send({ id: message.id, result: {} });
  }
});
`;

type ThreadCommand = {
  id: string;
  action: "create" | "rename" | "delete";
  name: string | null;
  model?: string | null;
  reasoning_effort?: string | null;
  external_thread_id: string | null;
};

function json(response: ServerResponse, data: unknown, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ data }));
}

async function bodyOf(request: AsyncIterable<unknown>): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
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

describe("Codex Bridge Web Thread management", () => {
  let child: ChildProcess | null = null;
  let temporaryDirectory: string | null = null;

  afterEach(async () => {
    await stopChild(child);
    child = null;
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
    temporaryDirectory = null;
  });

  it("creates, renames, and deletes local App Server Threads", async () => {
    const commands: ThreadCommand[] = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        action: "create",
        name: "Created from Web",
        model: "gpt-5.6-terra",
        reasoning_effort: "high",
        external_thread_id: null,
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        action: "rename",
        name: "Renamed from Web",
        model: "gpt-5.6-terra",
        reasoning_effort: "high",
        external_thread_id: "thread-existing",
      },
      {
        id: "33333333-3333-4333-8333-333333333333",
        action: "delete",
        name: null,
        external_thread_id: "thread-existing",
      },
    ];
    const completions: Array<{
      commandId: string;
      body: Record<string, unknown>;
    }> = [];
    const inventories: Array<Array<Record<string, unknown>>> = [];
    const wakeResponses = new Set<ServerResponse>();
    let createdCommandCompleted = false;
    let stdout = "";
    let stderr = "";

    const server = createServer(async (request, response) => {
      const pathname = new URL(request.url ?? "/", "http://board.test").pathname;
      if (pathname === "/api/ai/config") {
        const status = await bodyOf(request);
        json(response, {
          configuration: {
            connection_id: "connection-thread-manager",
            version: 1,
            desired: {
              enabled: true,
              include_thread_titles: true,
              max_threads: 10,
              max_concurrent_turns: 2,
              sync_history: false,
              history_turn_limit: 10,
              working_directories: null,
            },
            applied: null,
            runtime: { online: true, lease_expires_at: null },
            updated_at: new Date().toISOString(),
            echoed_runtime: status.runtime_instance_id,
          },
        });
        return;
      }
      if (pathname === "/api/ai/sessions/sync") {
        const body = await bodyOf(request);
        const threads = body.threads as Array<Record<string, unknown>>;
        inventories.push(threads);
        json(response, {
          sessions: threads.map((thread) => ({
            id: `session-${String(thread.external_conversation_ref)}`,
            external_conversation_ref: thread.external_conversation_ref,
          })),
        });
        return;
      }
      if (pathname === "/api/ai/thread-commands/created") {
        json(response, {
          thread_ids: createdCommandCompleted ? ["thread-created"] : [],
        });
        return;
      }
      if (pathname === "/api/ai/thread-commands/claim") {
        await bodyOf(request);
        json(response, { command: commands.shift() ?? null });
        return;
      }
      const completion = pathname.match(
        /^\/api\/ai\/thread-commands\/([^/]+)\/complete$/,
      );
      if (completion) {
        if (completion[1] === "11111111-1111-4111-8111-111111111111") {
          createdCommandCompleted = true;
        }
        completions.push({
          commandId: completion[1],
          body: await bodyOf(request),
        });
        json(response, { command: { id: completion[1] } });
        return;
      }
      if (pathname === "/api/ai/sessions/wake") {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(": connected\n\n");
        wakeResponses.add(response);
        response.on("close", () => wakeResponses.delete(response));
        return;
      }
      if (pathname === "/api/ai/tasks/claim-next") {
        json(response, { task: null });
        return;
      }
      if (request.method !== "GET") await bodyOf(request);
      json(response, {});
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test port");

    temporaryDirectory = await mkdtemp(
      path.join(tmpdir(), "atb-thread-management-test-"),
    );
    const fakeCodex = path.join(temporaryDirectory, "fake-codex.cjs");
    await writeFile(fakeCodex, FAKE_CODEX, "utf8");
    await chmod(fakeCodex, 0o755);
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      AI_TASK_BOARD_URL: `http://127.0.0.1:${address.port}`,
      AI_TASK_BOARD_CONNECTION_TOKEN: "atb_thread_management_token",
      AI_TASK_BOARD_CONFIG_POLL_INTERVAL_MS: "1000",
      AI_TASK_BOARD_THREAD_SYNC_INTERVAL_MS: "10000",
      AI_TASK_BOARD_POLL_INTERVAL_MS: "500",
      CODEX_BINARY: fakeCodex,
      CODEX_WORKING_DIRECTORY: temporaryDirectory,
      CODEX_BRIDGE_WEB_CONFIG: "true",
      CODEX_BRIDGE_INCLUDE_THREAD_TITLES: "true",
      CODEX_BRIDGE_ALLOW_REMOTE_THREAD_TITLES: "true",
      CODEX_THREAD_ID: "",
      CODEX_THREAD_SCOPE: "all",
      CODEX_MAX_THREADS: "10",
      CODEX_MAX_CONCURRENT_TURNS: "2",
    };
    delete environment.CODEX_BRIDGE_PERMISSION_MODE;
    delete environment.CODEX_BRIDGE_APPROVAL_MODE;
    child = spawn(
      path.resolve("node_modules/.bin/tsx"),
      [path.resolve("packages/codex-bridge/src/cli.ts")],
      {
        cwd: process.cwd(),
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    try {
      await waitUntil(
        () =>
          completions.length === 3 &&
          inventories.some(
            (threads) =>
              threads.length === 1 &&
              threads[0]?.external_conversation_ref === "thread-created",
          ),
        () =>
          `commands were not reconciled\nstdout:\n${stdout}\nstderr:\n${stderr}\n` +
          `completions=${JSON.stringify(completions)}\n` +
          `inventories=${JSON.stringify(inventories)}`,
      );
    } finally {
      await stopChild(child);
      child = null;
      for (const response of wakeResponses) response.end();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }

    expect(completions).toEqual([
      expect.objectContaining({
        commandId: "11111111-1111-4111-8111-111111111111",
        body: expect.objectContaining({
          succeeded: true,
          external_thread_id: "thread-created",
        }),
      }),
      expect.objectContaining({
        commandId: "22222222-2222-4222-8222-222222222222",
        body: expect.objectContaining({ succeeded: true }),
      }),
      expect.objectContaining({
        commandId: "33333333-3333-4333-8333-333333333333",
        body: expect.objectContaining({ succeeded: true }),
      }),
    ]);
    expect(stderr).toContain(
      `THREAD_START {"cwd":${JSON.stringify(temporaryDirectory)},` +
        '"model":"gpt-5.6-terra",' +
        '"config":{"model_reasoning_effort":"high"},' +
        '"approvalPolicy":"on-request",' +
        '"approvalsReviewer":"user",' +
        '"sandbox":"danger-full-access"}',
    );
    expect(stderr).not.toContain('"sandbox":"workspace-write"');
    expect(stderr).toContain(
      'THREAD_RENAME {"threadId":"thread-created","name":"Created from Web"}',
    );
    expect(stderr).toContain(
      'THREAD_RENAME {"threadId":"thread-existing","name":"Renamed from Web"}',
    );
    expect(stderr).toContain(
      'THREAD_RESUME {"threadId":"thread-existing","excludeTurns":true,' +
        '"model":"gpt-5.6-terra",' +
        '"config":{"model_reasoning_effort":"high"},' +
        `"cwd":${JSON.stringify(temporaryDirectory)},` +
        '"approvalPolicy":"on-request",' +
        '"approvalsReviewer":"user",' +
        '"sandbox":"danger-full-access"}',
    );
    expect(stderr).toContain(
      'THREAD_DELETE {"threadId":"thread-existing"}',
    );
  }, 20_000);

  it("deletes a locally managed Thread whose Board Session is already fenced", async () => {
    const command: ThreadCommand = {
      id: "44444444-4444-4444-8444-444444444444",
      action: "delete",
      name: null,
      external_thread_id: "thread-existing",
    };
    const completions: Array<Record<string, unknown>> = [];
    const inventories: Array<Array<Record<string, unknown>>> = [];
    let commandAvailable = true;
    let taskClaims = 0;
    let stdout = "";
    let stderr = "";

    const server = createServer(async (request, response) => {
      const pathname = new URL(request.url ?? "/", "http://board.test").pathname;
      if (pathname === "/api/ai/config") {
        const status = await bodyOf(request);
        json(response, {
          configuration: {
            connection_id: "connection-fenced-delete",
            version: 1,
            desired: {
              enabled: true,
              include_thread_titles: false,
              max_threads: 10,
              max_concurrent_turns: 2,
              sync_history: false,
              history_turn_limit: 10,
            },
            applied: null,
            runtime: { online: true, lease_expires_at: null },
            updated_at: new Date().toISOString(),
            echoed_runtime: status.runtime_instance_id,
          },
        });
        return;
      }
      if (pathname === "/api/ai/sessions/sync") {
        const body = await bodyOf(request);
        const threads = body.threads as Array<Record<string, unknown>>;
        inventories.push(threads);
        json(response, {
          sessions: threads.map((thread) => ({
            id: `session-${String(thread.external_conversation_ref)}`,
            external_conversation_ref: thread.external_conversation_ref,
            deletion_requested_at: new Date().toISOString(),
          })),
        });
        return;
      }
      if (pathname === "/api/ai/thread-commands/created") {
        json(response, { thread_ids: [] });
        return;
      }
      if (pathname === "/api/ai/thread-commands/claim") {
        await bodyOf(request);
        json(response, {
          command: commandAvailable ? command : null,
        });
        commandAvailable = false;
        return;
      }
      if (
        pathname ===
        "/api/ai/thread-commands/44444444-4444-4444-8444-444444444444/complete"
      ) {
        completions.push(await bodyOf(request));
        json(response, { command });
        return;
      }
      if (pathname === "/api/ai/tasks/claim-next") {
        taskClaims += 1;
        await bodyOf(request);
        response.writeHead(403, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              code: "SESSION_NOT_AUTHORIZED",
              message: "The AI session is not authorized",
            },
          }),
        );
        return;
      }
      if (request.method !== "GET") await bodyOf(request);
      json(response, {});
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test port");

    temporaryDirectory = await mkdtemp(
      path.join(tmpdir(), "atb-fenced-delete-test-"),
    );
    const fakeCodex = path.join(temporaryDirectory, "fake-codex.cjs");
    await writeFile(fakeCodex, FAKE_CODEX, "utf8");
    await chmod(fakeCodex, 0o755);
    child = spawn(
      path.resolve("node_modules/.bin/tsx"),
      [path.resolve("packages/codex-bridge/src/cli.ts")],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AI_TASK_BOARD_URL: `http://127.0.0.1:${address.port}`,
          AI_TASK_BOARD_CONNECTION_TOKEN: "atb_fenced_delete_token",
          AI_TASK_BOARD_CONFIG_POLL_INTERVAL_MS: "1000",
          AI_TASK_BOARD_THREAD_SYNC_INTERVAL_MS: "10000",
          AI_TASK_BOARD_POLL_INTERVAL_MS: "500",
          CODEX_BINARY: fakeCodex,
          CODEX_WORKING_DIRECTORY: temporaryDirectory,
          CODEX_BRIDGE_WEB_CONFIG: "true",
          CODEX_THREAD_ID: "",
          CODEX_THREAD_SCOPE: "all",
          CODEX_MAX_THREADS: "10",
          CODEX_MAX_CONCURRENT_TURNS: "2",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    try {
      await waitUntil(
        () =>
          completions.length === 1 &&
          inventories.some((threads) => threads.length === 0),
        () =>
          `fenced deletion was not reconciled\nstdout:\n${stdout}\nstderr:\n${stderr}\n` +
          `completions=${JSON.stringify(completions)}\n` +
          `inventories=${JSON.stringify(inventories)}`,
      );
      expect(child.exitCode).toBeNull();
    } finally {
      await stopChild(child);
      child = null;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }

    expect(completions[0]).toMatchObject({
      succeeded: true,
      external_thread_id: "thread-existing",
    });
    expect(taskClaims).toBe(0);
    expect(stderr).toContain(
      'THREAD_DELETE {"threadId":"thread-existing"}',
    );
  }, 20_000);
});
