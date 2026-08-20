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

const ACP_SESSION_ID = "kimi-session-pause";
const BOARD_SESSION_ID = "board-session-pause";
const PAUSE_COMMAND_ID = "pause-command-1";

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

type FakePromptResponse = { stopReason: string; usage: null };

function createFakeAcp(session: SessionInfo) {
  const cancelCalls: string[] = [];
  const promptCalls: string[] = [];
  let resolvePrompt!: (response: FakePromptResponse) => void;
  let markPromptStarted!: () => void;
  const promptStarted = new Promise<void>((resolve) => {
    markPromptStarted = resolve;
  });
  const acp = {
    supportsImages: false,
    agentDescription: "Fake Kimi ACP",
    onUnexpectedExit: () => undefined,
    listAllSessions: async () => [session],
    resumeSession: async () => CONFIG_OPTIONS,
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
      markPromptStarted();
      return new Promise<FakePromptResponse>((resolve) => {
        resolvePrompt = resolve;
      });
    },
    cancel: async (sessionId: string) => {
      cancelCalls.push(sessionId);
      resolvePrompt({ stopReason: "cancelled", usage: null });
    },
    closeSession: async () => undefined,
    close: async () => undefined,
  };
  return {
    acp: acp as unknown as KimiAcpClient,
    cancelCalls,
    promptCalls,
    promptStarted,
    finishPrompt: (response: FakePromptResponse) => resolvePrompt(response),
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
  queuedCommand: Record<string, unknown> | null;
  taskClaimed: boolean;
  offerTask: boolean;
  presenceCalls: number;
  failCalls: number;
  completeTaskCalls: number;
  releaseCalls: number;
  commandCompletions: Array<Record<string, unknown>>;
};

