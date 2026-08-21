import { describe, expect, it } from "vitest";

import {
  aggregateParentStatus,
  compareClaimCandidates,
  hasRequiredCapabilities,
  isTaskRunningStatus,
  isTaskStatusTransitionAllowed,
  matchesCapabilities,
  taskDisplayStatus,
} from "@/lib/domain/task-rules";
import type { TaskStatus } from "@/lib/types/database";

const statuses: TaskStatus[] = [
  "inbox",
  "ready",
  "claimed",
  "running",
  "waiting_user",
  "blocked",
  "paused",
  "completed",
  "failed",
  "cancelled",
];

describe("task display status", () => {
  it("does not present an unassigned legacy leaf as reserved", () => {
    expect(
      taskDisplayStatus({ status: "ready", assigned_session_id: null }),
    ).toBe("inbox");
  });

  it("keeps assigned leaves and aggregate parents in the reserved flow", () => {
    expect(
      taskDisplayStatus({
        status: "ready",
        assigned_session_id: "session-1",
      }),
    ).toBe("ready");
    expect(
      taskDisplayStatus(
        { status: "ready", assigned_session_id: null },
        true,
      ),
    ).toBe("ready");
  });

  it("does not infer completion for any terminal or active status", () => {
    expect(
      taskDisplayStatus({ status: "running", assigned_session_id: null }),
    ).toBe("running");
    expect(
      taskDisplayStatus({ status: "completed", assigned_session_id: null }),
    ).toBe("completed");
  });
});

describe("task running status", () => {
  it("treats claimed and running as actively handled by a session", () => {
    expect(isTaskRunningStatus("claimed")).toBe(true);
    expect(isTaskRunningStatus("running")).toBe(true);
  });

  it("excludes queued, waiting, and terminal states", () => {
    for (const status of statuses) {
      if (status === "claimed" || status === "running") continue;
      expect(isTaskRunningStatus(status)).toBe(false);
    }
  });
});

describe("parent status aggregation", () => {
  it.each([
    [[], "blocked"],
    [["cancelled"], "blocked"],
    [["completed", "completed", "cancelled"], "completed"],
    [["ready", "running", "waiting_user", "failed"], "waiting_user"],
    [["ready", "claimed", "failed"], "running"],
    [["ready", "running", "failed"], "running"],
    [["ready", "failed", "blocked"], "failed"],
    [["ready", "blocked", "inbox"], "ready"],
    [["blocked", "inbox", "cancelled"], "blocked"],
    [["paused"], "paused"],
    [["completed", "paused", "cancelled"], "paused"],
    [["blocked", "paused"], "blocked"],
    [["ready", "paused"], "ready"],
    [["failed", "paused"], "failed"],
    [["running", "paused"], "running"],
    [["waiting_user", "paused"], "waiting_user"],
  ] as Array<[TaskStatus[], TaskStatus]>)(
    "aggregates %j as %s using database precedence",
    (children, expected) => {
      expect(aggregateParentStatus(children)).toBe(expected);
    },
  );
});

describe("capability matching", () => {
  it.each([
    [[], [], true],
    [[], ["analysis"], true],
    [["analysis"], ["analysis", "writing"], true],
    [["analysis", "writing"], ["analysis"], false],
    [["Analysis"], ["analysis"], false],
    [["analysis", "analysis"], ["analysis"], true],
  ] as Array<[string[], string[], boolean]>)(
    "matches required %j against available %j => %s",
    (required, available, expected) => {
      expect(matchesCapabilities(required, available)).toBe(expected);
      expect(hasRequiredCapabilities(required, available)).toBe(expected);
    },
  );
});

describe("claim candidate ordering", () => {
  const base = {
    root_task_id: "root-a",
    priority: 10,
    created_at: "2026-08-08T00:00:00.000Z",
  };

  it("sorts priority descending, creation time ascending, then UUID", () => {
    const candidates = [
      { ...base, id: "b", priority: 5 },
      { ...base, id: "c", priority: 10, created_at: "2026-08-07T00:00:00.000Z" },
      { ...base, id: "b", priority: 10 },
      { ...base, id: "a", priority: 10 },
    ];

    expect(candidates.sort(compareClaimCandidates).map((candidate) => candidate.id)).toEqual([
      "c",
      "a",
      "b",
      "b",
    ]);
  });

  it("prefers the same root before global priority", () => {
    const preferred = {
      ...base,
      id: "preferred",
      root_task_id: "preferred-root",
      priority: -10,
    };
    const globallyHigher = { ...base, id: "higher", priority: 100 };

    expect(
      [globallyHigher, preferred]
        .sort((left, right) =>
          compareClaimCandidates(left, right, "preferred-root"),
        )
        .map((candidate) => candidate.id),
    ).toEqual(["preferred", "higher"]);
  });
});

describe("task state transitions", () => {
  const allowedLeafTransitions: Record<TaskStatus, TaskStatus[]> = {
    inbox: ["ready", "blocked", "cancelled"],
    ready: ["claimed", "paused", "cancelled"],
    claimed: [
      "claimed",
      "running",
      "ready",
      "waiting_user",
      "blocked",
      "paused",
      "completed",
      "failed",
      "cancelled",
    ],
    running: [
      "claimed",
      "running",
      "ready",
      "waiting_user",
      "blocked",
      "paused",
      "completed",
      "failed",
      "cancelled",
    ],
    waiting_user: ["ready", "blocked", "cancelled"],
    blocked: ["ready", "cancelled"],
    paused: ["ready", "blocked", "cancelled"],
    completed: ["ready", "blocked", "cancelled"],
    failed: ["ready", "blocked", "cancelled"],
    cancelled: [],
  };

  it("matches the complete leaf-command transition matrix", () => {
    for (const from of statuses) {
      for (const to of statuses) {
        expect(
          isTaskStatusTransitionAllowed(from, to, "leaf-command"),
          `${from} -> ${to}`,
        ).toBe(allowedLeafTransitions[from].includes(to));
      }
    }
  });

  it("allows only aggregate display states for non-cancelled parents", () => {
    const aggregateStates: TaskStatus[] = [
      "blocked",
      "ready",
      "running",
      "waiting_user",
      "failed",
      "paused",
      "completed",
    ];

    for (const from of statuses) {
      for (const to of statuses) {
        expect(
          isTaskStatusTransitionAllowed(from, to, "parent-aggregate"),
          `${from} -> ${to}`,
        ).toBe(from !== "cancelled" && aggregateStates.includes(to));
      }
    }
  });
});
