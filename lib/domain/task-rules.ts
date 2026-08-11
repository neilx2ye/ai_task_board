import type { TaskStatus } from "@/lib/types/database";

export type TaskTreeNode = {
  id: string;
  parent_task_id: string | null;
  status: TaskStatus;
};

export type ClaimCandidate = {
  id: string;
  root_task_id?: string;
  priority: number;
  created_at: string;
};

export type BoardTaskState = {
  status: TaskStatus;
  assigned_session_id: string | null;
};

/**
 * `ready` only means "reserved" when a runnable leaf is actually bound to a
 * session. Older rows (or maintenance orphans) can still be `ready` without a
 * session; present those as historical unbound work instead of implying that
 * some AI conversation will receive them. Aggregate parents are exempt because
 * their `ready` state is derived from assigned descendants.
 *
 * This is a board projection only. In particular, it never guesses that a task
 * completed from text, activity timestamps, or session presence.
 */
export function taskBoardStatus(
  task: BoardTaskState,
  hasChildren = false,
): TaskStatus {
  if (
    task.status === "ready" &&
    task.assigned_session_id === null &&
    !hasChildren
  ) {
    return "inbox";
  }
  return task.status;
}

/**
 * Mirrors the parent display precedence enforced by the database. This is for
 * rendering/tests only; mutations must still go through a domain RPC.
 */
export function aggregateParentStatus(statuses: readonly TaskStatus[]): TaskStatus {
  const active = statuses.filter((status) => status !== "cancelled");
  if (!active.length) return "blocked";
  if (active.every((status) => status === "completed")) return "completed";
  if (active.includes("waiting_user")) return "waiting_user";
  if (active.some((status) => status === "claimed" || status === "running")) {
    return "running";
  }
  if (active.includes("failed")) return "failed";
  if (active.includes("ready")) return "ready";
  return "blocked";
}

/** Count non-cancelled leaves below (or including) rootTaskId at any depth. */
export function calculateLeafProgress(
  tasks: readonly TaskTreeNode[],
  rootTaskId: string,
): { completed_leaves: number; total_leaves: number } {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const root = byId.get(rootTaskId);
  if (!root || root.status === "cancelled") {
    return { completed_leaves: 0, total_leaves: 0 };
  }

  const allChildren = new Map<string, TaskTreeNode[]>();
  for (const task of tasks) {
    if (!task.parent_task_id) continue;
    const siblings = allChildren.get(task.parent_task_id) ?? [];
    siblings.push(task);
    allChildren.set(task.parent_task_id, siblings);
  }

  let completedLeaves = 0;
  let totalLeaves = 0;
  const visited = new Set<string>();
  const queue = [root];
  while (queue.length) {
    const task = queue.shift();
    if (!task || visited.has(task.id)) continue;
    visited.add(task.id);
    const children = allChildren.get(task.id) ?? [];
    const activeChildren = children.filter((child) => child.status !== "cancelled");
    if (!activeChildren.length) {
      // Once a parent has children it stays aggregation-only, even if every
      // child was cancelled. This matches the SQL structured-progress helper.
      if (task.id === rootTaskId && children.length > 0) continue;
      totalLeaves += 1;
      if (task.status === "completed") completedLeaves += 1;
      continue;
    }
    queue.push(...activeChildren);
  }

  return { completed_leaves: completedLeaves, total_leaves: totalLeaves };
}

export function matchesCapabilities(
  requiredCapabilities: readonly string[],
  sessionCapabilities: readonly string[],
): boolean {
  const available = new Set(sessionCapabilities);
  return requiredCapabilities.every((capability) => available.has(capability));
}

export const hasRequiredCapabilities = matchesCapabilities;

/** Sort order used by claim RPCs: preferred root, priority, age, then UUID. */
export function compareClaimCandidates(
  left: ClaimCandidate,
  right: ClaimCandidate,
  preferredRootTaskId?: string | null,
): number {
  const leftPreferred =
    preferredRootTaskId != null && left.root_task_id === preferredRootTaskId;
  const rightPreferred =
    preferredRootTaskId != null && right.root_task_id === preferredRootTaskId;
  if (leftPreferred !== rightPreferred) return leftPreferred ? -1 : 1;
  if (left.priority !== right.priority) return right.priority - left.priority;
  if (left.created_at !== right.created_at) {
    return left.created_at < right.created_at ? -1 : 1;
  }
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

const allowedTransitions: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  inbox: new Set(["ready", "blocked", "cancelled"]),
  ready: new Set(["claimed", "cancelled"]),
  claimed: new Set([
    "claimed",
    "running",
    "ready",
    "waiting_user",
    "blocked",
    "completed",
    "failed",
    "cancelled",
  ]),
  running: new Set([
    "claimed",
    "running",
    "ready",
    "waiting_user",
    "blocked",
    "completed",
    "failed",
    "cancelled",
  ]),
  waiting_user: new Set(["ready", "blocked", "cancelled"]),
  blocked: new Set(["ready", "cancelled"]),
  completed: new Set(["ready", "blocked", "cancelled"]),
  failed: new Set(["ready", "blocked", "cancelled"]),
  cancelled: new Set(),
};

const parentAggregateStates = new Set<TaskStatus>([
  "blocked",
  "ready",
  "running",
  "waiting_user",
  "failed",
  "completed",
]);

export function isTaskStatusTransitionAllowed(
  from: TaskStatus,
  to: TaskStatus,
  mode: "leaf-command" | "parent-aggregate" = "leaf-command",
): boolean {
  if (mode === "parent-aggregate") {
    return from !== "cancelled" && parentAggregateStates.has(to);
  }
  return allowedTransitions[from].has(to);
}

export const isValidTransition = isTaskStatusTransitionAllowed;
