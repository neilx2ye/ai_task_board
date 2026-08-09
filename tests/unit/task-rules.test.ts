import { describe, expect, it } from "vitest";

import {
  aggregateParentStatus,
  calculateLeafProgress,
  compareClaimCandidates,
  hasRequiredCapabilities,
  isTaskStatusTransitionAllowed,
  matchesCapabilities,
} from "@/lib/domain/task-rules";
import type { TaskStatus } from "@/lib/types/database";

const statuses: TaskStatus[] = [
  "inbox",
  "ready",
  "claimed",
  "running",
  "waiting_user",
  "blocked",
  "completed",
  "failed",
  "cancelled",
];

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
  ] as Array<[TaskStatus[], TaskStatus]>)(
    "aggregates %j as %s using database precedence",
    (children, expected) => {
      expect(aggregateParentStatus(children)).toBe(expected);
    },
  );
});

describe("multi-level leaf progress", () => {
  it("counts only non-cancelled leaves at arbitrary depth", () => {
    const tasks = [
      { id: "root", parent_task_id: null, status: "running" },
      { id: "leaf-a", parent_task_id: "root", status: "completed" },
      { id: "branch-b", parent_task_id: "root", status: "ready" },
      { id: "leaf-b1", parent_task_id: "branch-b", status: "completed" },
      { id: "branch-b2", parent_task_id: "branch-b", status: "blocked" },
      { id: "leaf-b2a", parent_task_id: "branch-b2", status: "ready" },
      { id: "cancelled-leaf", parent_task_id: "root", status: "cancelled" },
    ] as const;

    expect(calculateLeafProgress(tasks, "root")).toEqual({
      completed_leaves: 2,
      total_leaves: 3,
    });
  });

  it.each([
    ["ready", { completed_leaves: 0, total_leaves: 1 }],
    ["completed", { completed_leaves: 1, total_leaves: 1 }],
  ] as const)("treats a %s root leaf as one unit", (status, expected) => {
    expect(
      calculateLeafProgress([{ id: "root", parent_task_id: null, status }], "root"),
    ).toEqual(expected);
  });

  it("does not turn an aggregation parent back into a leaf when all children cancel", () => {
    expect(
      calculateLeafProgress(
        [
          { id: "root", parent_task_id: null, status: "blocked" },
          { id: "cancelled", parent_task_id: "root", status: "cancelled" },
        ],
        "root",
      ),
    ).toEqual({ completed_leaves: 0, total_leaves: 0 });
  });

  it("returns zero progress for an absent or cancelled root", () => {
    const tasks = [{ id: "root", parent_task_id: null, status: "cancelled" }] as const;

    expect(calculateLeafProgress(tasks, "missing")).toEqual({
      completed_leaves: 0,
      total_leaves: 0,
    });
    expect(calculateLeafProgress(tasks, "root")).toEqual({
      completed_leaves: 0,
      total_leaves: 0,
    });
  });
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
    ready: ["claimed", "cancelled"],
    claimed: [
      "claimed",
      "running",
      "ready",
      "waiting_user",
      "blocked",
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
      "completed",
      "failed",
      "cancelled",
    ],
    waiting_user: ["ready", "blocked", "cancelled"],
    blocked: ["ready", "cancelled"],
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
