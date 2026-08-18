import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createHistoryActivityRefreshBatcher,
  createRealtimeInvalidationBatcher,
  realtimeInvalidations,
  SAFE_HISTORY_SYNC_REALTIME_COLUMNS,
  type RealtimeInvalidation,
} from "@/hooks/use-realtime";

function labels(invalidations: readonly RealtimeInvalidation[]): string[] {
  return invalidations.map(
    ({ queryKey, exact }) =>
      `${exact ? "exact" : "prefix"}:${queryKey.join("/")}`,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Realtime cache invalidation", () => {
  it("refreshes the working-directory hierarchy on inventory changes", () => {
    expect(
      labels(
        realtimeInvalidations("ai_bridge_directories", {
          new: { connection_id: "connection-1", directory_key: "main" },
        }),
      ),
    ).toEqual(["exact:bridge-directories"]);
  });

  it("excludes service-only history fencing columns from Realtime", () => {
    expect(SAFE_HISTORY_SYNC_REALTIME_COLUMNS).not.toContain(
      "runtime_instance_id",
    );
    expect(SAFE_HISTORY_SYNC_REALTIME_COLUMNS).not.toContain(
      "report_sequence",
    );
    expect(SAFE_HISTORY_SYNC_REALTIME_COLUMNS).not.toContain("request_hash");
    expect(SAFE_HISTORY_SYNC_REALTIME_COLUMNS).toContain("session_id");
    expect(SAFE_HISTORY_SYNC_REALTIME_COLUMNS).toContain("status");
  });

  it("targets the conversation for a history-only status update", () => {
    expect(
      labels(
        realtimeInvalidations("session_history_syncs", {
          new: { session_id: "session-1", status: "complete" },
        }),
      ),
    ).toEqual(["exact:sessions/session-1"]);
  });

  it("targets only the task and session referenced by a completion burst", () => {
    const invalidations = [
      ...realtimeInvalidations("tasks", {
        new: {
          id: "task-1",
          assigned_session_id: "session-1",
          claimed_by_session_id: "session-1",
          created_by_type: "ai",
          created_by_id: "session-1",
        },
      }),
      ...realtimeInvalidations("task_messages", {
        new: {
          id: "message-1",
          task_id: "task-1",
          sender_type: "ai",
          sender_id: "session-1",
        },
      }),
      ...realtimeInvalidations("task_events", {
        new: {
          id: 11,
          task_id: "task-1",
          actor_type: "ai",
          actor_id: "session-1",
        },
      }),
      ...realtimeInvalidations("artifacts", {
        new: { id: "artifact-1", task_id: "task-1" },
      }),
    ];

    expect(new Set(labels(invalidations))).toEqual(
      new Set([
        "exact:tasks",
        "exact:tasks/task-1",
        "exact:sessions",
        // 规划面板的 Turn 链进度跟随任务状态刷新。
        "exact:turn-plans/session-1",
      ]),
    );
    expect(labels(invalidations)).not.toContain("exact:sessions/session-2");
    expect(labels(invalidations)).not.toContain("exact:sessions/session-1");
    expect(labels(invalidations)).not.toContain("exact:turn-plans/session-2");
  });

  it("coalesces duplicate invalidations during the debounce window", async () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient();
    const invalidate = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue(undefined);
    const batcher = createRealtimeInvalidationBatcher(queryClient, 150);
    const taskInvalidation = {
      queryKey: ["tasks", "task-1"],
      exact: true,
    } as const;
    const sessionInvalidation = {
      queryKey: ["sessions", "session-1"],
      exact: true,
    } as const;

    batcher.schedule([taskInvalidation, sessionInvalidation]);
    batcher.schedule([taskInvalidation]);
    await vi.advanceTimersByTimeAsync(149);
    expect(invalidate).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledWith(taskInvalidation);
    expect(invalidate).toHaveBeenCalledWith(sessionInvalidation);
  });

  it("refreshes an imported history burst once per affected session", async () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient();
    const invalidate = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockResolvedValue(undefined);
    const batcher = createHistoryActivityRefreshBatcher(queryClient, 750);

    batcher.schedule("session-1");
    await vi.advanceTimersByTimeAsync(500);
    batcher.schedule("session-1");
    batcher.schedule("session-2");
    await vi.advanceTimersByTimeAsync(749);
    expect(invalidate).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["sessions", "session-1"],
      exact: true,
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["sessions", "session-2"],
      exact: true,
    });
  });
});

describe("Planning workspace Realtime invalidation", () => {
  it("targets the affected planning note", () => {
    expect(
      labels(
        realtimeInvalidations("planning_notes", {
          new: {
            project_ref: "path:/workspace/main",
          },
        }),
      ),
    ).toEqual(["exact:planning-notes/path:/workspace/main"]);
  });

  it("targets the turn plan of the affected session", () => {
    expect(
      labels(
        realtimeInvalidations("session_turn_plans", {
          new: { session_id: "session-1" },
          old: { session_id: "session-9" },
        }),
      ),
    ).toEqual(["exact:turn-plans/session-1", "exact:turn-plans/session-9"]);
  });

  it("ignores planning rows without usable identifiers", () => {
    expect(
      realtimeInvalidations("planning_notes", { new: {} }),
    ).toEqual([]);
    expect(
      realtimeInvalidations("session_turn_plans", { new: {} }),
    ).toEqual([]);
  });
});
