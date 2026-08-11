import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const FAKE_USER_INPUT_CODEX = `#!/usr/bin/env node
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const thread = { id: "thread-input", name: "Input", cwd: "/workspace/input", parentThreadId: null };
let turnStarts = 0;
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-user-input" } });
  } else if (message.method === "thread/list") {
    send({ id: message.id, result: { data: [thread], nextCursor: null } });
  } else if (message.method === "thread/resume") {
    send({ id: message.id, result: { thread } });
  } else if (message.method === "turn/start") {
    turnStarts += 1;
    process.stderr.write("TURN_START " + turnStarts + "\\n");
    send({ id: message.id, result: { turn: { id: "turn-input", status: "inProgress" } } });
    setTimeout(() => send({
      id: 700,
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-input",
        turnId: "turn-input",
        itemId: "item-input",
        isBlocking: true,
        questions: [
          {
            id: "deploy",
            header: "发布方式",
            question: "请选择发布方式",
            options: [
              { label: "滚动发布", description: "逐实例替换" },
              { label: "立即切换", description: "一次切换" }
            ]
          },
          {
            id: "note",
            header: "备注",
            question: "请输入备注",
            options: null,
            isSecret: true
          }
        ]
      }
    }), 25);
  } else if (message.id === 700) {
    process.stderr.write("INPUT_RESPONSE " + JSON.stringify(message) + "\\n");
    send({ method: "item/completed", params: {
      threadId: "thread-input",
      turnId: "turn-input",
      item: { type: "agentMessage", id: "answer-item", text: "Continued original turn", phase: "final_answer" }
    } });
    send({ method: "turn/completed", params: {
      threadId: "thread-input",
      turn: { id: "turn-input", status: "completed", error: null }
    } });
  } else if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
  }
});
`;

function json(response: ServerResponse, data: unknown, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ data }));
}

async function bodyOf(request: AsyncIterable<unknown>) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

async function stopChild(child: ChildProcess | null) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Bridge did not stop")), 5_000),
    ),
  ]);
}

describe("Codex Bridge structured user input process", () => {
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

  it(
    "keeps one turn waiting and resumes it with the Web answer",
    async () => {
      let claimed = false;
      let registerBody: Record<string, unknown> | null = null;
      let pollCount = 0;
      let completeBody: Record<string, unknown> | null = null;
      const wakeResponses = new Set<ServerResponse>();
      let resolveComplete!: () => void;
      const completed = new Promise<void>((resolve) => {
        resolveComplete = resolve;
      });

      const server = createServer(async (request, response) => {
        const pathname = new URL(request.url ?? "/", "http://board.test").pathname;
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
          await bodyOf(request);
          json(response, {
            sessions: [
              { id: "session-input", external_conversation_ref: "thread-input" },
            ],
          });
          return;
        }
        if (pathname === "/api/ai/thread-commands/claim") {
          await bodyOf(request);
          json(response, { command: null });
          return;
        }
        if (pathname === "/api/ai/tasks/claim-next") {
          await bodyOf(request);
          if (!claimed) {
            claimed = true;
            json(response, {
              task: {
                id: "task-input",
                title: "Ask before deploying",
                description: "Deploy after confirming the strategy",
                acceptance_criteria: null,
                claim_token: "claim-input",
              },
            });
          } else {
            json(response, { task: null });
          }
          return;
        }
        if (pathname === "/api/ai/tasks/user-input-requests") {
          registerBody = await bodyOf(request);
          json(response, {
            request: {
              id: registerBody.request_id,
              status: "pending",
            },
          });
          return;
        }
        if (pathname.endsWith("/poll")) {
          const body = await bodyOf(request);
          pollCount += 1;
          json(response, {
            request: {
              id: body.request_id,
              status: pollCount >= 3 ? "answered" : "pending",
              answers:
                pollCount >= 3
                  ? {
                      deploy: ["滚动发布"],
                      note: ["private release note"],
                    }
                  : null,
            },
          });
          return;
        }
        if (pathname === "/api/ai/tasks/complete") {
          completeBody = await bodyOf(request);
          json(response, {});
          resolveComplete();
          return;
        }
        if (request.method !== "GET") await bodyOf(request);
        json(response, {});
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No test port");

      temporaryDirectory = await mkdtemp(path.join(tmpdir(), "atb-input-test-"));
      const fakeCodex = path.join(temporaryDirectory, "fake-codex.cjs");
      await writeFile(fakeCodex, FAKE_USER_INPUT_CODEX, "utf8");
      await chmod(fakeCodex, 0o755);

      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        AI_TASK_BOARD_URL: `http://127.0.0.1:${address.port}`,
        AI_TASK_BOARD_CONNECTION_TOKEN: "atb_test_connection_token",
        CODEX_BINARY: fakeCodex,
        CODEX_MAX_THREADS: "1",
        CODEX_THREAD_SCOPE: "all",
        CODEX_MAX_CONCURRENT_TURNS: "1",
        AI_TASK_BOARD_POLL_INTERVAL_MS: "500",
        AI_TASK_BOARD_THREAD_SYNC_INTERVAL_MS: "10000",
      };
      delete environment.CODEX_THREAD_ID;
      child = spawn(
        path.resolve("node_modules/.bin/tsx"),
        [path.resolve("packages/codex-bridge/src/cli.ts")],
        {
          cwd: process.cwd(),
          env: environment,
          stdio: ["ignore", "pipe", "pipe"],
        },
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
              () => reject(new Error(`Structured input timeout: ${stderr}`)),
              15_000,
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

      expect(registerBody).toMatchObject({
        task_id: "task-input",
        claim_token: "claim-input",
        turn_id: "turn-input",
        item_id: "item-input",
        is_blocking: true,
      });
      expect(pollCount).toBeGreaterThanOrEqual(3);
      expect(completeBody).toMatchObject({ task_id: "task-input" });
      expect((stderr.match(/TURN_START /g) ?? []).length).toBe(1);
      expect(stderr).toContain(
        'INPUT_RESPONSE {"id":700,"result":{"answers":{"deploy":{"answers":["滚动发布"]},"note":{"answers":["private release note"]}}}}',
      );
    },
    25_000,
  );
});
