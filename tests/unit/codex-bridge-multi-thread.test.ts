import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";

const FAKE_CODEX = `#!/usr/bin/env node
const readline = require("node:readline");
const threads = [
  { id: "thread-a", name: "Alpha", preview: "Alpha", cwd: "/workspace/a", parentThreadId: null },
  { id: "thread-b", name: "Beta", preview: "Beta", cwd: "/workspace/b", parentThreadId: null },
];
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
process.stderr.write("FAKE_ENV " + JSON.stringify({
  boardTokenPresent: Boolean(process.env.AI_TASK_BOARD_CONNECTION_TOKEN),
  codexAuth: process.env.OPENAI_API_KEY || null,
}) + "\\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stderr.write("FAKE_INITIALIZE " + JSON.stringify(message.params) + "\\n");
    send({ id: message.id, result: { userAgent: "fake-codex" } });
  } else if (message.method === "thread/list") {
    send({ id: message.id, result: { data: threads, nextCursor: null, backwardsCursor: null } });
  } else if (message.method === "thread/resume") {
    process.stderr.write("FAKE_RESUME " + JSON.stringify(message.params) + "\\n");
    const thread = threads.find((candidate) => candidate.id === message.params.threadId);
    send({ id: message.id, result: { thread, model: "fake-model", cwd: thread.cwd } });
  } else if (message.method === "turn/start") {
    const threadId = message.params.threadId;
    const turnId = "turn-" + threadId;
    const itemId = "item-" + threadId;
    process.stderr.write("FAKE_TURN_START " + JSON.stringify(message.params) + "\\n");
    send({ method: "item/agentMessage/delta", params: {
      threadId, turnId: "old-" + turnId, itemId: "old-" + itemId, delta: "LEAKED OLD TURN",
    } });
    send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId, delta: "Working" } });
    send({ id: message.id, result: { turn: { id: turnId, status: "inProgress" } } });
    setTimeout(() => {
      send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId, delta: " " } });
    }, 600);
    setTimeout(() => {
      send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId, delta: threadId } });
      send({ method: "item/completed", params: {
        threadId,
        turnId,
        item: { type: "agentMessage", id: itemId, text: "", phase: "final_answer" },
      } });
      send({ method: "turn/completed", params: {
        threadId,
        turn: { id: turnId, status: "completed", error: null },
      } });
    }, 1_200);
  } else if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
  }
});
`;

const DELAYED_START_CODEX = `#!/usr/bin/env node
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-delayed-codex" } });
  } else if (message.method === "thread/list") {
    send({ id: message.id, result: {
      data: [{ id: "thread-delayed", cwd: "/workspace/delayed", parentThreadId: null }],
      nextCursor: null,
    } });
  } else if (message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: "thread-delayed" } } });
  } else if (message.method === "turn/start") {
    process.stderr.write("TURN_START_RECEIVED\\n");
    setTimeout(() => send({ id: message.id, result: {
      turn: { id: "turn-delayed", status: "inProgress" },
    } }), 250);
  } else if (message.method === "turn/interrupt") {
    process.stderr.write("INTERRUPT_RECEIVED " + message.params.turnId + "\\n");
    send({ id: message.id, result: {} });
  }
});
`;

const EMPTY_CODEX = `#!/usr/bin/env node
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: { userAgent: "fake-empty" } });
  else if (message.method === "thread/list") send({ id: message.id, result: { data: [], nextCursor: null } });
});
`;

const CRASHING_CODEX = `#!/usr/bin/env node
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: { userAgent: "fake-crash" } });
  else if (message.method === "thread/list") process.exit(7);
});
`;

const BACKLOG_CODEX = `#!/usr/bin/env node
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-backlog" } });
  } else if (message.method === "thread/list") {
    send({ id: message.id, result: {
      data: [{ id: "thread-overflow", cwd: "/workspace/overflow", parentThreadId: null }],
      nextCursor: null,
    } });
  } else if (message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: "thread-overflow" } } });
  } else if (message.method === "turn/start") {
    send({ id: message.id, result: {
      turn: { id: "turn-overflow", status: "inProgress" },
    } });
    setTimeout(() => {
      for (let index = 0; index < 80; index += 1) {
        send({ method: "item/commandExecution/outputDelta", params: {
          threadId: "thread-overflow",
          turnId: "turn-overflow",
          itemId: "item-" + index,
          delta: "x".repeat(8192),
        } });
      }
    }, 25);
  } else if (message.method === "turn/interrupt") {
    process.stderr.write("BACKLOG_INTERRUPT " + message.params.turnId + "\\n");
    send({ id: message.id, result: {} });
  }
});
`;

