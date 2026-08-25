"use client";

import { useEffect } from "react";
import {
  type InfiniteData,
  type QueryClient,
  useQueryClient,
} from "@tanstack/react-query";

import {
  BRIDGE_DIRECTORIES_QUERY_KEY,
  planningNotesQueryKey,
  sessionQueryKey,
  SESSIONS_QUERY_KEY,
  taskQueryKey,
  TASKS_QUERY_KEY,
  threadPlanningNotesQueryKey,
  turnPlansQueryKey,
} from "@/hooks/query-keys";
import { compareSessionActivities } from "@/hooks/use-sessions";
import type {
  SessionActivityItem,
  SessionConversation,
  SessionListItem,
} from "@/lib/types/domain";
import type {
  AISessionRow,
  SessionActivityRow,
  TaskRow,
} from "@/lib/types/database";

export const REALTIME_TABLES = [
  "tasks",
  "task_messages",
  "task_events",
  "session_activities",
  "session_history_syncs",
  "ai_sessions",
  "ai_bridge_directories",
  "artifacts",
  "planning_notes",
  "thread_planning_notes",
  "session_turn_plans",
] as const;

export type RealtimeTable = (typeof REALTIME_TABLES)[number];
export type RealtimeInvalidation = {
  queryKey: readonly string[];
  exact: boolean;
};

type RealtimePayloadRow = Record<string, unknown>;

function payloadRows(payload: unknown): RealtimePayloadRow[] {
  if (!payload || typeof payload !== "object") return [];
  const candidate = payload as { new?: unknown; old?: unknown };
  const rows: RealtimePayloadRow[] = [];
  for (const row of [candidate.new, candidate.old]) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    rows.push(row as RealtimePayloadRow);
  }
  return rows;
}

function nonEmptyString(row: RealtimePayloadRow, key: string): string | null {
  const value = row[key];
  return typeof value === "string" && value ? value : null;
}

function dedupeInvalidations(
  invalidations: readonly RealtimeInvalidation[],
): RealtimeInvalidation[] {
  return [
    ...new Map(
      invalidations.map((invalidation) => [
        `${invalidation.exact ? "exact" : "prefix"}:${JSON.stringify(invalidation.queryKey)}`,
        invalidation,
      ]),
    ).values(),
  ];
}

/** Map a Realtime row to only the caches that can contain that row. */
export function realtimeInvalidations(
  table: RealtimeTable,
  payload: unknown,
): RealtimeInvalidation[] {
  const rows = payloadRows(payload);
  const invalidations: RealtimeInvalidation[] = [];
  const exact = (queryKey: readonly string[]) => {
    invalidations.push({ queryKey, exact: true });
  };

  if (table === "tasks") {
    exact(TASKS_QUERY_KEY);
    exact(SESSIONS_QUERY_KEY);
    for (const row of rows) {
      const taskId = nonEmptyString(row, "id");
      if (taskId) exact(taskQueryKey(taskId));
      // 规划面板的 Turn 链进度直接来自任务状态，跟随任务变更刷新。
      const sessionId = nonEmptyString(row, "assigned_session_id");
      if (sessionId) exact(turnPlansQueryKey(sessionId));
    }
  } else if (table === "task_messages") {
    // The board list embeds each waiting task's latest AI message.
    exact(TASKS_QUERY_KEY);
    for (const row of rows) {
      const taskId = nonEmptyString(row, "task_id");
      if (taskId) exact(taskQueryKey(taskId));
    }
  } else if (table === "task_events") {
    for (const row of rows) {
      const taskId = nonEmptyString(row, "task_id");
      if (taskId) exact(taskQueryKey(taskId));
      // Session conversation activity is delivered by session_activities and
      // merged directly. task_events is a compatibility/audit mirror and must
      // not refetch every loaded infinite-history page for each completed item.
    }
  } else if (table === "artifacts") {
    for (const row of rows) {
      const taskId = nonEmptyString(row, "task_id");
      if (taskId) exact(taskQueryKey(taskId));
    }
  } else if (table === "ai_sessions") {
    exact(SESSIONS_QUERY_KEY);
    for (const row of rows) {
      const sessionId = nonEmptyString(row, "id");
      if (sessionId) exact(sessionQueryKey(sessionId));
    }
  } else if (table === "ai_bridge_directories") {
    exact(BRIDGE_DIRECTORIES_QUERY_KEY);
  } else if (table === "planning_notes") {
    for (const row of rows) {
      const projectRef = nonEmptyString(row, "project_ref");
      if (projectRef) {
        exact(planningNotesQueryKey(projectRef));
      }
    }
  } else if (table === "thread_planning_notes") {
    for (const row of rows) {
      const sessionId = nonEmptyString(row, "session_id");
      if (sessionId) {
        exact(threadPlanningNotesQueryKey(sessionId));
      }
    }
  } else if (table === "session_turn_plans") {
    for (const row of rows) {
      const sessionId = nonEmptyString(row, "session_id");
      if (sessionId) exact(turnPlansQueryKey(sessionId));
    }
  } else {
    for (const row of rows) {
      const sessionId = nonEmptyString(row, "session_id");
      if (sessionId) exact(sessionQueryKey(sessionId));
    }
  }

  return dedupeInvalidations(invalidations);
}

