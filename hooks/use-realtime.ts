"use client";

import { useEffect } from "react";
import {
  type InfiniteData,
  type QueryClient,
  useQueryClient,
} from "@tanstack/react-query";

import { catchUpEventCursor } from "@/hooks/realtime-catchup";
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
import { useSupabase } from "@/hooks/use-supabase";
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

/** 从 postgres_changes payload 中提取 task_events 行 id；无法识别时返回 null。 */
function extractEventId(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const row = (payload as { new?: unknown }).new;
  if (!row || typeof row !== "object") return null;
  const id = (row as { id?: unknown }).id;
  return typeof id === "number" ? id : null;
}

function extractSessionId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const candidate = payload as { new?: unknown; old?: unknown };
  for (const row of [candidate.new, candidate.old]) {
    if (!row || typeof row !== "object") continue;
    const sessionId = (row as { session_id?: unknown }).session_id;
    if (typeof sessionId === "string" && sessionId) return sessionId;
  }
  return null;
}

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
 * 订阅当前 Workspace 的 Supabase Realtime 数据库变更。
 * - 按表和行 id 只失效可能受影响的列表、任务详情或会话，并在 150ms 内合并；
 *   live session_activities insert 直接并入对应会话缓存；历史导入的 burst
 *   在安静窗口后整批重拉，避免逐行重排时间线。session_history_syncs 让纯状态
 *   或空批次也能及时刷新；task message/event 镜像不会再次重拉会话的所有历史页。
 * - 维护内存中的最新 TaskEvent id 游标：实时 payload 单调推进；
 *   每次 SUBSCRIBED（含断线重连）按 id > cursor 分页补拉遗漏事件，
 *   发现遗漏即失效查询，全量重拉仍是权威状态恢复手段。
 * - 补拉失败不破坏订阅；30 秒轮询（QueryClient 默认配置）继续兜底。
 * - workspace 变化时游标随 effect 重建而重置；cleanup 后不再写旧订阅。
 */
export function useRealtimeWorkspace(workspaceId: string | undefined) {
  const supabase = useSupabase();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!supabase || !workspaceId) return;

    let cancelled = false;
    // null 表示基线尚未建立；仅在闭包内使用，workspace 切换即重置。
    let cursor: number | null = null;
    let catchUpInFlight = false;
    const invalidationBatcher = createRealtimeInvalidationBatcher(queryClient);
    const historyRefreshBatcher =
      createHistoryActivityRefreshBatcher(queryClient);

    const advanceCursor = (id: number) => {
      if (cursor === null || id > cursor) cursor = id;
    };

    const fetchMaxEventId = async (): Promise<number> => {
      const { data, error } = await supabase
        .from("task_events")
        .select("id")
        .eq("workspace_id", workspaceId)
        .order("id", { ascending: false })
        .limit(1);
      if (error) throw error;
      return data?.[0]?.id ?? 0;
    };

    const fetchEventIdsAfter = async (
      afterId: number,
      limit: number,
    ): Promise<readonly number[]> => {
      const { data, error } = await supabase
        .from("task_events")
        .select("id")
        .eq("workspace_id", workspaceId)
        .gt("id", afterId)
        .order("id", { ascending: true })
        .limit(limit);
      if (error) throw error;
      return (data ?? []).map((row) => row.id);
    };

    /** 初次建立基线，重连时补拉遗漏；与实时回调竞态时用 max 单调合并。 */
    const syncEventCursor = async () => {
      if (catchUpInFlight) return;
      catchUpInFlight = true;
      try {
        if (cursor === null) {
          advanceCursor(await fetchMaxEventId());
          return;
        }
        const result = await catchUpEventCursor({
          cursor,
          fetchPage: fetchEventIdsAfter,
        });
        // 补拉期间实时回调可能已推进游标，只取更大值。
        advanceCursor(result.cursor);
        if (result.missed > 0 && !cancelled) {
          invalidationBatcher.schedule(RECOVERY_INVALIDATIONS);
        }
      } finally {
        catchUpInFlight = false;
      }
    };

    const channel = supabase.channel(`workspace:${workspaceId}`);

    for (const table of REALTIME_TABLES) {
      channel.on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table,
          filter: `workspace_id=eq.${workspaceId}`,
          // 有 service-only 列的表必须显式限制为已授权的公开投影。
          ...(table === "tasks"
            ? { select: [...SAFE_TASK_REALTIME_COLUMNS] }
            : table === "session_history_syncs"
              ? { select: [...SAFE_HISTORY_SYNC_REALTIME_COLUMNS] }
              : null),
        },
        (payload) => {
          if (table === "task_events") {
            const id = extractEventId(payload);
            if (id !== null) advanceCursor(id);
          }
          if (table === "session_history_syncs") {
            const sessionId = extractSessionId(payload);
            if (sessionId) {
              historyRefreshBatcher.schedule(sessionId);
            } else {
              invalidationBatcher.schedule(
                realtimeInvalidations(table, payload),
              );
            }
          } else if (table === "session_activities") {
            const activity = sessionActivityFromRealtime(payload);
            const sessionId = activity?.session_id ?? extractSessionId(payload);
            if (activity && sessionId) {
              if (isHistoryImportActivity(activity)) {
                historyRefreshBatcher.schedule(sessionId);
                return;
              }
              const updated = queryClient.setQueryData<
                InfiniteData<SessionConversation, string | null>
              >(sessionQueryKey(sessionId), (current) =>
                appendRealtimeSessionActivity(current, activity),
              );
              if (!updated) {
                invalidationBatcher.schedule(
                  realtimeInvalidations(table, payload),
                );
              }
            } else if (sessionId) {
              invalidationBatcher.schedule(
                realtimeInvalidations(table, payload),
              );
            }
          } else if (table === "ai_sessions") {
            const update = sessionUpdateFromRealtime(payload);
            if (!update) {
              invalidationBatcher.schedule(
                realtimeInvalidations(table, payload),
              );
              return;
            }

            const sessionList =
              queryClient.getQueryData<SessionListItem[]>(SESSIONS_QUERY_KEY);
            if (sessionList?.some((session) => session.id === update.id)) {
              queryClient.setQueryData<SessionListItem[]>(
                SESSIONS_QUERY_KEY,
                (current) =>
                  current
                    ? patchRealtimeSessionList(current, update)
                    : current,
              );
            } else {
              invalidationBatcher.schedule([
                { queryKey: SESSIONS_QUERY_KEY, exact: true },
              ]);
            }

            queryClient.setQueryData<
              InfiniteData<SessionConversation, string | null>
            >(sessionQueryKey(update.id), (current) =>
              current
                ? patchRealtimeSessionConversation(current, update)
                : current,
            );
          } else {
            invalidationBatcher.schedule(
              realtimeInvalidations(table, payload),
            );
          }
        },
      );
    }

    channel.subscribe((status) => {
      if (status !== "SUBSCRIBED") return;
      void (async () => {
        try {
          await syncEventCursor();
        } catch {
          // 补拉失败不破坏订阅；权威状态由全量失效与轮询兜底恢复。
        }
        if (!cancelled) invalidationBatcher.schedule(RECOVERY_INVALIDATIONS);
      })();
    });

    return () => {
      cancelled = true;
      invalidationBatcher.cancel();
      historyRefreshBatcher.cancel();
      void supabase.removeChannel(channel);
    };
  }, [supabase, workspaceId, queryClient]);
}