type SeenActivity = {
  sessionId: string;
  body: Record<string, unknown>;
};

function json(response: ServerResponse, data: unknown, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ data }));
}

async function bodyOf(request: AsyncIterable<unknown>): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
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

describe("Codex Bridge multi-thread device runtime", () => {
  let child: ChildProcess | null = null;
  let temporaryDirectory: string | null = null;

  afterEach(async () => {
    await stopChild(child);
    child = null;
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  });

  it(
    "discovers two threads and completes one queued turn on each",
    async () => {
      const claimedSessions = new Set<string>();
      const activities: SeenActivity[] = [];
      let syncedInventory: Array<Record<string, unknown>> = [];
      const completedSessions = new Set<string>();
      const wakeResponses = new Set<ServerResponse>();
      let resolveCompleted!: () => void;
      const completed = new Promise<void>((resolve) => {
        resolveCompleted = resolve;
      });

      const server = createServer(async (request, response) => {
        const pathname = new URL(request.url ?? "/", "http://board.test").pathname;
        const sessionId = String(request.headers["x-ai-session-id"] ?? "");
        if (pathname === "/api/ai/config") {
          response.writeHead(404, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: { message: "legacy Board" } }));
          return;
        }
        if (pathname === "/api/ai/sessions/wake") {
          response.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
          });
          response.write(": connected\n\n");
          wakeResponses.add(response);
          response.on("close", () => wakeResponses.delete(response));
          return;
        }
        if (pathname === "/api/ai/sessions/sync") {
          const body = await bodyOf(request);
          const threads = body.threads as Array<Record<string, unknown>>;
          syncedInventory = threads;
          json(response, {
            sessions: threads.map((thread, index) => ({
              id: `session-${index + 1}`,
              external_conversation_ref: thread.external_conversation_ref,
            })),
          });
          return;
        }
        if (pathname === "/api/ai/tasks/claim-next") {
          if (!claimedSessions.has(sessionId)) {
            claimedSessions.add(sessionId);
            json(response, {
              task: {
                id: `task-${sessionId}`,
                title: `Task for ${sessionId}`,
                description: `Please work in ${sessionId}`,
                acceptance_criteria: null,
                claim_token: `claim-${sessionId}`,
              },
            });
          } else {
            json(response, { task: null });
          }
          return;
        }
        if (pathname === "/api/ai/sessions/activity") {
          activities.push({ sessionId, body: await bodyOf(request) });
          json(response, {});
          return;
        }
        if (pathname === "/api/ai/tasks/complete") {
          await bodyOf(request);
          completedSessions.add(sessionId);
          json(response, {});
          if (completedSessions.size === 2) resolveCompleted();
          return;
        }
        if (request.method !== "GET") await bodyOf(request);
        json(response, {});
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No test port");

      temporaryDirectory = await mkdtemp(path.join(tmpdir(), "atb-bridge-test-"));
      const fakeCodex = path.join(temporaryDirectory, "fake-codex.cjs");
      await writeFile(fakeCodex, FAKE_CODEX, "utf8");
      await chmod(fakeCodex, 0o755);

      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        AI_TASK_BOARD_URL: `http://127.0.0.1:${address.port}`,
        AI_TASK_BOARD_CONNECTION_TOKEN: "atb_test_connection_token",
        CODEX_BINARY: fakeCodex,
        CODEX_MAX_THREADS: "2",
        CODEX_THREAD_SCOPE: "all",
        CODEX_MAX_CONCURRENT_TURNS: "2",
        OPENAI_API_KEY: "codex_auth_is_preserved",
        AI_TASK_BOARD_POLL_INTERVAL_MS: "500",
        AI_TASK_BOARD_THREAD_SYNC_INTERVAL_MS: "10000",
      };
      delete environment.CODEX_THREAD_ID;
      child = spawn(
        path.resolve("node_modules/.bin/tsx"),
        [path.resolve("packages/codex-bridge/src/cli.ts")],
        { cwd: process.cwd(), env: environment, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      try {
        await Promise.race([
          completed,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error(`Bridge smoke timeout: ${stderr}`)),
              10_000,
            ),
          ),
        ]);
      } finally {
        await stopChild(child);
        child = null;
        for (const response of wakeResponses) response.end();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }

      expect(claimedSessions).toEqual(new Set(["session-1", "session-2"]));
      expect(completedSessions).toEqual(new Set(["session-1", "session-2"]));
      expect(JSON.stringify(syncedInventory)).not.toContain("Alpha");
      expect(JSON.stringify(syncedInventory)).not.toContain("Beta");
      expect(syncedInventory).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "Codex · a · thread-a" }),
          expect.objectContaining({ name: "Codex · b · thread-b" }),
        ]),
      );
      expect(stderr).toContain(
        'FAKE_ENV {"boardTokenPresent":false,"codexAuth":"codex_auth_is_preserved"}',
      );
      expect(stderr).toContain('"requestAttestation":false');
      expect(stderr).toContain('"approvalPolicy":"on-request"');
      expect(stderr).toContain('"approvalsReviewer":"user"');
      expect(stderr).toContain('"sandbox":"workspace-write"');
      expect(stderr).toContain('"type":"workspaceWrite"');
      expect(stderr).toContain('"writableRoots":["/workspace/a"]');
      expect(
        activities.filter((activity) => activity.body.kind === "assistant_message"),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionId: "session-1",
            body: expect.objectContaining({
              content: "Working thread-a",
              data: expect.objectContaining({ phase: "completed" }),
            }),
          }),
          expect.objectContaining({
            sessionId: "session-2",
            body: expect.objectContaining({
              content: "Working thread-b",
              data: expect.objectContaining({ phase: "completed" }),
            }),
          }),
        ]),
      );
      expect(
        activities.some(
          (activity) =>
            activity.body.kind === "assistant_message" &&
            (activity.body.data as Record<string, unknown>).phase === "delta",
        ),
      ).toBe(true);
      expect(
        activities.some(
          (activity) =>
            activity.body.kind === "assistant_message" &&
            activity.body.content === " ",
        ),
      ).toBe(true);
      expect(JSON.stringify(activities)).not.toContain("LEAKED OLD TURN");
    },
    20_000,
  );

  it(
    "drains a delayed turn/start response and interrupts the turn on SIGTERM",
    async () => {
      const wakeResponses = new Set<ServerResponse>();
      let claimed = false;
      const server = createServer(async (request, response) => {
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
          const body = await bodyOf(request);
          const thread = (body.threads as Array<Record<string, unknown>>)[0];
          json(response, {
            sessions: [{
              id: "session-delayed",
              external_conversation_ref: thread?.external_conversation_ref,
            }],
          });
          return;
        }
        if (pathname === "/api/ai/tasks/claim-next") {
          json(response, {
            task: claimed
              ? null
              : {
                  id: "task-delayed",
                  title: "Delayed start",
                  description: "Wait for the delayed start response",
                  acceptance_criteria: null,
                  claim_token: "claim-delayed",
                },
          });
          claimed = true;
          return;
        }
        if (request.method !== "GET") await bodyOf(request);
        json(response, {});
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No test port");

      temporaryDirectory = await mkdtemp(path.join(tmpdir(), "atb-bridge-stop-"));
      const fakeCodex = path.join(temporaryDirectory, "fake-delayed.cjs");
      await writeFile(fakeCodex, DELAYED_START_CODEX, "utf8");
      await chmod(fakeCodex, 0o755);
      child = spawn(
        path.resolve("node_modules/.bin/tsx"),
        [path.resolve("packages/codex-bridge/src/cli.ts")],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            AI_TASK_BOARD_URL: `http://127.0.0.1:${address.port}`,
            AI_TASK_BOARD_CONNECTION_TOKEN: "atb_delayed_token",
            CODEX_BINARY: fakeCodex,
            CODEX_THREAD_ID: "",
            CODEX_THREAD_SCOPE: "all",
            AI_TASK_BOARD_POLL_INTERVAL_MS: "500",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stderr = "";
      let signalSent = false;
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
        if (!signalSent && stderr.includes("TURN_START_RECEIVED")) {
          signalSent = true;
          child?.kill("SIGTERM");
        }
      });

      try {
        const [code] = await Promise.race([
          once(child, "exit"),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`Bridge shutdown timeout: ${stderr}`)),
              8_000,
            ),
          ),
        ]);
        child = null;
        expect(code).toBe(0);
        expect(signalSent).toBe(true);
        expect(stderr).toContain("INTERRUPT_RECEIVED turn-delayed");
      } finally {
        await stopChild(child);
        child = null;
        for (const response of wakeResponses) response.end();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
    15_000,
  );

  it.each([
    [401, "认证失败"],
    [404, "请先升级 Board schema/API"],
  ])(
    "fails fast when inventory sync returns HTTP %i",
    async (status, expectedMessage) => {
      const server = createServer((_request, response) => {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: `status-${status}` } }));
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No test port");
      temporaryDirectory = await mkdtemp(path.join(tmpdir(), "atb-bridge-4xx-"));
      const fakeCodex = path.join(temporaryDirectory, "fake-empty.cjs");
      await writeFile(fakeCodex, EMPTY_CODEX, "utf8");
      await chmod(fakeCodex, 0o755);
      child = spawn(
        path.resolve("node_modules/.bin/tsx"),
        [path.resolve("packages/codex-bridge/src/cli.ts")],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            AI_TASK_BOARD_URL: `http://127.0.0.1:${address.port}`,
            AI_TASK_BOARD_CONNECTION_TOKEN: "atb_invalid_token",
            CODEX_BINARY: fakeCodex,
            CODEX_THREAD_ID: "",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      try {
        const [code] = await Promise.race([
          once(child, "exit"),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`4xx fail-fast timeout: ${stderr}`)), 4_000),
          ),
        ]);
        child = null;
        expect(code).not.toBe(0);
        expect(stderr).toContain(expectedMessage);
      } finally {
        await stopChild(child);
        child = null;
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
    10_000,
  );

  it("exits non-zero when Codex App Server exits unexpectedly", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "legacy Board" } }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test port");
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), "atb-bridge-crash-"));
    const fakeCodex = path.join(temporaryDirectory, "fake-crash.cjs");
    await writeFile(fakeCodex, CRASHING_CODEX, "utf8");
    await chmod(fakeCodex, 0o755);
    child = spawn(
      path.resolve("node_modules/.bin/tsx"),
      [path.resolve("packages/codex-bridge/src/cli.ts")],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AI_TASK_BOARD_URL: `http://127.0.0.1:${address.port}`,
          AI_TASK_BOARD_CONNECTION_TOKEN: "atb_crash_token",
          CODEX_BINARY: fakeCodex,
          CODEX_THREAD_ID: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    try {
      const [code] = await Promise.race([
        once(child, "exit"),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Crash propagation timeout: ${stderr}`)), 4_000),
        ),
      ]);
      child = null;
      expect(code).not.toBe(0);
      expect(stderr).toContain("Codex App Server 意外退出");
    } finally {
      await stopChild(child);
      child = null;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 10_000);

  it("interrupts and exits instead of buffering unbounded activity uploads", async () => {
    const wakeResponses = new Set<ServerResponse>();
    const stalledActivityResponses = new Set<ServerResponse>();
    let claimed = false;
    const server = createServer(async (request, response) => {
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
            id: "session-overflow",
            external_conversation_ref: "thread-overflow",
          }],
        });
        return;
      }
      if (pathname === "/api/ai/tasks/claim-next") {
        json(response, {
          task: claimed
            ? null
            : {
                id: "task-overflow",
                title: "Overflow protection",
                description: "Produce a large stream",
                acceptance_criteria: null,
                claim_token: "claim-overflow",
              },
        });
        claimed = true;
        return;
      }
      if (pathname === "/api/ai/sessions/activity") {
        await bodyOf(request);
        stalledActivityResponses.add(response);
        response.on("close", () => stalledActivityResponses.delete(response));
        return;
      }
      if (request.method !== "GET") await bodyOf(request);
      json(response, {});
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test port");

    temporaryDirectory = await mkdtemp(path.join(tmpdir(), "atb-bridge-backlog-"));
    const fakeCodex = path.join(temporaryDirectory, "fake-backlog.cjs");
    await writeFile(fakeCodex, BACKLOG_CODEX, "utf8");
    await chmod(fakeCodex, 0o755);
    child = spawn(
      path.resolve("node_modules/.bin/tsx"),
      [path.resolve("packages/codex-bridge/src/cli.ts")],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AI_TASK_BOARD_URL: `http://127.0.0.1:${address.port}`,
          AI_TASK_BOARD_CONNECTION_TOKEN: "atb_backlog_token",
          CODEX_BINARY: fakeCodex,
          CODEX_THREAD_ID: "",
          CODEX_THREAD_SCOPE: "all",
          AI_TASK_BOARD_POLL_INTERVAL_MS: "500",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    try {
      const [code] = await Promise.race([
        once(child, "exit"),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Backlog protection timeout: ${stderr}`)),
            8_000,
          ),
        ),
      ]);
      child = null;
      expect(code).not.toBe(0);
      expect(stderr).toContain("backlog exceeded its safety limit");
      expect(stderr).toContain("BACKLOG_INTERRUPT turn-overflow");
    } finally {
      await stopChild(child);
      child = null;
      for (const response of wakeResponses) response.end();
      for (const response of stalledActivityResponses) response.end();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 15_000);
});