export function createRealtimeInvalidationBatcher(
  queryClient: Pick<QueryClient, "invalidateQueries">,
  delayMs = 150,
) {
  const pending = new Map<string, RealtimeInvalidation>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const invalidations = [...pending.values()];
    pending.clear();
    for (const invalidation of invalidations) {
      void queryClient.invalidateQueries(invalidation);
    }
  };

  return {
    schedule(invalidations: readonly RealtimeInvalidation[]) {
      for (const invalidation of invalidations) {
        pending.set(
          `${invalidation.exact ? "exact" : "prefix"}:${JSON.stringify(invalidation.queryKey)}`,
          invalidation,
        );
      }
      if (pending.size && timer === null) timer = setTimeout(flush, delayMs);
    },
    flush,
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending.clear();
    },
  };
}

/**
 * History imports can insert hundreds of activity rows in one burst. Wait for
 * the burst to settle, then refetch each affected conversation once instead of
 * mutating the visible timeline once per row.
 */
export function createHistoryActivityRefreshBatcher(
  queryClient: Pick<QueryClient, "invalidateQueries">,
  delayMs = 750,
) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const invalidate = (sessionId: string) => {
    const timer = timers.get(sessionId);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(sessionId);
    void queryClient.invalidateQueries({
      queryKey: sessionQueryKey(sessionId),
      exact: true,
    });
  };

  const flush = () => {
    for (const sessionId of [...timers.keys()]) invalidate(sessionId);
  };

  return {
    schedule(sessionId: string) {
      const existing = timers.get(sessionId);
      if (existing !== undefined) clearTimeout(existing);
      timers.set(sessionId, setTimeout(() => invalidate(sessionId), delayMs));
    },
    flush,
    cancel() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}

const RECOVERY_INVALIDATIONS: readonly RealtimeInvalidation[] = [
  { queryKey: TASKS_QUERY_KEY, exact: false },
  { queryKey: SESSIONS_QUERY_KEY, exact: false },
  { queryKey: BRIDGE_DIRECTORIES_QUERY_KEY, exact: false },
];

/**
 * tasks 表的 Realtime 订阅必须显式限制安全列：
 * claim_token_hash 对 authenticated 角色没有 SELECT 权限，
 * 订阅整行会被 Realtime 拒绝。此处列出 TaskRow 全部公开字段，
 * 明确排除 claim_token_hash。
 */
export const SAFE_TASK_REALTIME_COLUMNS = [
  "id",
  "workspace_id",
  "parent_task_id",
  "root_task_id",
  "title",
  "description",
  "acceptance_criteria",
  "status",
  "priority",
  "position",
  "model",
  "reasoning_effort",
  "goal_mode",
  "steer",
  "assigned_session_id",
  "claimed_by_session_id",
  "claimed_at",
  "lease_expires_at",
  "awaiting_user_input",
  "required_capabilities",
  "external_source",
  "external_task_ref",
  "external_conversation_ref",
  "progress_note",
  "progress_percent_estimate",
  "result_summary",
  "result_json",
  "created_by_type",
  "created_by_id",
  "created_at",
  "updated_at",
  "completed_at",
] as const satisfies ReadonlyArray<keyof TaskRow>;

/**
 * History runtime/sequence fields are service-only fencing state. Authenticated
 * Workspace clients receive only this public projection, so Realtime must not
 * request the otherwise ungranted internal columns.
 */
export const SAFE_HISTORY_SYNC_REALTIME_COLUMNS = [
  "workspace_id",
  "connection_id",
  "session_id",
  "status",
  "turn_limit",
  "scanned_turns",
  "total_turns",
  "imported_items",
  "next_cursor",
  "error",
  "started_at",
  "completed_at",
  "updated_at",
] as const;

