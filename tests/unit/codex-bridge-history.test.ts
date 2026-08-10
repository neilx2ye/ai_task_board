import { describe, expect, it, vi } from "vitest";

import type {
  AppServerThread,
  AppServerThreadItem,
  AppServerTurn,
} from "../../packages/codex-bridge/src/app-server-client";
import {
  HISTORY_ACTIVITIES_PER_SCAN_LIMIT,
  HISTORY_CONTENT_LIMIT,
  HISTORY_IMPORT_BODY_LIMIT_BYTES,
  HISTORY_ITEMS_PER_TURN_LIMIT,
  historicalActivitiesForTurn,
  HistorySynchronizer,
  isInteractiveHistoryThread,
  sanitizeHistoryContent,
  scanThreadHistory,
  splitHistoryImportItems,
  type HistoryImportItem,
  type HistoryImporter,
  type HistorySyncReport,
} from "../../packages/codex-bridge/src/history-sync";

describe("Codex Bridge history sync", () => {
  it("maps only text messages, the final answer, and provider reasoning summaries", () => {
    const turn: AppServerTurn = {
      id: "019f1234-5678-7abc-8def-0123456789ab",
      status: "completed",
      startedAt: 1_786_291_200,
      completedAt: 1_786_291_230,
      itemsView: "full",
      items: [
        {
          type: "userMessage",
          id: "user-1",
          clientId: null,
          content: [
            { type: "text", text: "Use token=super-secret-value" },
            { type: "localImage", path: "/private/screenshot.png" },
            { type: "skill", name: "private", path: "/private/SKILL.md" },
          ],
        },
        {
          type: "reasoning",
          id: "reasoning-1",
          summary: ["Checked the constraints", "Selected a safe approach"],
          content: ["RAW HIDDEN REASONING MUST NEVER CROSS"],
        },
        {
          type: "commandExecution",
          id: "command-1",
          command: "cat /private/secret.txt",
          cwd: "/private",
          aggregatedOutput: "COMMAND OUTPUT MUST NEVER CROSS",
        },
        {
          type: "agentMessage",
          id: "agent-commentary",
          phase: "commentary",
          text: "Intermediate commentary",
        },
        {
          type: "agentMessage",
          id: "agent-final",
          phase: "final_answer",
          text: "Finished safely",
        },
        {
          type: "mcpToolCall",
          id: "mcp-1",
          server: "private",
          arguments: { path: "/private/secret.txt" },
        },
      ],
    };

    const activities = historicalActivitiesForTurn("thread-1", turn);
    const sourceOrderBase = activities[0]?.source_order;

    expect(sourceOrderBase).toEqual(expect.any(Number));
    expect(Number.isSafeInteger(sourceOrderBase)).toBe(true);

    expect(activities).toEqual([
      expect.objectContaining({
        external_ref:
          "codex-history:thread-1:019f1234-5678-7abc-8def-0123456789ab:user-1",
        kind: "user_message",
        content: "Use token=[REDACTED]",
        source_order: sourceOrderBase,
        occurred_at: "2026-08-09T16:00:00.000Z",
        data: {
          protocol: "codex-app-server/v1",
          thread_id: "thread-1",
          turn_id: "019f1234-5678-7abc-8def-0123456789ab",
          item_id: "user-1",
        },
      }),
      expect.objectContaining({
        kind: "reasoning",
        content: "Checked the constraints\n\nSelected a safe approach",
        source_order: (sourceOrderBase ?? 0) + 1,
      }),
      expect.objectContaining({
        kind: "assistant_message",
        content: "Finished safely",
        source_order: (sourceOrderBase ?? 0) + 4,
      }),
    ]);
    const serialized = JSON.stringify(activities);
    expect(serialized).not.toContain("RAW HIDDEN");
    expect(serialized).not.toContain("COMMAND OUTPUT");
    expect(serialized).not.toContain("/private");
    expect(serialized).not.toContain("Intermediate commentary");
  });

  it("skips a whole turn carrying a clientUserMessageId and supports old null-phase replies", () => {
    const boardTurn: AppServerTurn = {
      id: "turn-board",
      status: "completed",
      items: [
        {
          type: "userMessage",
          id: "board-user",
          clientId: "board-task-uuid",
          content: [{ type: "text", text: "Board task" }],
        },
        { type: "agentMessage", id: "board-agent", text: "Board reply" },
      ],
    };
    expect(historicalActivitiesForTurn("thread-1", boardTurn)).toEqual([]);

    const legacyTurn: AppServerTurn = {
      id: "turn-legacy",
      status: "completed",
      startedAt: 100,
      items: [
        { type: "agentMessage", id: "old-1", text: "Earlier" },
        { type: "agentMessage", id: "old-2", text: "Final legacy reply" },
      ],
    };
    expect(historicalActivitiesForTurn("thread-1", legacyTurn)).toMatchObject([
      {
        kind: "assistant_message",
        content: "Final legacy reply",
        source_order: expect.any(Number),
      },
    ]);
  });

  it("keeps items from turns with the same source timestamp contiguous", () => {
    const turn = (id: string, label: string): AppServerTurn => ({
      id,
      status: "completed",
      startedAt: 1_786_291_200,
      itemsView: "full",
      items: [
        {
          type: "userMessage",
          id: `${label}-user`,
          clientId: null,
          content: [{ type: "text", text: `${label} prompt` }],
        },
        {
          type: "agentMessage",
          id: `${label}-answer`,
          phase: "final_answer",
          text: `${label} answer`,
        },
      ],
    });
    const first = historicalActivitiesForTurn(
      "thread-1",
      turn("019f1234-5678-7abc-8def-0123456789ab", "first"),
    );
    const second = historicalActivitiesForTurn(
      "thread-1",
      turn("019f1234-5679-7abc-8def-0123456789ab", "second"),
    );
    const ordered = [...first, ...second].sort(
      (left, right) => left.source_order - right.source_order,
    );
    const turnGroups = ordered
      .map((activity) => activity.data.turn_id)
      .filter((turnId, index, values) => index === 0 || turnId !== values[index - 1]);

    expect(new Set(turnGroups)).toEqual(
      new Set([
        "019f1234-5678-7abc-8def-0123456789ab",
        "019f1234-5679-7abc-8def-0123456789ab",
      ]),
    );
    expect(turnGroups).toHaveLength(2);
    expect(ordered.every((activity) => Number.isSafeInteger(activity.source_order))).toBe(
      true,
    );
    expect(
      historicalActivitiesForTurn(
        "thread-1",
        turn("019f1234-5678-7abc-8def-0123456789ab", "first"),
      ).map((activity) => activity.source_order),
    ).toEqual(first.map((activity) => activity.source_order));
  });

  it("redacts and truncates history content without splitting a surrogate pair", () => {
    const value = `${"x".repeat(HISTORY_CONTENT_LIMIT - 20)}😀${"y".repeat(100)}`;
    const result = sanitizeHistoryContent(value);
    expect(result.length).toBeLessThanOrEqual(HISTORY_CONTENT_LIMIT);
    expect(result).toContain("历史内容已截断");
    expect(result).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(result).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it("requests unloaded turns, paginates items, and skips live Board turns", async () => {
    const boardItems = [
      {
        type: "userMessage",
        id: "board-user",
        clientId: "task-id",
        content: [{ type: "text", text: "Board task" }],
      },
    ];
    const localItems = [
      {
        type: "userMessage",
        id: "local-user",
        clientId: null,
        content: [{ type: "text", text: "Local prompt" }],
      },
      {
        type: "commandExecution",
        id: "local-command",
        aggregatedOutput: "private output",
      },
      {
        type: "agentMessage",
        id: "local-agent",
        phase: "final_answer",
        text: "Local answer",
      },
    ];
    const threadTurnsList = vi
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            id: "turn-board",
            status: "completed",
            itemsView: "notLoaded",
            items: [],
          },
          {
            id: "turn-local",
            status: "completed",
            startedAt: 200,
            itemsView: "notLoaded",
            items: [],
          },
        ],
        nextCursor: null,
      });
    const threadItemsList = vi.fn(async (params: { turnId: string }) => ({
      data: (params.turnId === "turn-board" ? boardItems : localItems).map(
        (item) => ({ turnId: params.turnId, item }),
      ),
      nextCursor: null,
    }));
    const result = await scanThreadHistory({
      appServer: { threadTurnsList, threadItemsList } as never,
      thread: { id: "thread-local", source: "cli", createdAt: 100 },
      turnLimit: 2,
      signal: new AbortController().signal,
    });

    expect(threadTurnsList).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-local",
        sortDirection: "desc",
        itemsView: "notLoaded",
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(threadItemsList).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-local",
        turnId: "turn-local",
        sortDirection: "asc",
      }),
      expect.anything(),
    );
    expect(result).toMatchObject({
      scannedTurns: 1,
      nextCursor: null,
      sourceExhausted: true,
      safetyCapReached: false,
      items: [
        { kind: "user_message", content: "Local prompt" },
        { kind: "assistant_message", content: "Local answer" },
      ],
    });
    expect(result.items.map((item) => item.source_order)).toEqual(
      historicalActivitiesForTurn("thread-local", {
        id: "turn-local",
        status: "completed",
        startedAt: 200,
        itemsView: "full",
        items: localItems,
      }).map((item) => item.source_order),
    );
    expect(threadItemsList).toHaveBeenCalledTimes(2);
  });

  it("streams a 1,104-item turn while retaining only the privacy whitelist", async () => {
    const junk = Array.from({ length: 1_101 }, (_, index) =>
      index % 2 === 0
        ? {
            type: "commandExecution",
            id: `command-${index}`,
            command: "cat /private/secret",
            aggregatedOutput: `HIDDEN COMMAND ${index}`,
          }
        : {
            type: "mcpToolCall",
            id: `mcp-${index}`,
            arguments: { token: `HIDDEN MCP ${index}` },
          },
    );
    const turnItems = [
      {
        type: "userMessage",
        id: "large-user",
        clientId: null,
        content: [{ type: "text", text: "Large local prompt" }],
      },
      ...junk.slice(0, 550),
      {
        type: "reasoning",
        id: "large-reasoning",
        summary: ["Safe provider summary"],
        content: ["HIDDEN RAW REASONING"],
      },
      ...junk.slice(550),
      {
        type: "agentMessage",
        id: "large-final",
        phase: "final_answer",
        text: "Large local answer",
      },
    ];
    expect(turnItems).toHaveLength(1_104);

    const createAppServer = () => {
      const threadTurnsList = vi.fn().mockResolvedValue({
        data: [
          {
            id: "turn-large",
            status: "completed",
            startedAt: 200,
            itemsView: "notLoaded",
            items: [],
          },
        ],
        nextCursor: null,
      });
      const threadItemsList = vi.fn(
        async (params: { cursor: string | null; limit: number; turnId: string }) => {
          const offset = params.cursor ? Number(params.cursor.slice(7)) : 0;
          const end = Math.min(turnItems.length, offset + params.limit);
          return {
            data: turnItems.slice(offset, end).map((item) => ({
              turnId: params.turnId,
              item,
            })),
            nextCursor: end < turnItems.length ? `offset:${end}` : null,
          };
        },
      );
      return { threadTurnsList, threadItemsList };
    };

    const firstAppServer = createAppServer();
    const first = await scanThreadHistory({
      appServer: firstAppServer as never,
      thread: { id: "thread-large", source: "cli", createdAt: 100 },
      turnLimit: 1,
      signal: new AbortController().signal,
    });
    const second = await scanThreadHistory({
      appServer: createAppServer() as never,
      thread: { id: "thread-large", source: "cli", createdAt: 100 },
      turnLimit: 1,
      signal: new AbortController().signal,
    });

    expect(first).toMatchObject({
      scannedTurns: 1,
      sourceExhausted: true,
      safetyCapReached: false,
      items: [
        { kind: "user_message", content: "Large local prompt" },
        { kind: "reasoning", content: "Safe provider summary" },
        { kind: "assistant_message", content: "Large local answer" },
      ],
    });
    expect(first.items).toEqual(second.items);
    expect(firstAppServer.threadItemsList).toHaveBeenCalledTimes(12);
    expect(JSON.stringify(first.items)).not.toMatch(
      /HIDDEN|commandExecution|mcpToolCall|\/private/,
    );
    const sourceOrders = first.items.map((item) => item.source_order);
    expect(sourceOrders.every(Number.isSafeInteger)).toBe(true);
    expect(sourceOrders[1]).toBe((sourceOrders[0] ?? 0) + 1);
    expect(sourceOrders[2]).toBe((sourceOrders[0] ?? 0) + 2);
  });

  it("reports partial and imports no part of a turn that exceeds remaining activity capacity", async () => {
    const safeItems: AppServerThreadItem[] = [
      {
        type: "agentMessage",
        id: "safe-final",
        phase: "final_answer",
        text: "Safe newer answer",
      },
    ];
    const oversizedItems: AppServerThreadItem[] = Array.from(
      { length: HISTORY_ACTIVITIES_PER_SCAN_LIMIT },
      (_, index) => ({
        type: "reasoning",
        id: `reasoning-${index}`,
        summary: [`Summary ${index}`],
        content: [`HIDDEN RAW ${index}`],
      }),
    );
    const createAppServer = () => {
      const items = new Map<string, AppServerThreadItem[]>([
        ["turn-safe", safeItems],
        ["turn-oversized", oversizedItems],
      ]);
      return {
        threadTurnsList: vi.fn().mockResolvedValue({
          data: [
            { id: "turn-safe", status: "completed", itemsView: "notLoaded" },
            {
              id: "turn-oversized",
              status: "completed",
              itemsView: "notLoaded",
            },
          ],
          nextCursor: null,
        }),
        threadItemsList: vi.fn(
          async (params: { cursor: string | null; limit: number; turnId: string }) => {
            const turnItems = items.get(params.turnId) ?? [];
            const offset = params.cursor ? Number(params.cursor.slice(7)) : 0;
            const end = Math.min(turnItems.length, offset + params.limit);
            return {
              data: turnItems.slice(offset, end).map((item) => ({
                turnId: params.turnId,
                item,
              })),
              nextCursor: end < turnItems.length ? `offset:${end}` : null,
            };
          },
        ),
      };
    };

    const result = await scanThreadHistory({
      appServer: createAppServer() as never,
      thread: { id: "thread-cap", source: "cli", createdAt: 100 },
      turnLimit: 3,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      scannedTurns: 1,
      nextCursor: "local-safety-cap",
      sourceExhausted: false,
      safetyCapReached: true,
      items: [{ data: { turn_id: "turn-safe" }, content: "Safe newer answer" }],
    });
    expect(result.items.some((item) => item.data.turn_id === "turn-oversized")).toBe(
      false,
    );

    const reports: Array<{ sync: HistorySyncReport; items: HistoryImportItem[] }> = [];
    const synchronizer = new HistorySynchronizer({
      appServer: createAppServer() as never,
      runtimeInstanceId: "019f1234-5678-7abc-8def-0123456789ab",
      configuration: () => ({ enabled: true, turnLimit: 3 }),
      importHistory: vi.fn(async (_sessionId, request) => {
        reports.push({ sync: request.sync, items: request.items });
        return {
          imported: { inserted: request.items.length, replayed: 0 },
          history_sync: {
            ...request.sync,
            imported_items: request.items.length,
            started_at: "2026-08-10T00:00:00.000Z",
            completed_at: null,
            updated_at: "2026-08-10T00:00:00.000Z",
          },
        };
      }),
    });
    const controller = new AbortController();
    const running = synchronizer.start(controller.signal);
    synchronizer.updateTargets([
      {
        sessionId: "session-cap",
        thread: { id: "thread-cap", source: "cli", createdAt: 100 },
      },
    ]);
    const deadline = Date.now() + 2_000;
    while (!reports.some((report) => report.sync.status === "partial")) {
      if (Date.now() >= deadline) throw new Error("partial status was not reported");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(reports.map((report) => report.sync.status)).toEqual([
      "syncing",
      "partial",
    ]);
    expect(reports.at(-1)?.sync.next_cursor).toBe("local-safety-cap");
    expect(
      reports.flatMap((report) => report.items).map((item) => item.data.turn_id),
    ).toEqual(["turn-safe"]);
    synchronizer.stop();
    controller.abort(new Error("test complete"));
    await expect(running).resolves.toBeUndefined();
  });

  it("marks a turn partial without importing it when raw item pagination exceeds 10,000", async () => {
    const threadItemsList = vi.fn(
      async (params: { cursor: string | null; limit: number; turnId: string }) => {
        const offset = params.cursor ? Number(params.cursor.slice(7)) : 0;
        const end = offset + params.limit;
        return {
          data: Array.from({ length: params.limit }, (_, index) => ({
            turnId: params.turnId,
            item: {
              type: "commandExecution",
              id: `command-${offset + index}`,
              aggregatedOutput: "HIDDEN COMMAND OUTPUT",
            },
          })),
          // A cursor at exactly the local boundary proves at least one older
          // raw item exists and must produce a non-resumable partial marker.
          nextCursor: `offset:${end}`,
        };
      },
    );
    const result = await scanThreadHistory({
      appServer: {
        threadTurnsList: vi.fn().mockResolvedValue({
          data: [
            { id: "turn-raw-cap", status: "completed", itemsView: "notLoaded" },
          ],
          nextCursor: null,
        }),
        threadItemsList,
      } as never,
      thread: { id: "thread-raw-cap", source: "cli" },
      turnLimit: 1,
      signal: new AbortController().signal,
    });

    expect(threadItemsList).toHaveBeenCalledTimes(
      HISTORY_ITEMS_PER_TURN_LIMIT / 100,
    );
    expect(result).toEqual({
      items: [],
      scannedTurns: 0,
      nextCursor: "local-safety-cap",
      sourceExhausted: false,
      safetyCapReached: true,
    });
  });

  it("keeps import batches within item and encoded-body limits", () => {
    const item = (index: number): HistoryImportItem => ({
      external_ref: `codex-history:thread:turn:item-${index}`,
      kind: "assistant_message",
      content: "四".repeat(20_000),
      occurred_at: "2026-08-10T00:00:00.000Z",
      source_order: index,
      data: {
        protocol: "codex-app-server/v1",
        thread_id: "thread",
        turn_id: "turn",
        item_id: `item-${index}`,
      },
    });
    const sync: HistorySyncReport = {
      status: "complete",
      turn_limit: 50,
      scanned_turns: 50,
      total_turns: null,
      next_cursor: null,
      error: null,
    };
    const batches = splitHistoryImportItems(
      "019f1234-5678-7abc-8def-0123456789ab",
      Array.from({ length: 101 }, (_, index) => item(index)),
      sync,
    );

    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(100);
      expect(
        Buffer.byteLength(
          JSON.stringify({
            runtime_instance_id: "019f1234-5678-7abc-8def-0123456789ab",
            report_sequence: Number.MAX_SAFE_INTEGER,
            items: batch,
            sync,
          }),
          "utf8",
        ),
      ).toBeLessThanOrEqual(HISTORY_IMPORT_BODY_LIMIT_BYTES);
    }
  });

  it("reports history failures without terminating the background runtime", async () => {
    const reports: HistorySyncReport[] = [];
    const importer: HistoryImporter = vi.fn(async (_sessionId, request) => {
      reports.push(request.sync);
      return {
        imported: { inserted: 0, replayed: 0 },
        history_sync: {
          ...request.sync,
          imported_items: 0,
          started_at: "2026-08-10T00:00:00.000Z",
          completed_at: null,
          updated_at: "2026-08-10T00:00:00.000Z",
        },
      };
    });
    const synchronizer = new HistorySynchronizer({
      appServer: {
        threadTurnsList: vi.fn().mockRejectedValue(new Error("history read failed")),
        threadItemsList: vi.fn(),
      } as never,
      runtimeInstanceId: "019f1234-5678-7abc-8def-0123456789ab",
      configuration: () => ({ enabled: true, turnLimit: 50 }),
      importHistory: importer,
    });
    const controller = new AbortController();
    const running = synchronizer.start(controller.signal);
    synchronizer.updateTargets([
      { sessionId: "session-1", thread: { id: "thread-1", source: "cli" } },
    ]);

    const deadline = Date.now() + 2_000;
    while (!reports.some((report) => report.status === "failed")) {
      if (Date.now() >= deadline) throw new Error("failure status was not reported");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(reports.map((report) => report.status)).toEqual(["syncing", "failed"]);
    expect(reports.at(-1)?.error).toContain("history read failed");

    synchronizer.stop();
    controller.abort(new Error("test complete"));
    await expect(running).resolves.toBeUndefined();
  });

  it("completes at the configured limit and does not requeue an unchanged active target", async () => {
    const reports: HistorySyncReport[] = [];
    let resolveTurns!: (value: {
      data: AppServerTurn[];
      nextCursor: string | null;
    }) => void;
    const turns = new Promise<{
      data: AppServerTurn[];
      nextCursor: string | null;
    }>((resolve) => {
      resolveTurns = resolve;
    });
    const threadTurnsList = vi.fn(() => turns);
    const threadItemsList = vi.fn().mockResolvedValue({
      data: [
        {
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "answer-1",
            phase: "final_answer",
            text: "Answer",
          },
        },
      ],
      nextCursor: null,
    });
    const importer: HistoryImporter = vi.fn(async (_sessionId, request) => {
      reports.push(request.sync);
      return {
        imported: { inserted: request.items.length, replayed: 0 },
        history_sync: {
          ...request.sync,
          imported_items: request.items.length,
          started_at: "2026-08-10T00:00:00.000Z",
          completed_at: null,
          updated_at: "2026-08-10T00:00:00.000Z",
        },
      };
    });
    const synchronizer = new HistorySynchronizer({
      appServer: { threadTurnsList, threadItemsList } as never,
      runtimeInstanceId: "019f1234-5678-7abc-8def-0123456789ab",
      configuration: () => ({ enabled: true, turnLimit: 1 }),
      importHistory: importer,
    });
    const target = {
      sessionId: "session-1",
      thread: {
        id: "thread-1",
        source: "cli",
        createdAt: 100,
        updatedAt: 200,
      },
    };
    const controller = new AbortController();
    const running = synchronizer.start(controller.signal);
    synchronizer.updateTargets([target]);

    const scanDeadline = Date.now() + 2_000;
    while (threadTurnsList.mock.calls.length === 0) {
      if (Date.now() >= scanDeadline) throw new Error("history scan did not start");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // Inventory may refresh while the active target is no longer in `queue`.
    synchronizer.updateTargets([target]);
    synchronizer.updateTargets([target]);
    resolveTurns({
      data: [
        {
          id: "turn-1",
          status: "completed",
          startedAt: 100,
          itemsView: "notLoaded",
          items: [],
        },
      ],
      // Older turns exist, but the configured one-turn snapshot is complete.
      nextCursor: "older-page",
    });

    const completionDeadline = Date.now() + 2_000;
    while (!reports.some((report) => report.status === "complete")) {
      if (Date.now() >= completionDeadline) {
        throw new Error("history completion was not reported");
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    synchronizer.updateTargets([target]);
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(threadTurnsList).toHaveBeenCalledTimes(1);
    expect(reports.map((report) => report.status)).toEqual([
      "syncing",
      "complete",
    ]);
    expect(reports.at(-1)).toMatchObject({
      scanned_turns: 1,
      next_cursor: null,
    });

    synchronizer.stop();
    controller.abort(new Error("test complete"));
    await expect(running).resolves.toBeUndefined();
  });

  it("accepts only ordinary CLI/IDE threads when source is known", () => {
    const thread = (source?: unknown): AppServerThread => ({ id: "thread", source });
    expect(isInteractiveHistoryThread(thread("cli"))).toBe(true);
    expect(isInteractiveHistoryThread(thread("vscode"))).toBe(true);
    expect(isInteractiveHistoryThread(thread(undefined))).toBe(false);
    expect(isInteractiveHistoryThread(thread(null))).toBe(false);
    expect(isInteractiveHistoryThread(thread("exec"))).toBe(false);
    expect(isInteractiveHistoryThread(thread("appServer"))).toBe(false);
    expect(isInteractiveHistoryThread(thread({ subAgent: "review" }))).toBe(false);
  });
});
