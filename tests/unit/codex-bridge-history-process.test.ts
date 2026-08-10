import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const FAKE_HISTORY_CODEX = `#!/usr/bin/env node
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const turns = [
  {
    id: "019f1234-5678-7abc-8def-0123456789ab",
    status: "completed",
    startedAt: 1786291200,
    completedAt: 1786291210,
    itemsView: "full",
    items: [
      { type: "userMessage", id: "local-user", clientId: null, content: [
        { type: "text", text: "Local historical prompt" },
        { type: "localImage", path: "/private/history.png" }
      ] },
      { type: "reasoning", id: "local-reasoning", summary: ["Provider summary"], content: ["HIDDEN RAW REASONING"] },
      { type: "commandExecution", id: "local-command", command: "cat /private/secret", aggregatedOutput: "HIDDEN COMMAND OUTPUT" },
      { type: "agentMessage", id: "local-final", phase: "final_answer", text: "Local historical answer" }
    ]
  },
  {
    id: "019f1234-5678-7abc-8def-0123456789ac",
    status: "completed",
    startedAt: 1786291100,
    completedAt: 1786291110,
    itemsView: "full",
    items: [
      { type: "userMessage", id: "board-user", clientId: "board-task-id", content: [{ type: "text", text: "Board live prompt" }] },
      { type: "agentMessage", id: "board-final", phase: "final_answer", text: "Board live answer" }
    ]
  },
  {
    id: "019f1234-5678-7abc-8def-0123456789ad",
    status: "inProgress",
    startedAt: 1786291000,
    completedAt: null,
    itemsView: "full",
    items: [{ type: "userMessage", id: "active-user", clientId: null, content: [{ type: "text", text: "Active prompt" }] }]
  }
];
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-history-codex/0.147" } });
  } else if (message.method === "thread/list") {
    send({ id: message.id, result: {
      data: [{ id: "thread-history", source: "cli", cwd: "/workspace/history", parentThreadId: null, createdAt: 1786290000 }],
      nextCursor: null
    } });
  } else if (message.method === "thread/turns/list") {
    send({ id: message.id, result: {
      data: turns.slice(0, message.params.limit || turns.length).map(({ items, ...turn }) => ({
        ...turn,
        items: [],
        itemsView: message.params.itemsView
      })),
      nextCursor: null,
      backwardsCursor: null
    } });
  } else if (message.method === "thread/items/list") {
    const turn = turns.find((candidate) => candidate.id === message.params.turnId);
    const items = turn ? turn.items : [];
    const offset = message.params.cursor ? Number(message.params.cursor.slice(7)) : 0;
    const limit = message.params.limit || 100;
    const end = Math.min(items.length, offset + limit);
    send({ id: message.id, result: {
      data: items.slice(offset, end).map((item) => ({ turnId: message.params.turnId, item })),
      nextCursor: end < items.length ? "offset:" + end : null,
      backwardsCursor: null
    } });
  }
});
`;

function json(response: ServerResponse, data: unknown, status = 200): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ data }));
}