export function sessionActivityFromRealtime(
  payload: unknown,
): SessionActivityItem | null {
  if (!payload || typeof payload !== "object") return null;
  const row = (payload as { new?: unknown }).new;
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const candidate = row as Partial<SessionActivityRow> & { id?: unknown };
  if (
    candidate.id === undefined ||
    typeof candidate.session_id !== "string" ||
    typeof candidate.workspace_id !== "string" ||
    typeof candidate.kind !== "string" ||
    typeof candidate.actor_type !== "string" ||
    typeof candidate.created_at !== "string"
  ) {
    return null;
  }
  const id = String(candidate.id);
  const occurredAt =
    typeof candidate.occurred_at === "string"
      ? candidate.occurred_at
      : candidate.created_at;
  const sourceOrder =
    typeof candidate.source_order === "number" &&
    Number.isSafeInteger(candidate.source_order)
      ? String(candidate.source_order)
      : id;
  const source =
    candidate.source === "codex_history" ? "codex_history" : "live";
  return {
    ...candidate,
    id,
    occurred_at: occurredAt,
    source_order: sourceOrder,
    source,
  } as SessionActivityItem;
}

export function isHistoryImportActivity(
  activity: SessionActivityItem,
): boolean {
  return (
    activity.source === "codex_history" ||
    (activity.task_id === null &&
      activity.external_ref?.startsWith("codex-history:") === true)
  );
}

export function appendRealtimeSessionActivity(
  current: InfiniteData<SessionConversation, string | null> | undefined,
  activity: SessionActivityItem,
): InfiniteData<SessionConversation, string | null> | undefined {
  if (!current?.pages.length) return current;
  if (
    current.pages.some((page) =>
      page.activities.some((candidate) => candidate.id === activity.id),
    )
  ) {
    return current;
  }

  const pages = [...current.pages];
  const first = pages[0];
  const activities = [...first.activities, activity].sort(
    compareSessionActivities,
  );
  pages[0] = {
    ...first,
    activities,
  };
  return { ...current, pages };
}

export type RealtimeSessionUpdate = Partial<AISessionRow> & { id: string };

export function sessionUpdateFromRealtime(
  payload: unknown,
): RealtimeSessionUpdate | null {
  if (!payload || typeof payload !== "object") return null;
  const row = (payload as { new?: unknown }).new;
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const candidate = row as Partial<AISessionRow>;
  return typeof candidate.id === "string" && candidate.id
    ? (candidate as RealtimeSessionUpdate)
    : null;
}

export function patchRealtimeSessionList(
  current: readonly SessionListItem[],
  update: RealtimeSessionUpdate,
): SessionListItem[] {
  if (update.deletion_requested_at) {
    return current.filter((session) => session.id !== update.id);
  }
  return current.map((session) => {
    if (session.id !== update.id) return session;
    const updated = {
      ...session,
      ...update,
      connection: session.connection,
      current_task: session.current_task,
      queued_task_count: session.queued_task_count,
    };
    return {
      ...updated,
      name: updated.user_name ?? updated.name,
    };
  });
}

export function patchRealtimeSessionConversation(
  current: InfiniteData<SessionConversation, string | null>,
  update: RealtimeSessionUpdate,
): InfiniteData<SessionConversation, string | null> {
  if (update.deletion_requested_at) return current;
  return {
    ...current,
    pages: current.pages.map((page) => ({
      ...page,
      session:
        page.session.id === update.id
          ? (() => {
              const updated = {
                ...page.session,
                ...update,
                connection: page.session.connection,
                current_task: page.session.current_task,
                queued_task_count: page.session.queued_task_count,
              };
              return {
                ...updated,
                name: updated.user_name ?? updated.name,
              };
            })()
          : page.session,
    })),
  };
}

/**
 * 订阅当前 Workspace 的本地数据库变更流（LISTEN/NOTIFY → SSE）。
 * 服务端只下发 `{ table, op, workspace_id }`，前端按表做粗粒度失效；
 * 断线重连成功后执行一次全量失效作为权威恢复手段。
 */
export function useRealtimeWorkspace(workspaceId: string | undefined) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!workspaceId) return;

    let cancelled = false;
    let source: EventSource | null = null;
    const invalidationBatcher = createRealtimeInvalidationBatcher(queryClient);
    const historyRefreshBatcher =
      createHistoryActivityRefreshBatcher(queryClient);

    source = new EventSource(
      `/api/realtime?workspace_id=${encodeURIComponent(workspaceId)}`,
    );
    source.onopen = () => {
      // 首次建立与断线重连后都做一次全量失效，权威状态由拉取恢复。
      if (!cancelled) invalidationBatcher.schedule(RECOVERY_INVALIDATIONS);
    };
    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as { table?: unknown };
        if (
          typeof payload.table !== "string" ||
          !(REALTIME_TABLES as readonly string[]).includes(payload.table)
        ) {
          return;
        }
        invalidationBatcher.schedule(
          realtimeInvalidations(payload.table as RealtimeTable, {}),
        );
      } catch {
        // 单条坏消息不影响订阅；下一次连接或事件会继续恢复。
      }
    };

    return () => {
      cancelled = true;
      source?.close();
      invalidationBatcher.cancel();
      historyRefreshBatcher.cancel();
    };
  }, [workspaceId, queryClient]);
}
