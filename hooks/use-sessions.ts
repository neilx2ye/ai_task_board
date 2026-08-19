"use client";

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useRef } from "react";

import { apiFetch } from "@/hooks/api-client";
import { createPendingIdempotencyTracker } from "@/hooks/pending-idempotency";
import {
  BRIDGE_DIRECTORIES_QUERY_KEY,
  sessionQueryKey,
  SESSIONS_QUERY_KEY,
  TASKS_QUERY_KEY,
} from "@/hooks/query-keys";
import type { SessionConversation, SessionListItem } from "@/lib/types/domain";
import type { AIThreadCommandRow } from "@/lib/types/database";

export function sessionConversationRecoveryInterval(
  pageCount: number,
  historyStatus: "syncing" | "partial" | "complete" | "failed" | null = null,
): 3_000 | 30_000 | false {
  if (historyStatus === "syncing" && pageCount <= 1) return 3_000;
  return pageCount <= 1 ? 30_000 : false;
}

export function useSessions() {
  return useQuery({
    queryKey: SESSIONS_QUERY_KEY,
    queryFn: async () => {
      const data =
        await apiFetch<{ sessions?: SessionListItem[] }>("/api/user/sessions");
      return data.sessions ?? [];
    },
    // 会话是否“存活”取决于 last_seen_at；即使没有 Realtime 事件，页面也要
    // 定期重新计算并拉取心跳结果。
    refetchInterval: 30_000,
  });
}

type MarkCompletionsViewedResult = {
  session_id: string;
  unviewed_completed_count: number;
};

/** 打开 Thread 时把“完成未查看”任务标记为已查看，并乐观更新会话清单。 */
export function useMarkSessionCompletionsViewed() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) =>
      apiFetch<MarkCompletionsViewedResult>(
        `/api/user/sessions/${sessionId}/viewed`,
        { method: "POST" },
      ),
    onMutate: async (sessionId) => {
      await queryClient.cancelQueries({ queryKey: SESSIONS_QUERY_KEY });
      const previous = queryClient.getQueryData<SessionListItem[]>(
        SESSIONS_QUERY_KEY,
      );
      queryClient.setQueryData<SessionListItem[]>(
        SESSIONS_QUERY_KEY,
        (current) =>
          current?.map((session) =>
            session.id === sessionId
              ? { ...session, unviewed_completed_count: 0 }
              : session,
          ),
      );
      return { previous };
    },
    onError: (_error, _sessionId, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(SESSIONS_QUERY_KEY, context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
    },
  });
}

export function useSessionConversation(sessionId: string | null) {
  return useInfiniteQuery({
    queryKey: sessionQueryKey(sessionId ?? ""),
    enabled: Boolean(sessionId),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const query = new URLSearchParams({ limit: "100" });
      if (pageParam) query.set("before_activity_cursor", pageParam);
      return apiFetch<SessionConversation>(
        `/api/user/sessions/${sessionId}?${query.toString()}`,
      );
    },
    getNextPageParam: (lastPage) =>
      lastPage.pagination.activities.has_more_older
        ? (lastPage.pagination.activities.oldest_cursor ?? undefined)
        : undefined,
    // SessionActivity Realtime rows are merged directly into this cache. Keep
    // a recovery poll while only the newest page is loaded; polling a
    // multi-page infinite query would refetch every historical page in order.
    // Realtime reconnect catch-up remains the recovery path after pagination.
    refetchInterval: (query) =>
      sessionConversationRecoveryInterval(
        query.state.data?.pages.length ?? 0,
        query.state.data?.pages[0]?.history_sync?.status ?? null,
      ),
  });
}

function valuesById<T>(values: readonly T[], id: (value: T) => string) {
  return [...new Map(values.map((value) => [id(value), value])).values()];
}

type ActivityOrderingFields = {
  created_at: string;
  occurred_at?: string;
  source_order?: string;
  id: string;
};

export function sessionActivityOccurredAt(
  activity: ActivityOrderingFields,
): string {
  return activity.occurred_at ?? activity.created_at;
}

function compareLosslessIntegers(left: string, right: string): number {
  try {
    const leftValue = BigInt(left);
    const rightValue = BigInt(right);
    return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
  } catch {
    return left.localeCompare(right);
  }
}

