import type { TaskStatus } from "@/lib/types/database";

export type ClaimCandidate = {
  id: string;
  root_task_id?: string;
  priority: number;
  created_at: string;
};

export type TaskDisplayState = {
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
 * This is a display projection only. In particular, it never guesses that a
 * task completed from text, activity timestamps, or session presence.
 */
export function taskDisplayStatus(
  task: TaskDisplayState,
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
  if (active.some(isTaskRunningStatus)) {
    return "running";
  }
  if (active.includes("failed")) return "failed";
  if (active.includes("ready")) return "ready";
  if (active.includes("blocked")) return "blocked";
  if (active.includes("paused")) return "paused";
  return "blocked";
}

/** claimed/running 都表示会话正在处理该任务，Web 可对其下发停止（暂停）指令。 */
export function isTaskRunningStatus(status: TaskStatus): boolean {
  return status === "claimed" || status === "running";
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
  ready: new Set(["claimed", "paused", "cancelled"]),
  claimed: new Set([
    "claimed",
    "running",
    "ready",
    "waiting_user",
    "blocked",
    "paused",
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
    "paused",
    "completed",
    "failed",
    "cancelled",
  ]),
  waiting_user: new Set(["ready", "blocked", "cancelled"]),
  blocked: new Set(["ready", "cancelled"]),
  paused: new Set(["ready", "blocked", "cancelled"]),
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
  "paused",
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
