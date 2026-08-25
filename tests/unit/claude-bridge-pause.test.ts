import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { SessionInfo } from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClaudeAcpClient } from "../../packages/claude-code-bridge/src/acp-client";
import {
  ClaudeBridge,
  SessionWorker,
  TurnLimiter,
} from "../../packages/claude-code-bridge/src/bridge";
import type {
  BoardClient,
  BoardSession,
  ClaimedTask,
  ThreadCommand,
} from "../../packages/claude-code-bridge/src/board-client";
import {
  loadConfiguration,
  type ClaudeBridgeConfiguration,
} from "../../packages/claude-code-bridge/src/config";

type PromptResult = { stopReason: string; usage: null };

/** Minimal ClaudeAcpClient double: the prompt hangs until `cancel` resolves it. */
class FakeAcp {
  readonly cancelCalls: string[] = [];
  onPromptStarted: (() => void) | null = null;
  private promptResolve: ((value: PromptResult) => void) | null = null;

  get supportsImages(): boolean {
    return false;
  }

  onUnexpectedExit(): void {}

  setTaskActive(): void {}

  subscribe(): () => void {
    return () => undefined;
  }

  async resumeSession(): Promise<never[]> {
    return [];
  }

  async setConfigValue(
    _sessionId: string,
    options: readonly unknown[],
  ): Promise<readonly unknown[]> {
    return options;
  }

  selectedValue(): string | null {
    return null;
  }

  prompt(): Promise<PromptResult> {
    return new Promise((resolve) => {
      this.promptResolve = resolve;
      this.onPromptStarted?.();
    });
  }

  async cancel(sessionId: string): Promise<void> {
    this.cancelCalls.push(sessionId);
    this.promptResolve?.({ stopReason: "cancelled", usage: null });
  }

  /** 测试辅助：让挂起的 prompt 以指定 stopReason 正常收场。 */
  completePrompt(stopReason: string): void {
    this.promptResolve?.({ stopReason, usage: null });
  }

  async closeSession(): Promise<void> {}

  async close(): Promise<void> {}
}

/** Minimal BoardClient double recording every task-mutating call. */
class FakeBoard {
  readonly failTask = vi.fn(async () => undefined);
  readonly completeTask = vi.fn(async () => undefined);
  readonly releaseTask = vi.fn(async () => undefined);
  readonly reportAssistantMessage = vi.fn(async () => undefined);
  claimCalls = 0;

  constructor(
    private readonly boardSession: BoardSession,
    private readonly task: ClaimedTask | null,
  ) {}

  async heartbeatPresence(): Promise<BoardSession> {
    return this.boardSession;
  }

  async heartbeatClaim(): Promise<null> {
    return null;
  }

  async claimTask(): Promise<ClaimedTask | null> {
    this.claimCalls += 1;
    const task = this.claimCalls === 1 ? this.task : null;
    return task;
  }

  async reportProgress(): Promise<void> {}

  async taskArtifacts(): Promise<never[]> {
    return [];
  }
}

type BridgeInternals = {
  workers: Map<string, SessionWorker>;
  processThreadCommands(): Promise<boolean>;
};

const ACP_SESSION_ID = "acp-session-1";
const BOARD_SESSION_ID = "4d2f6f14-9f02-4f2c-9f6d-2f6f149f024f";

function baseConfiguration(): ClaudeBridgeConfiguration {
  return loadConfiguration({
    AI_TASK_BOARD_URL: "https://board.example.com",
    AI_TASK_BOARD_CONNECTION_TOKEN: "atb_test_token_value",
    CLAUDE_WORKING_DIRECTORY: "/srv/app",
    AI_TASK_BOARD_POLL_INTERVAL_MS: "500",
  });
}

function sessionInfo(): SessionInfo {
  return {
    sessionId: ACP_SESSION_ID,
    cwd: "/srv/app",
    title: "Pause test",
    updatedAt: new Date().toISOString(),
  };
}

function boardSession(): BoardSession {
  return {
    id: BOARD_SESSION_ID,
    external_conversation_ref: ACP_SESSION_ID,
  };
}

function claimedTask(): ClaimedTask {
  return {
    id: "task-1",
    title: "需要暂停的任务",
    description: null,
    acceptance_criteria: null,
    claim_token: "claim-token-1",
  };
}