async function bodyOf(request: AsyncIterable<unknown>): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function waitUntil(
  predicate: () => boolean,
  diagnostics: () => string,
  timeoutMs = 10_000,
): Promise<void> {
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

describe("Codex Bridge history process", () => {
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

  it("imports a bounded sanitized snapshot without duplicating Board live turns", async () => {
    const configurationStatuses: Array<Record<string, unknown>> = [];
    const historyRequests: Array<Record<string, unknown>> = [];
    const wakeResponses = new Set<ServerResponse>();
    const server = createServer(async (request, response) => {
      const pathname = new URL(request.url ?? "/", "http://board.test").pathname;
      if (pathname === "/api/ai/config") {
        configurationStatuses.push(await bodyOf(request));
        json(response, {
          configuration: {
            connection_id: "connection-history",
            version: 1,
            desired: {
              enabled: true,
              include_thread_titles: false,
              max_threads: 1,
              max_concurrent_turns: 1,
              sync_history: true,
              history_turn_limit: 3
            },
            applied: null,
            updated_at: new Date().toISOString()
          }
        });
        return;
      }
      if (pathname === "/api/ai/sessions/sync") {
        const body = await bodyOf(request);
        const threads = body.threads as Array<Record<string, unknown>>;
        json(response, {
          sessions: threads.map((thread) => ({
            id: "session-history",
            external_conversation_ref: thread.external_conversation_ref
          }))
        });
        return;
      }
      if (pathname === "/api/ai/sessions/history") {
        const body = await bodyOf(request);
        historyRequests.push(body);
        const sync = body.sync as Record<string, unknown>;
        json(response, {
          imported: {
            inserted: Array.isArray(body.items) ? body.items.length : 0,
            replayed: 0
          },
          history_sync: {
            ...sync,
            imported_items: 3,
            started_at: new Date().toISOString(),
            completed_at: sync.status === "syncing" ? null : new Date().toISOString(),
            updated_at: new Date().toISOString()
          }
        });
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

    temporaryDirectory = await mkdtemp(path.join(tmpdir(), "atb-history-process-"));
    const fakeCodex = path.join(temporaryDirectory, "fake-codex.cjs");
    await writeFile(fakeCodex, FAKE_HISTORY_CODEX, "utf8");
    await chmod(fakeCodex, 0o755);
    child = spawn(
      path.resolve("node_modules/.bin/tsx"),
      [path.resolve("packages/codex-bridge/src/cli.ts")],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AI_TASK_BOARD_URL: `http://127.0.0.1:${address.port}`,
          AI_TASK_BOARD_CONNECTION_TOKEN: "atb_history_token",
          AI_TASK_BOARD_CONFIG_POLL_INTERVAL_MS: "1000",
          AI_TASK_BOARD_THREAD_SYNC_INTERVAL_MS: "10000",
          AI_TASK_BOARD_POLL_INTERVAL_MS: "500",
          CODEX_BINARY: fakeCodex,
          CODEX_BRIDGE_WEB_CONFIG: "true",
          CODEX_BRIDGE_ALLOW_HISTORY_SYNC: "true",
          CODEX_BRIDGE_MAX_HISTORY_TURNS: "3",
          CODEX_MAX_THREADS: "1",
          CODEX_MAX_CONCURRENT_TURNS: "1",
          CODEX_THREAD_ID: "",
          CODEX_THREAD_SCOPE: "all",
          CODEX_WORKING_DIRECTORY: temporaryDirectory,
          CODEX_BRIDGE_PERMISSION_MODE: "safe",
          CODEX_BRIDGE_APPROVAL_MODE: "decline"
        },
        stdio: ["ignore", "pipe", "pipe"]
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

    try {
      await waitUntil(
        () =>
          historyRequests.some(
            (body) => (body.sync as Record<string, unknown>)?.status === "complete",
          ),
        () => `history did not complete\n${stdout}\n${stderr}\n${JSON.stringify(historyRequests)}`,
      );
    } finally {
      await stopChild(child);
      child = null;
      for (const response of wakeResponses) response.end();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }

    expect(
      configurationStatuses.some((status) =>
        (status.effective as Record<string, unknown> | null)?.sync_history === true,
      ),
    ).toBe(true);
    expect(historyRequests[0]).toMatchObject({
      runtime_instance_id: expect.any(String),
      report_sequence: 1,
      items: [],
      sync: { status: "syncing", turn_limit: 3, scanned_turns: 0 },
    });
    const reportSequences = historyRequests.map((body) =>
      Number(body.report_sequence),
    );
    expect(reportSequences.every(Number.isSafeInteger)).toBe(true);
    expect(reportSequences).toEqual(
      [...reportSequences].sort((left, right) => left - right),
    );
    expect(new Set(reportSequences).size).toBe(reportSequences.length);
    const allImported = historyRequests.flatMap((body) =>
      Array.isArray(body.items) ? body.items : [],
    );
    const imported = [
      ...new Map(
        allImported.map((item) => [String(item.external_ref), item] as const),
      ).values(),
    ];
    expect(imported).toMatchObject([
      { kind: "user_message", content: "Local historical prompt" },
      { kind: "reasoning", content: "Provider summary" },
      { kind: "assistant_message", content: "Local historical answer" },
    ]);
    const serialized = JSON.stringify(imported);
    expect(serialized).not.toContain("Board live");
    expect(serialized).not.toContain("Active prompt");
    expect(serialized).not.toContain("HIDDEN RAW REASONING");
    expect(serialized).not.toContain("HIDDEN COMMAND OUTPUT");
    expect(serialized).not.toContain("/private");
    for (const externalRef of new Set(allImported.map((item) => item.external_ref))) {
      expect(
        new Set(
          allImported
            .filter((item) => item.external_ref === externalRef)
            .map((item) => JSON.stringify(item)),
        ).size,
      ).toBe(1);
    }
  }, 15_000);
});