/** Match the API's stable chronological order without coercing bigint strings. */
export function compareSessionActivities(
  left: ActivityOrderingFields,
  right: ActivityOrderingFields,
): number {
  const byTime = sessionActivityOccurredAt(left).localeCompare(
    sessionActivityOccurredAt(right),
  );
  if (byTime) return byTime;
  const bySourceOrder = compareLosslessIntegers(
    left.source_order ?? left.id,
    right.source_order ?? right.id,
  );
  return bySourceOrder || compareLosslessIntegers(left.id, right.id);
}

/** Combine newest-first API pages into one chronological conversation. */
export function mergeSessionConversationPages(
  pages: readonly SessionConversation[] | undefined,
): SessionConversation | undefined {
  if (!pages?.length) return undefined;
  const first = pages[0];
  const last = pages.at(-1) ?? first;
  const activities = valuesById(
    pages.flatMap((page) => page.activities),
    (activity) => activity.id,
  ).sort(compareSessionActivities);
  const legacy = pages.map((page) => page.pagination.legacy);

  return {
    session: first.session,
    history_sync: first.history_sync,
    tasks: valuesById(
      pages.flatMap((page) => page.tasks),
      (task) => task.id,
    ).sort((left, right) => left.created_at.localeCompare(right.created_at)),
    messages: valuesById(
      pages.flatMap((page) => page.messages),
      (message) => message.id,
    ).sort((left, right) => left.created_at.localeCompare(right.created_at)),
    input_requests: valuesById(
      pages.flatMap((page) => page.input_requests ?? []),
      (request) => request.id,
    ).sort((left, right) => left.created_at.localeCompare(right.created_at)),
    events: valuesById(
      pages.flatMap((page) => page.events),
      (event) => String(event.id),
    ).sort((left, right) => left.id - right.id),
    activities,
    artifacts: valuesById(
      pages.flatMap((page) => page.artifacts ?? []),
      (artifact) => artifact.id,
    ),
    pagination: {
      activities: {
        ...last.pagination.activities,
        newest_cursor: first.pagination.activities.newest_cursor,
        oldest_cursor: last.pagination.activities.oldest_cursor,
      },
      legacy: {
        limit: Math.max(...legacy.map((value) => value.limit)),
        tasks_truncated: legacy.some((value) => value.tasks_truncated),
        messages_truncated: legacy.some((value) => value.messages_truncated),
        events_truncated: legacy.some((value) => value.events_truncated),
      },
    },
  };
}

export function useCreateSessionTurn(sessionId: string) {
  const queryClient = useQueryClient();
  const idempotency = useRef<
    ReturnType<typeof createPendingIdempotencyTracker> | undefined
  >(undefined);
  const requestKeys = useRef(
    new WeakMap<
      {
        content: string;
        images?: File[];
        model?: string | null;
        reasoning_effort?: string | null;
        goal_mode?: boolean | null;
      },
      { fingerprint: string; key: string }
    >(),
  );
  idempotency.current ??= createPendingIdempotencyTracker();
  return useMutation({
    mutationFn: (input: {
      content: string;
      images?: File[];
      model?: string | null;
      reasoning_effort?: string | null;
      goal_mode?: boolean | null;
    }) => {
      const fingerprint = `${sessionId}\0${input.content}\0${input.model ?? ""}\0${input.reasoning_effort ?? ""}\0${input.goal_mode ?? ""}\0${(input.images ?? [])
        .map((file) => `${file.name}:${file.type}:${file.size}:${file.lastModified}`)
        .join("|")}`;
      const idempotencyKey = idempotency.current!.keyFor(fingerprint);
      requestKeys.current.set(input, { fingerprint, key: idempotencyKey });
      const formData = new FormData();
      formData.set("content", input.content);
      if (input.model) formData.set("model", input.model);
      if (input.reasoning_effort) {
        formData.set("reasoning_effort", input.reasoning_effort);
      }
      if (input.goal_mode !== null && input.goal_mode !== undefined) {
        formData.set("goal_mode", String(input.goal_mode));
      }
      for (const image of input.images ?? []) formData.append("images", image);
      return apiFetch<unknown>(`/api/user/sessions/${sessionId}/turns`, {
        method: "POST",
        body: formData,
        idempotencyKey,
      });
    },
    onSuccess: (_result, input) => {
      const request = requestKeys.current.get(input);
      if (request) {
        idempotency.current!.confirm(request.fingerprint, request.key);
      }
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
      void queryClient.invalidateQueries({
        queryKey: sessionQueryKey(sessionId),
      });
      void queryClient.invalidateQueries({ queryKey: TASKS_QUERY_KEY });
    },
    onSettled: (_result, _error, input) => {
      requestKeys.current.delete(input);
    },
  });
}

