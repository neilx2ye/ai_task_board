import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createRealtimeInvalidationBatcher,
  realtimeInvalidations,
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
      ]),
    );
    expect(labels(invalidations)).not.toContain("exact:sessions/session-2");
    expect(labels(invalidations)).not.toContain("exact:sessions/session-1");
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
});
