import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import type { SessionConfigOption, SessionInfo } from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { KimiAcpClient } from "../../packages/kimi-bridge/src/acp-client";
import { KimiBridge } from "../../packages/kimi-bridge/src/bridge";
import { loadConfiguration } from "../../packages/kimi-bridge/src/config";

const ACP_SESSION_ID = "kimi-session-keep-live";
const BOARD_SESSION_ID = "board-session-keep-live";

const CONFIG_OPTIONS: SessionConfigOption[] = [
  {
    id: "model-selector",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "kimi-code/k3",
    options: [{ value: "kimi-code/k3", name: "K3", description: null }],
  },
  {
    id: "mode-selector",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: "auto",
    options: [
      { value: "default", name: "Default" },
      { value: "auto", name: "Auto" },
    ],
  },
];

type PromptBehavior =
  | { kind: "resolve"; stopReason: "end_turn" }
  | {
      kind: "reject";
      message: string;
      data: Record<string, unknown>;
    };

function createFakeAcp(session: SessionInfo, behavior: PromptBehavior) {
  const resumeCalls: string[] = [];
  const closeCalls: string[] = [];
  const promptCalls: string[] = [];
  const acp = {
    supportsImages: false,
    agentDescription: "Fake Kimi ACP",
    onUnexpectedExit: () => undefined,
    listAllSessions: async () => [session],
    resumeSession: async (resumed: SessionInfo) => {
      resumeCalls.push(resumed.sessionId);
      return CONFIG_OPTIONS;
    },
    setConfigValue: async (
      _sessionId: string,
      options: SessionConfigOption[],
    ) => [...options],
    selectedValue: () => null,
    newSession: async () => {
      throw new Error("本测试不应新建 Session");
    },
    deleteSession: async () => undefined,
    subscribe: () => () => undefined,
    setTaskActive: () => undefined,
    prompt: async (sessionId: string) => {
      promptCalls.push(sessionId);
      if (behavior.kind === "reject") {
        const error = Object.assign(new Error(behavior.message), {
          code: -32603,
          data: behavior.data,
        });
        throw error;
      }
      return { stopReason: behavior.stopReason, usage: null };
    },
    cancel: async () => undefined,
    closeSession: async (sessionId: string) => {
      closeCalls.push(sessionId);
    },
    close: async () => undefined,
  };
  return {
    acp: acp as unknown as KimiAcpClient,
    resumeCalls,
    closeCalls,
    promptCalls,
  };
}

function json(response: ServerResponse, data: unknown, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ data }));
}

async function bodyOf(
  request: AsyncIterable<unknown>,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

async function waitFor(
  condition: () => boolean,
  description: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${description}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

type FakeBoard = {
  server: Server;
  tasks: Array<Record<string, unknown>>;
  taskInFlight: boolean;
  completedTaskIds: string[];
  failedTasks: Array<{ id: string; reason: string }>;
};

function taskOf(id: string, title: string): Record<string, unknown> {
  return {
    id,
    title,
    description: null,
    acceptance_criteria: null,
    claim_token: `claim-${id}`,
  };
}

function createFakeBoard(tasks: Array<Record<string, unknown>>): FakeBoard {
  const board: FakeBoard = {
    server: null as unknown as Server,
    tasks: [...tasks],
    taskInFlight: false,
    completedTaskIds: [],
    failedTasks: [],
  };
  board.server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://board.test").pathname;
    if (pathname === "/api/ai/config") {
      await bodyOf(request);
      json(response, {
        configuration: {
          connection_id: "conn-keep-live",
          version: 1,
          desired: {
            enabled: true,
            include_thread_titles: false,
            max_threads: 4,
            max_concurrent_turns: 2,
            sync_history: false,
            history_turn_limit: 50,
            working_directories: null,
          },
          updated_at: new Date().toISOString(),
        },
      });
      return;
    }
    if (pathname === "/api/ai/sessions/sync") {
      const body = await bodyOf(request);
      const threads = body.threads as Array<Record<string, unknown>>;
      json(response, {
        sessions: threads.map((thread) => ({
          id: BOARD_SESSION_ID,
          external_conversation_ref: thread.external_conversation_ref,
        })),
      });
      return;
    }
    if (pathname === "/api/ai/sessions/presence") {
      await bodyOf(request);
      json(response, { session: null });
      return;
    }
    if (pathname === "/api/ai/tasks/claim-next") {
      await bodyOf(request);
      if (board.taskInFlight || board.tasks.length === 0) {
        json(response, { task: null });
        return;
      }
      board.taskInFlight = true;
      json(response, { task: board.tasks.shift() ?? null });
      return;
    }
    if (pathname === "/api/ai/tasks/report-progress") {
      await bodyOf(request);
      json(response, {});
      return;
    }
    if (pathname === "/api/ai/tasks/fail") {
      const body = await bodyOf(request);
      board.taskInFlight = false;
      board.failedTasks.push({
        id: String(body.task_id ?? ""),
        reason: String(body.reason ?? ""),
      });
      json(response, {});
      return;
    }
    if (pathname === "/api/ai/tasks/complete") {
      const body = await bodyOf(request);
      board.taskInFlight = false;
      board.completedTaskIds.push(String(body.task_id ?? ""));
      json(response, {});
      return;
    }
    if (pathname === "/api/ai/tasks/release") {
      await bodyOf(request);
      json(response, {});
      return;
    }
    if (pathname === "/api/ai/thread-commands/claim") {
      await bodyOf(request);
      json(response, { command: null });
      return;
    }
    if (request.method !== "GET") await bodyOf(request);
    json(response, pathname.startsWith("/api/ai/tasks/") ? { artifacts: [] } : {});
  });
  return board;
}