function pauseCommand(
  sessionId: string | null,
  taskId: string | null = null,
): ThreadCommand {
  return {
    id: "command-1",
    action: "pause",
    name: null,
    directory_key: null,
    session_id: sessionId,
    task_id: taskId,
    external_thread_id: null,
  };
}

async function waitFor(
  condition: () => boolean,
  description: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`等待超时：${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Stub fetch serving the thread-command claim/complete endpoints. */
function stubThreadCommandFetch(command: ThreadCommand | null) {
  const completions: Array<Record<string, unknown>> = [];
  let claimCount = 0;
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/ai/thread-commands/claim")) {
      claimCount += 1;
      return jsonResponse({ command: claimCount === 1 ? command : null });
    }
    if (url.includes("/api/ai/thread-commands/") && url.endsWith("/complete")) {
      completions.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return jsonResponse({});
    }
    throw new Error(`测试未预期的看板请求：${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { completions, fetchMock };
}

describe("Claude Code Bridge 任务暂停", () => {
  let configHome: string | null = null;
  let workers: SessionWorker[] = [];

  function trackWorker(worker: SessionWorker): SessionWorker {
    workers.push(worker);
    return worker;
  }

  function newBridge(acp: FakeAcp): ClaudeBridge {
    configHome = mkdtempSync(path.join(tmpdir(), "atb-claude-pause-"));
    vi.stubEnv("XDG_CONFIG_HOME", configHome);
    return new ClaudeBridge(
      baseConfiguration(),
      acp as unknown as ClaudeAcpClient,
    );
  }

  afterEach(async () => {
    await Promise.all(
      workers.map((worker) => worker.stop().catch(() => undefined)),
    );
    workers = [];
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    if (configHome) {
      rmSync(configHome, { recursive: true, force: true });
      configHome = null;
    }
  });

  it("pause 命令中断运行中的 prompt：发送 session/cancel，任务不 fail，命令成功完成", async () => {
    const acp = new FakeAcp();
    const board = new FakeBoard(boardSession(), claimedTask());
    const worker = trackWorker(
      new SessionWorker(
        sessionInfo(),
        boardSession(),
        baseConfiguration(),
        board as unknown as BoardClient,
        acp as unknown as ClaudeAcpClient,
        new TurnLimiter(1),
        () => undefined,
      ),
    );
    const promptStarted = new Promise<void>((resolve) => {
      acp.onPromptStarted = resolve;
    });
    const run = worker.start();
    await promptStarted;

    const bridge = newBridge(acp);
    const internals = bridge as unknown as BridgeInternals;
    internals.workers.set(ACP_SESSION_ID, worker);
    // task_id 与当前活跃任务匹配（claimedTask().id === "task-1"）
    const { completions } = stubThreadCommandFetch(
      pauseCommand(BOARD_SESSION_ID, "task-1"),
    );

    await internals.processThreadCommands();
    await waitFor(() => !worker.busy, "暂停后 worker 应退出忙碌状态");

    // ACP session/cancel 已发送，prompt 以 cancelled 收场
    expect(acp.cancelCalls).toEqual([ACP_SESSION_ID]);
    // 任务已在看板侧 paused：不能 fail/complete/release（会 409）
    expect(board.failTask).not.toHaveBeenCalled();
    expect(board.completeTask).not.toHaveBeenCalled();
    expect(board.releaseTask).not.toHaveBeenCalled();
    // 命令按成功完成（external_thread_id 为 null 时回传 null）
    expect(completions).toEqual([
      expect.objectContaining({
        succeeded: true,
        external_thread_id: null,
        error: null,
      }),
    ]);

    await worker.stop();
    await run;
  });

  it("pause 时 worker 空闲：成功的 no-op，不发送 cancel", async () => {
    const acp = new FakeAcp();
    const board = new FakeBoard(boardSession(), null);
    const worker = trackWorker(
      new SessionWorker(
        sessionInfo(),
        boardSession(),
        baseConfiguration(),
        board as unknown as BoardClient,
        acp as unknown as ClaudeAcpClient,
        new TurnLimiter(1),
        () => undefined,
      ),
    );
    const run = worker.start();
    await waitFor(() => board.claimCalls > 0, "worker 应完成首轮空闲轮询");

    const bridge = newBridge(acp);
    const internals = bridge as unknown as BridgeInternals;
    internals.workers.set(ACP_SESSION_ID, worker);
    // task_id 为 null：旧版看板的载荷形态，走无条件的 legacy 路径（空闲 no-op）
    const { completions } = stubThreadCommandFetch(pauseCommand(BOARD_SESSION_ID));

    await internals.processThreadCommands();

    expect(acp.cancelCalls).toEqual([]);
    expect(board.failTask).not.toHaveBeenCalled();
    expect(board.completeTask).not.toHaveBeenCalled();
    expect(board.releaseTask).not.toHaveBeenCalled();
    expect(completions).toEqual([
      expect.objectContaining({ succeeded: true, error: null }),
    ]);

    await worker.stop();
    await run;
  });

  it("pause 命令指向未知 Session：成功的 no-op（幂等，兼容重放）", async () => {
    const acp = new FakeAcp();
    const bridge = newBridge(acp);
    const internals = bridge as unknown as BridgeInternals;
    const { completions } = stubThreadCommandFetch(
      pauseCommand("00000000-0000-4000-8000-000000000000"),
    );

    await internals.processThreadCommands();

    expect(acp.cancelCalls).toEqual([]);
    expect(completions).toEqual([
      expect.objectContaining({ succeeded: true, error: null }),
    ]);
  });

  it("pause 中断的 prompt 若抛错也不 failTask（仅本地清理）", async () => {
    const acp = new FakeAcp();
    // cancel 时让 prompt 直接 reject，模拟协议层把取消传播成异常
    const originalCancel = acp.cancel.bind(acp);
    let promptReject: ((error: Error) => void) | null = null;
    acp.prompt = () =>
      new Promise<PromptResult>((_resolve, reject) => {
        promptReject = reject;
        acp.onPromptStarted?.();
      });
    acp.cancel = async (sessionId: string) => {
      await originalCancel(sessionId);
      promptReject?.(new Error("prompt aborted"));
    };

    const board = new FakeBoard(boardSession(), claimedTask());
    const worker = trackWorker(
      new SessionWorker(
        sessionInfo(),
        boardSession(),
        baseConfiguration(),
        board as unknown as BoardClient,
        acp as unknown as ClaudeAcpClient,
        new TurnLimiter(1),
        () => undefined,
      ),
    );
    const promptStarted = new Promise<void>((resolve) => {
      acp.onPromptStarted = resolve;
    });
    const run = worker.start();
    await promptStarted;

    await worker.requestPause("task-1");
    await waitFor(() => !worker.busy, "暂停后 worker 应退出忙碌状态");

    expect(acp.cancelCalls).toEqual([ACP_SESSION_ID]);
    expect(board.failTask).not.toHaveBeenCalled();
    expect(board.completeTask).not.toHaveBeenCalled();
    expect(board.releaseTask).not.toHaveBeenCalled();

    await worker.stop();
    await run;
  });

  it("pause 命令的 task_id 与当前任务不匹配：视为过期命令，不误中断新任务的 prompt", async () => {
    const acp = new FakeAcp();
    const board = new FakeBoard(boardSession(), claimedTask());
    const worker = trackWorker(
      new SessionWorker(
        sessionInfo(),
        boardSession(),
        baseConfiguration(),
        board as unknown as BoardClient,
        acp as unknown as ClaudeAcpClient,
        new TurnLimiter(1),
        () => undefined,
      ),
    );
    const promptStarted = new Promise<void>((resolve) => {
      acp.onPromptStarted = resolve;
    });
    const run = worker.start();
    await promptStarted;

    const bridge = newBridge(acp);
    const internals = bridge as unknown as BridgeInternals;
    internals.workers.set(ACP_SESSION_ID, worker);
    // 上一个任务的 pause 命令迟到：worker 已在跑 task-1，命令针对 task-0
    const { completions } = stubThreadCommandFetch(
      pauseCommand(BOARD_SESSION_ID, "task-0"),
    );

    await internals.processThreadCommands();

    // 过期命令：不发送 cancel，但命令仍按成功完成（幂等 no-op）
    expect(acp.cancelCalls).toEqual([]);
    expect(completions).toEqual([
      expect.objectContaining({ succeeded: true, error: null }),
    ]);

    // 当前任务不受干扰：prompt 正常完成后照常 completeTask
    acp.completePrompt("end_turn");
    await waitFor(() => !worker.busy, "任务正常完成后 worker 应退出忙碌状态");
    expect(board.completeTask).toHaveBeenCalledTimes(1);
    expect(board.failTask).not.toHaveBeenCalled();
    expect(board.releaseTask).not.toHaveBeenCalled();

    await worker.stop();
    await run;
  });
});