function createFakeBoard(): FakeBoard {
  const board: FakeBoard = {
    server: null as unknown as Server,
    queuedCommand: null,
    taskClaimed: false,
    offerTask: true,
    presenceCalls: 0,
    failCalls: 0,
    completeTaskCalls: 0,
    releaseCalls: 0,
    commandCompletions: [],
  };
  board.server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://board.test").pathname;
    if (pathname === "/api/ai/config") {
      await bodyOf(request);
      json(response, {
        configuration: {
          connection_id: "conn-pause",
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
      board.presenceCalls += 1;
      json(response, { session: null });
      return;
    }
    if (pathname === "/api/ai/tasks/claim-next") {
      await bodyOf(request);
      if (board.offerTask && !board.taskClaimed) {
        board.taskClaimed = true;
        json(response, {
          task: {
            id: "task-pause",
            title: "Pause me",
            description: "A task interrupted by a Web pause",
            acceptance_criteria: null,
            claim_token: "claim-pause",
          },
        });
      } else {
        json(response, { task: null });
      }
      return;
    }
    if (pathname === "/api/ai/tasks/report-progress") {
      await bodyOf(request);
      json(response, {});
      return;
    }
    if (pathname === "/api/ai/tasks/fail") {
      await bodyOf(request);
      board.failCalls += 1;
      json(response, {});
      return;
    }
    if (pathname === "/api/ai/tasks/complete") {
      await bodyOf(request);
      board.completeTaskCalls += 1;
      json(response, {});
      return;
    }
    if (pathname === "/api/ai/tasks/release") {
      await bodyOf(request);
      board.releaseCalls += 1;
      json(response, {});
      return;
    }
    if (pathname === "/api/ai/thread-commands/claim") {
      await bodyOf(request);
      const command = board.queuedCommand;
      board.queuedCommand = null;
      json(response, { command });
      return;
    }
    if (
      pathname.startsWith("/api/ai/thread-commands/") &&
      pathname.endsWith("/complete")
    ) {
      board.commandCompletions.push(await bodyOf(request));
      json(response, {});
      return;
    }
    if (request.method !== "GET") await bodyOf(request);
    json(response, pathname.startsWith("/api/ai/tasks/") ? { artifacts: [] } : {});
  });
  return board;
}

function pauseCommand(taskId: string | null): Record<string, unknown> {
  return {
    id: PAUSE_COMMAND_ID,
    action: "pause",
    session_id: BOARD_SESSION_ID,
    external_thread_id: ACP_SESSION_ID,
    task_id: taskId,
    name: null,
    directory_key: null,
    platform: "kimi",
    attempt_count: 1,
  };
}

describe("Kimi Bridge Web 暂停指令", () => {
  let temporaryDirectory: string | null = null;

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      temporaryDirectory = null;
    }
  });

  async function startBridge(board: FakeBoard) {
    board.server.listen(0, "127.0.0.1");
    await once(board.server, "listening");
    const address = board.server.address();
    if (!address || typeof address === "string") throw new Error("No test port");

    temporaryDirectory = await mkdtemp(path.join(tmpdir(), "atb-kimi-pause-"));
    vi.stubEnv("XDG_CONFIG_HOME", temporaryDirectory);
    const session: SessionInfo = {
      sessionId: ACP_SESSION_ID,
      cwd: temporaryDirectory,
      title: "Pause target",
      updatedAt: new Date().toISOString(),
    };
    const fake = createFakeAcp(session);
    const configuration = loadConfiguration({
      AI_TASK_BOARD_URL: `http://127.0.0.1:${address.port}`,
      AI_TASK_BOARD_CONNECTION_TOKEN: "atb_test_pause_token",
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
    "暂停运行中 turn：发送 session/cancel，任务不 fail，指令成功完成",
    async () => {
      const board = createFakeBoard();
      const { bridge, fake, runPromise } = await startBridge(board);
      try {
        await waitFor(
          () => fake.promptCalls.length > 0,
          "Kimi turn 开始",
        );
        board.queuedCommand = pauseCommand("task-pause");
        await waitFor(
          () => board.commandCompletions.length > 0,
          "暂停指令完成",
        );

        expect(fake.cancelCalls).toEqual([ACP_SESSION_ID]);
        expect(board.failCalls).toBe(0);
        expect(board.completeTaskCalls).toBe(0);
        expect(board.releaseCalls).toBe(0);
        expect(board.commandCompletions[0]).toMatchObject({
          succeeded: true,
          error: null,
        });
      } finally {
        await stopBridge(bridge, runPromise, board);
      }
    },
    20_000,
  );

  it(
    "暂停空闲 Session：成功 no-op，不发送 cancel",
    async () => {
      const board = createFakeBoard();
      board.offerTask = false;
      const { bridge, fake, runPromise } = await startBridge(board);
      try {
        await waitFor(() => board.presenceCalls > 0, "worker 空闲心跳");
        // null task_id 固定旧 Board 的兼容路径（无条件暂停语义）。
        board.queuedCommand = pauseCommand(null);
        await waitFor(
          () => board.commandCompletions.length > 0,
          "暂停指令完成",
        );

        expect(fake.promptCalls).toEqual([]);
        expect(fake.cancelCalls).toEqual([]);
        expect(board.failCalls).toBe(0);
        expect(board.commandCompletions[0]).toMatchObject({
          succeeded: true,
          error: null,
        });
      } finally {
        await stopBridge(bridge, runPromise, board);
      }
    },
    20_000,
  );

  it(
    "过期暂停指令（task_id 不匹配）：不中断当前 turn，任务正常完成",
    async () => {
      const board = createFakeBoard();
      const { bridge, fake, runPromise } = await startBridge(board);
      try {
        await waitFor(() => fake.promptCalls.length > 0, "Kimi turn 开始");
        board.queuedCommand = pauseCommand("task-already-paused-earlier");
        await waitFor(
          () => board.commandCompletions.length > 0,
          "暂停指令完成",
        );

        // The stale command is a successful no-op: no cancel, no pause flag.
        expect(fake.cancelCalls).toEqual([]);
        expect(board.commandCompletions[0]).toMatchObject({
          succeeded: true,
          error: null,
        });

        // The active turn keeps running and completes the task normally.
        fake.finishPrompt({ stopReason: "end_turn", usage: null });
        await waitFor(() => board.completeTaskCalls > 0, "任务正常完成");
        expect(board.failCalls).toBe(0);
        expect(board.releaseCalls).toBe(0);
      } finally {
        await stopBridge(bridge, runPromise, board);
      }
    },
    20_000,
  );
});