describe("Kimi Bridge 保持会话 live", () => {
  let temporaryDirectory: string | null = null;

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      temporaryDirectory = null;
    }
  });

  async function startBridge(
    board: FakeBoard,
    behavior: PromptBehavior,
  ) {
    board.server.listen(0, "127.0.0.1");
    await once(board.server, "listening");
    const address = board.server.address();
    if (!address || typeof address === "string") throw new Error("No test port");

    temporaryDirectory = await mkdtemp(path.join(tmpdir(), "atb-kimi-live-"));
    vi.stubEnv("XDG_CONFIG_HOME", temporaryDirectory);
    const session: SessionInfo = {
      sessionId: ACP_SESSION_ID,
      cwd: temporaryDirectory,
      title: "Keep live target",
      updatedAt: new Date().toISOString(),
    };
    const fake = createFakeAcp(session, behavior);
    const configuration = loadConfiguration({
      AI_TASK_BOARD_URL: `http://127.0.0.1:${address.port}`,
      AI_TASK_BOARD_CONNECTION_TOKEN: "atb_test_keep_live_token",
      KIMI_WORKING_DIRECTORY: temporaryDirectory,
      KIMI_SHARE_DIR: temporaryDirectory,
      AI_TASK_BOARD_POLL_INTERVAL_MS: "500",
      AI_TASK_BOARD_CONFIG_POLL_INTERVAL_MS: "1000",
      AI_TASK_BOARD_THREAD_SYNC_INTERVAL_MS: "10000",
    });
    const bridge = new KimiBridge(configuration, fake.acp);
    const runPromise = bridge.run().catch((error: unknown) => error);
    return { bridge, fake, runPromise };
  }

  async function stopBridge(
    bridge: KimiBridge,
    runPromise: Promise<unknown>,
    board: FakeBoard,
  ) {
    await bridge.stop();
    const runError = await runPromise;
    await new Promise<void>((resolve, reject) =>
      board.server.close((error) => (error ? reject(error) : resolve())),
    );
    expect(runError).toBeUndefined();
  }

  it(
    "连续任务之间不 close 会话，每轮 resume 后都能正常完成",
    async () => {
      const board = createFakeBoard([
        taskOf("task-1", "First task"),
        taskOf("task-2", "Second task"),
      ]);
      const { bridge, fake, runPromise } = await startBridge(board, {
        kind: "resolve",
        stopReason: "end_turn",
      });
      try {
        await waitFor(
          () => board.completedTaskIds.length === 2,
          "两轮任务完成",
        );

        expect(board.completedTaskIds).toEqual(["task-1", "task-2"]);
        expect(board.failedTasks).toEqual([]);
        expect(fake.promptCalls).toEqual([ACP_SESSION_ID, ACP_SESSION_ID]);
        expect(fake.resumeCalls.length).toBeGreaterThanOrEqual(3);
        expect(fake.closeCalls).toEqual([]);
      } finally {
        await stopBridge(bridge, runPromise, board);
      }
    },
    20_000,
  );

  it(
    "任务失败时把 ACP error.data.details 带入失败原因，且不 close 会话",
    async () => {
      const board = createFakeBoard([taskOf("task-fail", "Failing task")]);
      const details =
        "runtime acp:session-failing is registered twice in one transaction";
      const { bridge, fake, runPromise } = await startBridge(board, {
        kind: "reject",
        message: "Internal error",
        data: { details },
      });
      try {
        await waitFor(() => board.failedTasks.length === 1, "任务失败上报");

        expect(board.failedTasks[0].id).toBe("task-fail");
        expect(board.failedTasks[0].reason).toContain("Internal error");
        expect(board.failedTasks[0].reason).toContain(details);
        expect(fake.closeCalls).toEqual([]);
      } finally {
        await stopBridge(bridge, runPromise, board);
      }
    },
    20_000,
  );
});