type ThreadCommandResult = { command: AIThreadCommandRow };

export function useCreateThread(connectionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      name: string;
      directory_key?: string | null;
      model?: string | null;
      reasoning_effort?: string | null;
      platform?: string | null;
    }) =>
      apiFetch<ThreadCommandResult>(
        `/api/user/connections/${connectionId}/threads`,
        { method: "POST", json: input },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
      void queryClient.invalidateQueries({
        queryKey: BRIDGE_DIRECTORIES_QUERY_KEY,
      });
    },
  });
}

export function useRenameThread(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      name: string;
      model?: string | null;
      reasoning_effort?: string | null;
    }) =>
      apiFetch<ThreadCommandResult>(`/api/user/sessions/${sessionId}`, {
        method: "PATCH",
        json: input,
      }),
    onSuccess: (_result, input) => {
      queryClient.setQueryData<SessionListItem[]>(
        SESSIONS_QUERY_KEY,
        (current) =>
          current?.map((session) =>
            session.id === sessionId
              ? {
                  ...session,
                  name: input.name,
                  user_name: input.name,
                  configured_model:
                    input.model ?? session.configured_model,
                  configured_reasoning_effort:
                    input.reasoning_effort ??
                    session.configured_reasoning_effort,
                  thread_settings_status:
                    input.model || input.reasoning_effort
                      ? "queued"
                      : session.thread_settings_status,
                }
              : session,
          ),
      );
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
      void queryClient.invalidateQueries({
        queryKey: sessionQueryKey(sessionId),
      });
    },
  });
}

export function useDeleteThread(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<ThreadCommandResult>(`/api/user/sessions/${sessionId}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      queryClient.setQueryData<SessionListItem[]>(
        SESSIONS_QUERY_KEY,
        (current) =>
          current?.filter((session) => session.id !== sessionId),
      );
      queryClient.removeQueries({
        queryKey: sessionQueryKey(sessionId),
        exact: true,
      });
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: TASKS_QUERY_KEY });
    },
  });
}

type ThreadDeleteTarget = Pick<SessionListItem, "id" | "name">;

export type DeleteThreadsResult = {
  deletedIds: string[];
  failures: Array<ThreadDeleteTarget & { message: string }>;
};

/** 分批提交删除，避免一次性为大量未勾选 Thread 打满浏览器连接。 */
export function useDeleteThreads() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      sessions: readonly ThreadDeleteTarget[],
    ): Promise<DeleteThreadsResult> => {
      const deletedIds: string[] = [];
      const failures: DeleteThreadsResult["failures"] = [];

      for (let index = 0; index < sessions.length; index += 5) {
        const batch = sessions.slice(index, index + 5);
        const results = await Promise.all(
          batch.map(async (session) => {
            try {
              await apiFetch<ThreadCommandResult>(
                `/api/user/sessions/${session.id}`,
                { method: "DELETE" },
              );
              return { session, message: null };
            } catch (error) {
              return {
                session,
                message:
                  error instanceof Error
                    ? error.message
                    : "删除失败，请稍后重试",
              };
            }
          }),
        );

        for (const result of results) {
          if (result.message === null) {
            deletedIds.push(result.session.id);
          } else {
            failures.push({ ...result.session, message: result.message });
          }
        }
      }

      return { deletedIds, failures };
    },
    onSuccess: (result) => {
      const deletedIds = new Set(result.deletedIds);
      if (deletedIds.size > 0) {
        queryClient.setQueryData<SessionListItem[]>(
          SESSIONS_QUERY_KEY,
          (current) =>
            current?.filter((session) => !deletedIds.has(session.id)),
        );
        for (const sessionId of deletedIds) {
          queryClient.removeQueries({
            queryKey: sessionQueryKey(sessionId),
            exact: true,
          });
        }
      }
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: TASKS_QUERY_KEY });
    },
  });
}
